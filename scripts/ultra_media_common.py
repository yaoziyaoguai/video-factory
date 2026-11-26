#!/usr/bin/env python3
"""Shared task ledger, media validation, and Frame HTTP client for Google AI Ultra media skills.

Uses only Python 3.12+ standard library so skills run out-of-the-box on both Linux servers
and macOS workers without extra pip dependencies.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import http.cookiejar
import json
import mimetypes
import os
import pathlib
import shutil
import sqlite3
import struct
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_STATE_DIR = pathlib.Path(
    os.environ.get("ULTRA_MEDIA_STATE_DIR", str(REPO_ROOT / "workspace" / "ultra-media"))
)
CREDENTIALS_ENV_PATH = pathlib.Path(
    os.environ.get(
        "ULTRA_MEDIA_CREDENTIALS_FILE",
        str(pathlib.Path.home() / ".config" / "ultra-media" / "credentials.env"),
    )
)


def load_saved_credentials(path: pathlib.Path | None = None) -> dict[str, str]:
    """Load owner-only key=value credentials from `~/.config/ultra-media/credentials.env`."""
    target = path or CREDENTIALS_ENV_PATH
    if not target.is_file():
        return {}
    result: dict[str, str] = {}
    for raw_line in target.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key:
            result[key] = val
    return result


def save_credentials_env(updates: dict[str, str], path: pathlib.Path | None = None) -> pathlib.Path:
    """Merge `updates` into `~/.config/ultra-media/credentials.env` with mode 0600."""
    target = path or CREDENTIALS_ENV_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(target.parent, 0o700)
    except OSError:
        pass
    merged = load_saved_credentials(target)
    for k, v in updates.items():
        if v == "":
            merged.pop(k, None)
        else:
            merged[k] = v
    lines = ["# Managed by scripts/ultra_config.py (mode 0600; do not commit)"]
    for k in sorted(merged):
        escaped = merged[k].replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'{k}="{escaped}"')
    tmp = target.with_suffix(".env.tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(target)
    os.chmod(target, 0o600)
    return target

LEDGER_SCHEMA = """
CREATE TABLE IF NOT EXISTS external_tasks (
    task_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    external_id TEXT,
    external_meta_json TEXT NOT NULL DEFAULT '{}',
    request_json TEXT NOT NULL,
    local_file TEXT,
    file_sha256 TEXT,
    frame_receipt_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_external_tasks_kind_status
    ON external_tasks(kind, status, updated_at DESC);
"""


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def make_idempotency_key(kind: str, payload: dict[str, Any]) -> str:
    return f"{kind}:{sha256_bytes(canonical_json(payload).encode('utf-8'))[:24]}"


def make_task_id(prefix: str, idempotency_key: str) -> str:
    digest = sha256_bytes(idempotency_key.encode("utf-8"))[:12]
    return f"{prefix}-{digest}"


class TaskLedger:
    """SQLite-backed task ledger persisting external IDs to prevent duplicate credit/CU spend."""

    def __init__(self, db_path: pathlib.Path | None = None) -> None:
        self.db_path = db_path or (DEFAULT_STATE_DIR / "tasks.db")
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.db_path.parent, 0o700)
        except OSError:
            pass
        with self._connect() as conn:
            conn.executescript(LEDGER_SCHEMA)
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def get(self, task_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM external_tasks WHERE task_id = ?", (task_id,)).fetchone()
        return self._decode_row(row) if row else None

    def get_by_key(self, idempotency_key: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM external_tasks WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
        return self._decode_row(row) if row else None

    def list_tasks(self, kind: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if kind:
                rows = conn.execute(
                    "SELECT * FROM external_tasks WHERE kind = ? ORDER BY updated_at DESC LIMIT ?",
                    (kind, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM external_tasks ORDER BY updated_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [self._decode_row(r) for r in rows]

    def create_or_get(
        self,
        *,
        task_id: str,
        kind: str,
        idempotency_key: str,
        request: dict[str, Any],
        external_meta: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Atomically insert a prepared task or return existing record (created=False)."""
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                existing = conn.execute(
                    "SELECT * FROM external_tasks WHERE idempotency_key = ? OR task_id = ?",
                    (idempotency_key, task_id),
                ).fetchone()
                if existing:
                    conn.execute("COMMIT")
                    return self._decode_row(existing), False
                conn.execute(
                    """
                    INSERT INTO external_tasks(
                        task_id, kind, idempotency_key, status, external_meta_json,
                        request_json, created_at, updated_at
                    ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?)
                    """,
                    (
                        task_id,
                        kind,
                        idempotency_key,
                        canonical_json(external_meta or {}),
                        canonical_json(request),
                        now,
                        now,
                    ),
                )
                row = conn.execute(
                    "SELECT * FROM external_tasks WHERE task_id = ?", (task_id,)
                ).fetchone()
                conn.execute("COMMIT")
                return self._decode_row(row), True
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    def update(
        self,
        task_id: str,
        *,
        status: str | None = None,
        external_id: str | None = None,
        meta_patch: dict[str, Any] | None = None,
        local_file: str | pathlib.Path | None = None,
        file_sha256: str | None = None,
        frame_receipt: dict[str, Any] | None = None,
        error: str | None = ...,  # type: ignore[assignment]
    ) -> dict[str, Any]:
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT * FROM external_tasks WHERE task_id = ?", (task_id,)
                ).fetchone()
                if not row:
                    raise KeyError(f"Task not found in ledger: {task_id}")
                current = self._decode_row(row)
                merged_meta = {**current["external_meta"], **(meta_patch or {})}
                next_status = status if status is not None else current["status"]
                next_ext_id = external_id if external_id is not None else current["external_id"]
                next_file = str(local_file) if local_file is not None else current["local_file"]
                next_sha = file_sha256 if file_sha256 is not None else current["file_sha256"]
                next_receipt = (
                    canonical_json(frame_receipt)
                    if frame_receipt is not None
                    else (
                        canonical_json(current["frame_receipt"])
                        if current["frame_receipt"] is not None
                        else None
                    )
                )
                next_error = current["error"] if error is ... else error
                conn.execute(
                    """
                    UPDATE external_tasks
                    SET status = ?, external_id = ?, external_meta_json = ?,
                        local_file = ?, file_sha256 = ?, frame_receipt_json = ?,
                        error = ?, updated_at = ?
                    WHERE task_id = ?
                    """,
                    (
                        next_status,
                        next_ext_id,
                        canonical_json(merged_meta),
                        next_file,
                        next_sha,
                        next_receipt,
                        next_error,
                        now,
                        task_id,
                    ),
                )
                updated = conn.execute(
                    "SELECT * FROM external_tasks WHERE task_id = ?", (task_id,)
                ).fetchone()
                conn.execute("COMMIT")
                return self._decode_row(updated)
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    @staticmethod
    def _decode_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "task_id": row["task_id"],
            "kind": row["kind"],
            "idempotency_key": row["idempotency_key"],
            "status": row["status"],
            "external_id": row["external_id"],
            "external_meta": json.loads(row["external_meta_json"] or "{}"),
            "request": json.loads(row["request_json"] or "{}"),
            "local_file": row["local_file"],
            "file_sha256": row["file_sha256"],
            "frame_receipt": (
                json.loads(row["frame_receipt_json"]) if row["frame_receipt_json"] else None
            ),
            "error": row["error"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }


# --- Media verification ---------------------------------------------------------------------


class MediaValidationError(ValueError):
    """Downloaded or generated media file failed integrity verification."""


def verify_media_file(path: pathlib.Path, expected_kind: str) -> dict[str, Any]:
    """Validate container signature, non-zero payload, and optional ffprobe metadata."""
    if not path.is_file():
        raise MediaValidationError(f"Media file does not exist: {path}")
    size = path.stat().st_size
    if size < 32:
        raise MediaValidationError(f"Media file is empty or truncated ({size} bytes): {path}")
    head = path.read_bytes()[:64]
    ext = path.suffix.lower()

    if expected_kind == "video":
        if len(head) < 12 or head[4:8] != b"ftyp":
            raise MediaValidationError(f"File is not a valid MP4 (missing ftyp box): {path}")
        mime_type = "video/mp4"
    elif expected_kind == "audio":
        if ext == ".wav" or head[:4] == b"RIFF":
            if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
                raise MediaValidationError(f"File is not a valid RIFF WAVE container: {path}")
            mime_type = "audio/wav"
        elif ext == ".mp3" or head[:3] == b"ID3" or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
            if not (head[:3] == b"ID3" or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)):
                raise MediaValidationError(f"File is not a valid MP3 stream: {path}")
            mime_type = "audio/mpeg"
        else:
            raise MediaValidationError(
                f"Unsupported audio format {ext!r} (Frame upload requires .wav or .mp3): {path}"
            )
    elif expected_kind == "image":
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            mime_type = "image/png"
        elif head.startswith(b"\xff\xd8\xff"):
            mime_type = "image/jpeg"
        elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            mime_type = "image/webp"
        else:
            raise MediaValidationError(f"File is not a supported PNG/JPEG/WebP image: {path}")
    else:
        raise ValueError(f"Unknown expected_kind: {expected_kind}")

    facts: dict[str, Any] = {
        "path": str(path.resolve()),
        "size_bytes": size,
        "sha256": sha256_file(path),
        "mime_type": mime_type,
    }

    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_type,width,height,sample_rate,channels",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise MediaValidationError(f"ffprobe rejected {path}: {proc.stderr.strip()}")
        try:
            probe = json.loads(proc.stdout)
            duration_s = float((probe.get("format") or {}).get("duration") or 0.0)
            if duration_s > 0:
                facts["duration_ms"] = round(duration_s * 1000)
            for stream in probe.get("streams") or []:
                if stream.get("codec_type") == "video":
                    facts["width"] = stream.get("width")
                    facts["height"] = stream.get("height")
                elif stream.get("codec_type") == "audio":
                    facts["has_audio"] = True
                    if stream.get("sample_rate"):
                        facts["sample_rate"] = int(stream["sample_rate"])
                    if stream.get("channels"):
                        facts["channels"] = int(stream["channels"])
        except (ValueError, TypeError):
            pass

    return facts


# --- Frame (video-factory) HTTP API client --------------------------------------------------


class FrameApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, payload: dict[str, Any] | None = None):
        super().__init__(f"Frame API HTTP {status} [{code}]: {message}")
        self.status = status
        self.code = code
        self.payload = payload or {}


class FrameClient:
    """Client for Frame's `/api/agent/v1` endpoints, including idempotent media ingestion."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        ui_origin: str | None = None,
        username: str | None = None,
        password: str | None = None,
        session_cookie: str | None = None,
        timeout_s: float = 120.0,
    ) -> None:
        saved = load_saved_credentials()
        raw_url = (
            base_url
            or os.environ.get("FRAME_BASE_URL")
            or saved.get("FRAME_BASE_URL")
            or "http://127.0.0.1:4318"
        ).rstrip("/")
        self.base_url = raw_url
        parsed = urllib.parse.urlparse(raw_url)
        self.ui_origin = (
            ui_origin
            or os.environ.get("FRAME_UI_ORIGIN")
            or saved.get("FRAME_UI_ORIGIN")
            or f"{parsed.scheme}://{parsed.netloc}"
        )
        self.username = (
            username
            if username is not None
            else (os.environ.get("FRAME_USERNAME") or saved.get("FRAME_USERNAME"))
        )
        self.password = (
            password
            if password is not None
            else (os.environ.get("FRAME_PASSWORD") or saved.get("FRAME_PASSWORD"))
        )
        self.session_cookie = (
            session_cookie
            if session_cookie is not None
            else (os.environ.get("FRAME_SESSION_COOKIE") or saved.get("FRAME_SESSION_COOKIE"))
        )
        self.timeout_s = timeout_s
        self.cookies = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        self._logged_in = False

    def _headers(self, *, mutation: bool = False, content_type: str | None = None) -> dict[str, str]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if self.session_cookie:
            cookie_val = (
                self.session_cookie
                if "=" in self.session_cookie
                else f"vf_session={self.session_cookie}"
            )
            headers["Cookie"] = cookie_val
        if mutation:
            headers["Origin"] = self.ui_origin
            headers["x-video-factory-request"] = "studio"
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    def ensure_authenticated(self) -> None:
        if self._logged_in or self.session_cookie or not (self.username and self.password):
            return
        body = json.dumps({"username": self.username, "password": self.password}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/auth/login",
            data=body,
            method="POST",
            headers=self._headers(mutation=True, content_type="application/json"),
        )
        try:
            with self._opener.open(req, timeout=self.timeout_s) as resp:
                resp.read()
                self._logged_in = True
        except urllib.error.HTTPError as exc:
            self._raise_http_error(exc)

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        mutation: bool = False,
    ) -> dict[str, Any]:
        self.ensure_authenticated()
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers=self._headers(mutation=mutation, content_type=content_type),
        )
        try:
            with self._opener.open(req, timeout=self.timeout_s) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            self._raise_http_error(exc)

    @staticmethod
    def _raise_http_error(exc: urllib.error.HTTPError) -> None:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {}
        code = str(payload.get("code") or payload.get("error") or f"HTTP_{exc.code}")
        msg = str(payload.get("message") or raw[:300] or exc.reason)
        raise FrameApiError(exc.code, code, msg, payload) from exc

    def get_conversation(self, conversation_id: str) -> dict[str, Any]:
        return self._request_json(
            "GET", f"/api/agent/v1/conversations/{urllib.parse.quote(conversation_id)}"
        )

    def create_conversation(self, title: str, command_id: str | None = None) -> dict[str, Any]:
        cmd = command_id or f"cmd-conv-{uuid.uuid4().hex[:16]}"
        body = json.dumps({"commandId": cmd, "title": title[:64]}).encode("utf-8")
        return self._request_json(
            "POST",
            "/api/agent/v1/conversations",
            body=body,
            content_type="application/json",
            mutation=True,
        )

    def get_snapshot(self, conversation_id: str) -> dict[str, Any]:
        return self._request_json(
            "GET", f"/api/agent/v1/conversations/{urllib.parse.quote(conversation_id)}/snapshot"
        )

    def get_revision(self, artifact_id: str, revision_id: str) -> dict[str, Any]:
        return self._request_json(
            "GET",
            f"/api/agent/v1/artifacts/{urllib.parse.quote(artifact_id)}"
            f"/revisions/{urllib.parse.quote(revision_id)}",
        )

    def download_blob(self, blob_id: str, destination: pathlib.Path) -> pathlib.Path:
        self.ensure_authenticated()
        destination.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(
            f"{self.base_url}/api/agent/v1/blobs/{urllib.parse.quote(blob_id)}/content?download=1",
            method="GET",
            headers=self._headers(mutation=False),
        )
        try:
            with self._opener.open(req, timeout=self.timeout_s) as resp:
                with destination.open("wb") as out:
                    shutil.copyfileobj(resp, out)
        except urllib.error.HTTPError as exc:
            self._raise_http_error(exc)
        return destination

    def ingest_media(
        self,
        conversation_id: str,
        file_path: pathlib.Path,
        *,
        command_id: str | None = None,
        file_name: str | None = None,
    ) -> dict[str, Any]:
        """Upload MP4/WAV/MP3/PNG/JPG into Frame via `POST /conversations/:id/uploads`.

        Automatically fetches `expectedRevision`, uses deterministic `commandId` for safe replay,
        and retries once if `STALE_REVISION` (409) occurs due to concurrent conversation activity.
        """
        file_path = file_path.resolve()
        if not file_path.is_file():
            raise FileNotFoundError(f"Media file to ingest not found: {file_path}")
        digest = sha256_file(file_path)
        cmd_id = command_id or f"cmd-ul-{sha256_bytes(f'{conversation_id}:{digest}'.encode())[:24]}"
        upload_name = file_name or file_path.name
        mime_type = self._upload_mime(upload_name)

        for attempt in range(2):
            conv = self.get_conversation(conversation_id)
            expected_revision = int(conv["revision"])
            boundary = f"----FrameUltraBoundary{uuid.uuid4().hex}"
            body = _encode_multipart_upload(
                boundary=boundary,
                fields={
                    "commandId": cmd_id,
                    "expectedRevision": str(expected_revision),
                    "rights": "owned_or_licensed",
                },
                file_name=upload_name,
                mime_type=mime_type,
                file_bytes=file_path.read_bytes(),
            )
            try:
                return self._request_json(
                    "POST",
                    f"/api/agent/v1/conversations/{urllib.parse.quote(conversation_id)}/uploads",
                    body=body,
                    content_type=f"multipart/form-data; boundary={boundary}",
                    mutation=True,
                )
            except FrameApiError as exc:
                if exc.status == 409 and exc.code == "STALE_REVISION" and attempt == 0:
                    continue
                raise
        raise RuntimeError("Unreachable upload retry loop")

    @staticmethod
    def _upload_mime(file_name: str) -> str:
        ext = pathlib.Path(file_name).suffix.lower()
        mapping = {
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".wav": "audio/wav",
            ".mp3": "audio/mpeg",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
        }
        if ext not in mapping:
            guessed, _ = mimetypes.guess_type(file_name)
            raise ValueError(
                f"Unsupported extension {ext!r} for Frame upload (guessed {guessed!r}). "
                f"Allowed: {', '.join(sorted(mapping))}"
            )
        return mapping[ext]


def _encode_multipart_upload(
    *,
    boundary: str,
    fields: dict[str, str],
    file_name: str,
    mime_type: str,
    file_bytes: bytes,
) -> bytes:
    chunks: list[bytes] = []
    bnd = boundary.encode("ascii")
    for name, value in fields.items():
        chunks.append(b"--" + bnd + b"\r\n")
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(value.encode("utf-8") + b"\r\n")
    safe_name = file_name.replace('"', "_")
    chunks.append(b"--" + bnd + b"\r\n")
    chunks.append(
        f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'.encode("utf-8")
    )
    chunks.append(f"Content-Type: {mime_type}\r\n\r\n".encode("ascii"))
    chunks.append(file_bytes)
    chunks.append(b"\r\n--" + bnd + b"--\r\n")
    return b"".join(chunks)


# --- Minimal synthetic media writers for offline simulation tests ---------------------------


def write_minimal_wav(path: pathlib.Path, duration_s: float = 1.0, sample_rate: int = 24000) -> None:
    """Write a valid PCM 16-bit mono WAV file for offline contract and pipeline testing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    num_samples = max(1, int(duration_s * sample_rate))
    pcm = b"\x00\x00" * num_samples
    byte_rate = sample_rate * 2
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        byte_rate,
        2,
        16,
        b"data",
        len(pcm),
    )
    path.write_bytes(header + pcm)


def write_minimal_mp3(path: pathlib.Path, frames: int = 38) -> None:
    """Write valid MPEG1 Layer3 128kbps 44.1kHz silent frames (~1s at 38 frames)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # 0xFFFB9064 -> MPEG1 Layer3, 128kbps, 44100Hz, Joint Stereo; frame length = 417 bytes
    frame = bytes([0xFF, 0xFB, 0x90, 0x64]) + (b"\x00" * 413)
    path.write_bytes(frame * max(1, frames))


def write_minimal_png(path: pathlib.Path) -> None:
    """Write a valid 1x1 RGB PNG image for offline simulation tests."""
    import zlib

    path.parent.mkdir(parents=True, exist_ok=True)

    def png_chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\x20\x60\xa0")
    raw = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", idat)
        + png_chunk(b"IEND", b"")
    )
    path.write_bytes(raw)


def copy_sample_mp4_or_minimal(path: pathlib.Path) -> None:
    """Copy a real sample MP4 from Frame preview assets if present, else write valid ISO-BMFF box."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sample = (
        REPO_ROOT
        / "apps"
        / "studio"
        / "src"
        / "client"
        / "agent"
        / "preview"
        / "assets"
        / "coffee-preview.mp4"
    )
    if sample.is_file():
        shutil.copyfile(sample, path)
        return
    ftyp = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    mdat = b"\x00\x00\x00\x10mdat" + b"\x00" * 8
    path.write_bytes(ftyp + mdat)
