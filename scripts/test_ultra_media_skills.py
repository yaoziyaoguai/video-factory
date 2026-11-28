#!/usr/bin/env python3
"""End-to-end offline simulation test suite for Google AI Ultra media skills.

Verifies without spending real Colab CUs or Flow credits:
1. Skill SKILL.md frontmatter & relative file link integrity across all 3 skills.
2. Colab LTX-2.5 happy path: Frame blob fetch -> GPU alloc -> exec -> MP4 verify -> GPU stop ->
   Frame `/uploads` ingestion (including 409 STALE_REVISION retry & idempotent replay).
3. Colab failure cleanup guarantee: kernel failure still triggers `colab stop` (0 leaked sessions).
4. Colab timeout recovery: existing remote `output.mp4` is pulled & GPU stopped without re-running.
5. StudioWright dual-Ultra account verification, port isolation (`ultra-1` vs `ultra-2`), and
   automatic failover when an account enters cooldown.
6. Flow Video dry-run quote, happy-path MP4 + Frame ingestion, and timeout recovery via `sw download <media_id>`.
7. Flow Music WAV & MP3 generation + Frame ingestion, and timeout recovery via `sw music list` + `sw music download`.
"""

from __future__ import annotations

import email.parser
import email.policy
import http.server
import json
import os
import pathlib
import re
import socketserver
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from studiowright_bridge import studiowright_debug_port  # noqa: E402
from ultra_media_common import (  # noqa: E402
    copy_sample_mp4_or_minimal,
    verify_media_file,
    write_minimal_mp3,
    write_minimal_png,
    write_minimal_wav,
)

COLAB_CLI = REPO_ROOT / ".agents" / "skills" / "colab-ltx-video" / "scripts" / "colab_ltx.py"
FLOW_VID_CLI = REPO_ROOT / ".agents" / "skills" / "flow-video" / "scripts" / "flow_video.py"
FLOW_MUS_CLI = REPO_ROOT / ".agents" / "skills" / "flow-music" / "scripts" / "flow_music.py"


class MockFrameServer:
    """In-memory mock of Frame's `/api/agent/v1` conversation & upload routes."""

    def __init__(self, first_frame_bytes: bytes) -> None:
        self.first_frame_bytes = first_frame_bytes
        self.revision = 3
        self.inject_stale_once = False
        self.receipts_by_cmd: dict[str, dict[str, object]] = {}
        self.uploads: list[dict[str, object]] = []

        parent = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: object) -> None:
                return

            def _send_json(self, code: int, payload: dict[str, object]) -> None:
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self) -> None:  # noqa: N802
                if self.path.startswith("/api/agent/v1/conversations/"):
                    conv_id = self.path.split("/")[4].split("?")[0]
                    self._send_json(
                        200,
                        {
                            "conversationId": conv_id,
                            "title": "Test Storyboard",
                            "revision": parent.revision,
                        },
                    )
                    return
                if self.path.startswith("/api/agent/v1/blobs/"):
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(parent.first_frame_bytes)))
                    self.end_headers()
                    self.wfile.write(parent.first_frame_bytes)
                    return
                self._send_json(404, {"code": "NOT_FOUND", "message": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                if self.headers.get("x-video-factory-request") != "studio":
                    self._send_json(403, {"code": "FORBIDDEN", "message": "missing studio header"})
                    return
                if not (self.headers.get("Origin") or "").startswith("http://127.0.0.1:"):
                    self._send_json(403, {"code": "FORBIDDEN", "message": "origin mismatch"})
                    return
                if self.path == "/api/agent/v1/conversations":
                    length = int(self.headers.get("Content-Length", "0"))
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                    self._send_json(
                        201,
                        {
                            "conversationId": "conv_auto_created_1",
                            "title": payload.get("title", "Untitled"),
                            "revision": parent.revision,
                        },
                    )
                    return
                if self.path.endswith("/uploads"):
                    conv_id = self.path.split("/")[4]
                    ctype = self.headers.get("Content-Type", "")
                    length = int(self.headers.get("Content-Length", "0"))
                    body = self.rfile.read(length)
                    raw_msg = f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii") + body
                    msg = email.parser.BytesParser(policy=email.policy.default).parsebytes(raw_msg)
                    fields: dict[str, str] = {}
                    file_bytes = b""
                    file_name = ""
                    file_mime = "application/octet-stream"
                    for part in msg.iter_parts():
                        name = part.get_param("name", header="content-disposition")
                        fname = part.get_filename()
                        payload_bytes = part.get_payload(decode=True) or b""
                        if fname is not None:
                            file_name = fname
                            file_bytes = payload_bytes
                            file_mime = part.get_content_type()
                        elif name:
                            fields[name] = payload_bytes.decode("utf-8")
                    cmd_id = fields.get("commandId", "")
                    expected_rev = int(fields.get("expectedRevision", "0"))
                    rights = fields.get("rights", "")

                    if rights != "owned_or_licensed":
                        self._send_json(400, {"code": "INVALID_INPUT", "message": "bad rights"})
                        return
                    if cmd_id in parent.receipts_by_cmd:
                        self._send_json(201, parent.receipts_by_cmd[cmd_id])
                        return
                    if parent.inject_stale_once:
                        parent.inject_stale_once = False
                        parent.revision += 1
                        self._send_json(409, {"code": "STALE_REVISION", "message": "stale revision"})
                        return
                    if expected_rev != parent.revision:
                        self._send_json(409, {"code": "STALE_REVISION", "message": "rev mismatch"})
                        return

                    parent.revision += 1
                    idx = len(parent.uploads) + 1
                    receipt = {
                        "conversation": {"conversationId": conv_id, "revision": parent.revision},
                        "attachment": {
                            "source": {"artifactId": f"art_sim_{idx}", "revisionId": f"rev_sim_{idx}"},
                            "blobId": f"blob_sim_{idx}",
                            "mimeType": file_mime,
                            "durationMs": 5040 if file_name.endswith(".mp4") else 60000,
                            "facts": {
                                "fileName": file_name,
                                "sizeBytes": len(file_bytes),
                                "rights": rights,
                            },
                        },
                    }
                    parent.receipts_by_cmd[cmd_id] = receipt
                    parent.uploads.append({"cmd_id": cmd_id, "file_name": file_name, "size": len(file_bytes)})
                    self._send_json(201, receipt)
                    return
                self._send_json(404, {"code": "NOT_FOUND", "message": "unknown route"})

        self._httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        self.port = self._httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


FAKE_COLAB_SCRIPT = r"""#!/usr/bin/env python3
import json, os, pathlib, shutil, sys

state_file = pathlib.Path(os.environ["FAKE_COLAB_STATE"])
state = json.loads(state_file.read_text()) if state_file.is_file() else {"sessions": {}, "calls": [], "fs": {}}
args = sys.argv[1:]
while args and args[0] in ("--auth", "--config"):
    args = args[2:]

cmd = args[0]
state["calls"].append(args)

def save():
    state_file.write_text(json.dumps(state, indent=2))

def session_arg(a):
    if "-s" in a:
        return a[a.index("-s") + 1]
    if "--session" in a:
        return a[a.index("--session") + 1]
    return next(iter(state["sessions"]), None)

if cmd == "new":
    s = session_arg(args) or "auto-1"
    gpu = args[args.index("--gpu") + 1] if "--gpu" in args else "CPU"
    state["sessions"][s] = {"endpoint": f"gpu-{gpu.lower()}-ep-{s}", "hw": gpu}
    save()
    print(f"[colab] Creating session '{s}'...\n[colab] Session READY.")
elif cmd in ("sessions", "status"):
    s = session_arg(args) if cmd == "status" and ("-s" in args or "--session" in args) else None
    items = [(s, state["sessions"][s])] if s and s in state["sessions"] else list(state["sessions"].items())
    if not items:
        print("[colab] No active sessions found on server.")
    for name, info in items:
        print(f"[{name}] {info['endpoint']} | Hardware: {info['hw']} | Shape: High-RAM | Variant: GPU | Status: IDLE")
    save()
elif cmd == "drivemount":
    save()
    print("[colab] Mounted /content/drive")
elif cmd == "upload":
    s = session_arg(args)
    pos = [x for x in args[1:] if not x.startswith("-") and x != s]
    local_p, remote_p = pos[0], pos[1]
    dest = state_file.parent / "remote_fs" / s / remote_p.lstrip("/")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(local_p, dest)
    save()
    print(f"[colab] Uploaded '{local_p}' to '{remote_p}'")
elif cmd == "exec":
    s = session_arg(args)
    f_path = args[args.index("-f") + 1] if "-f" in args else ""
    envs = {}
    for i, tok in enumerate(args):
        if tok == "--env":
            k, v = args[i + 1].split("=", 1)
            envs[k] = v
    mode = os.environ.get("FAKE_COLAB_MODE", "ok")
    if "ltx25_remote_worker.py" in f_path:
        if mode == "fail_exec":
            save()
            sys.stderr.write("RuntimeError: Simulated CUDA OOM in LTX-2.5\n")
            sys.exit(1)
        if "LTX_JOB_CONFIG_FILE" in envs:
            cfg_p = state_file.parent / "remote_fs" / s / envs["LTX_JOB_CONFIG_FILE"].lstrip("/")
            cfg = json.loads(cfg_p.read_text())
        else:
            cfg = json.loads(envs["LTX_JOB_CONFIG_JSON"])
        rdir = state_file.parent / "remote_fs" / s / cfg["remote_job_dir"].lstrip("/")
        rdir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(os.environ["FAKE_SAMPLE_MP4"], rdir / "output.mp4")
        (rdir / "status.json").write_text(json.dumps({"state": "succeeded"}))
        (rdir / "meta.json").write_text(json.dumps({"gpu_name": "NVIDIA L4", "num_frames": cfg["num_frames"]}))
    save()
    print("[ltx25-worker] DONE")
elif cmd == "download":
    s = session_arg(args)
    pos = [x for x in args[1:] if not x.startswith("-") and x != s]
    remote_p, local_p = pos[0], pos[1]
    src = state_file.parent / "remote_fs" / s / remote_p.lstrip("/")
    if not src.is_file():
        save()
        sys.stderr.write(f"[colab] Remote file not found: {remote_p}\n")
        sys.exit(1)
    pathlib.Path(local_p).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, local_p)
    save()
    print(f"[colab] Downloaded '{remote_p}' to '{local_p}'")
elif cmd == "stop":
    s = session_arg(args)
    if s in state["sessions"]:
        del state["sessions"][s]
        save()
        print("[colab] Session terminated.")
    else:
        save()
        sys.stderr.write(f"[colab] Session '{s}' not found.\n")
        sys.exit(1)
elif cmd == "usage":
    save()
    print("Current balance: 1942.50 compute units\nUsage rate: 0.00/hr\nActive assignments: 0")
"""


FAKE_SW_SCRIPT = r"""#!/usr/bin/env python3
import json, os, pathlib, shutil, sqlite3, sys, time

sw_home = pathlib.Path(os.environ["STUDIOWRIGHT_HOME"])
log_file = sw_home / "sw_calls.json"
calls = json.loads(log_file.read_text()) if log_file.is_file() else []

args = sys.argv[1:]
profile = "default"
if "--profile" in args:
    i = args.index("--profile")
    profile = args[i + 1]
    args = args[:i] + args[i + 2:]

calls.append({"profile": profile, "args": args})
log_file.write_text(json.dumps(calls, indent=2))

if args == ["--version"]:
    print("StudioWright, version 0.4.0-sim")
    sys.exit(0)

cmd = args[0]
mode = os.environ.get("FAKE_SW_MODE", "ok")
db = sqlite3.connect(str(sw_home / "studiowright.db"))

if cmd == "doctor":
    print(json.dumps({"profile": profile, "ok": True, "checks": []}))
elif cmd == "video":
    prompt = args[1]
    if "--dry-run" in args:
        print(json.dumps({"job_id": "dry123", "project_id": "11111111-1111-1111-1111-111111111111", "credits": 15, "submitted": False}))
        sys.exit(0)
    out_dir = pathlib.Path(args[args.index("--out") + 1])
    out_dir.mkdir(parents=True, exist_ok=True)
    media_id = "22222222-2222-2222-2222-222222222222"
    proj_id = "11111111-1111-1111-1111-111111111111"
    # Always record submitted media_id in studiowright.db just like real StudioWright!
    db.execute(
        "INSERT OR REPLACE INTO jobs(id, kind, profile, project_id, params, status, result, created) VALUES(?,?,?,?,?,?,?,?)",
        (
            "swjob_vid_1",
            "video",
            profile,
            proj_id,
            json.dumps({"prompt": prompt}),
            "interrupted" if mode == "interrupt_after_submit" else "done",
            json.dumps({"stage": "submitted", "media_ids": [media_id]}),
            time.time(),
        ),
    )
    db.commit()
    if mode == "interrupt_after_submit":
        sys.stderr.write("PlaywrightError: simulated page wait interrupted after submit\n")
        sys.exit(1)
    dest = out_dir / "clip-1.mp4"
    shutil.copyfile(os.environ["FAKE_SAMPLE_MP4"], dest)
    print(json.dumps({
        "job_id": "swjob_vid_1",
        "project_id": proj_id,
        "files": [str(dest)],
        "media_ids": [media_id],
        "stage": "delivered",
        "credits": 15,
        "credits_left": 985,
        "seconds": 31.2,
    }))
elif cmd == "download":
    media_id = args[1]
    out_dir = pathlib.Path(args[args.index("--out") + 1])
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{media_id}.mp4"
    shutil.copyfile(os.environ["FAKE_SAMPLE_MP4"], dest)
    print(json.dumps({"project_id": "11111111-1111-1111-1111-111111111111", "files": [str(dest)], "errors": {}}))
elif cmd == "music":
    sub = args[1]
    if sub == "list":
        songs = json.loads((sw_home / "music_lib.json").read_text()) if (sw_home / "music_lib.json").is_file() else []
        credits = 450 if profile == "ultra-1" else 900
        print(json.dumps({"credits_remaining": credits, "plan": "Google AI Ultra", "songs": songs}))
    elif sub == "create":
        fmt = args[args.index("--format") + 1]
        title = args[args.index("--title") + 1]
        out_dir = pathlib.Path(args[args.index("--out") + 1])
        out_dir.mkdir(parents=True, exist_ok=True)
        song_id = "33333333-3333-3333-3333-333333333333"
        # Record song in library so timeout recovery can find it without re-generating!
        (sw_home / "music_lib.json").write_text(json.dumps([{"id": song_id, "title": title, "seconds": 60.0, "kind": "song"}]))
        if mode == "interrupt_music_after_submit":
            sys.stderr.write("PlaywrightError: simulated disconnect after Flow Music accepted song\n")
            sys.exit(1)
        dest = out_dir / f"track-1.{fmt}"
        shutil.copyfile(os.environ["FAKE_SAMPLE_WAV" if fmt == "wav" else "FAKE_SAMPLE_MP3"], dest)
        print(json.dumps({
            "job_id": "swjob_mus_1",
            "files": [str(dest)],
            "songs": [{"id": song_id, "title": title, "seconds": 60.0, "file": str(dest)}],
            "credits_remaining_before": 900,
            "plan": "Google AI Ultra",
            "seconds": 36.4,
        }))
    elif sub == "download":
        song_id = args[2]
        fmt = args[args.index("--format") + 1]
        out_dir = pathlib.Path(args[args.index("--out") + 1])
        out_dir.mkdir(parents=True, exist_ok=True)
        dest = out_dir / f"recovered-{song_id[:6]}.{fmt}"
        shutil.copyfile(os.environ["FAKE_SAMPLE_WAV" if fmt == "wav" else "FAKE_SAMPLE_MP3"], dest)
        print(json.dumps({"job_id": "swjob_mus_dl", "files": [str(dest)], "seconds": 4.1}))
"""


class UltraMediaSkillsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="vf-ultra-test-")
        self.root = pathlib.Path(self.tmp.name)
        self.state_dir = self.root / "state"
        self.assets_dir = self.root / "assets"
        self.assets_dir.mkdir(parents=True, exist_ok=True)

        self.sample_png = self.assets_dir / "first.png"
        self.sample_mp4 = self.assets_dir / "sample.mp4"
        self.sample_wav = self.assets_dir / "sample.wav"
        self.sample_mp3 = self.assets_dir / "sample.mp3"
        write_minimal_png(self.sample_png)
        copy_sample_mp4_or_minimal(self.sample_mp4)
        write_minimal_wav(self.sample_wav, duration_s=1.0)
        write_minimal_mp3(self.sample_mp3)

        self.frame_server = MockFrameServer(self.sample_png.read_bytes())

        # Prepare fake colab & fake sw binaries
        self.fake_colab = self.root / "fake_colab.py"
        self.fake_colab.write_text(FAKE_COLAB_SCRIPT, encoding="utf-8")
        self.fake_colab.chmod(0o755)
        self.colab_state = self.root / "colab_state.json"

        self.sw_home = self.root / "sw_home"
        self._init_fake_studiowright_home()
        self.fake_sw = self.root / "fake_sw.py"
        self.fake_sw.write_text(FAKE_SW_SCRIPT, encoding="utf-8")
        self.fake_sw.chmod(0o755)

    def tearDown(self) -> None:
        self.frame_server.close()
        self.tmp.cleanup()

    def _init_fake_studiowright_home(self) -> None:
        for idx, prof in enumerate(("ultra-1", "ultra-2"), start=1):
            prefs = self.sw_home / "profiles" / prof / "Default" / "Preferences"
            prefs.parent.mkdir(parents=True, exist_ok=True)
            prefs.write_text(
                json.dumps({"account_info": [{"email": f"ultra{idx}@example.com"}]}),
                encoding="utf-8",
            )
        conn = sqlite3.connect(str(self.sw_home / "studiowright.db"))
        conn.executescript(
            """
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, project_id TEXT,
                params TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
                created REAL NOT NULL, started REAL, finished REAL
            );
            CREATE TABLE pacing (
                profile TEXT PRIMARY KEY, next_free REAL NOT NULL DEFAULT 0,
                cooldown_until REAL NOT NULL DEFAULT 0, refusals INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?)",
            ("flow.credits.ultra-1", json.dumps({"credits": 420, "at": time.time()})),
        )
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?)",
            ("flow.credits.ultra-2", json.dumps({"credits": 960, "at": time.time()})),
        )
        conn.commit()
        conn.close()

    def _env(self, **extra: str) -> dict[str, str]:
        env = dict(os.environ)
        env.update(
            {
                "FAKE_COLAB_STATE": str(self.colab_state),
                "FAKE_SAMPLE_MP4": str(self.sample_mp4),
                "FAKE_SAMPLE_WAV": str(self.sample_wav),
                "FAKE_SAMPLE_MP3": str(self.sample_mp3),
                "STUDIOWRIGHT_HOME": str(self.sw_home),
                "ULTRA_MEDIA_CREDENTIALS_FILE": str(self.root / "isolated_credentials.env"),
                **extra,
            }
        )
        return env

    def test_01_skill_spec_and_links(self) -> None:
        skills_root = REPO_ROOT / ".agents" / "skills"
        expected = ("colab-ltx-video", "flow-video", "flow-music")
        for name in expected:
            skill_md = skills_root / name / "SKILL.md"
            self.assertTrue(skill_md.is_file(), f"Missing {skill_md}")
            text = skill_md.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("---\n"), f"{name}/SKILL.md must start with YAML frontmatter")
            fm = text.split("---\n", 2)[1]
            self.assertIn(f"name: {name}", fm)
            self.assertIn("description:", fm)
            for rel_link in re.findall(r"\]\((\.\.?/[^)]+)\)", text):
                target = (skill_md.parent / rel_link).resolve()
                self.assertTrue(target.is_file(), f"Broken link {rel_link} in {skill_md}")

    def test_02_colab_happy_path_stale_retry_replay_and_gpu_release(self) -> None:
        self.frame_server.inject_stale_once = True
        proc = subprocess.run(
            [
                sys.executable,
                str(COLAB_CLI),
                "run",
                "--state-dir",
                str(self.state_dir),
                "--colab-bin",
                str(self.fake_colab),
                "--frame-url",
                self.frame_server.url,
                "--frame-blob-id",
                "blob_first_frame_1",
                "--prompt",
                "Camera pushes in on mountain ridge at sunrise",
                "--preset",
                "720p",
                "--mount-drive",
                "--conversation-id",
                "conv_story_01",
            ],
            capture_output=True,
            text=True,
            env=self._env(),
            check=True,
        )
        res = json.loads(proc.stdout)
        self.assertEqual(res["status"], "ingested")
        self.assertFalse(res["replayed"])
        self.assertTrue(res["external_meta"]["runtime_cleaned"])
        self.assertEqual(res["frame_receipt"]["attachment"]["blobId"], "blob_sim_1")
        verify_media_file(pathlib.Path(res["local_file"]), "video")

        # Confirm zero active Colab sessions remain
        cstate = json.loads(self.colab_state.read_text())
        self.assertEqual(cstate["sessions"], {})
        new_calls_before = sum(1 for c in cstate["calls"] if c[0] == "new")
        self.assertEqual(new_calls_before, 1)

        # Re-run identical request -> must replay from ledger without allocating a second GPU!
        proc2 = subprocess.run(
            [
                sys.executable,
                str(COLAB_CLI),
                "run",
                "--state-dir",
                str(self.state_dir),
                "--colab-bin",
                str(self.fake_colab),
                "--frame-url",
                self.frame_server.url,
                "--frame-blob-id",
                "blob_first_frame_1",
                "--prompt",
                "Camera pushes in on mountain ridge at sunrise",
                "--preset",
                "720p",
                "--mount-drive",
                "--conversation-id",
                "conv_story_01",
            ],
            capture_output=True,
            text=True,
            env=self._env(),
            check=True,
        )
        res2 = json.loads(proc2.stdout)
        self.assertTrue(res2["replayed"])
        cstate_after = json.loads(self.colab_state.read_text())
        self.assertEqual(sum(1 for c in cstate_after["calls"] if c[0] == "new"), 1)
        self.assertEqual(len(self.frame_server.uploads), 1)

    def test_03_colab_failure_still_cleans_up_gpu_runtime(self) -> None:
        proc = subprocess.run(
            [
                sys.executable,
                str(COLAB_CLI),
                "run",
                "--state-dir",
                str(self.state_dir),
                "--colab-bin",
                str(self.fake_colab),
                "--first-frame",
                str(self.sample_png),
                "--prompt",
                "Simulated OOM shot",
            ],
            capture_output=True,
            text=True,
            env=self._env(FAKE_COLAB_MODE="fail_exec"),
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0)
        cstate = json.loads(self.colab_state.read_text())
        self.assertEqual(cstate["sessions"], {}, "Leaked Colab GPU session on failure!")
        self.assertTrue(any(c[0] == "stop" for c in cstate["calls"]))

    def test_04_colab_cu_plan(self) -> None:
        proc = subprocess.run(
            [
                sys.executable,
                str(COLAB_CLI),
                "plan-cu",
                "--colab-bin",
                str(self.fake_colab),
                "--query-live",
            ],
            capture_output=True,
            text=True,
            env=self._env(),
            check=True,
        )
        plan = json.loads(proc.stdout)
        self.assertEqual(plan["monthly_budget_cu"], 2000.0)
        self.assertIn("1942.50 compute units", plan["live_account_usage"])
        self.assertEqual(len(plan["profiles"]), 3)

    def test_05_studiowright_dual_ultra_verify_and_cooldown_failover(self) -> None:
        self.assertNotEqual(
            studiowright_debug_port("ultra-1"),
            studiowright_debug_port("ultra-2"),
        )
        ver = subprocess.run(
            [
                sys.executable,
                str(FLOW_VID_CLI),
                "verify",
                "--sw-bin",
                str(self.fake_sw),
                "--studiowright-home",
                str(self.sw_home),
                "--check-music-credits",
                "--doctor",
            ],
            capture_output=True,
            text=True,
            env=self._env(),
            check=True,
        )
        vdata = json.loads(ver.stdout)
        self.assertTrue(vdata["dual_ultra_ready"])
        self.assertEqual(vdata["ready_profiles"], ["ultra-1", "ultra-2"])

        # Put ultra-2 (which has 960 credits) into cooldown -> auto-router must pick ultra-1!
        conn = sqlite3.connect(str(self.sw_home / "studiowright.db"))
        conn.execute(
            "INSERT OR REPLACE INTO pacing(profile, next_free, cooldown_until, refusals) VALUES(?,?,?,?)",
            ("ultra-2", 0.0, time.time() + 1800.0, 1),
        )
        conn.commit()
        conn.close()

        dry = subprocess.run(
            [
                sys.executable,
                str(FLOW_VID_CLI),
                "run",
                "--sw-bin",
                str(self.fake_sw),
                "--studiowright-home",
                str(self.sw_home),
                "--prompt",
                "Test dry run failover",
                "--dry-run",
            ],
            capture_output=True,
            text=True,
            env=self._env(),
            check=True,
        )
        dres = json.loads(dry.stdout)
        self.assertTrue(dres["dry_run"])
        self.assertEqual(dres["selected_profile"], "ultra-1")
        self.assertEqual(dres["quote"]["credits"], 15)

    def test_06_flow_video_timeout_recovery_and_frame_ingest(self) -> None:
        # Simulate CLI interrupt right after Flow accepted media_id -> automatic recovery via `sw download`!
        proc = subprocess.run(
            [
                sys.executable,
                str(FLOW_VID_CLI),
                "run",
                "--state-dir",
                str(self.state_dir),
                "--sw-bin",
                str(self.fake_sw),
                "--studiowright-home",
                str(self.sw_home),
                "--frame-url",
                self.frame_server.url,
                "--start-frame",
                str(self.sample_png),
                "--prompt",
                "Slow push-in on coastal lighthouse at dusk",
                "--duration",
                "5",
                "--conversation-id",
                "conv_flow_vid",
            ],
            capture_output=True,
            text=True,
            env=self._env(FAKE_SW_MODE="interrupt_after_submit"),
            check=True,
        )
        res = json.loads(proc.stdout)
        self.assertEqual(res["status"], "ingested")
        self.assertEqual(res["external_meta"]["recovered_from"], "sw_download_media_id")
        self.assertEqual(res["external_meta"]["sw_profile"], "ultra-2")
        calls = json.loads((self.sw_home / "sw_calls.json").read_text())
        video_submits = [c for c in calls if c["args"][0] == "video"]
        downloads = [c for c in calls if c["args"][0] == "download"]
        self.assertEqual(len(video_submits), 1, "Must NOT submit video a second time!")
        self.assertEqual(len(downloads), 1, "Must recover via zero-credit `sw download`!")

    def test_07_flow_music_wav_and_mp3_recovery_and_frame_ingest(self) -> None:
        # 1) WAV with simulated post-submit interrupt -> recovers via `sw music list` + `sw music download`
        proc_wav = subprocess.run(
            [
                sys.executable,
                str(FLOW_MUS_CLI),
                "run",
                "--state-dir",
                str(self.state_dir),
                "--sw-bin",
                str(self.fake_sw),
                "--studiowright-home",
                str(self.sw_home),
                "--frame-url",
                self.frame_server.url,
                "--sound",
                "Warm acoustic documentary underscore, soft cello",
                "--format",
                "wav",
                "--conversation-id",
                "conv_flow_mus",
            ],
            capture_output=True,
            text=True,
            env=self._env(FAKE_SW_MODE="interrupt_music_after_submit"),
            check=True,
        )
        rwav = json.loads(proc_wav.stdout)
        self.assertEqual(rwav["status"], "ingested")
        self.assertEqual(rwav["external_meta"]["recovered_from"], "sw_music_download")
        self.assertEqual(
            verify_media_file(pathlib.Path(rwav["local_file"]), "audio")["mime_type"],
            "audio/wav",
        )

        # 2) MP3 normal run + Frame ingestion
        proc_mp3 = subprocess.run(
            [
                sys.executable,
                str(FLOW_MUS_CLI),
                "run",
                "--state-dir",
                str(self.state_dir),
                "--sw-bin",
                str(self.fake_sw),
                "--studiowright-home",
                str(self.sw_home),
                "--frame-url",
                self.frame_server.url,
                "--sound",
                "Upbeat synthwave travel montage",
                "--format",
                "mp3",
                "--conversation-id",
                "conv_flow_mus",
            ],
            capture_output=True,
            text=True,
            env=self._env(FAKE_SW_MODE="ok"),
            check=True,
        )
        rmp3 = json.loads(proc_mp3.stdout)
        self.assertEqual(rmp3["status"], "ingested")
        self.assertEqual(
            verify_media_file(pathlib.Path(rmp3["local_file"]), "audio")["mime_type"],
            "audio/mpeg",
        )

    def test_08_saved_credentials_autoload_and_auto_create_conversation(self) -> None:
        from ultra_media_common import save_credentials_env

        cred_file = self.root / "creds" / "credentials.env"
        save_credentials_env(
            {
                "HF_TOKEN": "hf_simulated_secret_token",
                "FRAME_BASE_URL": self.frame_server.url,
            },
            path=cred_file,
        )
        self.assertEqual(stat.S_IMODE(cred_file.stat().st_mode), 0o600)

        proc = subprocess.run(
            [
                sys.executable,
                str(COLAB_CLI),
                "run",
                "--state-dir",
                str(self.state_dir),
                "--colab-bin",
                str(self.fake_colab),
                "--first-frame",
                str(self.sample_png),
                "--prompt",
                "Auto-created conversation test shot",
                "--auto-create-conversation",
                "Colab 720p 验收会话",
            ],
            capture_output=True,
            text=True,
            env=self._env(ULTRA_MEDIA_CREDENTIALS_FILE=str(cred_file)),
            check=True,
        )
        res = json.loads(proc.stdout)
        self.assertEqual(res["status"], "ingested")
        self.assertEqual(res["external_meta"]["conversation_id"], "conv_auto_created_1")
        cstate = json.loads(self.colab_state.read_text())
        # hf_simulated_secret_token_not_in_argv: secret is uploaded via job_config.json, never leaked in argv
        exec_calls = [c for c in cstate["calls"] if c[0] == "exec" and any("LTX_JOB_CONFIG_FILE=" in x for x in c)]
        self.assertEqual(len(exec_calls), 1)
        self.assertFalse(any("hf_simulated_secret_token" in " ".join(c) for c in cstate["calls"]))
        session_name = res["external_id"]
        remote_cfg = json.loads(
            (self.colab_state.parent / "remote_fs" / session_name / "content" / "jobs" / res["task_id"] / "job_config.json").read_text()
        )
        self.assertEqual(remote_cfg["hf_token"], "hf_simulated_secret_token")

    def test_09_safetensors_integrity_and_revision_manifest_quarantine(self) -> None:
        import importlib.util
        import struct

        worker_path = REPO_ROOT / ".agents" / "skills" / "colab-ltx-video" / "scripts" / "ltx25_remote_worker.py"
        spec = importlib.util.spec_from_file_location("ltx25_remote_worker", str(worker_path))
        assert spec and spec.loader
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)

        def write_valid_safetensors(dest: pathlib.Path, payload_len: int = 256) -> None:
            dest.parent.mkdir(parents=True, exist_ok=True)
            header = {
                "__metadata__": {"format": "pt"},
                "weight": {"dtype": "BF16", "shape": [payload_len // 2], "data_offsets": [0, payload_len]},
            }
            h_bytes = json.dumps(header).encode("utf-8")
            dest.write_bytes(struct.pack("<Q", len(h_bytes)) + h_bytes + (b"\x01" * payload_len))

        cache_dir = self.root / "model_cache"
        req_files = worker.required_ltx25_files("conv")
        for rel in req_files.values():
            write_valid_safetensors(cache_dir / rel, 512)

        rev_a = "a" * 40
        rev_b = "b" * 40
        dl_calls: list[tuple[str, str]] = []

        def fake_downloader(*, repo_id: str, filename: str, revision: str, local_dir: pathlib.Path, token: str | None) -> pathlib.Path:
            dl_calls.append((filename, revision))
            out = pathlib.Path(local_dir) / filename
            write_valid_safetensors(out, 512)
            return out

        # 1) All 5 valid cached weights verified with 0 downloads
        _, rep1 = worker.verify_or_download_ltx25_weights(
            cache_dir,
            model_revision=rev_a,
            downloader=fake_downloader,
            revision_resolver=lambda _r, rev, _t: rev,
        )
        self.assertEqual(rep1["downloaded_count"], 0)
        self.assertEqual(rep1["reused_count"], 5)
        self.assertEqual(rep1["cache_source"], "ephemeral_warm")

        # 2) Truncate one weight file even though > 1 MiB header claims 2 MiB -> quarantined & re-downloaded!
        victim = cache_dir / req_files["transformer"]
        bad_hdr = json.dumps(
            {"weight": {"dtype": "BF16", "shape": [1048576], "data_offsets": [0, 2097152]}}
        ).encode("utf-8")
        # File is 1.2 MiB (> 1 MiB), so naive size check would have accepted it, but safetensors check catches it!
        victim.write_bytes(struct.pack("<Q", len(bad_hdr)) + bad_hdr + (b"\x00" * (1200 * 1024)))
        with self.assertRaises(worker.SafetensorsIntegrityError):
            worker.verify_safetensors_integrity(victim)

        _, rep2 = worker.verify_or_download_ltx25_weights(
            cache_dir,
            model_revision=rev_a,
            downloader=fake_downloader,
            revision_resolver=lambda _r, rev, _t: rev,
        )
        self.assertEqual(rep2["downloaded_count"], 1)
        self.assertEqual(rep2["reused_count"], 4)

        # 3) Pinned commit change (rev_a -> rev_b) invalidates stale revision and refreshes all 5 files
        dl_calls.clear()
        _, rep3 = worker.verify_or_download_ltx25_weights(
            cache_dir,
            model_revision=rev_b,
            downloader=fake_downloader,
            revision_resolver=lambda _r, rev, _t: rev,
        )
        self.assertEqual(rep3["downloaded_count"], 5)
        self.assertEqual(len(dl_calls), 5)

    def test_10_linux_single_account_cloud_preflight_and_distinct_flow_credits(self) -> None:
        cloud_sw_home = self.root / "cloud_sw_home"
        state_sep = self.root / "state_sep"

        # 1) Preflight with missing browser/login reports fallback_mode="draft_and_manual_upload" + disclosures
        pre_vid = subprocess.run(
            [
                sys.executable,
                str(FLOW_VID_CLI),
                "preflight",
                "--init-profile-dir",
                "--profiles",
                "cloud-1",
                "--sw-bin",
                "/nonexistent/sw",
                "--studiowright-home",
                str(cloud_sw_home),
            ],
            capture_output=True,
            text=True,
            env=self._env(),
            check=True,
        )
        pvid = json.loads(pre_vid.stdout)
        self.assertEqual(pvid["credit_unit"], "flow_video_credits")
        self.assertFalse(pvid["automated_ready"])
        self.assertEqual(pvid["fallback_mode"], "draft_and_manual_upload")
        self.assertIn("third_party_browser_automation", pvid["disclosure"])
        prof_dir = cloud_sw_home / "profiles" / "cloud-1"
        self.assertTrue(prof_dir.is_dir())
        self.assertEqual(stat.S_IMODE(prof_dir.stat().st_mode), 0o700)

        pre_mus = subprocess.run(
            [
                sys.executable,
                str(FLOW_MUS_CLI),
                "preflight",
                "--profiles",
                "cloud-1",
                "--sw-bin",
                "/nonexistent/sw",
                "--studiowright-home",
                str(cloud_sw_home),
            ],
            capture_output=True,
            text=True,
            env=self._env(),
            check=True,
        )
        pmus = json.loads(pre_mus.stdout)
        self.assertEqual(pmus["credit_unit"], "flow_music_credits")
        self.assertNotEqual(pvid["credit_unit"], pmus["credit_unit"])

        # 2) Draft + manual upload fallback for both Flow Video and Flow Music keeps credit units strictly separate
        dr_vid = json.loads(
            subprocess.run(
                [
                    sys.executable,
                    str(FLOW_VID_CLI),
                    "draft",
                    "--state-dir",
                    str(state_sep),
                    "--prompt",
                    "Manual fallback video shot",
                    "--conversation-id",
                    "conv_manual_1",
                ],
                capture_output=True,
                text=True,
                env=self._env(),
                check=True,
            ).stdout
        )
        self.assertEqual(dr_vid["status"], "draft_prepared")
        self.assertEqual(dr_vid["external_meta"]["credit_unit"], "flow_video_credits")

        manual_mp4 = self.root / "manual_dl.mp4"
        copy_sample_mp4_or_minimal(manual_mp4)
        ing_vid = json.loads(
            subprocess.run(
                [
                    sys.executable,
                    str(FLOW_VID_CLI),
                    "ingest-manual",
                    "--state-dir",
                    str(state_sep),
                    "--frame-url",
                    self.frame_server.url,
                    "--task-id",
                    dr_vid["task_id"],
                    "--file",
                    str(manual_mp4),
                    "--observed-credits-delta",
                    "10",
                ],
                capture_output=True,
                text=True,
                env=self._env(),
                check=True,
            ).stdout
        )
        self.assertEqual(ing_vid["status"], "ingested")
        self.assertEqual(ing_vid["external_meta"]["credit_unit"], "flow_video_credits")
        self.assertTrue(ing_vid["external_meta"]["balance_delta_is_observed_only"])

        manual_wav = self.root / "manual_song.wav"
        write_minimal_wav(manual_wav, duration_s=1.5, sample_rate=48000)
        ing_mus = json.loads(
            subprocess.run(
                [
                    sys.executable,
                    str(FLOW_MUS_CLI),
                    "ingest-manual",
                    "--state-dir",
                    str(state_sep),
                    "--frame-url",
                    self.frame_server.url,
                    "--file",
                    str(manual_wav),
                    "--observed-credits-delta",
                    "2",
                    "--conversation-id",
                    "conv_manual_1",
                ],
                capture_output=True,
                text=True,
                env=self._env(),
                check=True,
            ).stdout
        )
        self.assertEqual(ing_mus["status"], "ingested")
        self.assertEqual(ing_mus["external_meta"]["credit_unit"], "flow_music_credits")
        self.assertTrue(ing_mus["external_meta"]["media_facts"]["mix_ready_for_frame"])

        # Cross-channel ingest protection: Flow Music refuses to overwrite a Flow Video task_id
        bad_cross = subprocess.run(
            [
                sys.executable,
                str(FLOW_MUS_CLI),
                "ingest-manual",
                "--state-dir",
                str(state_sep),
                "--task-id",
                dr_vid["task_id"],
                "--file",
                str(manual_wav),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(bad_cross.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
