#!/usr/bin/env python3
"""Colab CLI orchestrator & controlled Frame `MediaExecutionPort` executor for LTX-2.5 Distilled.

Supports two execution surfaces sharing the same SQLite ownership ledger:
1. Web Native Port Lifecycle (`submit`, `query`, `cancel`, `release-batch`, `preflight`):
   - Persists local `attempt_id` + `request_identity` + `session_name` BEFORE GPU allocation.
   - Uses an isolated `colab-sessions.json` (`0600`) and enforces strict runtime ownership:
     NEVER adopts `[?]` anonymous sessions, NEVER unassigns `[?]` endpoints, NEVER runs prefix
     or `--all` stops on the web path, and verifies `endpoint == confirmed_endpoint` before
     `exec` / `download` / `stop`.
   - Reconciles interrupted allocations via `colab-sessions.json` without ever re-allocating a
     second GPU for the same `attempt_id`.
   - Supports same-batch multi-shot warm reuse (`--batch-id <runId>`) keeping LTX-2.5 weights
     loaded in GPU/CPU-offload memory across shots in the same approved batch while keeping
     every shot individually recoverable and releasing the GPU on final shot, failure, or cancel.
2. Manual CLI (`run`, `recover`, `plan-cu`, `benchmark-compare`, `cleanup`):
   - Preserves developer CLI workflows and zero-CU capacity/benchmark analysis.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from ultra_media_common import (  # noqa: E402
    DEFAULT_STATE_DIR,
    FrameClient,
    MediaValidationError,
    TaskLedger,
    canonical_json,
    load_saved_credentials,
    make_idempotency_key,
    make_task_id,
    sha256_file,
    utc_now_iso,
    verify_media_file,
)

WORKER_SCRIPT = SCRIPT_DIR / "ltx25_remote_worker.py"

PRESETS: dict[str, dict[str, Any]] = {
    "720p": {
        "16:9": {"gen_w": 1280, "gen_h": 704, "out_w": 1280, "out_h": 720},
        "9:16": {"gen_w": 704, "gen_h": 1280, "out_w": 720, "out_h": 1280},
        "default_gpu": "T4",
    },
    "1080p": {
        "16:9": {"gen_w": 1920, "gen_h": 1088, "out_w": 1920, "out_h": 1080},
        "9:16": {"gen_w": 1088, "gen_h": 1920, "out_w": 1080, "out_h": 1920},
        "default_gpu": "L4",
    },
}

CU_RATES_PER_HOUR: dict[str, float] = {
    "T4": 1.55,
    "L4": 4.20,
    "G4": 8.50,
    "A100": 11.80,
    "H100": 26.50,
}

ENDPOINT_RE = re.compile(r"^\[(?P<name>[^\]]+)\]\s+(?P<endpoint>\S+)\s+\|\s+Hardware:\s+(?P<hw>\S+)")
USAGE_BALANCE_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(?:compute units|cu)\b", re.IGNORECASE)

BATCH_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS colab_batches (
    batch_id TEXT PRIMARY KEY,
    session_name TEXT NOT NULL,
    confirmed_endpoint TEXT,
    gpu TEXT,
    daemon_dir TEXT NOT NULL,
    model_revision TEXT NOT NULL,
    mount_drive INTEGER NOT NULL DEFAULT 0,
    cache_dir TEXT NOT NULL,
    status TEXT NOT NULL,
    total_shots INTEGER NOT NULL DEFAULT 1,
    completed_shots INTEGER NOT NULL DEFAULT 0,
    usage_before_cu REAL,
    alloc_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


class ColabCommandError(RuntimeError):
    def __init__(
        self,
        cmd: list[str],
        returncode: int,
        stdout: str,
        stderr: str,
        timed_out: bool = False,
    ) -> None:
        msg = (
            f"Colab command timed out: {' '.join(cmd)}"
            if timed_out
            else f"Colab command failed (exit {returncode}): {' '.join(cmd)}\n{(stderr or stdout).strip()[-600:]}"
        )
        super().__init__(msg)
        self.cmd = cmd
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.timed_out = timed_out


class ColabOwnershipError(RuntimeError):
    """Raised when an operation attempts to touch a runtime whose ownership cannot be proven."""


def ensure_batch_schema(db_path: pathlib.Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        conn.executescript(BATCH_TABLE_SQL)
        conn.commit()
    finally:
        conn.close()


def parse_observed_cu_balance(usage_text: str | None) -> float | None:
    if not usage_text:
        return None
    matches = USAGE_BALANCE_RE.findall(usage_text)
    if not matches:
        return None
    try:
        return float(matches[0])
    except ValueError:
        return None


def read_hf_token_secure(args: argparse.Namespace) -> str:
    if getattr(args, "hf_token_stdin", False):
        token = sys.stdin.read().strip()
        if token:
            return token
    if getattr(args, "hf_token", None):
        return str(args.hf_token).strip()
    env_tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if env_tok:
        return env_tok.strip()
    saved = load_saved_credentials()
    if saved.get("HF_TOKEN"):
        return str(saved["HF_TOKEN"]).strip()
    hf_token_file = pathlib.Path(
        os.environ.get("HF_TOKEN_PATH")
        or (pathlib.Path(os.environ.get("HF_HOME", "~/.cache/huggingface")).expanduser() / "token")
    ).expanduser()
    if hf_token_file.is_file():
        return hf_token_file.read_text(encoding="utf-8").strip()
    return ""


class ColabCliDriver:
    """Controlled wrapper around `google-colab-cli` (`colab`) with strict ownership checks."""

    def __init__(
        self,
        *,
        colab_bin: str | None = None,
        auth_mode: str | None = None,
        config_path: str | pathlib.Path | None = None,
    ) -> None:
        raw_bin = colab_bin or os.environ.get("COLAB_CLI_BIN") or "colab"
        self.base_argv = shlex.split(raw_bin)
        if not shutil.which(self.base_argv[0]) and not pathlib.Path(self.base_argv[0]).is_file():
            uvx = shutil.which("uvx")
            if raw_bin == "colab" and uvx:
                self.base_argv = [uvx, "--from", "google-colab-cli", "colab"]
        self.auth_mode = auth_mode or os.environ.get("COLAB_CLI_AUTH")
        self.config_path = str(config_path) if config_path else os.environ.get("COLAB_CLI_CONFIG")
        if self.config_path:
            cfg_p = pathlib.Path(self.config_path)
            cfg_p.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(cfg_p.parent, 0o700)
            except OSError:
                pass

    def binary_exists(self) -> bool:
        exe = self.base_argv[0]
        return bool(shutil.which(exe) or pathlib.Path(exe).is_file())

    def _argv(self, args: list[str]) -> list[str]:
        cmd = list(self.base_argv)
        if self.auth_mode:
            cmd.extend(["--auth", self.auth_mode])
        if self.config_path:
            cmd.extend(["--config", self.config_path])
        cmd.extend(args)
        return cmd

    def run(
        self,
        args: list[str],
        *,
        timeout_s: float = 300.0,
        check: bool = True,
        extra_env: dict[str, str] | None = None,
        stream: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        cmd = self._argv(args)
        run_env = {**os.environ, **(extra_env or {})} if extra_env else None
        if not stream:
            try:
                proc = subprocess.run(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    text=True,
                    env=run_env,
                    timeout=timeout_s,
                    check=False,
                )
            except FileNotFoundError as exc:
                raise ColabCommandError(
                    cmd,
                    127,
                    "",
                    f"Executable '{cmd[0]}' not found. Install via `uv tool install google-colab-cli`.",
                ) from exc
            except subprocess.TimeoutExpired as exc:
                raise ColabCommandError(
                    cmd,
                    124,
                    (exc.stdout or "") if isinstance(exc.stdout, str) else "",
                    (exc.stderr or "") if isinstance(exc.stderr, str) else "",
                    timed_out=True,
                ) from exc
            if check and proc.returncode != 0:
                raise ColabCommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
            return proc

        try:
            popen = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=run_env,
            )
        except FileNotFoundError as exc:
            raise ColabCommandError(
                cmd,
                127,
                "",
                f"Executable '{cmd[0]}' not found. Install via `uv tool install google-colab-cli`.",
            ) from exc

        out_chunks: list[str] = []
        err_chunks: list[str] = []

        def _pump(pipe: Any, sink: list[str]) -> None:
            try:
                for line in iter(pipe.readline, ""):
                    sink.append(line)
                    sys.stderr.write(line)
                    sys.stderr.flush()
            finally:
                pipe.close()

        t_out = threading.Thread(target=_pump, args=(popen.stdout, out_chunks), daemon=True)
        t_err = threading.Thread(target=_pump, args=(popen.stderr, err_chunks), daemon=True)
        t_out.start()
        t_err.start()
        try:
            rc = popen.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired as exc:
            popen.kill()
            t_out.join(timeout=2.0)
            t_err.join(timeout=2.0)
            raise ColabCommandError(
                cmd,
                124,
                "".join(out_chunks),
                "".join(err_chunks),
                timed_out=True,
            ) from exc
        t_out.join(timeout=5.0)
        t_err.join(timeout=5.0)
        completed = subprocess.CompletedProcess(cmd, rc, "".join(out_chunks), "".join(err_chunks))
        if check and rc != 0:
            raise ColabCommandError(cmd, rc, completed.stdout, completed.stderr)
        return completed

    def list_sessions(self) -> list[dict[str, str]]:
        proc = self.run(["sessions"], timeout_s=60.0, check=True)
        found: list[dict[str, str]] = []
        for line in proc.stdout.splitlines():
            match = ENDPOINT_RE.match(line.strip())
            if match:
                found.append(match.groupdict())
        return found

    def local_store_entry(self, session_name: str) -> dict[str, Any] | None:
        """Inspect isolated `colab-sessions.json` for an exact named session (never `[?]`)."""
        if not session_name or session_name == "?" or not self.config_path:
            return None
        cfg_file = pathlib.Path(self.config_path)
        if not cfg_file.is_file():
            return None
        try:
            raw = json.loads(cfg_file.read_text(encoding="utf-8"))
        except ValueError:
            return None
        if not isinstance(raw, dict):
            return None
        sessions_map = raw.get("sessions") if isinstance(raw.get("sessions"), dict) else raw
        entry = sessions_map.get(session_name)
        if isinstance(entry, dict) and entry.get("endpoint"):
            return entry
        return None

    def owned_session_info(
        self,
        session_name: str,
        *,
        expected_endpoint: str | None = None,
    ) -> dict[str, str] | None:
        """Resolve an active session ONLY when named `session_name` (`!= '?'`) and matching `expected_endpoint`."""
        if not session_name or session_name == "?":
            return None
        proc = self.run(["status", "-s", session_name], timeout_s=60.0, check=False)
        candidate: dict[str, str] | None = None
        for line in proc.stdout.splitlines():
            match = ENDPOINT_RE.match(line.strip())
            if match and match.group("name") == session_name:
                candidate = match.groupdict()
                break
        if candidate is None:
            for item in self.list_sessions():
                if item["name"] == session_name:
                    candidate = item
                    break
        if candidate is None:
            return None
        if expected_endpoint and candidate["endpoint"] != expected_endpoint:
            raise ColabOwnershipError(
                f"Session {session_name!r} endpoint mismatch: expected {expected_endpoint!r}, "
                f"found {candidate['endpoint']!r}. Refusing cross-session access."
            )
        return candidate

    def query_usage_cu(self) -> float | None:
        proc = self.run(["usage"], timeout_s=30.0, check=False)
        if proc.returncode != 0:
            return None
        return parse_observed_cu_balance(f"{proc.stdout}\n{proc.stderr}")

    def stop_owned_session(
        self,
        session_name: str,
        confirmed_endpoint: str,
    ) -> dict[str, Any]:
        """Stop ONLY `(session_name, confirmed_endpoint)` — never `[?]` or other sessions."""
        if not session_name or session_name == "?" or not confirmed_endpoint:
            raise ColabOwnershipError(
                f"Refusing to stop session without provable ownership: "
                f"session={session_name!r}, endpoint={confirmed_endpoint!r}"
            )
        t0 = time.monotonic()
        live = self.list_sessions()
        matching = [s for s in live if s["name"] == session_name]
        if matching and matching[0]["endpoint"] != confirmed_endpoint:
            raise ColabOwnershipError(
                f"Refusing to stop {session_name!r}: live endpoint {matching[0]['endpoint']!r} "
                f"!= confirmed endpoint {confirmed_endpoint!r}"
            )
        if not matching:
            return {
                "session_name": session_name,
                "confirmed_endpoint": confirmed_endpoint,
                "runtime_cleaned": True,
                "stop_attempts": 0,
                "release_ms": int(round((time.monotonic() - t0) * 1000)),
                "error": None,
            }

        attempts = 0
        last_err: str | None = None
        for attempts in range(1, 4):
            proc = self.run(["stop", "-s", session_name], timeout_s=90.0, check=False)
            if proc.returncode == 0:
                break
            combined = f"{proc.stdout}\n{proc.stderr}".lower()
            if "not found" in combined or "no active sessions" in combined or "does not exist" in combined:
                break
            last_err = (proc.stderr or proc.stdout).strip()
            time.sleep(1.5 * attempts)

        after = self.list_sessions()
        still_alive = [
            s
            for s in after
            if s["name"] == session_name or s["endpoint"] == confirmed_endpoint
        ]
        cleaned = len(still_alive) == 0
        return {
            "session_name": session_name,
            "confirmed_endpoint": confirmed_endpoint,
            "runtime_cleaned": cleaned,
            "stop_attempts": attempts,
            "release_ms": int(round((time.monotonic() - t0) * 1000)),
            "error": None if cleaned else (last_err or "Owned endpoint still visible in `colab sessions`"),
        }


def snap_frames(duration_sec: float, fps: float) -> int:
    raw = max(9, round(duration_sec * fps))
    k = max(1, math.ceil((raw - 1) / 8))
    return 8 * k + 1


def make_provider_task_id(session_name: str, endpoint: str, attempt_id: str) -> str:
    return f"colab:{session_name}:{endpoint}:{attempt_id}"


def parse_provider_task_id(provider_task_id: str | None) -> tuple[str | None, str | None, str | None]:
    if not provider_task_id or not provider_task_id.startswith("colab:"):
        return None, None, None
    parts = provider_task_id.split(":", 3)
    if len(parts) != 4:
        return None, None, None
    return parts[1] or None, parts[2] or None, parts[3] or None


def sanitize_session_slug(raw: str, prefix: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", raw).strip("-").lower()
    if len(slug) > 20:
        # Keep deterministic tail + short hash so two long IDs never collide
        digest = make_idempotency_key("sess", {"id": raw}).split(":")[-1][:6]
        slug = f"{slug[-12:]}-{digest}"
    return f"{prefix}-{slug or 'job'}"


def resolve_web_driver_and_ledger(args: argparse.Namespace) -> tuple[pathlib.Path, TaskLedger, ColabCliDriver]:
    state_root = (
        pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    )
    state_root.mkdir(parents=True, exist_ok=True)
    db_path = state_root / "tasks.db"
    ensure_batch_schema(db_path)
    ledger = TaskLedger(db_path)
    cfg_path = args.colab_config or str(state_root / "colab-sessions.json")
    driver = ColabCliDriver(
        colab_bin=args.colab_bin,
        auth_mode=args.colab_auth,
        config_path=cfg_path,
    )
    return state_root, ledger, driver


def precheck_colab_ready(
    driver: ColabCliDriver,
    *,
    hf_token: str,
    mount_drive: bool,
) -> dict[str, Any]:
    """Zero-CU preflight check before attempting any GPU allocation."""
    if not driver.binary_exists():
        return {
            "ready": False,
            "error_code": "COLAB_CLI_MISSING",
            "message": "未检测到 `colab` CLI 可执行文件（请安装 google-colab-cli）。",
        }
    if not hf_token and not mount_drive:
        return {
            "ready": False,
            "error_code": "HF_TOKEN_MISSING",
            "message": "缺少 Hugging Face 读取令牌（HF_TOKEN），且未启用已缓存的 Google Drive 权重目录。",
        }
    try:
        sessions = driver.list_sessions()
    except ColabCommandError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        return {
            "ready": False,
            "error_code": "COLAB_AUTH_UNAVAILABLE",
            "message": f"Colab CLI 未授权或连接失败：{detail[:400]}",
        }
    usage_before = driver.query_usage_cu()
    return {
        "ready": True,
        "active_sessions_count": len(sessions),
        "usage_before_cu": usage_before,
    }


def reconcile_interrupted_allocation(
    driver: ColabCliDriver,
    ledger: TaskLedger,
    task: dict[str, Any],
) -> dict[str, Any]:
    """If a process crashed during `colab new`, inspect isolated `colab-sessions.json` once.

    NEVER adopts `[?]` sessions and NEVER calls `colab new` again for this attempt.
    """
    meta = dict(task.get("external_meta") or {})
    if meta.get("confirmed_endpoint"):
        return task
    session_name = str(meta.get("session_name") or "")
    if not session_name or session_name == "?":
        return task

    local_entry = driver.local_store_entry(session_name)
    live_info = driver.owned_session_info(session_name)
    confirmed_ep = None
    confirmed_hw = meta.get("gpu")
    if local_entry and local_entry.get("endpoint"):
        confirmed_ep = str(local_entry["endpoint"])
        confirmed_hw = str(local_entry.get("accelerator") or confirmed_hw or "T4")
    elif live_info and live_info.get("endpoint"):
        confirmed_ep = str(live_info["endpoint"])
        confirmed_hw = str(live_info.get("hw") or confirmed_hw or "T4")

    if confirmed_ep:
        provider_tid = make_provider_task_id(session_name, confirmed_ep, task["task_id"])
        return ledger.update(
            task["task_id"],
            status="submitted" if meta.get("job_launched") else "allocated_unlaunched",
            external_id=provider_tid,
            meta_patch={
                "confirmed_endpoint": confirmed_ep,
                "gpu": confirmed_hw,
                "reconciled_from_local_store": True,
            },
        )

    return ledger.update(
        task["task_id"],
        status="allocation_unconfirmed",
        meta_patch={"allocation_reconciled_at": utc_now_iso()},
        error=(
            "Colab GPU 分配在收到确认回执前中断，隔离会话库中无该任务的已确认实例；"
            "按零重复分配与严格归属策略不重发分配，也不接管匿名会话。"
        ),
    )


def build_usage_summary(
    task: dict[str, Any],
    *,
    facts: dict[str, Any] | None = None,
    remote_meta: dict[str, Any] | None = None,
    release_ms: int | None = None,
    observed_delta: float | None = None,
) -> dict[str, Any]:
    meta = task.get("external_meta") or {}
    rmeta = remote_meta if remote_meta is not None else (meta.get("remote_meta") or {})
    mfacts = facts if facts is not None else (meta.get("media_facts") or {})
    gpu_code = str(meta.get("gpu") or "T4").upper()
    gpu_name = str(rmeta.get("gpu_name") or meta.get("gpu_name") or gpu_code)
    stage_raw = dict(rmeta.get("stage_timings_ms") or meta.get("stage_timings_ms") or {})
    alloc_ms = int(meta.get("queue_alloc_ms") or 0)
    dl_ms = int(meta.get("download_ms") or 0)
    rel_ms = int(release_ms if release_ms is not None else (meta.get("release_ms") or 0))

    stage_timings = {
        "queueAllocMs": max(0, alloc_ms),
        "envSetupMs": max(0, int(stage_raw.get("envSetupMs") or 0)),
        "weightFetchMs": max(0, int(stage_raw.get("weightFetchMs") or 0)),
        "modelLoadMs": max(0, int(stage_raw.get("modelLoadMs") or 0)),
        "inferenceMs": max(0, int(stage_raw.get("inferenceMs") or 0)),
        "encodeTransferMs": max(0, int(stage_raw.get("encodeTransferMs") or 0) + dl_ms),
        "releaseMs": max(0, rel_ms),
    }

    cache_source = str(
        meta.get("cache_source")
        or rmeta.get("cache_source")
        or ("ephemeral_download")
    )
    if cache_source == "sample_replay":
        est_cu = 0.0
    else:
        total_active_ms = (
            stage_timings["queueAllocMs"]
            + stage_timings["envSetupMs"]
            + stage_timings["weightFetchMs"]
            + stage_timings["modelLoadMs"]
            + stage_timings["inferenceMs"]
            + stage_timings["encodeTransferMs"]
            + stage_timings["releaseMs"]
        )
        rate = CU_RATES_PER_HOUR.get(gpu_code, 4.20)
        est_cu = round((total_active_ms / 3_600_000.0) * rate, 4)

    usage: dict[str, Any] = {
        "externalUnit": "colab_cu",
        "estimatedExternalAmount": est_cu,
        "accelerator": gpu_name,
        "modelRevision": str(
            rmeta.get("model_revision")
            or meta.get("model_revision")
            or "Lightricks/LTX-2.5@main"
        ),
        "cacheSource": cache_source,
        "stageTimingsMs": stage_timings,
    }
    endpoint = meta.get("confirmed_endpoint")
    if endpoint:
        usage["providerReceiptId"] = str(endpoint)
    if mfacts.get("duration_ms"):
        usage["mediaDurationMs"] = int(mfacts["duration_ms"])
    if mfacts.get("width"):
        usage["width"] = int(mfacts["width"])
    if mfacts.get("height"):
        usage["height"] = int(mfacts["height"])
    req = task.get("request") or {}
    if req.get("preset"):
        usage["resolution"] = str(req["preset"])
    obs = observed_delta if observed_delta is not None else meta.get("observed_balance_delta_cu")
    if isinstance(obs, (int, float)):
        usage["observedBalanceDelta"] = round(float(obs), 4)
    return usage


def read_batch_usage_before(db_path: pathlib.Path, batch_id: str | None) -> float | None:
    if not batch_id or not db_path.is_file():
        return None
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        row = conn.execute(
            "SELECT usage_before_cu FROM colab_batches WHERE batch_id = ?",
            (str(batch_id),),
        ).fetchone()
        if row and isinstance(row[0], (int, float)):
            return float(row[0])
    finally:
        conn.close()
    return None


def observe_delta_after_stop(
    driver: ColabCliDriver,
    *,
    runtime_cleaned: bool,
    usage_before: Any,
) -> float | None:
    if not runtime_cleaned or not isinstance(usage_before, (int, float)):
        return None
    usage_after = driver.query_usage_cu()
    if isinstance(usage_after, (int, float)):
        return round(abs(float(usage_before) - float(usage_after)), 4)
    return None


def build_partial_gpu_usage(
    task: dict[str, Any],
    *,
    release_ms: int | None = None,
    observed_delta: float | None = None,
) -> dict[str, Any] | None:
    """Build partial ProviderUsage for post-allocation failed/cancelled GPU attempts.

    Emits only proven facts (endpoint receipt, accelerator, revision, measured queue/release
    timings, and account balance delta if observed). Omits `estimatedExternalAmount` when
    remote worker execution stages were not completed so unknown GPU duration is never
    misreported as 0 CU.
    """
    meta = dict(task.get("external_meta") or {})
    endpoint = meta.get("confirmed_endpoint")
    if not endpoint or meta.get("session_name") == "sample-replay" or meta.get("sample_replay"):
        return None
    gpu_code = str(meta.get("gpu") or "T4").upper()
    gpu_name = str(meta.get("gpu_name") or gpu_code)
    alloc_ms = max(0, int(meta.get("queue_alloc_ms") or 0))
    rel_ms = max(0, int(release_ms if release_ms is not None else (meta.get("release_ms") or 0)))
    stage_timings: dict[str, int] = {
        "queueAllocMs": alloc_ms,
        "releaseMs": rel_ms,
    }
    stage_raw = meta.get("stage_timings_ms")
    if isinstance(stage_raw, dict):
        for k in ("envSetupMs", "weightFetchMs", "modelLoadMs", "inferenceMs", "encodeTransferMs"):
            if isinstance(stage_raw.get(k), (int, float)):
                stage_timings[k] = max(0, int(stage_raw[k]))

    usage: dict[str, Any] = {
        "externalUnit": "colab_cu",
        "providerReceiptId": str(endpoint),
        "accelerator": gpu_name,
        "modelRevision": str(meta.get("model_revision") or "Lightricks/LTX-2.5@main"),
        "stageTimingsMs": stage_timings,
    }
    req = task.get("request") or {}
    if req.get("preset"):
        usage["resolution"] = str(req["preset"])
    obs = observed_delta if observed_delta is not None else meta.get("observed_balance_delta_cu")
    if isinstance(obs, (int, float)):
        usage["observedBalanceDelta"] = round(float(obs), 4)
    return usage


def launch_detached_single_job(
    driver: ColabCliDriver,
    *,
    session_name: str,
    confirmed_endpoint: str,
    attempt_id: str,
    local_first_frame: pathlib.Path,
    job_config: dict[str, Any],
    mount_drive: bool,
    staging: pathlib.Path,
) -> None:
    driver.owned_session_info(session_name, expected_endpoint=confirmed_endpoint)
    if mount_drive:
        driver.run(["drivemount", "-s", session_name, "/content/drive"], timeout_s=180.0, check=True)

    remote_job_dir = str(job_config["remote_job_dir"])
    remote_worker_py = "/content/ltx25-bin/ltx25_remote_worker.py"
    prep_py = staging / "prep_single.py"
    prep_py.write_text(
        f"import os\nos.makedirs({remote_job_dir!r}, exist_ok=True)\nos.makedirs('/content/ltx25-bin', exist_ok=True)\nprint('prep_ok')\n",
        encoding="utf-8",
    )
    driver.run(["exec", "-s", session_name, "--timeout", "60", "-f", str(prep_py)], timeout_s=90.0)
    driver.run(
        ["upload", "-s", session_name, str(WORKER_SCRIPT), remote_worker_py],
        timeout_s=90.0,
        check=True,
    )
    driver.run(
        ["upload", "-s", session_name, str(local_first_frame), str(job_config["remote_first_frame"])],
        timeout_s=180.0,
        check=True,
    )

    local_cfg = staging / f"job_{attempt_id}.json"
    local_cfg.write_text(json.dumps(job_config, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(local_cfg, 0o600)
    remote_cfg = f"{remote_job_dir}/job_config.json"
    driver.run(["upload", "-s", session_name, str(local_cfg), remote_cfg], timeout_s=60.0, check=True)

    spawn_py = staging / "spawn_single.py"
    spawn_py.write_text(
        f"""import json, os, pathlib, subprocess, sys, time
job_dir = pathlib.Path({remote_job_dir!r})
status_path = job_dir / "status.json"
if status_path.is_file():
    cur = json.loads(status_path.read_text(encoding="utf-8"))
    if cur.get("state") in ("running", "succeeded"):
        print("already_launched")
        raise SystemExit(0)
log_f = (job_dir / "worker.log").open("ab")
proc = subprocess.Popen(
    [sys.executable, {remote_worker_py!r}, "--job-config", {remote_cfg!r}],
    stdin=subprocess.DEVNULL,
    stdout=log_f,
    stderr=subprocess.STDOUT,
    start_new_session=True,
)
tmp = job_dir / "status.json.tmp"
tmp.write_text(json.dumps({{"state": "running", "pid": proc.pid, "updated_at": time.time()}}), encoding="utf-8")
tmp.replace(status_path)
print(f"spawned:{{proc.pid}}")
""",
        encoding="utf-8",
    )
    driver.run(["exec", "-s", session_name, "--timeout", "60", "-f", str(spawn_py)], timeout_s=90.0)


def ensure_batch_daemon_and_enqueue(
    driver: ColabCliDriver,
    db_path: pathlib.Path,
    *,
    batch_id: str,
    total_shots: int,
    shot_seq: int,
    attempt_id: str,
    gpu_candidates: list[str],
    high_mem: bool,
    mount_drive: bool,
    cache_dir: str,
    model_revision: str,
    vae_variant: str,
    quantization: str,
    offload: str,
    hf_token: str,
    local_first_frame: pathlib.Path,
    job_config: dict[str, Any],
    usage_before_cu: float | None,
    staging: pathlib.Path,
) -> tuple[str, str, str, int, bool]:
    """Allocate or reuse a warm Colab session + in-memory daemon for `batch_id`.

    Returns `(session_name, confirmed_endpoint, gpu, queue_alloc_ms, reused_warm_batch)`.
    """
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM colab_batches WHERE batch_id = ?", (batch_id,)).fetchone()
    finally:
        conn.close()

    daemon_dir = f"/content/batch_daemons/{re.sub(r'[^a-zA-Z0-9_-]+', '_', batch_id)}"
    remote_worker_py = "/content/ltx25-bin/ltx25_remote_worker.py"

    if row and row["status"] == "active" and row["confirmed_endpoint"]:
        s_name = str(row["session_name"])
        s_ep = str(row["confirmed_endpoint"])
        s_gpu = str(row["gpu"] or gpu_candidates[0])
        live = driver.owned_session_info(s_name, expected_endpoint=s_ep)
        if live is not None:
            # Enqueue this shot onto the warm daemon!
            remote_job_dir = str(job_config["remote_job_dir"])
            prep_shot = staging / "prep_batch_shot.py"
            prep_shot.write_text(
                f"import os; os.makedirs({remote_job_dir!r}, exist_ok=True); os.makedirs({(daemon_dir + '/inbox')!r}, exist_ok=True); print('ok')\n",
                encoding="utf-8",
            )
            driver.run(["exec", "-s", s_name, "--timeout", "60", "-f", str(prep_shot)], timeout_s=90.0)
            driver.run(
                ["upload", "-s", s_name, str(local_first_frame), str(job_config["remote_first_frame"])],
                timeout_s=180.0,
                check=True,
            )
            shot_cfg = dict(job_config)
            shot_cfg.pop("hf_token", None)
            local_q = staging / f"{shot_seq:04d}_{attempt_id}.json"
            local_q.write_text(json.dumps(shot_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
            remote_q = f"{daemon_dir}/inbox/{shot_seq:04d}_{attempt_id}.json"
            driver.run(["upload", "-s", s_name, str(local_q), remote_q], timeout_s=60.0, check=True)
            # Ensure daemon process is alive (restarts warm daemon if idle timer exited)
            ensure_daemon_running_remote(
                driver,
                session_name=s_name,
                daemon_dir=daemon_dir,
                remote_worker_py=remote_worker_py,
                daemon_cfg={
                    "cache_dir": cache_dir,
                    "vae_variant": vae_variant,
                    "model_revision": model_revision,
                    "quantization": quantization,
                    "offload": offload,
                    "idle_timeout_sec": 600.0,
                    "hf_token": hf_token,
                    "mock_inference_mp4": job_config.get("mock_inference_mp4"),
                },
                staging=staging,
            )
            return s_name, s_ep, s_gpu, 0, True

    # Allocate dedicated session for this batch
    session_name = sanitize_session_slug(batch_id, "vf-batch")
    now = utc_now_iso()
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        conn.execute(
            """
            INSERT INTO colab_batches(
                batch_id, session_name, confirmed_endpoint, gpu, daemon_dir,
                model_revision, mount_drive, cache_dir, status, total_shots,
                completed_shots, usage_before_cu, alloc_ms, created_at, updated_at
            ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 'allocating', ?, 0, ?, 0, ?, ?)
            ON CONFLICT(batch_id) DO UPDATE SET
                session_name = excluded.session_name,
                confirmed_endpoint = NULL,
                status = 'allocating',
                total_shots = excluded.total_shots,
                updated_at = excluded.updated_at
            """,
            (
                batch_id,
                session_name,
                daemon_dir,
                model_revision,
                1 if mount_drive else 0,
                cache_dir,
                max(1, total_shots),
                usage_before_cu,
                now,
                now,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    t_alloc = time.monotonic()
    allocated_gpu, confirmed_ep = allocate_owned_session(
        driver, session_name=session_name, gpu_candidates=gpu_candidates, high_mem=high_mem
    )
    alloc_ms = int(round((time.monotonic() - t_alloc) * 1000))

    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        conn.execute(
            """
            UPDATE colab_batches
            SET confirmed_endpoint = ?, gpu = ?, status = 'active', alloc_ms = ?, updated_at = ?
            WHERE batch_id = ?
            """,
            (confirmed_ep, allocated_gpu, alloc_ms, utc_now_iso(), batch_id),
        )
        conn.commit()
    finally:
        conn.close()

    if mount_drive:
        driver.run(["drivemount", "-s", session_name, "/content/drive"], timeout_s=180.0, check=True)

    remote_job_dir = str(job_config["remote_job_dir"])
    init_py = staging / "init_batch.py"
    init_py.write_text(
        f"import os\nfor d in ['/content/ltx25-bin', {daemon_dir!r}, {(daemon_dir + '/inbox')!r}, {remote_job_dir!r}]:\n    os.makedirs(d, exist_ok=True)\nprint('batch_dirs_ready')\n",
        encoding="utf-8",
    )
    driver.run(["exec", "-s", session_name, "--timeout", "60", "-f", str(init_py)], timeout_s=90.0)
    driver.run(
        ["upload", "-s", session_name, str(WORKER_SCRIPT), remote_worker_py],
        timeout_s=90.0,
        check=True,
    )
    driver.run(
        ["upload", "-s", session_name, str(local_first_frame), str(job_config["remote_first_frame"])],
        timeout_s=180.0,
        check=True,
    )
    shot_cfg = dict(job_config)
    shot_cfg.pop("hf_token", None)
    local_q = staging / f"{shot_seq:04d}_{attempt_id}.json"
    local_q.write_text(json.dumps(shot_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    remote_q = f"{daemon_dir}/inbox/{shot_seq:04d}_{attempt_id}.json"
    driver.run(["upload", "-s", session_name, str(local_q), remote_q], timeout_s=60.0, check=True)

    ensure_daemon_running_remote(
        driver,
        session_name=session_name,
        daemon_dir=daemon_dir,
        remote_worker_py=remote_worker_py,
        daemon_cfg={
            "cache_dir": cache_dir,
            "vae_variant": vae_variant,
            "model_revision": model_revision,
            "quantization": quantization,
            "offload": offload,
            "idle_timeout_sec": 600.0,
            "hf_token": hf_token,
            "mock_inference_mp4": job_config.get("mock_inference_mp4"),
        },
        staging=staging,
    )
    return session_name, confirmed_ep, allocated_gpu, alloc_ms, False


def ensure_daemon_running_remote(
    driver: ColabCliDriver,
    *,
    session_name: str,
    daemon_dir: str,
    remote_worker_py: str,
    daemon_cfg: dict[str, Any],
    staging: pathlib.Path,
) -> None:
    local_dcfg = staging / "daemon_config.json"
    local_dcfg.write_text(json.dumps(daemon_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(local_dcfg, 0o600)
    driver.run(
        ["upload", "-s", session_name, str(local_dcfg), f"{daemon_dir}/daemon_config.json"],
        timeout_s=60.0,
        check=True,
    )
    boot_py = staging / "boot_daemon.py"
    boot_py.write_text(
        f"""import json, os, pathlib, subprocess, sys
ddir = pathlib.Path({daemon_dir!r})
st_file = ddir / "daemon_state.json"
if st_file.is_file():
    try:
        st = json.loads(st_file.read_text(encoding="utf-8"))
        pid = int(st.get("pid") or 0)
        if pid > 0 and st.get("state") in ("starting", "ready", "busy"):
            os.kill(pid, 0)
            print(f"daemon_alive:{{pid}}")
            raise SystemExit(0)
    except (OSError, ValueError):
        pass
(ddir / "STOP").unlink(missing_ok=True)
log_f = (ddir / "daemon.log").open("ab")
proc = subprocess.Popen(
    [sys.executable, {remote_worker_py!r}, "--batch-daemon", str(ddir)],
    stdin=subprocess.DEVNULL,
    stdout=log_f,
    stderr=subprocess.STDOUT,
    start_new_session=True,
)
print(f"daemon_spawned:{{proc.pid}}")
""",
        encoding="utf-8",
    )
    driver.run(["exec", "-s", session_name, "--timeout", "60", "-f", str(boot_py)], timeout_s=90.0)


def release_batch_if_owned(
    driver: ColabCliDriver,
    db_path: pathlib.Path,
    batch_id: str,
) -> dict[str, Any]:
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM colab_batches WHERE batch_id = ?", (batch_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return {"batch_id": batch_id, "released": False, "reason": "not_found", "release_ms": 0}
    s_name = row["session_name"]
    s_ep = row["confirmed_endpoint"]
    if not s_ep:
        local_entry = driver.local_store_entry(s_name)
        if local_entry and local_entry.get("endpoint"):
            s_ep = str(local_entry["endpoint"])
    if not s_ep:
        conn = sqlite3.connect(str(db_path), timeout=30.0)
        try:
            conn.execute(
                "UPDATE colab_batches SET status = 'allocation_unconfirmed', updated_at = ? WHERE batch_id = ?",
                (utc_now_iso(), batch_id),
            )
            conn.commit()
        finally:
            conn.close()
        return {"batch_id": batch_id, "released": False, "reason": "unconfirmed_endpoint", "release_ms": 0}

    stop_res = driver.stop_owned_session(s_name, s_ep)
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        conn.execute(
            "UPDATE colab_batches SET status = ?, updated_at = ? WHERE batch_id = ?",
            ("released" if stop_res["runtime_cleaned"] else "release_failed", utc_now_iso(), batch_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"batch_id": batch_id, "released": stop_res["runtime_cleaned"], **stop_res}


def allocate_owned_session(
    driver: ColabCliDriver,
    *,
    session_name: str,
    gpu_candidates: list[str],
    high_mem: bool,
) -> tuple[str, str]:
    """Allocate a fresh session named `session_name` and return `(gpu, confirmed_endpoint)`.

    NEVER adopts `[?]` endpoints. If `colab new` fails on a candidate pool without writing a
    confirmed session for `session_name`, tries the next candidate pool; if `colab_cli` DID
    write `session_name` to `colab-sessions.json`, binds and returns that exact endpoint.
    """
    alloc_errors: list[str] = []
    for cand_gpu in gpu_candidates:
        new_args = ["new", "-s", session_name, "--gpu", cand_gpu]
        if high_mem and cand_gpu not in ("L4",):
            new_args.append("--high-mem")
        try:
            driver.run(
                new_args,
                timeout_s=420.0,
                check=True,
                extra_env={
                    "COLAB_CLI_REQUEST_TIMEOUT": "120",
                    "COLAB_CLI_ASSIGN_RETRIES": "2",
                    "COLAB_CLI_RETRY_BACKOFF": "10",
                },
            )
        except ColabCommandError as exc:
            # Check ONLY our isolated local store for exact `session_name` (never `[?]`)
            local_entry = driver.local_store_entry(session_name)
            if local_entry and local_entry.get("endpoint"):
                ep = str(local_entry["endpoint"])
                hw = str(local_entry.get("accelerator") or cand_gpu).upper()
                return hw, ep
            alloc_errors.append(f"{cand_gpu}: {exc}")
            combined_msg = f"{exc.stdout}\n{exc.stderr}".lower()
            provable_refusal = (
                not exc.timed_out
                and exc.returncode != 124
                and (
                    "rejected accelerator" in combined_msg
                    or "allocation refused (precondition failed)" in combined_msg
                )
            )
            # Only fail over to another GPU pool when backend explicitly refused allocation (HTTP 400/412).
            # On timeouts, network drops, or exit 124, stop immediately to guarantee zero double-allocation!
            if not provable_refusal:
                raise ColabCommandError(
                    exc.cmd,
                    exc.returncode,
                    exc.stdout,
                    exc.stderr,
                    timed_out=exc.timed_out or exc.returncode == 124 or "timeout" in combined_msg,
                ) from exc
            continue

        info = driver.owned_session_info(session_name)
        local_entry = driver.local_store_entry(session_name)
        endpoint = (info or {}).get("endpoint") or (local_entry or {}).get("endpoint")
        if not endpoint:
            raise ColabOwnershipError(
                f"`colab new -s {session_name}` exited 0 but no confirmed endpoint was recorded."
            )
        hw = str((info or {}).get("hw") or (local_entry or {}).get("accelerator") or cand_gpu).upper()
        return hw, str(endpoint)

    raise RuntimeError(
        f"Unable to allocate Colab GPU for {session_name!r} from {gpu_candidates}: "
        + " | ".join(alloc_errors)
    )


# --- Web Native Lifecycle Commands (`submit`, `query`, `cancel`, `release-batch`, `preflight`) ---


def cmd_preflight(args: argparse.Namespace) -> dict[str, Any]:
    _, _, driver = resolve_web_driver_and_ledger(args)
    hf_token = read_hf_token_secure(args)
    return precheck_colab_ready(driver, hf_token=hf_token, mount_drive=bool(args.mount_drive))


def cmd_submit(args: argparse.Namespace) -> dict[str, Any]:
    state_root, ledger, driver = resolve_web_driver_and_ledger(args)
    db_path = state_root / "tasks.db"

    preset_cfg = PRESETS[args.preset]
    dims = preset_cfg[args.aspect]
    primary_gpu = (args.gpu or preset_cfg["default_gpu"]).upper()
    gpu_candidates = [primary_gpu]
    if args.gpu_fallbacks:
        for cand in args.gpu_fallbacks.split(","):
            c = cand.strip().upper()
            if c and c not in gpu_candidates:
                gpu_candidates.append(c)
    num_frames = snap_frames(args.duration_sec, args.fps)

    first_frame_path = pathlib.Path(args.first_frame).expanduser().resolve()
    verify_media_file(first_frame_path, "image")
    first_frame_sha = sha256_file(first_frame_path)

    attempt_id = args.attempt_id.strip()
    request_identity = (args.request_identity or attempt_id).strip()
    out_dir = (
        pathlib.Path(args.out_dir).expanduser().resolve()
        if args.out_dir
        else (state_root / "outputs" / "colab-ltx")
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    final_local_mp4 = out_dir / f"{attempt_id}.mp4"

    request_spec = {
        "attempt_id": attempt_id,
        "request_identity": request_identity,
        "run_id": args.run_id,
        "batch_id": args.batch_id,
        "batch_total_shots": args.batch_total_shots,
        "shot_seq": args.shot_seq,
        "model": "Lightricks/LTX-2.5-distilled",
        "model_revision": args.model_revision,
        "prompt": args.prompt.strip(),
        "first_frame_sha256": first_frame_sha,
        "preset": args.preset,
        "aspect": args.aspect,
        "duration_sec": args.duration_sec,
        "num_frames": num_frames,
        "fps": args.fps,
        "seed": args.seed,
        "mute_audio": bool(args.mute_audio),
    }

    session_name = (
        sanitize_session_slug(args.batch_id, "vf-batch")
        if (args.batch_id and args.batch_total_shots > 1)
        else sanitize_session_slug(attempt_id, "vf-att")
    )
    remote_job_dir = f"/content/jobs/{attempt_id}"
    remote_first_frame = f"{remote_job_dir}/first_frame{first_frame_path.suffix.lower()}"

    task, created = ledger.create_or_get(
        task_id=attempt_id,
        kind="colab_ltx_web",
        idempotency_key=request_identity,
        request=request_spec,
        external_meta={
            "session_name": session_name,
            "confirmed_endpoint": None,
            "remote_job_dir": remote_job_dir,
            "batch_id": args.batch_id if (args.batch_id and args.batch_total_shots > 1) else None,
            "batch_total_shots": args.batch_total_shots,
            "model_revision": f"Lightricks/LTX-2.5@{args.model_revision}",
            "runtime_cleaned": False,
        },
    )

    # Idempotent replay / recovery if `submit` was already called for this `attempt_id`
    if not created:
        status = task["status"]
        existing_meta = dict(task.get("external_meta") or {})
        if status == "downloaded" and final_local_mp4.is_file():
            facts = verify_media_file(final_local_mp4, "video")
            is_sample = bool(
                existing_meta.get("cache_source") == "sample_replay"
                or existing_meta.get("sample_replay")
            )
            return {
                "ok": True,
                "state": "succeeded",
                "sampleReplay": is_sample,
                "attemptId": attempt_id,
                "providerTaskId": task.get("external_id")
                or f"colab:{session_name}:local:{attempt_id}",
                "outputMp4Path": str(final_local_mp4),
                "mediaFacts": facts,
                "usage": build_usage_summary(task, facts=facts),
            }
        if status == "allocating":
            task = reconcile_interrupted_allocation(driver, ledger, task)
            status = task["status"]
            existing_meta = dict(task.get("external_meta") or {})
        if status == "allocation_unconfirmed":
            return {
                "ok": True,
                "state": "unknown",
                "attemptId": attempt_id,
                "providerTaskId": task.get("external_id"),
                "stableUnknown": True,
                "message": task.get("error") or "Colab GPU allocation outcome unconfirmed.",
            }
        if status == "submitted":
            return {
                "ok": True,
                "state": "running",
                "attemptId": attempt_id,
                "providerTaskId": task.get("external_id"),
            }
        if status == "precheck_failed":
            return {
                "ok": False,
                "state": "failed",
                "preSubmitRefusal": True,
                "attemptId": attempt_id,
                "errorCode": existing_meta.get("error_code") or "PRECHECK_FAILED",
                "message": task.get("error") or "Colab precheck failed.",
            }
        if status in ("failed", "cancelled"):
            partial_usage = build_partial_gpu_usage(task)
            return {
                "ok": False,
                "state": "cancelled" if status == "cancelled" else "failed",
                "preSubmitRefusal": bool(existing_meta.get("pre_submit_refusal")),
                "notAllocated": bool(existing_meta.get("not_allocated")),
                "sampleReplay": bool(
                    existing_meta.get("sample_replay")
                    or existing_meta.get("session_name") == "sample-replay"
                ),
                "attemptId": attempt_id,
                "providerTaskId": task.get("external_id"),
                "message": task.get("error") or f"Attempt already {status}.",
                **({"usage": partial_usage} if partial_usage else {}),
            }

    # Test-only zero-quota sample clip replay (NEVER used unless `--replay-sample-mp4` is explicitly passed)
    if args.replay_sample_mp4:
        sample_path = pathlib.Path(args.replay_sample_mp4).expanduser().resolve()
        facts = verify_media_file(sample_path, "video")
        shutil.copyfile(sample_path, final_local_mp4)
        facts = verify_media_file(final_local_mp4, "video")
        provider_tid = make_provider_task_id("sample-replay", "zero-cu-sample", attempt_id)
        task = ledger.update(
            attempt_id,
            status="downloaded",
            external_id=provider_tid,
            local_file=final_local_mp4,
            file_sha256=facts["sha256"],
            meta_patch={
                "session_name": "sample-replay",
                "confirmed_endpoint": "zero-cu-sample",
                "sample_replay": True,
                "gpu": "T4",
                "gpu_name": "Tesla T4 (Sample Replay)",
                "cache_source": "sample_replay",
                "queue_alloc_ms": 0,
                "download_ms": 0,
                "release_ms": 0,
                "runtime_cleaned": True,
                "media_facts": facts,
                "remote_meta": {
                    "gpu_name": "Tesla T4",
                    "model_revision": f"Lightricks/LTX-2.5@{args.model_revision}",
                    "cache_source": "sample_replay",
                    "stage_timings_ms": {
                        "envSetupMs": 0,
                        "weightFetchMs": 0,
                        "modelLoadMs": 0,
                        "inferenceMs": 0,
                        "encodeTransferMs": 0,
                    },
                },
            },
            error=None,
        )
        return {
            "ok": True,
            "state": "running",
            "sampleReplay": True,
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
        }

    # Real runtime preflight BEFORE touching Colab quota (0 CU on refusal)
    hf_token = read_hf_token_secure(args)
    precheck = precheck_colab_ready(driver, hf_token=hf_token, mount_drive=bool(args.mount_drive))
    if not precheck["ready"]:
        ledger.update(
            attempt_id,
            status="precheck_failed",
            meta_patch={
                "error_code": precheck["error_code"],
                "pre_submit_refusal": True,
                "runtime_cleaned": True,
            },
            error=precheck["message"],
        )
        return {
            "ok": False,
            "state": "failed",
            "preSubmitRefusal": True,
            "attemptId": attempt_id,
            "errorCode": precheck["error_code"],
            "message": precheck["message"],
        }

    cache_dir = args.drive_cache_dir if args.mount_drive else "/content/models/ltx-2.5"
    job_config: dict[str, Any] = {
        "task_id": attempt_id,
        "backend": args.backend,
        "model_revision": args.model_revision,
        "remote_job_dir": remote_job_dir,
        "remote_first_frame": remote_first_frame,
        "prompt": args.prompt.strip(),
        "gen_width": dims["gen_w"],
        "gen_height": dims["gen_h"],
        "target_width": dims["out_w"],
        "target_height": dims["out_h"],
        "exact_16_9_crop": not args.no_exact_crop,
        "duration_sec": args.duration_sec,
        "num_frames": num_frames,
        "fps": args.fps,
        "seed": args.seed,
        "mute_audio": bool(args.mute_audio),
        "cache_dir": cache_dir,
        "vae_variant": args.vae_variant,
        "quantization": args.quantization,
        "offload": args.offload,
        "enhance_prompt": bool(args.enhance_prompt),
        "hf_token": hf_token,
    }
    if args.mock_remote_mp4:
        job_config["mock_inference_mp4"] = args.mock_remote_mp4

    # Persist `allocating` BEFORE calling `colab new`!
    ledger.update(
        attempt_id,
        status="allocating",
        meta_patch={
            "session_name": session_name,
            "allocation_started_at": utc_now_iso(),
            "usage_before_cu": precheck.get("usage_before_cu"),
            "job_launched": False,
        },
    )

    with tempfile.TemporaryDirectory(prefix="colab-submit-") as staging_str:
        staging = pathlib.Path(staging_str)
        try:
            if args.batch_id and args.batch_total_shots > 1:
                s_name, confirmed_ep, allocated_gpu, alloc_ms, reused_batch = (
                    ensure_batch_daemon_and_enqueue(
                        driver,
                        db_path,
                        batch_id=args.batch_id,
                        total_shots=args.batch_total_shots,
                        shot_seq=args.shot_seq,
                        attempt_id=attempt_id,
                        gpu_candidates=gpu_candidates,
                        high_mem=bool(args.high_mem),
                        mount_drive=bool(args.mount_drive),
                        cache_dir=cache_dir,
                        model_revision=args.model_revision,
                        vae_variant=args.vae_variant,
                        quantization=args.quantization,
                        offload=args.offload,
                        hf_token=hf_token,
                        local_first_frame=first_frame_path,
                        job_config=job_config,
                        usage_before_cu=precheck.get("usage_before_cu"),
                        staging=staging,
                    )
                )
                provider_tid = make_provider_task_id(s_name, confirmed_ep, attempt_id)
                ledger.update(
                    attempt_id,
                    status="submitted",
                    external_id=provider_tid,
                    meta_patch={
                        "session_name": s_name,
                        "confirmed_endpoint": confirmed_ep,
                        "gpu": allocated_gpu,
                        "queue_alloc_ms": alloc_ms,
                        "reused_warm_batch": reused_batch,
                        "job_launched": True,
                        "runtime_cleaned": False,
                    },
                    error=None,
                )
                return {
                    "ok": True,
                    "state": "running",
                    "attemptId": attempt_id,
                    "providerTaskId": provider_tid,
                    "accelerator": allocated_gpu,
                    "warmBatchReused": reused_batch,
                }

            # Single-shot dedicated session
            existing_ep = (ledger.get(attempt_id) or {}).get("external_meta", {}).get("confirmed_endpoint")
            if existing_ep:
                allocated_gpu = primary_gpu
                confirmed_ep = str(existing_ep)
                alloc_ms = 0
            else:
                t_alloc = time.monotonic()
                allocated_gpu, confirmed_ep = allocate_owned_session(
                    driver,
                    session_name=session_name,
                    gpu_candidates=gpu_candidates,
                    high_mem=bool(args.high_mem),
                )
                alloc_ms = int(round((time.monotonic() - t_alloc) * 1000))

            provider_tid = make_provider_task_id(session_name, confirmed_ep, attempt_id)
            ledger.update(
                attempt_id,
                status="allocated_unlaunched",
                external_id=provider_tid,
                meta_patch={
                    "session_name": session_name,
                    "confirmed_endpoint": confirmed_ep,
                    "gpu": allocated_gpu,
                    "queue_alloc_ms": alloc_ms,
                    "runtime_cleaned": False,
                },
            )

            try:
                launch_detached_single_job(
                    driver,
                    session_name=session_name,
                    confirmed_endpoint=confirmed_ep,
                    attempt_id=attempt_id,
                    local_first_frame=first_frame_path,
                    job_config=job_config,
                    mount_drive=bool(args.mount_drive),
                    staging=staging,
                )
            except BaseException as launch_exc:
                stop_res = driver.stop_owned_session(session_name, confirmed_ep)
                obs_delta = observe_delta_after_stop(
                    driver,
                    runtime_cleaned=bool(stop_res.get("runtime_cleaned")),
                    usage_before=precheck.get("usage_before_cu"),
                )
                updated_fail = ledger.update(
                    attempt_id,
                    status="failed",
                    meta_patch={**stop_res, "observed_balance_delta_cu": obs_delta},
                    error=f"Remote worker launch failed: {launch_exc}",
                )
                partial_usage = build_partial_gpu_usage(
                    updated_fail,
                    release_ms=int(stop_res.get("release_ms") or 0),
                    observed_delta=obs_delta,
                )
                return {
                    "ok": False,
                    "state": "failed",
                    "preSubmitRefusal": False,
                    "attemptId": attempt_id,
                    "providerTaskId": provider_tid,
                    "message": f"Colab 远端作业启动失败并已释放本单 GPU：{launch_exc}",
                    **({"usage": partial_usage} if partial_usage else {}),
                }

            ledger.update(
                attempt_id,
                status="submitted",
                external_id=provider_tid,
                meta_patch={"job_launched": True},
                error=None,
            )
            return {
                "ok": True,
                "state": "running",
                "attemptId": attempt_id,
                "providerTaskId": provider_tid,
                "accelerator": allocated_gpu,
            }
        except ColabCommandError as exc:
            reconciled = reconcile_interrupted_allocation(
                driver, ledger, ledger.get(attempt_id) or task
            )
            combined_msg = f"{exc.stdout}\n{exc.stderr}".lower()
            synchronous_refusal = (
                not exc.timed_out
                and exc.returncode != 124
                and (
                    "rejected accelerator" in combined_msg
                    or "allocation refused (precondition failed)" in combined_msg
                )
            )
            if reconciled["status"] == "allocation_unconfirmed" and not synchronous_refusal:
                return {
                    "ok": True,
                    "state": "unknown",
                    "attemptId": attempt_id,
                    "stableUnknown": True,
                    "message": reconciled.get("error") or str(exc),
                }
            ep = (reconciled.get("external_meta") or {}).get("confirmed_endpoint")
            if ep:
                stop_res = driver.stop_owned_session(session_name, str(ep))
                obs_delta = observe_delta_after_stop(
                    driver,
                    runtime_cleaned=bool(stop_res.get("runtime_cleaned")),
                    usage_before=precheck.get("usage_before_cu"),
                )
                updated_fail = ledger.update(
                    attempt_id,
                    status="failed",
                    meta_patch={**stop_res, "observed_balance_delta_cu": obs_delta},
                    error=str(exc),
                )
                partial_usage = build_partial_gpu_usage(
                    updated_fail,
                    release_ms=int(stop_res.get("release_ms") or 0),
                    observed_delta=obs_delta,
                )
                return {
                    "ok": False,
                    "state": "failed",
                    "preSubmitRefusal": False,
                    "attemptId": attempt_id,
                    "providerTaskId": reconciled.get("external_id"),
                    "message": str(exc),
                    **({"usage": partial_usage} if partial_usage else {}),
                }
            ledger.update(
                attempt_id,
                status="failed",
                meta_patch={"runtime_cleaned": True, "pre_submit_refusal": True},
                error=str(exc),
            )
            return {
                "ok": False,
                "state": "failed",
                "preSubmitRefusal": True,
                "attemptId": attempt_id,
                "message": str(exc),
            }
        except BaseException as exc:
            cur = ledger.get(attempt_id) or {}
            ep = (cur.get("external_meta") or {}).get("confirmed_endpoint")
            if ep:
                stop_res = driver.stop_owned_session(session_name, str(ep))
                obs_delta = observe_delta_after_stop(
                    driver,
                    runtime_cleaned=bool(stop_res.get("runtime_cleaned")),
                    usage_before=precheck.get("usage_before_cu"),
                )
                updated_fail = ledger.update(
                    attempt_id,
                    status="failed",
                    meta_patch={**stop_res, "observed_balance_delta_cu": obs_delta},
                    error=str(exc),
                )
                partial_usage = build_partial_gpu_usage(
                    updated_fail,
                    release_ms=int(stop_res.get("release_ms") or 0),
                    observed_delta=obs_delta,
                )
                return {
                    "ok": False,
                    "state": "failed",
                    "preSubmitRefusal": False,
                    "attemptId": attempt_id,
                    "providerTaskId": cur.get("external_id"),
                    "message": f"{type(exc).__name__}: {exc}",
                    **({"usage": partial_usage} if partial_usage else {}),
                }
            # No confirmed endpoint: check whether backend refused all candidate pools synchronously
            err_text = str(exc).lower()
            if "rejected accelerator" in err_text or "allocation refused" in err_text:
                ledger.update(
                    attempt_id,
                    status="failed",
                    meta_patch={"runtime_cleaned": True, "pre_submit_refusal": True},
                    error=str(exc),
                )
                return {
                    "ok": False,
                    "state": "failed",
                    "preSubmitRefusal": True,
                    "attemptId": attempt_id,
                    "message": f"{type(exc).__name__}: {exc}",
                }
            reconciled = reconcile_interrupted_allocation(driver, ledger, cur or task)
            return {
                "ok": True,
                "state": "unknown",
                "attemptId": attempt_id,
                "stableUnknown": True,
                "message": reconciled.get("error") or f"{type(exc).__name__}: {exc}",
            }


def cmd_query(args: argparse.Namespace) -> dict[str, Any]:
    state_root, ledger, driver = resolve_web_driver_and_ledger(args)
    db_path = state_root / "tasks.db"
    attempt_id = args.attempt_id.strip()
    out_dir = (
        pathlib.Path(args.out_dir).expanduser().resolve()
        if args.out_dir
        else (state_root / "outputs" / "colab-ltx")
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    final_local_mp4 = out_dir / f"{attempt_id}.mp4"

    task = ledger.get(attempt_id)
    if not task and args.request_identity:
        task = ledger.get_by_key(args.request_identity)
    if not task:
        return {
            "ok": True,
            "state": "unknown",
            "attemptId": attempt_id,
            "stableUnknown": True,
            "message": f"本地 Colab 执行账本中不存在 attempt {attempt_id}；不猜测接管任何远端实例。",
        }

    if task["status"] == "allocating":
        task = reconcile_interrupted_allocation(driver, ledger, task)

    status = task["status"]
    meta = dict(task.get("external_meta") or {})
    provider_tid = task.get("external_id") or args.provider_task_id

    if status == "downloaded":
        local_f = pathlib.Path(task["local_file"]) if task.get("local_file") else final_local_mp4
        if local_f.is_file():
            facts = verify_media_file(local_f, "video")
            is_sample = bool(
                meta.get("cache_source") == "sample_replay" or meta.get("sample_replay")
            )
            rel_ms = int(meta.get("release_ms") or 0)
            obs_delta: float | None = None
            if args.release_policy == "release_now" and meta.get("batch_id") and not meta.get("runtime_cleaned"):
                b_before = read_batch_usage_before(db_path, str(meta["batch_id"]))
                b_res = release_batch_if_owned(driver, db_path, str(meta["batch_id"]))
                rel_ms = int(b_res.get("release_ms") or 0)
                obs_delta = observe_delta_after_stop(
                    driver,
                    runtime_cleaned=bool(b_res.get("released")),
                    usage_before=b_before if b_before is not None else meta.get("usage_before_cu"),
                )
                task = ledger.update(
                    attempt_id,
                    meta_patch={
                        "runtime_cleaned": bool(b_res.get("released")),
                        "release_ms": rel_ms,
                        **({"observed_balance_delta_cu": obs_delta} if obs_delta is not None else {}),
                    },
                )
            return {
                "ok": True,
                "state": "succeeded",
                "sampleReplay": is_sample,
                "attemptId": attempt_id,
                "providerTaskId": provider_tid,
                "outputMp4Path": str(local_f),
                "mediaFacts": facts,
                "usage": build_usage_summary(
                    task, facts=facts, release_ms=rel_ms, observed_delta=obs_delta
                ),
            }

    if status == "allocation_unconfirmed":
        return {
            "ok": True,
            "state": "unknown",
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "stableUnknown": True,
            "message": task.get("error") or "Colab GPU 分配状态未确认。",
        }

    if status == "allocated_unlaunched":
        s_name = str(meta.get("session_name") or "")
        s_ep = str(meta.get("confirmed_endpoint") or "")
        partial_usage = None
        if s_name and s_ep:
            stop_res = driver.stop_owned_session(s_name, s_ep)
            obs_delta = observe_delta_after_stop(
                driver,
                runtime_cleaned=bool(stop_res.get("runtime_cleaned")),
                usage_before=meta.get("usage_before_cu"),
            )
            updated_fail = ledger.update(
                attempt_id,
                status="failed",
                meta_patch={**stop_res, "observed_balance_delta_cu": obs_delta},
                error="进程在分配 GPU 后、上传作业前中断；已安全释放该实例。",
            )
            partial_usage = build_partial_gpu_usage(
                updated_fail,
                release_ms=int(stop_res.get("release_ms") or 0),
                observed_delta=obs_delta,
            )
        return {
            "ok": False,
            "state": "failed",
            "preSubmitRefusal": False,
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "message": "进程在分配 GPU 后、启动生成前中断；已安全释放本单 GPU。",
            **({"usage": partial_usage} if partial_usage else {}),
        }

    if status in ("failed", "precheck_failed"):
        partial_usage = build_partial_gpu_usage(task)
        return {
            "ok": False,
            "state": "failed",
            "preSubmitRefusal": bool(
                status == "precheck_failed" or meta.get("pre_submit_refusal")
            ),
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "message": task.get("error") or "Colab 视频生成失败。",
            **({"usage": partial_usage} if partial_usage else {}),
        }

    if status == "cancelled":
        partial_usage = build_partial_gpu_usage(task)
        return {
            "ok": True,
            "state": "cancelled",
            "notAllocated": bool(meta.get("not_allocated")),
            "sampleReplay": bool(
                meta.get("sample_replay") or meta.get("session_name") == "sample-replay"
            ),
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "message": task.get("error") or "已取消并释放本单 Colab GPU。",
            **({"usage": partial_usage} if partial_usage else {}),
        }

    s_name = str(meta.get("session_name") or "")
    s_ep = str(meta.get("confirmed_endpoint") or "")
    parsed_s, parsed_ep, _ = parse_provider_task_id(provider_tid)
    s_name = s_name or (parsed_s or "")
    s_ep = s_ep or (parsed_ep or "")
    remote_job_dir = str(meta.get("remote_job_dir") or f"/content/jobs/{attempt_id}")

    if not s_name or not s_ep:
        return {
            "ok": True,
            "state": "unknown",
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "stableUnknown": True,
            "message": "缺少可证明归属的 Colab 会话与端点记录。",
        }

    live = driver.owned_session_info(s_name, expected_endpoint=s_ep)
    if live is None:
        u_before = read_batch_usage_before(db_path, meta.get("batch_id"))
        obs_delta = observe_delta_after_stop(
            driver,
            runtime_cleaned=True,
            usage_before=u_before if u_before is not None else meta.get("usage_before_cu"),
        )
        updated_fail = ledger.update(
            attempt_id,
            status="failed",
            meta_patch={"runtime_cleaned": True, "observed_balance_delta_cu": obs_delta},
            error=f"Colab 实例 {s_name} ({s_ep}) 已不在活跃会话列表中，无法取回未落盘产物。",
        )
        partial_usage = build_partial_gpu_usage(updated_fail, observed_delta=obs_delta)
        return {
            "ok": False,
            "state": "failed",
            "preSubmitRefusal": False,
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "message": f"Colab 实例 {s_name} 已结束或被回收。",
            **({"usage": partial_usage} if partial_usage else {}),
        }

    with tempfile.TemporaryDirectory(prefix="colab-query-") as tmp_str:
        tmp = pathlib.Path(tmp_str)
        status_local = tmp / "status.json"
        st_proc = driver.run(
            ["download", "-s", s_name, f"{remote_job_dir}/status.json", str(status_local)],
            timeout_s=45.0,
            check=False,
        )
        remote_status: dict[str, Any] = {}
        if st_proc.returncode == 0 and status_local.is_file():
            try:
                remote_status = json.loads(status_local.read_text(encoding="utf-8"))
            except ValueError:
                remote_status = {}

        r_state = str(remote_status.get("state") or "running")
        if r_state == "failed":
            err_msg = str(remote_status.get("error") or "远端 LTX-2.5 生成失败。")
            batch_id = meta.get("batch_id")
            u_before = read_batch_usage_before(db_path, str(batch_id)) if batch_id else None
            if batch_id:
                stop_res = release_batch_if_owned(driver, db_path, str(batch_id))
                cleaned = bool(stop_res.get("released"))
            else:
                stop_res = driver.stop_owned_session(s_name, s_ep)
                cleaned = bool(stop_res.get("runtime_cleaned"))
            obs_delta = observe_delta_after_stop(
                driver,
                runtime_cleaned=cleaned,
                usage_before=u_before if u_before is not None else meta.get("usage_before_cu"),
            )
            rmeta_fail = remote_status.get("meta") if isinstance(remote_status.get("meta"), dict) else {}
            updated_fail = ledger.update(
                attempt_id,
                status="failed",
                meta_patch={
                    **stop_res,
                    "observed_balance_delta_cu": obs_delta,
                    **({"stage_timings_ms": rmeta_fail.get("stage_timings_ms")} if rmeta_fail.get("stage_timings_ms") else {}),
                    **({"gpu_name": rmeta_fail.get("gpu_name")} if rmeta_fail.get("gpu_name") else {}),
                },
                error=err_msg,
            )
            partial_usage = build_partial_gpu_usage(
                updated_fail,
                release_ms=int(stop_res.get("release_ms") or 0),
                observed_delta=obs_delta,
            )
            return {
                "ok": False,
                "state": "failed",
                "preSubmitRefusal": False,
                "attemptId": attempt_id,
                "providerTaskId": provider_tid,
                "message": err_msg,
                **({"usage": partial_usage} if partial_usage else {}),
            }

        if r_state != "succeeded":
            return {
                "ok": True,
                "state": "running",
                "attemptId": attempt_id,
                "providerTaskId": provider_tid,
            }

        # Download output.mp4 + meta.json BEFORE releasing GPU
        t_dl = time.monotonic()
        part_mp4 = final_local_mp4.with_suffix(".part.mp4")
        part_mp4.unlink(missing_ok=True)
        driver.run(
            ["download", "-s", s_name, f"{remote_job_dir}/output.mp4", str(part_mp4)],
            timeout_s=300.0,
            check=True,
        )
        facts = verify_media_file(part_mp4, "video")
        part_mp4.replace(final_local_mp4)
        facts["path"] = str(final_local_mp4)

        remote_meta: dict[str, Any] = (
            remote_status.get("meta") if isinstance(remote_status.get("meta"), dict) else {}
        )
        if not remote_meta:
            meta_local = tmp / "meta.json"
            m_proc = driver.run(
                ["download", "-s", s_name, f"{remote_job_dir}/meta.json", str(meta_local)],
                timeout_s=45.0,
                check=False,
            )
            if m_proc.returncode == 0 and meta_local.is_file():
                try:
                    remote_meta = json.loads(meta_local.read_text(encoding="utf-8"))
                except ValueError:
                    remote_meta = {}
        dl_ms = int(round((time.monotonic() - t_dl) * 1000))

        # Release policy: single-shot releases immediately; batch releases on last shot or explicit request
        batch_id = meta.get("batch_id")
        release_ms = 0
        runtime_cleaned = False
        observed_delta: float | None = None
        batch_usage_before: float | None = None

        if batch_id:
            conn = sqlite3.connect(str(db_path), timeout=30.0)
            conn.row_factory = sqlite3.Row
            try:
                conn.execute(
                    "UPDATE colab_batches SET completed_shots = completed_shots + 1, updated_at = ? WHERE batch_id = ?",
                    (utc_now_iso(), str(batch_id)),
                )
                conn.commit()
                b_row = conn.execute(
                    "SELECT * FROM colab_batches WHERE batch_id = ?", (str(batch_id),)
                ).fetchone()
                if b_row is not None and isinstance(b_row["usage_before_cu"], (int, float)):
                    batch_usage_before = float(b_row["usage_before_cu"])
            finally:
                conn.close()
            should_release = args.release_policy == "release_now" or (
                b_row is not None and int(b_row["completed_shots"]) >= int(b_row["total_shots"])
            )
            if should_release:
                b_stop = release_batch_if_owned(driver, db_path, str(batch_id))
                release_ms = int(b_stop.get("release_ms") or 0)
                runtime_cleaned = bool(b_stop.get("released"))
        else:
            stop_res = driver.stop_owned_session(s_name, s_ep)
            release_ms = int(stop_res.get("release_ms") or 0)
            runtime_cleaned = bool(stop_res.get("runtime_cleaned"))

        effective_before = (
            batch_usage_before
            if batch_usage_before is not None
            else meta.get("usage_before_cu")
        )
        observed_delta = observe_delta_after_stop(
            driver,
            runtime_cleaned=runtime_cleaned,
            usage_before=effective_before,
        )

        updated_task = ledger.update(
            attempt_id,
            status="downloaded",
            local_file=final_local_mp4,
            file_sha256=facts["sha256"],
            meta_patch={
                "media_facts": facts,
                "remote_meta": remote_meta,
                "cache_source": remote_meta.get("cache_source"),
                "gpu_name": remote_meta.get("gpu_name"),
                "stage_timings_ms": remote_meta.get("stage_timings_ms"),
                "download_ms": dl_ms,
                "release_ms": release_ms,
                "runtime_cleaned": runtime_cleaned,
                "observed_balance_delta_cu": observed_delta,
            },
            error=None,
        )
        return {
            "ok": True,
            "state": "succeeded",
            "sampleReplay": False,
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "outputMp4Path": str(final_local_mp4),
            "mediaFacts": facts,
            "usage": build_usage_summary(
                updated_task,
                facts=facts,
                remote_meta=remote_meta,
                release_ms=release_ms,
                observed_delta=observed_delta,
            ),
        }


def cmd_cancel(args: argparse.Namespace) -> dict[str, Any]:
    state_root, ledger, driver = resolve_web_driver_and_ledger(args)
    db_path = state_root / "tasks.db"
    attempt_id = args.attempt_id.strip()

    task = ledger.get(attempt_id)
    if not task and args.request_identity:
        task = ledger.get_by_key(args.request_identity)
    if not task:
        # Never allocated in local ledger -> 0-CU safe cancelled
        return {
            "ok": True,
            "state": "cancelled",
            "notAllocated": True,
            "attemptId": attempt_id,
            "message": "任务尚未向 Colab 发起分配，已直接取消。",
        }

    if task["status"] == "allocating":
        task = reconcile_interrupted_allocation(driver, ledger, task)

    status = task["status"]
    meta = dict(task.get("external_meta") or {})
    provider_tid = task.get("external_id") or args.provider_task_id

    if status == "cancelled":
        partial_usage = build_partial_gpu_usage(task)
        return {
            "ok": True,
            "state": "cancelled",
            "notAllocated": bool(meta.get("not_allocated")),
            "sampleReplay": bool(
                meta.get("sample_replay") or meta.get("session_name") == "sample-replay"
            ),
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "message": "已取消（幂等重放）。",
            **({"usage": partial_usage} if partial_usage else {}),
        }

    if status == "downloaded":
        local_f = pathlib.Path(task["local_file"]) if task.get("local_file") else None
        if local_f and local_f.is_file():
            # Ensure any warm batch session is still cleaned up if cancel happened mid-batch!
            if meta.get("batch_id") and not meta.get("runtime_cleaned"):
                release_batch_if_owned(driver, db_path, str(meta["batch_id"]))
            facts = verify_media_file(local_f, "video")
            return {
                "ok": True,
                "state": "succeeded",
                "sampleReplay": bool(
                    meta.get("cache_source") == "sample_replay" or meta.get("sample_replay")
                ),
                "attemptId": attempt_id,
                "providerTaskId": provider_tid,
                "outputMp4Path": str(local_f),
                "mediaFacts": facts,
                "usage": build_usage_summary(task, facts=facts),
            }

    if status == "allocation_unconfirmed":
        return {
            "ok": True,
            "state": "unknown",
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "stableUnknown": True,
            "message": task.get("error") or "分配确认前中断，无归属凭证可停止远端会话。",
        }

    if status in ("prepared", "precheck_failed"):
        ledger.update(
            attempt_id,
            status="cancelled",
            meta_patch={"not_allocated": True, "runtime_cleaned": True},
            error="取消于分配前。",
        )
        return {
            "ok": True,
            "state": "cancelled",
            "notAllocated": True,
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
        }

    s_name = str(meta.get("session_name") or "")
    s_ep = str(meta.get("confirmed_endpoint") or "")
    parsed_s, parsed_ep, _ = parse_provider_task_id(provider_tid)
    s_name = s_name or (parsed_s or "")
    s_ep = s_ep or (parsed_ep or "")

    if s_name == "sample-replay":
        ledger.update(
            attempt_id,
            status="cancelled",
            meta_patch={"sample_replay": True, "runtime_cleaned": True},
        )
        return {
            "ok": True,
            "state": "cancelled",
            "sampleReplay": True,
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
        }

    if meta.get("batch_id"):
        u_before = read_batch_usage_before(db_path, str(meta["batch_id"]))
        b_res = release_batch_if_owned(driver, db_path, str(meta["batch_id"]))
        cleaned = bool(b_res.get("released")) or b_res.get("reason") == "not_found"
        if not cleaned:
            return {
                "ok": True,
                "state": "unknown",
                "attemptId": attempt_id,
                "providerTaskId": provider_tid,
                "stableUnknown": True,
                "message": str(b_res.get("error") or "批次实例释放未确认"),
            }
        rel_ms = int(b_res.get("release_ms") or 0)
        obs_delta = observe_delta_after_stop(
            driver,
            runtime_cleaned=bool(b_res.get("released")),
            usage_before=u_before if u_before is not None else meta.get("usage_before_cu"),
        )
        updated_cancel = ledger.update(
            attempt_id,
            status="cancelled",
            meta_patch={
                "runtime_cleaned": True,
                "release_ms": rel_ms,
                "observed_balance_delta_cu": obs_delta,
            },
            error="用户取消并已释放批次 Colab GPU。",
        )
        partial_usage = build_partial_gpu_usage(
            updated_cancel, release_ms=rel_ms, observed_delta=obs_delta
        )
        return {
            "ok": True,
            "state": "cancelled",
            "notAllocated": False,
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            **({"usage": partial_usage} if partial_usage else {}),
        }

    if not s_name or not s_ep:
        return {
            "ok": True,
            "state": "unknown",
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "stableUnknown": True,
            "message": "无已确认会话归属信息，拒绝盲停其他会话。",
        }

    stop_res = driver.stop_owned_session(s_name, s_ep)
    if not stop_res["runtime_cleaned"]:
        ledger.update(attempt_id, meta_patch=stop_res)
        return {
            "ok": True,
            "state": "unknown",
            "attemptId": attempt_id,
            "providerTaskId": provider_tid,
            "stableUnknown": True,
            "message": str(stop_res.get("error") or "停止本单 Colab GPU 未获确认"),
        }

    rel_ms = int(stop_res.get("release_ms") or 0)
    obs_delta = observe_delta_after_stop(
        driver,
        runtime_cleaned=True,
        usage_before=meta.get("usage_before_cu"),
    )
    updated_cancel = ledger.update(
        attempt_id,
        status="cancelled",
        meta_patch={**stop_res, "observed_balance_delta_cu": obs_delta},
        error="用户取消并已释放本单 Colab GPU。",
    )
    partial_usage = build_partial_gpu_usage(
        updated_cancel, release_ms=rel_ms, observed_delta=obs_delta
    )
    return {
        "ok": True,
        "state": "cancelled",
        "notAllocated": False,
        "attemptId": attempt_id,
        "providerTaskId": provider_tid,
        **({"usage": partial_usage} if partial_usage else {}),
    }


def cmd_release_batch(args: argparse.Namespace) -> dict[str, Any]:
    state_root, _, driver = resolve_web_driver_and_ledger(args)
    return release_batch_if_owned(driver, state_root / "tasks.db", args.batch_id.strip())


# --- Manual CLI Commands (`run`, `recover`, `cleanup`, `plan-cu`, `benchmark-compare`) --------


def prepare_first_frame(
    *,
    first_frame: str | None,
    frame_blob_id: str | None,
    frame_client: FrameClient,
    staging_dir: pathlib.Path,
) -> pathlib.Path:
    if first_frame:
        path = pathlib.Path(first_frame).expanduser().resolve()
        verify_media_file(path, "image")
        return path
    if frame_blob_id:
        downloaded = frame_client.download_blob(frame_blob_id, staging_dir / f"{frame_blob_id}.img")
        facts = verify_media_file(downloaded, "image")
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[facts["mime_type"]]
        renamed = downloaded.with_suffix(ext)
        downloaded.rename(renamed)
        return renamed
    raise ValueError("Provide either --first-frame PATH or --frame-blob-id BLOB_ID.")


def try_recover_existing_colab_task(
    driver: ColabCliDriver,
    ledger: TaskLedger,
    task: dict[str, Any],
    output_path: pathlib.Path,
    *,
    stop_after_check: bool = True,
) -> dict[str, Any] | None:
    meta = task.get("external_meta") or {}
    parsed_s, parsed_ep, _ = parse_provider_task_id(task.get("external_id"))
    session_name = str(meta.get("session_name") or meta.get("colab_session") or parsed_s or task.get("external_id") or "")
    confirmed_ep = str(meta.get("confirmed_endpoint") or meta.get("colab_endpoint") or parsed_ep or "")
    remote_job_dir = meta.get("remote_job_dir")
    if not session_name or session_name == "?" or not remote_job_dir:
        return None

    info = driver.owned_session_info(session_name, expected_endpoint=confirmed_ep or None)
    if not info:
        ledger.update(
            task["task_id"],
            status="failed",
            meta_patch={"runtime_cleaned": True},
            error="Previous Colab session is no longer active on server; GPU already released.",
        )
        return None
    confirmed_ep = confirmed_ep or info["endpoint"]

    remote_mp4 = f"{remote_job_dir}/output.mp4"
    remote_status = f"{remote_job_dir}/status.json"
    with tempfile.TemporaryDirectory(prefix="colab-recover-") as tmp:
        status_local = pathlib.Path(tmp) / "status.json"
        st_proc = driver.run(
            ["download", "-s", session_name, remote_status, str(status_local)],
            timeout_s=60.0,
            check=False,
        )
        remote_state = None
        if st_proc.returncode == 0 and status_local.is_file():
            try:
                remote_state = json.loads(status_local.read_text(encoding="utf-8"))
            except ValueError:
                remote_state = None

        output_path.parent.mkdir(parents=True, exist_ok=True)
        dl_proc = driver.run(
            ["download", "-s", session_name, remote_mp4, str(output_path)],
            timeout_s=180.0,
            check=False,
        )
        if dl_proc.returncode == 0 and output_path.is_file():
            try:
                facts = verify_media_file(output_path, "video")
                cleanup = driver.stop_owned_session(session_name, confirmed_ep)
                return ledger.update(
                    task["task_id"],
                    status="downloaded",
                    local_file=output_path,
                    file_sha256=facts["sha256"],
                    meta_patch={
                        "recovered_from_timeout": True,
                        "media_facts": facts,
                        **cleanup,
                    },
                    error=None,
                )
            except MediaValidationError:
                output_path.unlink(missing_ok=True)

        if remote_state and remote_state.get("state") == "running" and not stop_after_check:
            return task

        cleanup = driver.stop_owned_session(session_name, confirmed_ep)
        err_detail = (
            remote_state.get("error")
            if isinstance(remote_state, dict) and remote_state.get("error")
            else "Remote output.mp4 was not ready; owned runtime stopped to prevent CU leak."
        )
        ledger.update(task["task_id"], status="failed", meta_patch=cleanup, error=str(err_detail))
        return None


def cmd_run(args: argparse.Namespace) -> dict[str, Any]:
    preset_cfg = PRESETS[args.preset]
    dims = preset_cfg[args.aspect]
    gpu = (args.gpu or preset_cfg["default_gpu"]).upper()
    num_frames = snap_frames(args.duration_sec, args.fps)

    state_root, ledger, driver = resolve_web_driver_and_ledger(args)
    frame_client = FrameClient(base_url=args.frame_url)

    with tempfile.TemporaryDirectory(prefix="ltx-input-") as staging_str:
        staging = pathlib.Path(staging_str)
        local_first_frame = prepare_first_frame(
            first_frame=args.first_frame,
            frame_blob_id=args.frame_blob_id,
            frame_client=frame_client,
            staging_dir=staging,
        )
        first_frame_sha = sha256_file(local_first_frame)
        request_spec = {
            "model": "Lightricks/LTX-2.5-distilled",
            "model_revision": args.model_revision,
            "backend": args.backend,
            "prompt": args.prompt.strip(),
            "first_frame_sha256": first_frame_sha,
            "preset": args.preset,
            "aspect": args.aspect,
            "num_frames": num_frames,
            "fps": args.fps,
            "seed": args.seed,
            "exact_16_9_crop": not args.no_exact_crop,
        }
        idem_key = args.task_id or make_idempotency_key("colab_ltx", request_spec)
        task_id = args.task_id or make_task_id("ltx", idem_key)

        out_dir = (
            pathlib.Path(args.out_dir).expanduser().resolve()
            if args.out_dir
            else (state_root / "outputs" / "colab-ltx")
        )
        out_dir.mkdir(parents=True, exist_ok=True)
        final_local_mp4 = out_dir / f"{task_id}.mp4"
        session_name = sanitize_session_slug(task_id, "vf-ltx")
        remote_job_dir = f"/content/jobs/{task_id}"

        task, created = ledger.create_or_get(
            task_id=task_id,
            kind="colab_ltx",
            idempotency_key=idem_key,
            request={**request_spec, "gpu": gpu, "conversation_id": args.conversation_id},
            external_meta={"session_name": session_name, "remote_job_dir": remote_job_dir},
        )

        if not created and not args.force_new:
            existing_file = pathlib.Path(task["local_file"]) if task.get("local_file") else final_local_mp4
            if task["status"] in ("downloaded", "ingested") and existing_file.is_file():
                facts = verify_media_file(existing_file, "video")
                if args.conversation_id and not task.get("frame_receipt"):
                    receipt = frame_client.ingest_media(args.conversation_id, existing_file)
                    task = ledger.update(task_id, status="ingested", frame_receipt=receipt)
                return {**task, "replayed": True, "media_facts": facts}

            if task["status"] in ("submitted", "timeout_unknown"):
                recovered = try_recover_existing_colab_task(
                    driver, ledger, task, final_local_mp4, stop_after_check=not args.keep_on_timeout
                )
                if recovered and recovered["status"] == "downloaded":
                    if args.conversation_id:
                        receipt = frame_client.ingest_media(args.conversation_id, final_local_mp4)
                        recovered = ledger.update(task_id, status="ingested", frame_receipt=receipt)
                    return {**recovered, "replayed": True}
                if recovered and recovered["status"] in ("submitted", "timeout_unknown"):
                    raise RuntimeError(
                        f"Task {task_id} is still running on owned Colab session {session_name}."
                    )

        gpu_candidates = [gpu]
        if args.gpu_fallbacks:
            for cand in args.gpu_fallbacks.split(","):
                c = cand.strip().upper()
                if c and c not in gpu_candidates:
                    gpu_candidates.append(c)

        ledger.update(task_id, status="allocating", meta_patch={"session_name": session_name})
        started_wall = time.monotonic()
        t_alloc = time.monotonic()
        allocated_gpu, confirmed_ep = allocate_owned_session(
            driver, session_name=session_name, gpu_candidates=gpu_candidates, high_mem=bool(args.high_mem)
        )
        alloc_ms = int(round((time.monotonic() - t_alloc) * 1000))
        preserve_runtime = False
        cleanup_report: dict[str, Any] = {
            "session_name": session_name,
            "confirmed_endpoint": confirmed_ep,
            "runtime_cleaned": False,
        }

        try:
            ledger.update(
                task_id,
                status="submitted",
                external_id=session_name,
                meta_patch={
                    "session_name": session_name,
                    "colab_session": session_name,
                    "confirmed_endpoint": confirmed_ep,
                    "colab_endpoint": confirmed_ep,
                    "gpu": allocated_gpu,
                    "queue_alloc_ms": alloc_ms,
                    "remote_job_dir": remote_job_dir,
                    "runtime_cleaned": False,
                },
                error=None,
            )

            cache_dir = "/content/models/ltx-2.5"
            if args.mount_drive:
                driver.run(["drivemount", "-s", session_name, "/content/drive"], timeout_s=180.0, check=True)
                cache_dir = args.drive_cache_dir

            remote_first_frame = f"{remote_job_dir}/first_frame{local_first_frame.suffix.lower()}"
            init_py = staging / "init_job_dir.py"
            init_py.write_text(
                f"import os; os.makedirs({remote_job_dir!r}, exist_ok=True); print('job_dir_ready')\n",
                encoding="utf-8",
            )
            driver.run(["exec", "-s", session_name, "--timeout", "60", "-f", str(init_py)], timeout_s=90.0)
            driver.run(
                ["upload", "-s", session_name, str(local_first_frame), remote_first_frame],
                timeout_s=180.0,
                check=True,
            )

            hf_token = read_hf_token_secure(args)
            job_config = {
                "task_id": task_id,
                "backend": args.backend,
                "model_revision": args.model_revision,
                "remote_job_dir": remote_job_dir,
                "remote_first_frame": remote_first_frame,
                "prompt": args.prompt.strip(),
                "gen_width": dims["gen_w"],
                "gen_height": dims["gen_h"],
                "target_width": dims["out_w"],
                "target_height": dims["out_h"],
                "exact_16_9_crop": not args.no_exact_crop,
                "duration_sec": args.duration_sec,
                "num_frames": num_frames,
                "fps": args.fps,
                "seed": args.seed,
                "mute_audio": bool(args.mute_audio),
                "cache_dir": cache_dir,
                "vae_variant": args.vae_variant,
                "quantization": args.quantization,
                "offload": args.offload,
                "enhance_prompt": args.enhance_prompt,
                "hf_token": hf_token,
            }
            local_job_cfg = staging / "job_config.json"
            local_job_cfg.write_text(json.dumps(job_config, ensure_ascii=False, indent=2), encoding="utf-8")
            os.chmod(local_job_cfg, 0o600)
            remote_job_cfg = f"{remote_job_dir}/job_config.json"
            driver.run(
                ["upload", "-s", session_name, str(local_job_cfg), remote_job_cfg],
                timeout_s=60.0,
                check=True,
            )
            exec_args = [
                "exec",
                "-s",
                session_name,
                "--timeout",
                str(args.idle_timeout_sec),
                "--env",
                f"LTX_JOB_CONFIG_FILE={remote_job_cfg}",
                "-f",
                str(WORKER_SCRIPT),
            ]
            driver.run(exec_args, timeout_s=args.wall_timeout_sec, check=True, stream=True)

            tmp_mp4 = final_local_mp4.with_suffix(".part.mp4")
            tmp_mp4.unlink(missing_ok=True)
            driver.run(
                ["download", "-s", session_name, f"{remote_job_dir}/output.mp4", str(tmp_mp4)],
                timeout_s=300.0,
                check=True,
            )
            facts = verify_media_file(tmp_mp4, "video")
            tmp_mp4.replace(final_local_mp4)
            facts["path"] = str(final_local_mp4)

            remote_meta: dict[str, Any] = {}
            meta_local = staging / "meta.json"
            meta_proc = driver.run(
                ["download", "-s", session_name, f"{remote_job_dir}/meta.json", str(meta_local)],
                timeout_s=60.0,
                check=False,
            )
            if meta_proc.returncode == 0 and meta_local.is_file():
                try:
                    remote_meta = json.loads(meta_local.read_text(encoding="utf-8"))
                except ValueError:
                    remote_meta = {}

            elapsed_hr = (time.monotonic() - started_wall) / 3600.0
            est_cu = round(elapsed_hr * CU_RATES_PER_HOUR.get(allocated_gpu, 10.0), 3)
            task = ledger.update(
                task_id,
                status="downloaded",
                local_file=final_local_mp4,
                file_sha256=facts["sha256"],
                meta_patch={
                    "media_facts": facts,
                    "remote_meta": remote_meta,
                    "cu_estimated": est_cu,
                },
                error=None,
            )
        except ColabCommandError as exc:
            if exc.timed_out:
                current_task = ledger.get(task_id)
                assert current_task is not None
                probed = try_recover_existing_colab_task(
                    driver, ledger, current_task, final_local_mp4, stop_after_check=not args.keep_on_timeout
                )
                if probed and probed["status"] == "downloaded":
                    preserve_runtime = True  # already stopped inside try_recover
                    task = probed
                else:
                    preserve_runtime = bool(args.keep_on_timeout)
                    ledger.update(
                        task_id,
                        status="timeout_unknown" if preserve_runtime else "failed",
                        error=str(exc),
                    )
                    raise
            else:
                ledger.update(task_id, status="failed", error=str(exc))
                raise
        except BaseException as exc:
            ledger.update(task_id, status="failed", error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            if not preserve_runtime:
                cleanup_report = driver.stop_owned_session(session_name, confirmed_ep)
                ledger.update(task_id, meta_patch=cleanup_report)

    target_conv_id = args.conversation_id
    if not target_conv_id and args.auto_create_conversation and task["status"] == "downloaded":
        created_conv = frame_client.create_conversation(args.auto_create_conversation)
        target_conv_id = str(created_conv.get("conversationId") or created_conv.get("id"))
    if target_conv_id and task["status"] == "downloaded":
        receipt = frame_client.ingest_media(target_conv_id, final_local_mp4)
        task = ledger.update(
            task_id,
            status="ingested",
            frame_receipt=receipt,
            meta_patch={"conversation_id": target_conv_id},
        )

    latest = ledger.get(task_id)
    assert latest is not None
    return {**latest, "replayed": False, "cleanup": cleanup_report}


def cmd_recover(args: argparse.Namespace) -> dict[str, Any]:
    state_root, ledger, driver = resolve_web_driver_and_ledger(args)
    task = ledger.get(args.task_id)
    if not task:
        raise KeyError(f"Unknown task_id: {args.task_id}")
    out_dir = state_root / "outputs" / "colab-ltx"
    out_path = pathlib.Path(task["local_file"]) if task.get("local_file") else (out_dir / f"{args.task_id}.mp4")
    recovered = try_recover_existing_colab_task(
        driver, ledger, task, out_path, stop_after_check=not args.keep_alive
    )
    if recovered and recovered["status"] == "downloaded":
        conv_id = args.conversation_id or (recovered["request"] or {}).get("conversation_id")
        if conv_id and not recovered.get("frame_receipt"):
            receipt = FrameClient(base_url=args.frame_url).ingest_media(conv_id, out_path)
            recovered = ledger.update(args.task_id, status="ingested", frame_receipt=receipt)
        return recovered
    latest = ledger.get(args.task_id)
    assert latest is not None
    return latest


def cmd_cleanup(args: argparse.Namespace) -> dict[str, Any]:
    """Explicit developer CLI cleanup ONLY (never called by web native port)."""
    _, _, driver = resolve_web_driver_and_ledger(args)
    sessions = driver.list_sessions()
    stopped: list[dict[str, Any]] = []
    for item in sessions:
        name = item["name"]
        if name == "?":
            continue
        if args.session and name == args.session:
            stopped.append(driver.stop_owned_session(name, item["endpoint"]))
        elif args.all:
            stopped.append(driver.stop_owned_session(name, item["endpoint"]))
    return {"inspected": len(sessions), "stopped": stopped}


def cmd_plan_cu(args: argparse.Namespace) -> dict[str, Any]:
    monthly_cu = args.monthly_cu
    reserve_cu = round(monthly_cu * args.reserve_ratio, 1)
    usable_cu = round(monthly_cu - reserve_cu, 1)

    profiles = [
        {
            "tier": "720p Baseline Fallback (1280x704 -> 1280x720, 5s, 121f)",
            "gpu": "T4 (15GB SM75, scaled-FP16 shim + disk/cpu offload)",
            "cu_per_hour": CU_RATES_PER_HOUR["T4"],
            "cold_start_min": 55.1,
            "drive_cached_single_shot_min": 28.0,
            "warm_session_per_shot_min": 22.0,
        },
        {
            "tier": "720p Recommended Ampere/Ada (1280x704 -> 1280x720, 5s, 121f)",
            "gpu": "L4 (24GB SM89, native bf16/fp8-cast + cpu offload)",
            "cu_per_hour": CU_RATES_PER_HOUR["L4"],
            "cold_start_min": 14.0,
            "drive_cached_single_shot_min": 3.2,
            "warm_session_per_shot_min": 1.8,
        },
        {
            "tier": "1080p Production Fast (1920x1088 -> 1920x1080, 5s, 121f)",
            "gpu": "A100 (40GB/80GB SM80, native bf16)",
            "cu_per_hour": CU_RATES_PER_HOUR["A100"],
            "cold_start_min": 11.0,
            "drive_cached_single_shot_min": 2.4,
            "warm_session_per_shot_min": 1.1,
        },
    ]

    estimates = []
    for p in profiles:
        rate = p["cu_per_hour"]
        cu_cold = round(rate * (p["cold_start_min"] / 60.0), 3)
        cu_cached = round(rate * (p["drive_cached_single_shot_min"] / 60.0), 3)
        batch_n = max(1, args.batch_shots)
        cu_batch_per_shot = round(
            rate * ((2.0 + batch_n * p["warm_session_per_shot_min"]) / 60.0) / batch_n, 3
        )
        estimates.append(
            {
                **p,
                "cu_per_shot_cold_no_cache": cu_cold,
                "cu_per_shot_drive_cached_ephemeral": cu_cached,
                f"cu_per_shot_batch_of_{batch_n}": cu_batch_per_shot,
                "monthly_shots_ephemeral_cached": math.floor(usable_cu / max(cu_cached, 0.001)),
                f"monthly_shots_batch_of_{batch_n}": math.floor(usable_cu / max(cu_batch_per_shot, 0.001)),
            }
        )

    live_usage: str | None = None
    if args.query_live:
        _, _, driver = resolve_web_driver_and_ledger(args)
        proc = driver.run(["usage"], timeout_s=30.0, check=False)
        live_usage = (proc.stdout or proc.stderr).strip()

    return {
        "monthly_budget_cu": monthly_cu,
        "safety_reserve_cu": reserve_cu,
        "usable_production_cu": usable_cu,
        "batch_shots_assumed": args.batch_shots,
        "live_account_usage": live_usage,
        "profiles": estimates,
    }


def cmd_benchmark_compare(args: argparse.Namespace) -> dict[str, Any]:
    """Zero-CU GPU comparison report combining measured ledger records & stage-cost modeling."""
    state_root = (
        pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    )
    ledger = TaskLedger(state_root / "tasks.db")
    historical: list[dict[str, Any]] = []
    for item in ledger.list_tasks(limit=50):
        if item["kind"] not in ("colab_ltx", "colab_ltx_web"):
            continue
        meta = item.get("external_meta") or {}
        rmeta = meta.get("remote_meta") or {}
        if item["status"] in ("downloaded", "ingested"):
            historical.append(
                {
                    "task_id": item["task_id"],
                    "gpu": meta.get("gpu") or rmeta.get("gpu_name"),
                    "gpu_name": rmeta.get("gpu_name") or meta.get("gpu_name"),
                    "vram_gb": rmeta.get("vram_gb"),
                    "elapsed_seconds": rmeta.get("elapsed_seconds"),
                    "cache_source": meta.get("cache_source") or rmeta.get("cache_source") or "ephemeral_download",
                    "stage_timings_ms": meta.get("stage_timings_ms") or rmeta.get("stage_timings_ms"),
                    "cu_estimated": meta.get("cu_estimated"),
                }
            )

    matrix = [
        {
            "gpu": "T4",
            "architecture": "Turing SM75 (15 GiB VRAM, no native bf16)",
            "cu_per_hour": CU_RATES_PER_HOUR["T4"],
            "precision_path": "scaled-FP16 Tensor Core shim + disk/CPU offload",
            "measured_cold_720p_sec": 3306.34,
            "measured_cold_cu": round((3306.34 / 3600.0) * CU_RATES_PER_HOUR["T4"], 3),
            "estimated_drive_warm_720p_sec": 1680,
            "estimated_warm_batch_shot_sec": 1320,
            "oom_failure_risk": "medium (14.56 GiB tight VRAM; requires disk offload on standard RAM)",
            "quality_consistency": "minor shim approximation (scaled FP16 vs native BF16)",
        },
        {
            "gpu": "L4",
            "architecture": "Ada SM89 (24 GiB VRAM, native BF16 + FP8 Tensor Cores)",
            "cu_per_hour": CU_RATES_PER_HOUR["L4"],
            "precision_path": "native BF16 + fp8-cast + CPU offload",
            "estimated_cold_720p_sec": 840,
            "estimated_cold_cu": round((840 / 3600.0) * CU_RATES_PER_HOUR["L4"], 3),
            "estimated_drive_warm_720p_sec": 192,
            "estimated_drive_warm_cu": round((192 / 3600.0) * CU_RATES_PER_HOUR["L4"], 3),
            "estimated_warm_batch_shot_sec": 108,
            "estimated_warm_batch_4shot_cu_per_shot": round(
                ((120 + 4 * 108) / 3600.0) * CU_RATES_PER_HOUR["L4"] / 4, 3
            ),
            "oom_failure_risk": "low (22.5 GiB usable VRAM + native FP8)",
            "quality_consistency": "reference exact (native BF16/FP8)",
        },
        {
            "gpu": "A100",
            "architecture": "Ampere SM80 (40/80 GiB VRAM, high HBM bandwidth)",
            "cu_per_hour": CU_RATES_PER_HOUR["A100"],
            "precision_path": "native BF16",
            "estimated_cold_720p_sec": 660,
            "estimated_cold_cu": round((660 / 3600.0) * CU_RATES_PER_HOUR["A100"], 3),
            "estimated_drive_warm_720p_sec": 144,
            "estimated_drive_warm_cu": round((144 / 3600.0) * CU_RATES_PER_HOUR["A100"], 3),
            "estimated_warm_batch_shot_sec": 66,
            "estimated_warm_batch_4shot_cu_per_shot": round(
                ((110 + 4 * 66) / 3600.0) * CU_RATES_PER_HOUR["A100"] / 4, 3
            ),
            "oom_failure_risk": "very_low",
            "quality_consistency": "reference exact (native BF16)",
        },
    ]
    return {
        "zero_cu_analysis": True,
        "historical_measured_runs": historical,
        "candidate_comparison": matrix,
        "live_benchmark_budget_cap_cu": {
            "single_l4_drive_cache_seed_and_2shot_warm_test": 1.25,
            "note": "Live GPU benchmark not executed automatically to preserve the remaining 18.90 CU.",
        },
    }


def add_generation_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--preset", choices=["720p", "1080p"], default="720p")
    p.add_argument("--aspect", choices=["16:9", "9:16"], default="16:9")
    p.add_argument("--duration-sec", type=float, default=5.0)
    p.add_argument("--fps", type=float, default=24.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--gpu", choices=["T4", "L4", "G4", "A100", "H100"])
    p.add_argument("--gpu-fallbacks", default="L4,T4,A100")
    p.add_argument("--high-mem", action="store_true", default=False)
    p.add_argument("--backend", choices=["ltx-pipelines", "diffusers"], default="ltx-pipelines")
    p.add_argument("--model-revision", default="main", help="Pinned HF branch/tag/40-char commit SHA.")
    p.add_argument("--vae-variant", choices=["conv", "diff"], default="conv")
    p.add_argument("--quantization", choices=["fp8-cast", "fp8-scaled-mm", "none"], default="fp8-cast")
    p.add_argument("--offload", choices=["auto", "cpu", "disk", "none"], default="auto")
    p.add_argument("--enhance-prompt", action="store_true")
    p.add_argument("--mute-audio", action="store_true")
    p.add_argument("--no-exact-crop", action="store_true")
    p.add_argument("--mount-drive", action="store_true")
    p.add_argument(
        "--drive-cache-dir",
        default="/content/drive/MyDrive/video-factory-cache/ltx-2.5",
    )
    p.add_argument("--hf-token", help="HuggingFace Read token (prefer --hf-token-stdin for server calls).")
    p.add_argument("--hf-token-stdin", action="store_true", help="Read HF token from stdin (avoids argv exposure).")
    p.add_argument("--out-dir", help="Local directory for retrieved MP4.")


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--state-dir", help="Override task ledger directory.")
    common.add_argument("--colab-bin", help="Override `colab` executable.")
    common.add_argument("--colab-auth", choices=["oauth2", "adc"], help="Colab CLI auth strategy.")
    common.add_argument("--colab-config", help="Isolated sessions.json path.")
    common.add_argument("--frame-url", help="Frame server URL.")

    parser = argparse.ArgumentParser(description="Colab LTX-2.5 Distilled executor & CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    # Web Native Port Subcommands
    pre_p = sub.add_parser("preflight", parents=[common], help="Zero-CU Colab readiness check")
    pre_p.add_argument("--mount-drive", action="store_true")
    pre_p.add_argument("--hf-token")
    pre_p.add_argument("--hf-token-stdin", action="store_true")

    sub_p = sub.add_parser("submit", parents=[common], help="Submit non-blocking Colab LTX attempt")
    sub_p.add_argument("--attempt-id", required=True)
    sub_p.add_argument("--request-identity")
    sub_p.add_argument("--run-id")
    sub_p.add_argument("--batch-id", help="Optional batch identifier for multi-shot warm reuse.")
    sub_p.add_argument("--batch-total-shots", type=int, default=1)
    sub_p.add_argument("--shot-seq", type=int, default=1)
    sub_p.add_argument("--first-frame", required=True)
    sub_p.add_argument("--prompt", required=True)
    sub_p.add_argument("--replay-sample-mp4", help="Test-only zero-quota sample MP4 injection.")
    sub_p.add_argument("--mock-remote-mp4", help="Test-only remote worker mock MP4 path.")
    add_generation_flags(sub_p)

    qry_p = sub.add_parser("query", parents=[common], help="Query in-flight Colab LTX attempt")
    qry_p.add_argument("--attempt-id", required=True)
    qry_p.add_argument("--request-identity")
    qry_p.add_argument("--provider-task-id")
    qry_p.add_argument("--out-dir")
    qry_p.add_argument(
        "--release-policy",
        choices=["auto", "keep_batch_warm", "release_now"],
        default="auto",
    )

    can_p = sub.add_parser("cancel", parents=[common], help="Cancel and release owned Colab GPU")
    can_p.add_argument("--attempt-id", required=True)
    can_p.add_argument("--request-identity")
    can_p.add_argument("--provider-task-id")

    rel_p = sub.add_parser("release-batch", parents=[common], help="Release owned warm batch session")
    rel_p.add_argument("--batch-id", required=True)

    # Developer CLI Subcommands
    run_p = sub.add_parser("run", parents=[common], help="Generate ~5s LTX-2.5 clip synchronously")
    run_p.add_argument("--first-frame", help="Local path to first-frame image.")
    run_p.add_argument("--frame-blob-id", help="Fetch first-frame blob from Frame.")
    run_p.add_argument("--prompt", required=True)
    add_generation_flags(run_p)
    run_p.add_argument("--idle-timeout-sec", type=float, default=180.0)
    run_p.add_argument("--wall-timeout-sec", type=float, default=2400.0)
    run_p.add_argument("--keep-on-timeout", action="store_true")
    run_p.add_argument("--conversation-id")
    run_p.add_argument("--auto-create-conversation")
    run_p.add_argument("--task-id")
    run_p.add_argument("--force-new", action="store_true")

    rec_p = sub.add_parser("recover", parents=[common], help="Recover timed-out CLI task")
    rec_p.add_argument("--task-id", required=True)
    rec_p.add_argument("--conversation-id")
    rec_p.add_argument("--keep-alive", action="store_true")

    clean_p = sub.add_parser("cleanup", parents=[common], help="Explicit CLI stop of locally tracked sessions")
    clean_p.add_argument("--session", help="Specific locally tracked session name.")
    clean_p.add_argument("--all", action="store_true", help="Stop all locally tracked sessions.")

    plan_p = sub.add_parser("plan-cu", parents=[common], help="Calculate monthly CU capacity plan")
    plan_p.add_argument("--monthly-cu", type=float, default=2000.0)
    plan_p.add_argument("--reserve-ratio", type=float, default=0.10)
    plan_p.add_argument("--batch-shots", type=int, default=8)
    plan_p.add_argument("--query-live", action="store_true")

    sub.add_parser("benchmark-compare", parents=[common], help="Zero-CU T4 vs L4/A100 comparison")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        dispatch = {
            "preflight": cmd_preflight,
            "submit": cmd_submit,
            "query": cmd_query,
            "cancel": cmd_cancel,
            "release-batch": cmd_release_batch,
            "run": cmd_run,
            "recover": cmd_recover,
            "cleanup": cmd_cleanup,
            "plan-cu": cmd_plan_cu,
            "benchmark-compare": cmd_benchmark_compare,
        }
        result = dispatch[args.command](args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
