#!/usr/bin/env python3
"""StudioWright Flow video generator + single-account cloud preflight + manual fallback + Frame ingestion.

Supports:
- `preflight`: Zero-credit check of Chrome, StudioWright (`sw`), Linux `xvfb-run`/`DISPLAY`, single
  cloud browser profile (`cloud-1`), and compliance/terms disclosures (`flow_video_credits`).
- `verify`: Detailed profile & CDP port inspection.
- `draft`: Save a zero-credit structured Flow video prompt/frame draft when automated browser path
  is unavailable or awaiting one-time user login.
- `ingest-manual`: Validate a manually downloaded Flow MP4, record `flow_video_credits` distinctly
  from `flow_music_credits` / CNY, and ingest into Frame via `/uploads`.
- `run`: Dry-run credit quote (`--dry-run`) or automated generation + timeout-first recovery.
- `recover`: Zero-credit recovery via `studiowright.db` / `sw download <media_id>`.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys
import tempfile
import time
from typing import Any

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from studiowright_bridge import BridgeCommandError, StudioWrightBridge  # noqa: E402
from ultra_media_common import (  # noqa: E402
    DEFAULT_STATE_DIR,
    FrameClient,
    TaskLedger,
    make_idempotency_key,
    make_task_id,
    sha256_file,
    utc_now_iso,
    verify_media_file,
)

CREDIT_UNIT = "flow_video_credits"


def make_bridge(args: argparse.Namespace) -> StudioWrightBridge:
    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()] if args.profiles else None
    return StudioWrightBridge(
        mac_host=args.mac_host,
        sw_bin=args.sw_bin,
        python_bin=args.mac_python,
        studiowright_home=args.studiowright_home,
        profiles=profiles,
    )


def recover_flow_video_task(
    bridge: StudioWrightBridge,
    ledger: TaskLedger,
    task: dict[str, Any],
    final_local_mp4: pathlib.Path,
) -> dict[str, Any] | None:
    """Attempt zero-credit recovery of an interrupted/timed-out Flow video generation."""
    meta = task.get("external_meta") or {}
    profile = meta.get("sw_profile")
    if not profile:
        return None
    submitted_epoch = float(meta.get("submitted_epoch") or 0.0)
    remote_out_dir = meta.get("worker_out_dir")
    req = task.get("request") or {}
    size = req.get("size")

    probe = bridge.run_python_probe(
        {
            "profiles": bridge.profiles,
            "lookup_profile": profile,
            "since_epoch": max(0.0, submitted_epoch - 10.0),
            "remote_out_dir": remote_out_dir,
        }
    )

    mp4_candidates = [f for f in (probe.get("remote_files") or []) if f.lower().endswith(".mp4")]
    if mp4_candidates:
        bridge.fetch_from_worker(mp4_candidates[0], final_local_mp4)
        facts = verify_media_file(final_local_mp4, "video")
        return ledger.update(
            task["task_id"],
            status="downloaded",
            local_file=final_local_mp4,
            file_sha256=facts["sha256"],
            meta_patch={
                "credit_unit": CREDIT_UNIT,
                "recovered_from": "worker_out_dir",
                "media_facts": facts,
            },
            error=None,
        )

    media_ids: list[str] = list(meta.get("media_ids") or [])
    project_id: str | None = meta.get("project_id") or req.get("project")
    matched_job: dict[str, Any] | None = None
    for job in probe.get("recent_jobs") or []:
        if job.get("kind") != "video":
            continue
        params = job.get("params") if isinstance(job.get("params"), dict) else {}
        if params.get("prompt") and params.get("prompt") != req.get("prompt"):
            continue
        matched_job = job
        project_id = project_id or job.get("project_id")
        res = job.get("result") if isinstance(job.get("result"), dict) else {}
        for mid in res.get("media_ids") or []:
            if mid not in media_ids:
                media_ids.append(mid)
        break

    if not media_ids:
        try:
            mlist_args = ["media", "list", "--limit", "8", "--json"]
            if project_id:
                mlist_args.extend(["--project", project_id])
            mlist = bridge.run_sw(profile, mlist_args, timeout_s=90.0)
            if isinstance(mlist, dict):
                project_id = project_id or mlist.get("project_id")
                for item in mlist.get("media") or []:
                    created = float(item.get("created") or 0.0)
                    if item.get("kind") == "video" and created >= submitted_epoch - 15.0:
                        media_ids.append(str(item["media_id"]))
                        break
        except BridgeCommandError:
            pass

    if media_ids:
        worker_out = remote_out_dir or bridge.prepare_worker_out_dir(
            task["task_id"], final_local_mp4.parent
        )
        dl_args = ["download", media_ids[0], "--out", worker_out, "--json"]
        if project_id:
            dl_args.extend(["--project", project_id])
        if size:
            dl_args.extend(["--size", str(size)])
        dl_res = bridge.run_sw(profile, dl_args, timeout_s=300.0)
        assert isinstance(dl_res, dict)
        files = dl_res.get("files") or []
        if files:
            bridge.fetch_from_worker(str(files[0]), final_local_mp4)
            facts = verify_media_file(final_local_mp4, "video")
            return ledger.update(
                task["task_id"],
                status="downloaded",
                external_id=(matched_job or {}).get("id") or task.get("external_id"),
                local_file=final_local_mp4,
                file_sha256=facts["sha256"],
                meta_patch={
                    "credit_unit": CREDIT_UNIT,
                    "recovered_from": "sw_download_media_id",
                    "project_id": dl_res.get("project_id") or project_id,
                    "media_ids": media_ids,
                    "media_facts": facts,
                },
                error=None,
            )

    if matched_job and matched_job.get("status") == "failed" and not media_ids:
        ledger.update(
            task["task_id"],
            status="failed",
            external_id=matched_job.get("id"),
            meta_patch={"credit_unit": CREDIT_UNIT},
            error=str(matched_job.get("error") or "StudioWright video job failed without media_id"),
        )
    return None


def cmd_preflight(args: argparse.Namespace) -> dict[str, Any]:
    bridge = make_bridge(args)
    return bridge.preflight_channel(
        "flow_video",
        init_profile_dir=bool(args.init_profile_dir),
        probe_live=bool(args.probe_live),
    )


def cmd_verify(args: argparse.Namespace) -> dict[str, Any]:
    bridge = make_bridge(args)
    return bridge.verify_dual_accounts(
        live_music_credits=args.check_music_credits,
        run_doctor=args.doctor,
    )


def cmd_draft(args: argparse.Namespace) -> dict[str, Any]:
    """Create a zero-credit Flow Video prompt draft for manual web generation fallback."""
    state_root = pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    ledger = TaskLedger(state_root / "tasks.db")
    start_sha = None
    if args.start_frame:
        sf = pathlib.Path(args.start_frame).expanduser().resolve()
        verify_media_file(sf, "image")
        start_sha = sha256_file(sf)

    spec = {
        "prompt": args.prompt.strip(),
        "model": args.model,
        "aspect": args.aspect,
        "resolution": args.resolution,
        "duration": args.duration,
        "start_sha256": start_sha,
        "conversation_id": args.conversation_id,
    }
    idem_key = args.task_id or make_idempotency_key("flow_video_draft", spec)
    task_id = args.task_id or make_task_id("fvid", idem_key)
    draft_dir = state_root / "drafts" / "flow-video"
    draft_dir.mkdir(parents=True, exist_ok=True)
    draft_file = draft_dir / f"{task_id}.json"
    draft_payload = {
        "task_id": task_id,
        "kind": "flow_video",
        "credit_unit": CREDIT_UNIT,
        "created_at": utc_now_iso(),
        "spec": spec,
        "start_frame_path": str(pathlib.Path(args.start_frame).expanduser().resolve()) if args.start_frame else None,
        "manual_ingest_command": (
            f"python3 .agents/skills/flow-video/scripts/flow_video.py ingest-manual "
            f"--task-id {task_id} --file /path/to/downloaded.mp4"
            + (f" --conversation-id {args.conversation_id}" if args.conversation_id else "")
        ),
    }
    draft_file.write_text(json.dumps(draft_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    task, _ = ledger.create_or_get(
        task_id=task_id,
        kind="flow_video",
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
    """Validate and ingest a manually generated Flow MP4 without mixing credit units."""
    state_root = pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    ledger = TaskLedger(state_root / "tasks.db")
    src_mp4 = pathlib.Path(args.file).expanduser().resolve()
    facts = verify_media_file(src_mp4, "video")

    task_id = args.task_id or make_task_id("fvid", f"manual:{facts['sha256']}")
    out_dir = state_root / "outputs" / "flow-video"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest_mp4 = out_dir / f"{task_id}.mp4"
    if src_mp4 != dest_mp4.resolve():
        shutil.copyfile(src_mp4, dest_mp4)

    existing = ledger.get(task_id)
    if not existing:
        ledger.create_or_get(
            task_id=task_id,
            kind="flow_video",
            idempotency_key=f"flow_video_manual:{facts['sha256'][:24]}",
            request={"prompt": args.prompt or "manual_flow_video_upload", "conversation_id": args.conversation_id},
            external_meta={"credit_unit": CREDIT_UNIT, "mode": "manual_upload"},
        )
    elif existing["kind"] != "flow_video":
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
        local_file=dest_mp4,
        file_sha256=facts["sha256"],
        meta_patch=meta_patch,
        error=None,
    )
    conv_id = args.conversation_id or (task.get("request") or {}).get("conversation_id")
    if conv_id:
        receipt = FrameClient(base_url=args.frame_url).ingest_media(conv_id, dest_mp4)
        task = ledger.update(task_id, status="ingested", frame_receipt=receipt)
    return task


def cmd_run(args: argparse.Namespace) -> dict[str, Any]:
    bridge = make_bridge(args)
    state_root = pathlib.Path(args.state_dir).expanduser().resolve() if args.state_dir else DEFAULT_STATE_DIR
    ledger = TaskLedger(state_root / "tasks.db")
    frame_client = FrameClient(base_url=args.frame_url)

    with tempfile.TemporaryDirectory(prefix="flow-vid-in-") as tmp_str:
        tmp_dir = pathlib.Path(tmp_str)
        start_local: pathlib.Path | None = None
        end_local: pathlib.Path | None = None
        ref_locals: list[pathlib.Path] = []

        if args.start_frame:
            start_local = pathlib.Path(args.start_frame).expanduser().resolve()
            verify_media_file(start_local, "image")
        elif args.frame_blob_id:
            dl = frame_client.download_blob(args.frame_blob_id, tmp_dir / f"{args.frame_blob_id}.img")
            img_facts = verify_media_file(dl, "image")
            ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[img_facts["mime_type"]]
            start_local = dl.with_suffix(ext)
            dl.rename(start_local)

        if args.end_frame:
            end_local = pathlib.Path(args.end_frame).expanduser().resolve()
            verify_media_file(end_local, "image")
        for r in args.ref or []:
            rp = pathlib.Path(r).expanduser().resolve()
            verify_media_file(rp, "image")
            ref_locals.append(rp)

        mode = "ingredients" if ref_locals else args.mode
        request_spec = {
            "prompt": args.prompt.strip(),
            "model": args.model,
            "mode": mode,
            "aspect": args.aspect,
            "resolution": args.resolution,
            "duration": args.duration,
            "size": args.size,
            "start_sha256": sha256_file(start_local) if start_local else None,
            "end_sha256": sha256_file(end_local) if end_local else None,
            "ref_sha256s": [sha256_file(p) for p in ref_locals],
            "project": args.project,
        }

        if args.dry_run:
            profile, profile_info = bridge.select_profile(args.profile, "flow_video")
            sw_args = [
                "video",
                args.prompt.strip(),
                "--model",
                args.model,
                "--mode",
                mode,
                "--aspect",
                args.aspect,
                "--dry-run",
                "--json",
            ]
            if args.model in ("omni-flash", "omni-flash-1.2"):
                sw_args.extend(["--resolution", args.resolution, "--duration", str(args.duration)])
            if args.project:
                sw_args.extend(["--project", args.project])
            quote = bridge.run_sw(profile, sw_args, timeout_s=120.0)
            return {
                "dry_run": True,
                "credit_unit": CREDIT_UNIT,
                "selected_profile": profile,
                "profile_info": profile_info,
                "quote": quote,
            }

        idem_key = args.task_id or make_idempotency_key("flow_video", request_spec)
        task_id = args.task_id or make_task_id("fvid", idem_key)

        out_dir = (
            pathlib.Path(args.out_dir).expanduser().resolve()
            if args.out_dir
            else (state_root / "outputs" / "flow-video")
        )
        out_dir.mkdir(parents=True, exist_ok=True)
        final_local_mp4 = out_dir / f"{task_id}.mp4"

        task, created = ledger.create_or_get(
            task_id=task_id,
            kind="flow_video",
            idempotency_key=idem_key,
            request={**request_spec, "conversation_id": args.conversation_id},
            external_meta={"credit_unit": CREDIT_UNIT},
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
                recovered = recover_flow_video_task(bridge, ledger, task, final_local_mp4)
                if recovered and recovered["status"] == "downloaded":
                    if args.conversation_id:
                        receipt = frame_client.ingest_media(args.conversation_id, final_local_mp4)
                        recovered = ledger.update(task_id, status="ingested", frame_receipt=receipt)
                    return {**recovered, "replayed": True}
                cur = ledger.get(task_id)
                if cur and cur["status"] in ("submitted", "timeout_unknown"):
                    raise RuntimeError(
                        f"Task {task_id} was already submitted to profile "
                        f"'{cur['external_meta'].get('sw_profile')}' and has not settled yet. "
                        f"Run `recover --task-id {task_id}` to re-check without re-spending credits."
                    )

        profile, profile_info = bridge.select_profile(args.profile, "flow_video")
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
            },
            error=None,
        )

        try:
            sw_args = [
                "video",
                args.prompt.strip(),
                "--model",
                args.model,
                "--mode",
                mode,
                "--aspect",
                args.aspect,
                "--out",
                worker_out_dir,
                "--json",
            ]
            if args.model in ("omni-flash", "omni-flash-1.2"):
                sw_args.extend(["--resolution", args.resolution, "--duration", str(args.duration)])
            if start_local:
                sw_args.extend(["--start", bridge.stage_to_worker(start_local, task_id)])
            if end_local:
                sw_args.extend(["--end", bridge.stage_to_worker(end_local, task_id)])
            for rp in ref_locals:
                sw_args.extend(["--ref", bridge.stage_to_worker(rp, task_id)])
            if args.project:
                sw_args.extend(["--project", args.project])
            if args.size:
                sw_args.extend(["--size", args.size])
            if args.max_credits is not None:
                sw_args.extend(["--max-credits", str(args.max_credits)])

            res = bridge.run_sw(profile, sw_args, timeout_s=args.timeout_sec)
            assert isinstance(res, dict)
            files = res.get("files") or []
            if not files:
                raise RuntimeError(f"StudioWright returned no video files: {res}")

            bridge.fetch_from_worker(str(files[0]), final_local_mp4)
            facts = verify_media_file(final_local_mp4, "video")
            task = ledger.update(
                task_id,
                status="downloaded",
                external_id=str(res.get("job_id") or ""),
                local_file=final_local_mp4,
                file_sha256=facts["sha256"],
                meta_patch={
                    "credit_unit": CREDIT_UNIT,
                    "project_id": res.get("project_id"),
                    "media_ids": res.get("media_ids") or [],
                    "credits_spent": res.get("credits"),
                    "credits_left_observed": res.get("credits_left"),
                    "media_facts": facts,
                    "notes": res.get("notes"),
                },
                error=None,
            )
        except BridgeCommandError as exc:
            if exc.timed_out:
                ledger.update(task_id, status="timeout_unknown", error=str(exc))
                recovered = recover_flow_video_task(
                    bridge, ledger, ledger.get(task_id) or task, final_local_mp4
                )
                if recovered and recovered["status"] == "downloaded":
                    task = recovered
                else:
                    raise
            else:
                recovered = recover_flow_video_task(
                    bridge, ledger, ledger.get(task_id) or task, final_local_mp4
                )
                if recovered and recovered["status"] == "downloaded":
                    task = recovered
                else:
                    ledger.update(task_id, status="failed", error=str(exc))
                    raise
        finally:
            bridge.cleanup_worker_staging(task_id)

    if args.conversation_id and task["status"] == "downloaded":
        receipt = frame_client.ingest_media(args.conversation_id, final_local_mp4)
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
    out_dir = state_root / "outputs" / "flow-video"
    out_path = pathlib.Path(task["local_file"]) if task.get("local_file") else (out_dir / f"{args.task_id}.mp4")
    recovered = recover_flow_video_task(bridge, ledger, task, out_path)
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

    parser = argparse.ArgumentParser(description="Google Flow video generation & cloud browser preflight")
    sub = parser.add_subparsers(dest="command", required=True)

    pre_p = sub.add_parser("preflight", parents=[common], help="Zero-credit single-account cloud preflight")
    pre_p.add_argument("--init-profile-dir", action="store_true", help="Initialize 0700 cloud-1 profile dir.")
    pre_p.add_argument("--probe-live", action="store_true")

    ver_p = sub.add_parser("verify", parents=[common], help="Verify Chrome profiles & StudioWright")
    ver_p.add_argument("--check-music-credits", action="store_true")
    ver_p.add_argument("--doctor", action="store_true")

    dr_p = sub.add_parser("draft", parents=[common], help="Save zero-credit Flow video prompt draft")
    dr_p.add_argument("--prompt", required=True)
    dr_p.add_argument(
        "--model",
        choices=["omni-flash-1.2", "omni-flash", "veo-lite", "veo-fast", "veo-quality"],
        default="omni-flash-1.2",
    )
    dr_p.add_argument("--start-frame")
    dr_p.add_argument("--aspect", choices=["16:9", "9:16"], default="16:9")
    dr_p.add_argument("--resolution", choices=["360p", "720p"], default="720p")
    dr_p.add_argument("--duration", type=int, default=5)
    dr_p.add_argument("--conversation-id")
    dr_p.add_argument("--task-id")

    man_p = sub.add_parser("ingest-manual", parents=[common], help="Validate & ingest manually downloaded MP4")
    man_p.add_argument("--file", required=True, help="Path to downloaded MP4.")
    man_p.add_argument("--task-id", help="Existing draft task_id if created via `draft`.")
    man_p.add_argument("--prompt", help="Prompt note if no prior draft exists.")
    man_p.add_argument("--observed-credits-delta", type=float, help="Optional observed Flow video credits delta.")
    man_p.add_argument("--conversation-id", help="Frame conversation ID to ingest into.")

    run_p = sub.add_parser("run", parents=[common], help="Generate Flow MP4 clip and optionally ingest")
    run_p.add_argument("--prompt", required=True)
    run_p.add_argument(
        "--model",
        choices=["omni-flash-1.2", "omni-flash", "veo-lite", "veo-fast", "veo-quality"],
        default="omni-flash-1.2",
    )
    run_p.add_argument("--mode", choices=["frames", "ingredients"], default="frames")
    run_p.add_argument("--start-frame")
    run_p.add_argument("--frame-blob-id")
    run_p.add_argument("--end-frame")
    run_p.add_argument("--ref", action="append")
    run_p.add_argument("--aspect", choices=["16:9", "9:16"], default="16:9")
    run_p.add_argument("--resolution", choices=["360p", "720p"], default="720p")
    run_p.add_argument("--duration", type=int, default=5)
    run_p.add_argument("--size", choices=["720p", "1080p", "4K"])
    run_p.add_argument("--max-credits", type=int, default=25)
    run_p.add_argument("--dry-run", action="store_true")
    run_p.add_argument("--profile", default="auto")
    run_p.add_argument("--project")
    run_p.add_argument("--timeout-sec", type=float, default=600.0)
    run_p.add_argument("--conversation-id")
    run_p.add_argument("--out-dir")
    run_p.add_argument("--task-id")
    run_p.add_argument("--force-new", action="store_true")

    rec_p = sub.add_parser("recover", parents=[common], help="Recover timed-out Flow video job (0 credits)")
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
