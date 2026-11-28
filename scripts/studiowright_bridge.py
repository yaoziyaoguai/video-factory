#!/usr/bin/env python3
"""StudioWright execution bridge supporting both Linux single-account cloud browser (`cloud-1`)
and optional macOS / SSH worker profiles (`ultra-1,ultra-2`).

Architecture & Compliance Boundaries:
1. Official Web Login (`official_web_login`):
   - User manually signs into their Google account inside an isolated `0700` Chrome user-data-dir
     (`~/.local/share/studiowright/profiles/cloud-1` on Linux) over a localhost-restricted (`127.0.0.1`)
     remote desktop/tunnel. Agents NEVER touch passwords, 2FA, CAPTCHAs, or anti-bot challenges.
2. Third-Party Browser Automation (`third_party_browser_automation`):
   - `StudioWright` (`sw`) is an unofficial third-party Chrome DevTools Protocol (CDP) tool that
     automates Google Labs Flow & Flow Music web pages; availability depends on web UI stability and
     Google Terms of Service. When unavailable or unauthenticated, callers fall back to `draft` +
     `ingest-manual` without spending credits.
3. Separate Paid APIs & Credit Units (`separate_paid_api`):
   - Distinct from paid Vertex AI / Gemini Veo & Lyria APIs (`CNY`/`USD`). Flow Video consumes
     `flow_video_credits` and Flow Music consumes `flow_music_credits`; records are never mixed.
"""

from __future__ import annotations

import json
import os
import pathlib
import shlex
import shutil
import subprocess
import sys
import zlib
from typing import Any

PORT_BASE = 9300
PORT_SPAN = 90

DISCLOSURE_BOUNDARY: dict[str, str] = {
    "official_web_login": (
        "Google 账号登录由用户在受限云端浏览器 Profile（127.0.0.1 隧道）手动完成；"
        "自动化脚本不读取密码、不处理验证码或人机验证挑战。"
    ),
    "third_party_browser_automation": (
        "StudioWright (`sw`) 属于第三方开源 CDP 浏览器自动化工具，非 Google 官方 SDK；"
        "受网页改版、风控与服务条款约束，不可用时自动退回提示词草稿 + 手动上传回流路径。"
    ),
    "separate_paid_api": (
        "与按量付费的 Vertex AI / Gemini Veo、Lyria API（人民币/美元计费）完全独立；"
        "本通路使用订阅内网页积分，且严格区分 `flow_video_credits` 与 `flow_music_credits`。"
    ),
}


def studiowright_debug_port(profile_name: str) -> int:
    """Matches `studiowright.chrome.debug_port` (`9300 + crc32(profile) % 90`)."""
    return PORT_BASE + (zlib.crc32(profile_name.encode("utf-8")) % PORT_SPAN)


def default_profiles_for_host(*, is_remote: bool, studiowright_home: str | None = None) -> list[str]:
    if sys.platform.startswith("linux") and not is_remote:
        if studiowright_home:
            p_root = pathlib.Path(studiowright_home).expanduser() / "profiles"
            if (p_root / "ultra-1").is_dir() and (p_root / "ultra-2").is_dir() and not (p_root / "cloud-1").is_dir():
                return ["ultra-1", "ultra-2"]
        return ["cloud-1"]
    return ["ultra-1", "ultra-2"]


class BridgeCommandError(RuntimeError):
    def __init__(
        self,
        cmd_desc: str,
        returncode: int,
        stdout: str,
        stderr: str,
        *,
        timed_out: bool = False,
    ) -> None:
        detail = (
            f"StudioWright command timed out: {cmd_desc}"
            if timed_out
            else f"StudioWright command failed (exit {returncode}): {cmd_desc}\n{(stderr or stdout).strip()[-600:]}"
        )
        super().__init__(detail)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.timed_out = timed_out


REMOTE_INSPECT_SCRIPT = r"""
import json, os, pathlib, shutil, sqlite3, stat, sys, time, zlib

req = json.loads(sys.stdin.read())
profiles = req.get("profiles") or (["cloud-1"] if sys.platform.startswith("linux") else ["ultra-1", "ultra-2"])
sw_home_env = req.get("studiowright_home") or os.environ.get("STUDIOWRIGHT_HOME", "").strip()

if sw_home_env:
    sw_home = pathlib.Path(sw_home_env).expanduser()
elif sys.platform == "darwin":
    sw_home = pathlib.Path.home() / "Library" / "Application Support" / "studiowright"
elif sys.platform == "win32":
    sw_home = pathlib.Path(os.environ.get("LOCALAPPDATA", "~")).expanduser() / "studiowright"
else:
    sw_home = pathlib.Path(os.environ.get("XDG_DATA_HOME", "~/.local/share")).expanduser() / "studiowright"

chrome_candidates = [
    pathlib.Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
]
for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
    w = shutil.which(name)
    if w:
        chrome_candidates.append(pathlib.Path(w))
chrome_path = next((str(p) for p in chrome_candidates if p.is_file()), None)

raw_sw = str(req.get("sw_bin") or "sw")
sw_first = raw_sw.split()[0] if raw_sw else "sw"
sw_exe = shutil.which(sw_first) or (sw_first if pathlib.Path(sw_first).is_file() else None)
xvfb_exe = shutil.which("xvfb-run")
display_env = os.environ.get("DISPLAY") or ""

db_path = sw_home / "studiowright.db"
pacing_map = {}
flow_credits_map = {}
job_counts = {}
recent_jobs = []

if db_path.is_file():
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        for row in conn.execute("SELECT profile, next_free, cooldown_until, refusals FROM pacing"):
            pacing_map[row["profile"]] = dict(row)
        for row in conn.execute("SELECT key, value FROM settings WHERE key LIKE 'flow.credits.%'"):
            prof = row["key"].split("flow.credits.", 1)[1]
            try:
                flow_credits_map[prof] = json.loads(row["value"])
            except Exception:
                pass
        for row in conn.execute("SELECT profile, COUNT(*) AS n FROM jobs GROUP BY profile"):
            job_counts[row["profile"]] = row["n"]
        if req.get("lookup_profile"):
            since = float(req.get("since_epoch") or 0)
            for row in conn.execute(
                "SELECT id, kind, profile, project_id, params, status, result, error, created, started, finished "
                "FROM jobs WHERE profile = ? AND created >= ? ORDER BY created DESC LIMIT 10",
                (req["lookup_profile"], since),
            ):
                d = dict(row)
                for k in ("params", "result"):
                    if d.get(k):
                        try:
                            d[k] = json.loads(d[k])
                        except Exception:
                            pass
                recent_jobs.append(d)
    finally:
        conn.close()

now = time.time()
profile_reports = []
seen_ports = {}
port_collisions = []

for prof in profiles:
    port = 9300 + (zlib.crc32(prof.encode("utf-8")) % 90)
    if port in seen_ports:
        port_collisions.append({"port": port, "profiles": [seen_ports[port], prof]})
    seen_ports[port] = prof

    pdir = sw_home / "profiles" / prof
    prefs = pdir / "Default" / "Preferences"
    cookies_db = pdir / "Default" / "Cookies"
    emails = []
    if prefs.is_file():
        try:
            accts = json.loads(prefs.read_text(encoding="utf-8")).get("account_info") or []
            emails = [a["email"] for a in accts if a.get("email")]
        except Exception:
            pass
    dir_mode = oct(stat.S_IMODE(pdir.stat().st_mode)) if pdir.is_dir() else None

    flow_pace = pacing_map.get(prof, {})
    music_pace = pacing_map.get(f"{prof}:music", {})
    cooldown_s = max(0.0, float(flow_pace.get("cooldown_until") or 0.0) - now)
    music_cooldown_s = max(0.0, float(music_pace.get("cooldown_until") or 0.0) - now)
    fc = flow_credits_map.get(prof)

    profile_reports.append({
        "profile": prof,
        "cdp_port": port,
        "profile_dir": str(pdir),
        "profile_dir_exists": pdir.is_dir(),
        "profile_dir_mode": dir_mode,
        "has_cookie_store": cookies_db.is_file(),
        "signed_in_emails": emails,
        "flow_credits_cached": fc.get("credits") if isinstance(fc, dict) else None,
        "flow_credits_seen_at": fc.get("at") if isinstance(fc, dict) else None,
        "flow_cooldown_remaining_s": round(cooldown_s, 1),
        "music_cooldown_remaining_s": round(music_cooldown_s, 1),
        "historical_jobs": job_counts.get(prof, 0),
    })

remote_files = []
if req.get("remote_out_dir"):
    od = pathlib.Path(req["remote_out_dir"]).expanduser()
    if od.is_dir():
        remote_files = sorted(str(p) for p in od.iterdir() if p.is_file())

print(json.dumps({
    "platform": sys.platform,
    "studiowright_home": str(sw_home),
    "chrome_executable": chrome_path,
    "studiowright_executable": sw_exe,
    "xvfb_run_executable": xvfb_exe,
    "display_configured": bool(display_env),
    "port_collisions": port_collisions,
    "profiles": profile_reports,
    "recent_jobs": recent_jobs,
    "remote_files": remote_files,
}))
"""


class StudioWrightBridge:
    """Executes StudioWright (`sw`) locally (Linux single-account cloud browser or macOS) or via SSH."""

    def __init__(
        self,
        *,
        mac_host: str | None = None,
        sw_bin: str | None = None,
        python_bin: str | None = None,
        studiowright_home: str | None = None,
        profiles: list[str] | None = None,
        ssh_options: list[str] | None = None,
    ) -> None:
        host = (mac_host or os.environ.get("FLOW_MAC_HOST") or "local").strip()
        self.mac_host = host
        self.is_remote = host.lower() not in ("", "local", "localhost", "127.0.0.1")
        self.sw_bin = sw_bin or os.environ.get("STUDIOWRIGHT_BIN") or "sw"
        self.python_bin = python_bin or os.environ.get("FLOW_MAC_PYTHON") or sys.executable or "python3"
        self.studiowright_home = studiowright_home or os.environ.get("FLOW_MAC_STUDIOWRIGHT_HOME")
        env_profiles = os.environ.get("FLOW_PROFILES", "").strip()
        if profiles:
            self.profiles = profiles
        elif env_profiles:
            self.profiles = [p.strip() for p in env_profiles.split(",") if p.strip()]
        else:
            self.profiles = default_profiles_for_host(
                is_remote=self.is_remote, studiowright_home=self.studiowright_home
            )
        self.ssh_options = ssh_options or [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
        ]

    def _remote_env_prefix(self) -> str:
        parts = ['export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";']
        if self.studiowright_home:
            parts.append(f"export STUDIOWRIGHT_HOME={shlex.quote(self.studiowright_home)};")
        return " ".join(parts)

    def ensure_local_cloud_profile_dir(self, profile: str | None = None) -> pathlib.Path:
        """Create owner-only `0700` StudioWright profile directory on local Linux cloud host."""
        prof = profile or self.profiles[0]
        if self.studiowright_home:
            base = pathlib.Path(self.studiowright_home).expanduser()
        elif sys.platform == "darwin":
            base = pathlib.Path.home() / "Library" / "Application Support" / "studiowright"
        else:
            base = pathlib.Path(os.environ.get("XDG_DATA_HOME", "~/.local/share")).expanduser() / "studiowright"
        pdir = base / "profiles" / prof
        pdir.mkdir(parents=True, exist_ok=True)
        for cur in (base, base / "profiles", pdir):
            try:
                os.chmod(cur, 0o700)
            except OSError:
                pass
        return pdir

    def run_python_probe(self, payload: dict[str, Any], *, timeout_s: float = 30.0) -> dict[str, Any]:
        merged_payload = {"sw_bin": self.sw_bin, **payload}
        stdin_text = json.dumps(merged_payload, ensure_ascii=False)
        if not self.is_remote:
            env = dict(os.environ)
            if self.studiowright_home:
                env["STUDIOWRIGHT_HOME"] = self.studiowright_home
            proc = subprocess.run(
                [self.python_bin, "-c", REMOTE_INSPECT_SCRIPT],
                input=stdin_text,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                env=env,
                check=False,
            )
        else:
            remote_cmd = (
                f"{self._remote_env_prefix()} "
                f"{shlex.quote(self.python_bin)} -c {shlex.quote(REMOTE_INSPECT_SCRIPT)}"
            )
            proc = subprocess.run(
                ["ssh", *self.ssh_options, self.mac_host, remote_cmd],
                input=stdin_text,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        if proc.returncode != 0:
            raise BridgeCommandError("python-probe", proc.returncode, proc.stdout, proc.stderr)
        return json.loads(proc.stdout)

    def _maybe_wrap_xvfb(self, sw_cmd_tokens: list[str], sw_args: list[str]) -> list[str]:
        if self.is_remote or not sys.platform.startswith("linux"):
            return sw_cmd_tokens
        if sw_args == ["--version"] or os.environ.get("DISPLAY"):
            return sw_cmd_tokens
        xvfb_mode = os.environ.get("FLOW_USE_XVFB", "auto").strip().lower()
        if xvfb_mode in ("0", "false", "no"):
            return sw_cmd_tokens
        xvfb_bin = shutil.which("xvfb-run")
        if not xvfb_bin:
            return sw_cmd_tokens
        # In `auto` mode, wrap with xvfb-run only when using real `sw` (not a synthetic test script)
        if xvfb_mode == "1" or pathlib.Path(sw_cmd_tokens[0]).name == "sw":
            return [xvfb_bin, "-a", "--server-args=-screen 0 1440x900x24", *sw_cmd_tokens]
        return sw_cmd_tokens

    def run_sw(
        self,
        profile: str,
        sw_args: list[str],
        *,
        timeout_s: float = 600.0,
        expect_json: bool = True,
    ) -> dict[str, Any] | str:
        raw_tokens = [*shlex.split(self.sw_bin), "--profile", profile, *sw_args]
        exec_tokens = self._maybe_wrap_xvfb(raw_tokens, sw_args)
        cmd_desc = " ".join(shlex.quote(t) for t in raw_tokens)
        try:
            if not self.is_remote:
                env = dict(os.environ)
                if self.studiowright_home:
                    env["STUDIOWRIGHT_HOME"] = self.studiowright_home
                proc = subprocess.run(
                    exec_tokens,
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    env=env,
                    check=False,
                )
            else:
                remote_line = f"{self._remote_env_prefix()} {cmd_desc}"
                proc = subprocess.run(
                    ["ssh", *self.ssh_options, self.mac_host, remote_line],
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    check=False,
                )
        except FileNotFoundError as exc:
            raise BridgeCommandError(
                cmd_desc,
                127,
                "",
                f"Executable not found: {exc.filename}. Install StudioWright (`uv tool install git+https://github.com/umutkocak/studiowright`).",
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise BridgeCommandError(
                cmd_desc,
                124,
                (exc.stdout or "") if isinstance(exc.stdout, str) else "",
                (exc.stderr or "") if isinstance(exc.stderr, str) else "",
                timed_out=True,
            ) from exc

        if proc.returncode != 0:
            raise BridgeCommandError(cmd_desc, proc.returncode, proc.stdout, proc.stderr)

        if not expect_json:
            return proc.stdout.strip()
        try:
            return json.loads(proc.stdout)
        except ValueError as exc:
            raise BridgeCommandError(
                cmd_desc,
                proc.returncode,
                proc.stdout,
                f"Invalid JSON from `sw`: {exc}\nRaw stdout: {proc.stdout[:400]}",
            ) from exc

    def stage_to_worker(self, local_path: pathlib.Path, task_id: str) -> str:
        local_path = local_path.expanduser().resolve()
        if not local_path.is_file():
            raise FileNotFoundError(f"Input file not found: {local_path}")
        if not self.is_remote:
            return str(local_path)

        remote_dir = f"$HOME/.cache/vf-studiowright/in/{shlex.quote(task_id)}"
        mkdir_proc = subprocess.run(
            ["ssh", *self.ssh_options, self.mac_host, f"mkdir -p {remote_dir} && cd {remote_dir} && pwd"],
            capture_output=True,
            text=True,
            timeout=30.0,
            check=False,
        )
        if mkdir_proc.returncode != 0:
            raise BridgeCommandError("ssh mkdir", mkdir_proc.returncode, mkdir_proc.stdout, mkdir_proc.stderr)
        abs_remote_dir = mkdir_proc.stdout.strip().splitlines()[-1]
        remote_file = f"{abs_remote_dir}/{local_path.name}"
        scp_proc = subprocess.run(
            ["scp", "-q", *self.ssh_options, str(local_path), f"{self.mac_host}:{remote_file}"],
            capture_output=True,
            text=True,
            timeout=120.0,
            check=False,
        )
        if scp_proc.returncode != 0:
            raise BridgeCommandError("scp upload", scp_proc.returncode, scp_proc.stdout, scp_proc.stderr)
        return remote_file

    def prepare_worker_out_dir(self, task_id: str, local_fallback: pathlib.Path) -> str:
        if not self.is_remote:
            local_fallback.mkdir(parents=True, exist_ok=True)
            return str(local_fallback.resolve())
        remote_dir = f"$HOME/.cache/vf-studiowright/out/{shlex.quote(task_id)}"
        proc = subprocess.run(
            ["ssh", *self.ssh_options, self.mac_host, f"mkdir -p {remote_dir} && cd {remote_dir} && pwd"],
            capture_output=True,
            text=True,
            timeout=30.0,
            check=False,
        )
        if proc.returncode != 0:
            raise BridgeCommandError("ssh mkdir out", proc.returncode, proc.stdout, proc.stderr)
        return proc.stdout.strip().splitlines()[-1]

    def fetch_from_worker(self, worker_file: str, local_dest: pathlib.Path) -> pathlib.Path:
        local_dest.parent.mkdir(parents=True, exist_ok=True)
        if not self.is_remote:
            src = pathlib.Path(worker_file).expanduser().resolve()
            if src != local_dest.resolve():
                shutil.copyfile(src, local_dest)
            return local_dest
        tmp_dest = local_dest.with_suffix(local_dest.suffix + ".part")
        tmp_dest.unlink(missing_ok=True)
        proc = subprocess.run(
            ["scp", "-q", *self.ssh_options, f"{self.mac_host}:{worker_file}", str(tmp_dest)],
            capture_output=True,
            text=True,
            timeout=300.0,
            check=False,
        )
        if proc.returncode != 0:
            raise BridgeCommandError("scp download", proc.returncode, proc.stdout, proc.stderr)
        tmp_dest.replace(local_dest)
        return local_dest

    def cleanup_worker_staging(self, task_id: str) -> None:
        if not self.is_remote:
            return
        remote_in = f"$HOME/.cache/vf-studiowright/in/{shlex.quote(task_id)}"
        subprocess.run(
            ["ssh", *self.ssh_options, self.mac_host, f"rm -rf {remote_in}"],
            capture_output=True,
            text=True,
            timeout=30.0,
            check=False,
        )

    def verify_dual_accounts(
        self,
        *,
        live_music_credits: bool = False,
        run_doctor: bool = False,
    ) -> dict[str, Any]:
        """Verify Chrome, StudioWright CLI, CDP port isolation, and configured account profiles."""
        probe = self.run_python_probe({"profiles": self.profiles})
        sw_ver = None
        sw_ready = False
        try:
            ver_out = self.run_sw(self.profiles[0], ["--version"], timeout_s=20.0, expect_json=False)
            sw_ver = str(ver_out)
            sw_ready = True
        except BridgeCommandError as exc:
            sw_ver = f"unavailable ({exc})"

        for p_info in probe["profiles"]:
            prof = p_info["profile"]
            if sw_ready and live_music_credits and p_info["profile_dir_exists"]:
                try:
                    lib = self.run_sw(prof, ["music", "list", "--limit", "0", "--json"], timeout_s=60.0)
                    if isinstance(lib, dict):
                        p_info["music_credits_live"] = lib.get("credits_remaining")
                        p_info["music_plan"] = lib.get("plan")
                except BridgeCommandError as exc:
                    p_info["music_credits_error"] = str(exc)
            if sw_ready and run_doctor and p_info["profile_dir_exists"]:
                try:
                    doc = self.run_sw(prof, ["doctor", "--music", "--json"], timeout_s=120.0, expect_json=False)
                    p_info["doctor_output"] = str(doc)[:500]
                except BridgeCommandError as exc:
                    p_info["doctor_error"] = str(exc)

        ready_profiles = [
            p["profile"]
            for p in probe["profiles"]
            if p["profile_dir_exists"] and (len(p["signed_in_emails"]) > 0 or p.get("has_cookie_store"))
        ]
        return {
            "mac_host": self.mac_host,
            "is_remote_ssh": self.is_remote,
            "account_mode": "single_cloud_browser" if len(self.profiles) == 1 else "multi_profile",
            "studiowright_version": sw_ver,
            "studiowright_ready": sw_ready,
            **probe,
            "single_account_ready": bool(
                probe.get("chrome_executable")
                and sw_ready
                and len(ready_profiles) >= 1
                and len(probe["port_collisions"]) == 0
            ),
            "dual_ultra_ready": len(ready_profiles) >= 2 and len(probe["port_collisions"]) == 0,
            "ready_profiles": ready_profiles,
            "disclosure": DISCLOSURE_BOUNDARY,
        }

    def preflight_channel(
        self,
        channel: str,
        *,
        init_profile_dir: bool = False,
        probe_live: bool = False,
    ) -> dict[str, Any]:
        """Zero-credit preflight for `flow_video` or `flow_music` on single-account cloud browser."""
        if channel not in ("flow_video", "flow_music"):
            raise ValueError(f"Unsupported Flow channel: {channel}")
        credit_unit = "flow_music_credits" if channel == "flow_music" else "flow_video_credits"
        primary_profile = self.profiles[0]
        if init_profile_dir and not self.is_remote:
            self.ensure_local_cloud_profile_dir(primary_profile)

        status = self.verify_dual_accounts(
            live_music_credits=(probe_live and channel == "flow_music"),
            run_doctor=(probe_live and channel == "flow_music"),
        )
        missing: list[str] = []
        if not status.get("chrome_executable"):
            missing.append("chrome_browser")
        if not status.get("studiowright_ready"):
            missing.append("studiowright_cli")
        if (
            sys.platform.startswith("linux")
            and not self.is_remote
            and not status.get("display_configured")
            and not status.get("xvfb_run_executable")
        ):
            missing.append("xvfb_or_display")
        if not status.get("ready_profiles"):
            missing.append("user_manual_google_login")

        music_auth_state = "not_applicable"
        if channel == "flow_music":
            first_prof = (status.get("profiles") or [{}])[0]
            if "music_credits_live" in first_prof:
                music_auth_state = "verified"
            elif "music_credits_error" in first_prof:
                music_auth_state = f"requires_music_page_auth_or_terms ({first_prof['music_credits_error'][:200]})"
                missing.append("flow_music_page_authorization")
            else:
                music_auth_state = "unchecked_until_browser_ready"

        automated_ready = len(missing) == 0
        pdir_str = (
            status["profiles"][0]["profile_dir"]
            if status.get("profiles")
            else f"~/.local/share/studiowright/profiles/{primary_profile}"
        )
        target_url = (
            "https://labs.google/fx/tools/flow"
            if channel == "flow_video"
            else "https://labs.google/fx/tools/flow"
        )
        return {
            "channel": channel,
            "credit_unit": credit_unit,
            "zero_credit_preflight": True,
            "automated_ready": automated_ready,
            "missing_requirements": missing,
            "music_page_auth_status": music_auth_state,
            "fallback_mode": None if automated_ready else "draft_and_manual_upload",
            "primary_profile": primary_profile,
            "profile_dir": pdir_str,
            "manual_user_login_steps": [
                f"1. 在云端受限桌面（仅绑定 127.0.0.1 SSH 转发）启动独立 Profile 浏览器：google-chrome --user-data-dir={pdir_str} {target_url}",
                "2. 由用户本人完成单账号 Google 登录与（若 Flow Music 首次进入）音乐页面条款确认，随后关闭浏览器窗口。",
                f"3. 重新运行零积分预检确认 `automated_ready: true`（积分单位固定为 `{credit_unit}`，不与另一通道混记）。",
            ],
            "environment": status,
            "disclosure": DISCLOSURE_BOUNDARY,
        }

    def select_profile(self, requested_profile: str, kind: str) -> tuple[str, dict[str, Any]]:
        """Select a specific profile or auto-route across healthy accounts."""
        probe = self.run_python_probe({"profiles": self.profiles})
        by_name = {p["profile"]: p for p in probe["profiles"]}
        if requested_profile and requested_profile != "auto":
            info = by_name.get(requested_profile, {"profile": requested_profile})
            cd_key = "music_cooldown_remaining_s" if kind == "flow_music" else "flow_cooldown_remaining_s"
            if float(info.get(cd_key) or 0.0) > 0:
                raise RuntimeError(
                    f"Requested StudioWright profile '{requested_profile}' is in cooldown "
                    f"for {info[cd_key]}s."
                )
            return requested_profile, info

        candidates = []
        for p in probe["profiles"]:
            cd_key = "music_cooldown_remaining_s" if kind == "flow_music" else "flow_cooldown_remaining_s"
            if float(p.get(cd_key) or 0.0) > 0:
                continue
            candidates.append(p)

        if not candidates:
            raise RuntimeError(
                f"All configured StudioWright profiles ({', '.join(self.profiles)}) are cooling down."
            )

        def _score(item: dict[str, Any]) -> tuple[int, int, int]:
            signed_in = (
                1
                if (
                    item.get("profile_dir_exists")
                    and (item.get("signed_in_emails") or item.get("has_cookie_store"))
                )
                else 0
            )
            credits = item.get("flow_credits_cached")
            credit_score = int(credits) if isinstance(credits, (int, float)) else 500
            neg_jobs = -int(item.get("historical_jobs") or 0)
            return (signed_in, credit_score, neg_jobs)

        chosen = sorted(candidates, key=_score, reverse=True)[0]
        return str(chosen["profile"]), chosen
