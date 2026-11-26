#!/usr/bin/env python3
"""Server-side configuration & one-time auth entry point for Google Colab CLI, Hugging Face, and Frame.

Designed for headless Linux servers where:
- Your Mac is ONLY used once in a browser to approve the Google OAuth URL (and get HF_TOKEN),
  and after your Mac is powered off, this server runs all Colab + Frame tasks autonomously
  across any SSH session without re-login.
- Credentials live outside the git repository with strict 0700/0600 permissions:
  - Google Colab OAuth refresh token -> `~/.local/share/python_keyring/keyring_pass.cfg` (0600)
  - HF_TOKEN & Frame credentials     -> `~/.config/ultra-media/credentials.env` (0600)
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[0]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from ultra_media_common import (  # noqa: E402
    CREDENTIALS_ENV_PATH,
    FrameApiError,
    FrameClient,
    load_saved_credentials,
    save_credentials_env,
)

COLAB_UV_PYTHON = pathlib.Path.home() / ".local" / "share" / "uv" / "tools" / "google-colab-cli" / "bin" / "python"
BUNDLED_COLAB_BIN = pathlib.Path("/opt/frame-colab/venv/bin/colab")
PENDING_OAUTH_STATE = CREDENTIALS_ENV_PATH.parent / "oauth_pending_pkce.json"
DEFAULT_FRAME_URL = f"http://127.0.0.1:{os.environ.get('STUDIO_PORT', '4318')}"


def resolve_colab_bin_and_python() -> tuple[str, pathlib.Path]:
    raw_bin = (os.environ.get("COLAB_CLI_BIN") or "").strip()
    if raw_bin:
        first = shlex.split(raw_bin)[0]
        resolved = shutil.which(first) or first
    else:
        resolved = (
            shutil.which("colab")
            or (str(BUNDLED_COLAB_BIN) if BUNDLED_COLAB_BIN.is_file() else "")
            or str(pathlib.Path.home() / ".local" / "bin" / "colab")
        )
    bin_path = pathlib.Path(resolved)
    if bin_path.is_file():
        sibling_py = bin_path.resolve().parent / "python"
        if sibling_py.is_file():
            return str(bin_path), sibling_py
        try:
            first_line = bin_path.read_text(encoding="utf-8", errors="ignore").splitlines()[0]
            if first_line.startswith("#!"):
                shebang_py = pathlib.Path(shlex.split(first_line[2:].strip())[0])
                if shebang_py.is_file():
                    return str(bin_path), shebang_py
        except OSError:
            pass
    return str(bin_path), COLAB_UV_PYTHON


def ensure_keyring_configured() -> None:
    kr_cfg_dir = pathlib.Path.home() / ".config" / "python_keyring"
    kr_data_dir = pathlib.Path.home() / ".local" / "share" / "python_keyring"
    kr_cfg_dir.mkdir(parents=True, exist_ok=True)
    kr_data_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(kr_cfg_dir, 0o700)
    os.chmod(kr_data_dir, 0o700)
    cfg_file = kr_cfg_dir / "keyringrc.cfg"
    if not cfg_file.is_file():
        cfg_file.write_text("[backend]\ndefault-keyring = keyrings.alt.file.PlaintextKeyring\n", encoding="utf-8")
    os.chmod(cfg_file, 0o600)
    pass_file = kr_data_dir / "keyring_pass.cfg"
    if not pass_file.exists():
        pass_file.touch()
    os.chmod(pass_file, 0o600)


def check_hf_token(token: str) -> dict[str, Any]:
    """Verify HF token validity AND gated access to `Lightricks/LTX-2.5`."""
    token = token.strip()
    if not token:
        return {"configured": False, "valid": False, "gated_access": False, "detail": "Empty token"}

    headers = {"Authorization": f"Bearer {token}", "User-Agent": "video-factory-ultra-config/1.0"}
    user_name = None
    try:
        req = urllib.request.Request("https://huggingface.co/api/whoami-v2", headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            info = json.loads(resp.read().decode("utf-8"))
            user_name = info.get("name")
    except urllib.error.HTTPError as exc:
        return {
            "configured": True,
            "valid": False,
            "gated_access": False,
            "detail": f"HF token rejected by whoami-v2 (HTTP {exc.code})",
        }
    except Exception as exc:
        return {"configured": True, "valid": False, "gated_access": False, "detail": str(exc)}

    # Check actual gated weight tensor read access (README.md is served publicly for model cards)
    try:
        req_gated = urllib.request.Request(
            "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors",
            headers={**headers, "Range": "bytes=0-15"},
        )
        with urllib.request.urlopen(req_gated, timeout=15) as resp:
            ok = resp.status in (200, 206)
            return {
                "configured": True,
                "valid": True,
                "hf_user": user_name,
                "gated_access": ok,
                "detail": "Ready (Lightricks/LTX-2.5 gated weight read verified)",
            }
    except urllib.error.HTTPError as exc:
        err_msg = exc.headers.get("X-Error-Message") or f"HTTP {exc.code}"
        return {
            "configured": True,
            "valid": True,
            "hf_user": user_name,
            "gated_access": False,
            "detail": (
                f"Token valid for '{user_name}', but Lightricks/LTX-2.5 weight access returned {exc.code}: {err_msg}"
            ),
        }
    except Exception as exc:
        return {
            "configured": True,
            "valid": True,
            "hf_user": user_name,
            "gated_access": False,
            "detail": str(exc),
        }


def check_colab_non_interactive() -> dict[str, Any]:
    """Verify `colab usage` succeeds in a brand-new clean-env login shell without prompting."""
    ensure_keyring_configured()
    colab_bin, colab_py = resolve_colab_bin_and_python()
    if not pathlib.Path(colab_bin).is_file():
        return {"installed": False, "authenticated": False, "detail": "colab CLI not installed"}

    # First check via keyring inside colab's Python environment whether a token exists at all, so we never
    # trigger an interactive prompt that waits on EOF or prints a noisy traceback.
    has_token_py = (
        "import json, keyring; "
        "raw = keyring.get_password('google-colab-cli', 'oauth_token'); "
        "print(json.dumps({'has_token': bool(raw)}))"
    )
    probe = subprocess.run(
        [str(colab_py), "-c", has_token_py],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    has_token = False
    if probe.returncode == 0:
        try:
            has_token = bool(json.loads(probe.stdout).get("has_token"))
        except ValueError:
            has_token = False

    adc_file = pathlib.Path.home() / ".config" / "gcloud" / "application_default_credentials.json"
    if not has_token and not adc_file.is_file():
        return {
            "installed": True,
            "authenticated": False,
            "detail": "Not authorized yet (run `ultra-config setup` or `ultra-config google-auth-url`).",
        }

    # Simulate a brand-new non-interactive session with clean environment and closed stdin
    bin_dir = str(pathlib.Path(colab_bin).resolve().parent)
    clean_env = {
        "HOME": str(pathlib.Path.home()),
        "USER": os.environ.get("USER", ""),
        "LANG": "C.UTF-8",
        "PATH": f"{bin_dir}:{pathlib.Path.home() / '.local' / 'bin'}:/usr/local/bin:/usr/bin:/bin",
    }
    for proxy_key in ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"):
        if os.environ.get(proxy_key):
            clean_env[proxy_key] = os.environ[proxy_key]
    auth_args = [colab_bin, "usage"] if has_token else [colab_bin, "--auth", "adc", "usage"]
    proc = subprocess.run(
        auth_args,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        env=clean_env,
        timeout=45,
        check=False,
    )
    if proc.returncode == 0 and "Current balance:" in proc.stdout:
        return {
            "installed": True,
            "authenticated": True,
            "auth_mode": "oauth2-keyring" if has_token else "adc",
            "usage": proc.stdout.strip(),
        }
    return {
        "installed": True,
        "authenticated": False,
        "detail": (proc.stderr or proc.stdout).strip()[-400:],
    }


def check_frame_status(saved: dict[str, str]) -> dict[str, Any]:
    base_url = saved.get("FRAME_BASE_URL") or os.environ.get("FRAME_BASE_URL") or DEFAULT_FRAME_URL
    client = FrameClient(base_url=base_url)
    health_ok = False
    try:
        with urllib.request.urlopen(f"{client.base_url}/api/health", timeout=10) as resp:
            health = json.loads(resp.read().decode("utf-8"))
            health_ok = health.get("status") == "ok"
    except Exception as exc:
        return {"base_url": client.base_url, "reachable": False, "authenticated": False, "detail": str(exc)}

    try:
        client.ensure_authenticated()
        session = client._request_json("GET", "/api/auth/session")
        authed = bool(session.get("authenticated"))
        return {
            "base_url": client.base_url,
            "reachable": health_ok,
            "authenticated": authed,
            "username": session.get("username"),
            "owner_id": session.get("ownerId"),
            "detail": "Ready for MP4 upload" if authed else "Reachable, but Frame login credentials/cookie not set yet",
        }
    except FrameApiError as exc:
        return {
            "base_url": client.base_url,
            "reachable": health_ok,
            "authenticated": False,
            "detail": str(exc),
        }


def cmd_google_auth_url(_args: argparse.Namespace) -> dict[str, Any]:
    """Generate a one-time Google OAuth URL using colab-cli's exact client config & PKCE verifier."""
    ensure_keyring_configured()
    helper = r"""
import json
from importlib import resources
from google_auth_oauthlib.flow import InstalledAppFlow
from colab_cli.auth import PUBLIC_SCOPES, REMOTE_REDIRECT_URI

cfg = json.loads(resources.files("colab_cli").joinpath("oauth_config.json").read_text())
flow = InstalledAppFlow.from_client_config(cfg, PUBLIC_SCOPES)
flow.redirect_uri = REMOTE_REDIRECT_URI
auth_url, state = flow.authorization_url(prompt="consent", access_type="offline", token_usage="remote")
print(json.dumps({
    "auth_url": auth_url,
    "state": state,
    "code_verifier": getattr(flow, "code_verifier", None),
}))
"""
    _colab_bin, colab_py = resolve_colab_bin_and_python()
    proc = subprocess.run(
        [str(colab_py), "-c", helper],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    data = json.loads(proc.stdout)
    PENDING_OAUTH_STATE.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(PENDING_OAUTH_STATE.parent, 0o700)
    PENDING_OAUTH_STATE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.chmod(PENDING_OAUTH_STATE, 0o600)
    return {
        "auth_url": data["auth_url"],
        "next_step": (
            "Open `auth_url` in your browser, approve access, copy the authorization code, and run "
            "`python3 scripts/ultra_config.py google-auth-code` "
            "(in production container: `docker exec -it video_factory_prod python3 scripts/ultra_config.py google-auth-code`) "
            "to paste it via hidden prompt."
        ),
    }


def cmd_google_auth_code(args: argparse.Namespace) -> dict[str, Any]:
    """Exchange pasted Google authorization code and persist refresh token into server keyring."""
    ensure_keyring_configured()
    code = (args.code or "").strip()
    if not code:
        code = getpass.getpass("Paste Google authorization code: ").strip()
    if not code:
        raise ValueError("Authorization code cannot be empty.")

    pending = json.loads(PENDING_OAUTH_STATE.read_text(encoding="utf-8")) if PENDING_OAUTH_STATE.is_file() else {}
    helper = r"""
import json, sys, keyring
from importlib import resources
from google_auth_oauthlib.flow import InstalledAppFlow
from colab_cli.auth import PUBLIC_SCOPES, REMOTE_REDIRECT_URI, KEYRING_SERVICE_NAME, KEYRING_USERNAME

payload = json.loads(sys.stdin.read())
cfg = json.loads(resources.files("colab_cli").joinpath("oauth_config.json").read_text())
flow = InstalledAppFlow.from_client_config(cfg, PUBLIC_SCOPES, state=payload.get("state"))
flow.redirect_uri = REMOTE_REDIRECT_URI
if payload.get("code_verifier"):
    flow.code_verifier = payload["code_verifier"]
flow.oauth2session.scope = None
token = flow.fetch_token(code=payload["code"])
flow.oauth2session.scope = token.get("scope")
keyring.set_password(KEYRING_SERVICE_NAME, KEYRING_USERNAME, flow.credentials.to_json())
print(json.dumps({"saved": True, "has_refresh_token": bool(flow.credentials.refresh_token)}))
"""
    _colab_bin, colab_py = resolve_colab_bin_and_python()
    proc = subprocess.run(
        [str(colab_py), "-c", helper],
        input=json.dumps({"code": code, **pending}),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Failed to exchange Google auth code: {(proc.stderr or proc.stdout).strip()}")
    PENDING_OAUTH_STATE.unlink(missing_ok=True)
    os.chmod(pathlib.Path.home() / ".local" / "share" / "python_keyring" / "keyring_pass.cfg", 0o600)
    colab_status = check_colab_non_interactive()
    return {"exchange": json.loads(proc.stdout), "colab": colab_status}


def cmd_set_hf(args: argparse.Namespace) -> dict[str, Any]:
    if args.stdin:
        token = sys.stdin.read().strip()
    elif args.token:
        token = args.token.strip()
    else:
        token = getpass.getpass("Enter Hugging Face Read Token (hf_...): ").strip()
    if not token:
        raise ValueError("HF_TOKEN cannot be empty.")
    save_credentials_env({"HF_TOKEN": token})
    return check_hf_token(token)


def cmd_set_frame(args: argparse.Namespace) -> dict[str, Any]:
    updates: dict[str, str] = {}
    if args.url:
        updates["FRAME_BASE_URL"] = args.url.strip().rstrip("/")
    if args.cookie_stdin:
        updates["FRAME_SESSION_COOKIE"] = sys.stdin.read().strip()
    elif args.cookie:
        updates["FRAME_SESSION_COOKIE"] = args.cookie.strip()
    else:
        username = args.username or input("Frame username: ").strip()
        password = (
            sys.stdin.read().strip()
            if args.password_stdin
            else getpass.getpass("Frame password: ").strip()
        )
        if username:
            updates["FRAME_USERNAME"] = username
        if password:
            updates["FRAME_PASSWORD"] = password
    save_credentials_env(updates)
    return check_frame_status(load_saved_credentials())


def cmd_status(_args: argparse.Namespace) -> dict[str, Any]:
    saved = load_saved_credentials()
    hf_tok = saved.get("HF_TOKEN") or os.environ.get("HF_TOKEN") or ""
    colab = check_colab_non_interactive()
    hf = check_hf_token(hf_tok) if hf_tok else {"configured": False, "valid": False, "gated_access": False}
    frame = check_frame_status(saved)
    return {
        "credentials_file": str(CREDENTIALS_ENV_PATH),
        "colab": colab,
        "huggingface": hf,
        "frame": frame,
        "ready_for_720p_e2e": bool(
            colab.get("authenticated") and hf.get("gated_access") and frame.get("authenticated")
        ),
    }


def cmd_setup(args: argparse.Namespace) -> int:
    """Interactive SSH setup wizard for Google Colab, Hugging Face, and Frame."""
    ensure_keyring_configured()
    saved = load_saved_credentials()
    print("=== [1/3] Hugging Face Token (Lightricks/LTX-2.5) ===")
    existing_hf = saved.get("HF_TOKEN") or ""
    hf_status = check_hf_token(existing_hf) if existing_hf and not args.reconfigure else {"gated_access": False}
    if hf_status.get("gated_access"):
        print(f"  Already configured and verified for HF user '{hf_status.get('hf_user')}'.")
    else:
        print("  Ensure you accepted terms at: https://huggingface.co/Lightricks/LTX-2.5")
        tok = getpass.getpass("  Paste Hugging Face Read Token (hf_..., hidden): ").strip()
        if tok:
            save_credentials_env({"HF_TOKEN": tok})
            hf_status = check_hf_token(tok)
            print(f"  -> {hf_status.get('detail')}")

    print("\n=== [2/3] Frame Server Ingestion Auth ===")
    saved = load_saved_credentials()
    default_url = saved.get("FRAME_BASE_URL") or DEFAULT_FRAME_URL
    frame_status = check_frame_status(saved) if not args.reconfigure else {"authenticated": False}
    if frame_status.get("authenticated"):
        print(f"  Already authenticated to {frame_status['base_url']} as '{frame_status.get('username') or 'local-owner'}'.")
    else:
        url_in = input(f"  Frame Base URL [{default_url}]: ").strip() or default_url
        save_credentials_env({"FRAME_BASE_URL": url_in})
        mode = input("  Auth via [1] Username/Password or [2] vf_session Cookie or [Enter] skip for now? [1]: ").strip() or "1"
        if mode == "1":
            u = input("  Frame Username: ").strip()
            p = getpass.getpass("  Frame Password (hidden): ").strip()
            if u and p:
                save_credentials_env({"FRAME_USERNAME": u, "FRAME_PASSWORD": p, "FRAME_SESSION_COOKIE": ""})
                frame_status = check_frame_status(load_saved_credentials())
                print(f"  -> {frame_status.get('detail')}")
        elif mode == "2":
            c = getpass.getpass("  Paste vf_session cookie value (hidden): ").strip()
            if c:
                save_credentials_env({"FRAME_SESSION_COOKIE": c})
                frame_status = check_frame_status(load_saved_credentials())
                print(f"  -> {frame_status.get('detail')}")

    print("\n=== [3/3] Google Colab OAuth Authorization ===")
    colab_status = check_colab_non_interactive()
    if colab_status.get("authenticated") and not args.reconfigure:
        print(f"  Already authorized!\n{colab_status['usage']}")
    else:
        url_info = cmd_google_auth_url(args)
        print("\n  Open this URL in your Mac browser and sign in with your Google AI Ultra account:\n")
        print(f"    {url_info['auth_url']}\n")
        code = input("  Paste the authorization code shown by Google: ").strip()
        res = cmd_google_auth_code(argparse.Namespace(code=code))
        colab_status = res["colab"]
        print(f"  -> Authenticated: {colab_status.get('authenticated')}")
        if colab_status.get("usage"):
            print(colab_status["usage"])

    print("\n=== Summary (Fresh SSH Session Simulation) ===")
    summary = cmd_status(args)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ready_for_720p_e2e"] else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Configure Google Colab, HF_TOKEN, and Frame credentials on server")
    sub = parser.add_subparsers(dest="command", required=True)

    setup_p = sub.add_parser("setup", help="Interactive one-shot setup wizard in SSH")
    setup_p.add_argument("--reconfigure", action="store_true", help="Re-prompt even if already configured.")

    sub.add_parser("status", help="Non-interactive check of Colab, HF_TOKEN, and Frame readiness")
    sub.add_parser("google-auth-url", help="Print one-time Google OAuth URL for Mac browser")

    code_p = sub.add_parser("google-auth-code", help="Exchange pasted Google OAuth code and persist token")
    code_p.add_argument("--code", help="Authorization code from Google landing page.")

    hf_p = sub.add_parser("set-hf", help="Save and verify Hugging Face Read Token")
    hf_p.add_argument("--token", help="HF token string.")
    hf_p.add_argument("--stdin", action="store_true", help="Read HF token from stdin.")

    fr_p = sub.add_parser("set-frame", help="Save and verify Frame credentials")
    fr_p.add_argument("--url", help=f"Frame URL (default {DEFAULT_FRAME_URL}).")
    fr_p.add_argument("--username", help="Frame username.")
    fr_p.add_argument("--password-stdin", action="store_true", help="Read Frame password from stdin.")
    fr_p.add_argument("--cookie", help="vf_session cookie value.")
    fr_p.add_argument("--cookie-stdin", action="store_true", help="Read vf_session cookie from stdin.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "setup":
            return cmd_setup(args)
        if args.command == "status":
            res = cmd_status(args)
        elif args.command == "google-auth-url":
            res = cmd_google_auth_url(args)
        elif args.command == "google-auth-code":
            res = cmd_google_auth_code(args)
        elif args.command == "set-hf":
            res = cmd_set_hf(args)
        elif args.command == "set-frame":
            res = cmd_set_frame(args)
        else:
            raise ValueError(f"Unknown command: {args.command}")
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
