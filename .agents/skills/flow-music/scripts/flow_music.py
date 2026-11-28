#!/usr/bin/env python3
"""StudioWright Flow Music generator (WAV/MP3) + single-account cloud preflight + manual fallback.

Supports:
- `preflight`: Zero-credit check of Chrome, StudioWright (`sw`), Linux `xvfb-run`/`DISPLAY`, single
  cloud browser profile (`cloud-1`), Flow Music extra page auth check, and compliance disclosures
  (`flow_music_credits` strictly separated from `flow_video_credits`).
- `verify`: Detailed profile & live Flow Music credit inspection.
- `draft`: Save a zero-credit structured Flow Music style/lyrics/BPM/length draft when automated
  browser path is unavailable or awaiting one-time user login.
- `ingest-manual`: Validate a manually downloaded WAV (48kHz) or MP3, verify audio stream usability
  for Frame `mixed_concat` video mixing, record `flow_music_credits`, and ingest via `/uploads`.
- `run`: Generate song or instrumental via Flow Music (`lyria-3.5` / `lyria-3-pro`).
- `recover`: Zero-credit recovery via `studiowright.db` / `sw music download <song_id>`.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys
import time
from typing import Any

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from studiowright_bridge import BridgeCommandError, StudioWrightBridge  # noqa: E402
from ultra_media_common import (  # noqa: E402
    DEFAULT_STATE_DIR,
    FrameClient,
    MediaValidationError,
    TaskLedger,
    make_idempotency_key,
    make_task_id,
    sha256_file,
    utc_now_iso,
    verify_media_file,
)

CREDIT_UNIT = "flow_music_credits"


def make_bridge(args: argparse.Namespace) -> StudioWrightBridge:
    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()] if args.profiles else None
    return StudioWrightBridge(
        mac_host=args.mac_host,
        sw_bin=args.sw_bin,
        python_bin=args.mac_python,
        studiowright_home=args.studiowright_home,
        profiles=profiles,
    )


def verify_mix_ready_audio(path: pathlib.Path) -> dict[str, Any]:
    """Verify WAV/MP3 container AND confirm decoded audio stream is ready for Frame video mixing."""
    facts = verify_media_file(path, "audio")
    if shutil.which("ffprobe") and not facts.get("has_audio"):
        raise MediaValidationError(f"Audio file has no decodable audio stream for video mixing: {path}")
    facts["mix_ready_for_frame"] = True
    return facts


def recover_flow_music_task(
    bridge: StudioWrightBridge,
    ledger: TaskLedger,
    task: dict[str, Any],
    final_local_audio: pathlib.Path,
) -> dict[str, Any] | None:
    """Attempt zero-credit recovery of an interrupted/timed-out Flow Music generation."""
    meta = task.get("external_meta") or {}
    profile = meta.get("sw_profile")
    if not profile:
        return None
    submitted_epoch = float(meta.get("submitted_epoch") or 0.0)
    remote_out_dir = meta.get("worker_out_dir")
    req = task.get("request") or {}
    fmt = str(req.get("format") or "wav").lower()
    expected_title = req.get("title")

    probe = bridge.run_python_probe(
        {
            "profiles": bridge.profiles,
            "lookup_profile": profile,
            "since_epoch": max(0.0, submitted_epoch - 10.0),
            "remote_out_dir": remote_out_dir,
        }
    )

    audio_candidates = [
        f for f in (probe.get("remote_files") or []) if f.lower().endswith(f".{fmt}")
    ]
    if audio_candidates:
        bridge.fetch_from_worker(audio_candidates[0], final_local_audio)
        facts = verify_mix_ready_audio(final_local_audio)
        return ledger.update(
            task["task_id"],
            status="downloaded",
            local_file=final_local_audio,
            file_sha256=facts["sha256"],
            meta_patch={
                "credit_unit": CREDIT_UNIT,
                "recovered_from": "worker_out_dir",
                "media_facts": facts,
            },
            error=None,
        )

    song_ids: list[str] = list(meta.get("song_ids") or [])
    matched_job: dict[str, Any] | None = None
    for job in probe.get("recent_jobs") or []:
        if job.get("kind") != "music":
            continue
        params = job.get("params") if isinstance(job.get("params"), dict) else {}
        if expected_title and params.get("title") and params.get("title") != expected_title:
            continue
        matched_job = job
        res = job.get("result") if isinstance(job.get("result"), dict) else {}
        for s in res.get("songs") or []:
            if isinstance(s, dict) and s.get("id") and s["id"] not in song_ids:
                song_ids.append(str(s["id"]))
        break

    if not song_ids:
        try:
            lib = bridge.run_sw(profile, ["music", "list", "--limit", "10", "--json"], timeout_s=90.0)
            if isinstance(lib, dict):
                for song in lib.get("songs") or []:
                    if not isinstance(song, dict) or not song.get("id"):
                        continue
                    if expected_title and song.get("title") == expected_title:
                        song_ids.append(str(song["id"]))
                        break
        except BridgeCommandError:
            pass

    if song_ids:
        worker_out = remote_out_dir or bridge.prepare_worker_out_dir(
            task["task_id"], final_local_audio.parent
        )
        dl_res = bridge.run_sw(
            profile,
            ["music", "download", song_ids[0], "--format", fmt, "--out", worker_out, "--json"],
            timeout_s=240.0,
        )
        assert isinstance(dl_res, dict)
        files = dl_res.get("files") or []
        if files:
            bridge.fetch_from_worker(str(files[0]), final_local_audio)
            facts = verify_mix_ready_audio(final_local_audio)
            return ledger.update(
                task["task_id"],
                status="downloaded",
                external_id=(matched_job or {}).get("id") or song_ids[0],
                local_file=final_local_audio,
                file_sha256=facts["sha256"],
                meta_patch={
                    "credit_unit": CREDIT_UNIT,
                    "recovered_from": "sw_music_download",
                    "song_ids": song_ids,
                    "media_facts": facts,
                },
                error=None,
            )

    if matched_job and matched_job.get("status") == "failed" and not song_ids:
        ledger.update(
            task["task_id"],
            status="failed",
            external_id=matched_job.get("id"),
            meta_patch={"credit_unit": CREDIT_UNIT},
            error=str(matched_job.get("error") or "StudioWright music job failed without song_id"),
        )
    return None


def cmd_preflight(args: argparse.Namespace) -> dict[str, Any]:
    bridge = make_bridge(args)
    return bridge.preflight_channel(
        "flow_music",
        init_profile_dir=bool(args.init_profile_dir),
        probe_live=bool(args.probe_live),
    )


def cmd_verify(args: argparse.Namespace) -> dict[str, Any]:
    bridge = make_bridge(args)
    return bridge.verify_dual_accounts(live_music_credits=True, run_doctor=args.doctor)


def cmd_draft(args: argparse.Namespace) -> dict[str, Any]:
    """Create a zero-credit Flow Music prompt/lyrics draft for manual web fallback."""
    state_root = pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    ledger = TaskLedger(state_root / "tasks.db")
    lyrics_text = args.lyrics
    if args.lyrics_file:
        lyrics_text = pathlib.Path(args.lyrics_file).expanduser().resolve().read_text(encoding="utf-8")

    fmt = args.format.lower()
    spec = {
        "sound": args.sound.strip(),
        "lyrics": lyrics_text,
        "bpm": args.bpm,
        "length": args.length,
        "model": args.model,
        "format": fmt,
        "conversation_id": args.conversation_id,
    }
    idem_key = args.task_id or make_idempotency_key("flow_music_draft", spec)
    task_id = args.task_id or make_task_id("fmus", idem_key)
    draft_dir = state_root / "drafts" / "flow-music"
    draft_dir.mkdir(parents=True, exist_ok=True)
    draft_file = draft_dir / f"{task_id}.json"
    draft_payload = {
        "task_id": task_id,
        "kind": "flow_music",
        "credit_unit": CREDIT_UNIT,
        "created_at": utc_now_iso(),
        "spec": spec,
        "manual_ingest_command": (
            f"python3 .agents/skills/flow-music/scripts/flow_music.py ingest-manual "
            f"--task-id {task_id} --file /path/to/downloaded.{fmt}"
            + (f" --conversation-id {args.conversation_id}" if args.conversation_id else "")
        ),
    }
    draft_file.write_text(json.dumps(draft_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    task, _ = ledger.create_or_get(
        task_id=task_id,
        kind="flow_music",
        idempotency_key=idem_key,
        request=spec,
        external_meta={
            "credit_unit": CREDIT_UNIT,
            "mode": "manual_draft_fallback",
            "draft_file": str(draft_file),
            "credits_spent": 0,
        },
    )
    task = ledger.update(task_id, status="draft_prepared", meta_patch={"draft_file": str(draft_file)})
    return {**task, "draft_file": str(draft_file)}


def cmd_ingest_manual(args: argparse.Namespace) -> dict[str, Any]:
    """Validate a manually downloaded WAV/MP3 for Frame mixing & record `flow_music_credits`."""
    state_root = pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    ledger = TaskLedger(state_root / "tasks.db")
    src_audio = pathlib.Path(args.file).expanduser().resolve()
    facts = verify_mix_ready_audio(src_audio)
    ext = ".wav" if facts["mime_type"] == "audio/wav" else ".mp3"

    task_id = args.task_id or make_task_id("fmus", f"manual:{facts['sha256']}")
    out_dir = state_root / "outputs" / "flow-music"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest_audio = out_dir / f"{task_id}{ext}"
    if src_audio != dest_audio.resolve():
        shutil.copyfile(src_audio, dest_audio)

    existing = ledger.get(task_id)
    if not existing:
        ledger.create_or_get(
            task_id=task_id,
            kind="flow_music",
            idempotency_key=f"flow_music_manual:{facts['sha256'][:24]}",
            request={
                "sound": args.sound or "manual_flow_music_upload",
                "format": ext.lstrip("."),
                "conversation_id": args.conversation_id,
            },
            external_meta={"credit_unit": CREDIT_UNIT, "mode": "manual_upload"},
        )
    elif existing["kind"] != "flow_music":
        raise ValueError(f"Task {task_id} belongs to {existing['kind']}, refusing cross-channel ingest.")

    meta_patch: dict[str, Any] = {
        "credit_unit": CREDIT_UNIT,
        "ingestion_source": "manual_upload",
        "media_facts": facts,
    }
    if args.observed_credits_delta is not None:
        meta_patch["observed_balance_delta"] = float(args.observed_credits_delta)
        meta_patch["balance_delta_is_observed_only"] = True

    task = ledger.update(
        task_id,
        status="downloaded",
        local_file=dest_audio,
        file_sha256=facts["sha256"],
        meta_patch=meta_patch,
        error=None,
    )
    conv_id = args.conversation_id or (task.get("request") or {}).get("conversation_id")
    if conv_id:
        receipt = FrameClient(base_url=args.frame_url).ingest_media(conv_id, dest_audio)
        task = ledger.update(task_id, status="ingested", frame_receipt=receipt)
    return task


def cmd_run(args: argparse.Namespace) -> dict[str, Any]:
    bridge = make_bridge(args)
    state_root = pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    ledger = TaskLedger(state_root / "tasks.db")
    frame_client = FrameClient(base_url=args.frame_url)

    lyrics_text: str | None = args.lyrics
    if args.lyrics_file:
        lf = pathlib.Path(args.lyrics_file).expanduser().resolve()
        lyrics_text = lf.read_text(encoding="utf-8")

    cover_local: pathlib.Path | None = None
    if args.cover:
        cover_local = pathlib.Path(args.cover).expanduser().resolve()
        verify_media_file(cover_local, "image")

    fmt = args.format.lower()
    request_spec = {
        "sound": args.sound.strip(),
        "lyrics": lyrics_text,
        "bpm": args.bpm,
        "length": args.length,
        "seed": args.seed,
        "model": args.model,
        "format": fmt,
        "cover_sha256": sha256_file(cover_local) if cover_local else None,
        "cover_prompt": args.cover_prompt,
    }
    idem_key = args.task_id or make_idempotency_key("flow_music", request_spec)
    task_id = args.task_id or make_task_id("fmus", idem_key)
    effective_title = args.title or f"vf-{task_id}"

    out_dir = (
        pathlib.Path(args.out_dir).expanduser().resolve()
        if args.out_dir
        else (state_root / "outputs" / "flow-music")
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    final_local_audio = out_dir / f"{task_id}.{fmt}"

    task, created = ledger.create_or_get(
        task_id=task_id,
        kind="flow_music",
        idempotency_key=idem_key,
        request={**request_spec, "title": effective_title, "conversation_id": args.conversation_id},
        external_meta={"credit_unit": CREDIT_UNIT},
    )

    if not created and not args.force_new:
        existing_file = pathlib.Path(task["local_file"]) if task.get("local_file") else final_local_audio
        if task["status"] in ("downloaded", "ingested") and existing_file.is_file():
            facts = verify_mix_ready_audio(existing_file)
            if args.conversation_id and not task.get("frame_receipt"):
                receipt = frame_client.ingest_media(args.conversation_id, existing_file)
                task = ledger.update(task_id, status="ingested", frame_receipt=receipt)
            return {**task, "replayed": True, "media_facts": facts}

        if task["status"] in ("submitted", "timeout_unknown"):
            recovered = recover_flow_music_task(bridge, ledger, task, final_local_audio)
            if recovered and recovered["status"] == "downloaded":
                if args.conversation_id:
                    receipt = frame_client.ingest_media(args.conversation_id, final_local_audio)
                    recovered = ledger.update(task_id, status="ingested", frame_receipt=receipt)
                return {**recovered, "replayed": True}
            cur = ledger.get(task_id)
            if cur and cur["status"] in ("submitted", "timeout_unknown"):
                raise RuntimeError(
                    f"Music task {task_id} was already submitted to profile "
                    f"'{cur['external_meta'].get('sw_profile')}' and has not settled yet. "
                    f"Run `recover --task-id {task_id}` to re-check without re-spending credits."
                )

    profile, profile_info = bridge.select_profile(args.profile, "flow_music")
    worker_out_dir = bridge.prepare_worker_out_dir(task_id, out_dir / f"staging-{task_id}")
    submitted_epoch = time.time()

    ledger.update(
        task_id,
        status="submitted",
        meta_patch={
            "credit_unit": CREDIT_UNIT,
            "mac_host": bridge.mac_host,
            "sw_profile": profile,
            "profile_emails": profile_info.get("signed_in_emails"),
            "worker_out_dir": worker_out_dir,
            "submitted_epoch": submitted_epoch,
            "title": effective_title,
        },
        error=None,
    )

    try:
        sw_args = [
            "music",
            "create",
            args.sound.strip(),
            "--model",
            args.model,
            "--title",
            effective_title,
            "--format",
            fmt,
            "--out",
            worker_out_dir,
            "--json",
        ]
        if lyrics_text:
            sw_args.extend(["--lyrics", lyrics_text])
        if args.bpm is not None:
            sw_args.extend(["--bpm", str(args.bpm)])
        if args.length:
            sw_args.extend(["--length", args.length])
        if args.seed is not None:
            sw_args.extend(["--seed", str(args.seed)])
        if cover_local:
            sw_args.extend(["--cover", bridge.stage_to_worker(cover_local, task_id)])
        elif args.cover_prompt:
            sw_args.extend(["--cover-prompt", args.cover_prompt])

        res = bridge.run_sw(profile, sw_args, timeout_s=args.timeout_sec)
        assert isinstance(res, dict)
        files = res.get("files") or []
        songs = res.get("songs") or []
        if not files:
            raise RuntimeError(f"StudioWright returned no audio files: {res}")

        idx = max(0, min(args.take_index, len(files) - 1))
        bridge.fetch_from_worker(str(files[idx]), final_local_audio)
        facts = verify_mix_ready_audio(final_local_audio)
        song_ids = [str(s["id"]) for s in songs if isinstance(s, dict) and s.get("id")]
        task = ledger.update(
            task_id,
            status="downloaded",
            external_id=str(res.get("job_id") or (song_ids[0] if song_ids else "")),
            local_file=final_local_audio,
            file_sha256=facts["sha256"],
            meta_patch={
                "credit_unit": CREDIT_UNIT,
                "song_ids": song_ids,
                "selected_take_index": idx,
                "credits_remaining_before_observed": res.get("credits_remaining_before"),
                "plan": res.get("plan"),
                "media_facts": facts,
            },
            error=None,
        )
    except BridgeCommandError as exc:
        if exc.timed_out:
            ledger.update(task_id, status="timeout_unknown", error=str(exc))
            recovered = recover_flow_music_task(
                bridge, ledger, ledger.get(task_id) or task, final_local_audio
            )
            if recovered and recovered["status"] == "downloaded":
                task = recovered
            else:
                raise
        else:
            recovered = recover_flow_music_task(
                bridge, ledger, ledger.get(task_id) or task, final_local_audio
            )
            if recovered and recovered["status"] == "downloaded":
                task = recovered
            else:
                ledger.update(task_id, status="failed", error=str(exc))
                raise
    finally:
        bridge.cleanup_worker_staging(task_id)

    if args.conversation_id and task["status"] == "downloaded":
        receipt = frame_client.ingest_media(args.conversation_id, final_local_audio)
        task = ledger.update(task_id, status="ingested", frame_receipt=receipt)

    latest = ledger.get(task_id)
    assert latest is not None
    return {**latest, "replayed": False}


def cmd_recover(args: argparse.Namespace) -> dict[str, Any]:
    bridge = make_bridge(args)
    state_root = pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    ledger = TaskLedger(state_root / "tasks.db")
    task = ledger.get(args.task_id)
    if not task:
        raise KeyError(f"Unknown task_id: {args.task_id}")
    fmt = str((task.get("request") or {}).get("format") or "wav").lower()
    out_dir = state_root / "outputs" / "flow-music"
    out_path = pathlib.Path(task["local_file"]) if task.get("local_file") else (out_dir / f"{args.task_id}.{fmt}")
    recovered = recover_flow_music_task(bridge, ledger, task, out_path)
    if recovered and recovered["status"] == "downloaded":
        conv_id = args.conversation_id or (recovered["request"] or {}).get("conversation_id")
        if conv_id and not recovered.get("frame_receipt"):
            receipt = FrameClient(base_url=args.frame_url).ingest_media(conv_id, out_path)
            recovered = ledger.update(args.task_id, status="ingested", frame_receipt=receipt)
        return recovered
    latest = ledger.get(args.task_id)
    assert latest is not None
    return latest


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--mac-host", help="Worker host ('local' on Linux cloud browser, or SSH host).")
    common.add_argument("--sw-bin", help="StudioWright binary (default: sw).")
    common.add_argument("--mac-python", help="Python 3.12+ binary.")
    common.add_argument("--studiowright-home", help="Override STUDIOWRIGHT_HOME.")
    common.add_argument("--profiles", help="Comma-separated profiles (Linux default: cloud-1).")
    common.add_argument("--state-dir", help="Override local SQLite task ledger directory.")
    common.add_argument("--frame-url", help="Frame server URL.")

    parser = argparse.ArgumentParser(description="Google Flow Music generation & cloud browser preflight")
    sub = parser.add_subparsers(dest="command", required=True)

    pre_p = sub.add_parser("preflight", parents=[common], help="Zero-credit single-account Flow Music preflight")
    pre_p.add_argument("--init-profile-dir", action="store_true", help="Initialize 0700 cloud-1 profile dir.")
    pre_p.add_argument("--probe-live", action="store_true", help="Run zero-credit `sw music list --limit 0`.")

    ver_p = sub.add_parser("verify", parents=[common], help="Verify profiles & live Music credits")
    ver_p.add_argument("--doctor", action="store_true")

    dr_p = sub.add_parser("draft", parents=[common], help="Save zero-credit Flow Music prompt/lyrics draft")
    dr_p.add_argument("--sound", required=True)
    dr_p.add_argument("--lyrics")
    dr_p.add_argument("--lyrics-file")
    dr_p.add_argument("--bpm", type=int)
    dr_p.add_argument("--length", default="1:00")
    dr_p.add_argument("--model", choices=["lyria-3.5", "lyria-3-pro"], default="lyria-3.5")
    dr_p.add_argument("--format", choices=["wav", "mp3"], default="wav")
    dr_p.add_argument("--conversation-id")
    dr_p.add_argument("--task-id")

    man_p = sub.add_parser("ingest-manual", parents=[common], help="Validate & ingest manually downloaded WAV/MP3")
    man_p.add_argument("--file", required=True, help="Path to downloaded WAV or MP3.")
    man_p.add_argument("--task-id", help="Existing draft task_id if created via `draft`.")
    man_p.add_argument("--sound", help="Style note if no prior draft exists.")
    man_p.add_argument("--observed-credits-delta", type=float, help="Optional observed Flow Music credits delta.")
    man_p.add_argument("--conversation-id", help="Frame conversation ID to ingest into.")

    run_p = sub.add_parser("run", parents=[common], help="Generate Flow Music WAV/MP3 and optionally ingest")
    run_p.add_argument("--sound", required=True)
    run_p.add_argument("--lyrics")
    run_p.add_argument("--lyrics-file")
    run_p.add_argument("--bpm", type=int)
    run_p.add_argument("--length", default="1:00")
    run_p.add_argument("--seed", type=int)
    run_p.add_argument("--model", choices=["lyria-3.5", "lyria-3-pro"], default="lyria-3.5")
    run_p.add_argument("--title")
    run_p.add_argument("--cover")
    run_p.add_argument("--cover-prompt")
    run_p.add_argument("--format", choices=["wav", "mp3"], default="wav")
    run_p.add_argument("--take-index", type=int, default=0)
    run_p.add_argument("--profile", default="auto")
    run_p.add_argument("--timeout-sec", type=float, default=420.0)
    run_p.add_argument("--conversation-id")
    run_p.add_argument("--out-dir")
    run_p.add_argument("--task-id")
    run_p.add_argument("--force-new", action="store_true")

    rec_p = sub.add_parser("recover", parents=[common], help="Recover timed-out Flow Music job (0 credits)")
    rec_p.add_argument("--task-id", required=True)
    rec_p.add_argument("--conversation-id")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        dispatch = {
            "preflight": cmd_preflight,
            "verify": cmd_verify,
            "draft": cmd_draft,
            "ingest-manual": cmd_ingest_manual,
            "run": cmd_run,
            "recover": cmd_recover,
        }
        result = dispatch[args.command](args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
