import argparse
import json
import subprocess
from pathlib import Path
from typing import Optional

from .assets import match_assets_to_scenes, normalize_tags, write_asset_matches
from .content_strategy import (
    default_niches,
    generate_candidate_drafts,
    select_week_plan,
    write_week_plan,
)
from .database import Store
from .exporter import write_review_package, write_script
from .loop_engine import merge_criteria, normalize_slug, validate_phase, validate_status
from .metrics import default_metrics_report_path, write_metrics_report
from .renderer import render_job_manifest
from .script_service import draft_candidate_script, draft_script
from .stock_assets import prepare_scene_assets, search_scene_asset_candidates


DEFAULT_DB = Path("data/video_factory.sqlite")
DEFAULT_WORKSPACE = Path("workspace")


def main(argv: Optional[list] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    store = Store(args.db)

    if args.command == "init":
        store.init()
        print(f"Initialized database: {args.db}")
        return 0

    if args.command == "add-topic":
        store.init()
        topic_id = store.add_topic(
            title=args.title,
            angle=args.angle,
            source=args.source,
            priority=args.priority,
        )
        print(f"Added topic #{topic_id}: {args.title}")
        return 0

    if args.command == "list-topics":
        store.init()
        topics = store.list_topics(status=args.status)
        for topic in topics:
            print(f"#{topic.id} [{topic.status}] p{topic.priority} {topic.title} | {topic.angle}")
        if not topics:
            print("No topics found.")
        return 0

    if args.command == "draft":
        store.init()
        topic = store.get_topic(args.topic_id)
        draft = draft_script(topic, duration_target=args.duration)
        job_id = store.create_job(topic.id, args.duration)
        script_path = write_script(args.workspace, job_id, draft)
        store.replace_scenes(job_id, draft.scenes)
        store.update_job(job_id, status="scripted", script_path=script_path)
        print(f"Created job #{job_id} for topic #{topic.id}")
        print(f"Script: {script_path}")
        return 0

    if args.command == "draft-candidate":
        store.init()
        candidate = store.get_topic_candidate(args.candidate_id)
        topic_id = store.add_topic(
            title=candidate.title,
            angle=candidate.angle,
            source=f"candidate:{candidate.id}",
            priority=candidate.score,
        )
        topic = store.get_topic(topic_id)
        draft = draft_candidate_script(candidate, duration_target=args.duration)
        job_id = store.create_job(topic.id, args.duration)
        script_path = write_script(args.workspace, job_id, draft)
        store.replace_scenes(job_id, draft.scenes)
        export_dir = write_review_package(args.workspace, job_id, topic, draft, script_path)
        store.update_job(job_id, status="export_ready", script_path=script_path, export_dir=export_dir)
        print(f"Created job #{job_id} from candidate #{candidate.id}")
        print(f"Script: {script_path}")
        print(f"Export package: {export_dir}")
        return 0

    if args.command == "export":
        store.init()
        job = store.get_job(args.job_id)
        if not job["script_path"]:
            raise SystemExit(f"Job #{args.job_id} has no script. Run draft first.")
        topic = store.get_topic(int(job["topic_id"]))
        script_path = Path(str(job["script_path"]))
        draft = draft_from_script_json(script_path)
        export_dir = write_review_package(args.workspace, args.job_id, topic, draft, script_path)
        store.update_job(args.job_id, status="export_ready", export_dir=export_dir)
        print(f"Export package: {export_dir}")
        return 0

    if args.command == "loop-start":
        store.init()
        slug = normalize_slug(args.slug)
        branch = args.branch or current_git_branch()
        try:
            existing_loop = store.get_loop(slug)
        except ValueError:
            existing_loop = None
        if existing_loop is not None:
            print(f"Loop already exists #{existing_loop.id}: {existing_loop.slug}")
            return 0
        loop_id = store.create_loop(
            slug=slug,
            title=args.title,
            objective=args.objective,
            success_criteria=merge_criteria(args.criterion),
            branch=branch,
        )
        store.add_loop_event(
            loop_id=loop_id,
            phase="discover",
            status="completed",
            summary="Loop opened and success criteria recorded.",
            evidence=[],
        )
        print(f"Started loop #{loop_id}: {slug}")
        return 0

    if args.command == "loop-list":
        store.init()
        loops = store.list_loops(status=args.status)
        for loop in loops:
            print(f"#{loop.id} [{loop.status}] {loop.slug} | {loop.title} | {loop.branch}")
        if not loops:
            print("No loops found.")
        return 0

    if args.command == "loop-show":
        store.init()
        loop = store.get_loop(args.loop_ref)
        events = store.get_loop_events(loop.id)
        print(json.dumps(loop.__dict__, ensure_ascii=False, indent=2))
        print(json.dumps([event.__dict__ for event in events], ensure_ascii=False, indent=2))
        return 0

    if args.command == "loop-event":
        store.init()
        loop = store.get_loop(args.loop_ref)
        phase = validate_phase(args.phase)
        status = validate_status(args.status)
        event_id = store.add_loop_event(
            loop_id=loop.id,
            phase=phase,
            status=status,
            summary=args.summary,
            evidence=args.evidence,
        )
        print(f"Added loop event #{event_id} to {loop.slug}: {phase}/{status}")
        return 0

    if args.command == "loop-complete":
        store.init()
        loop = store.get_loop(args.loop_ref)
        store.complete_loop(loop.id, verification=args.verification)
        print(f"Completed loop #{loop.id}: {loop.slug}")
        return 0

    if args.command == "loop-status":
        store.init()
        loop = store.get_loop(args.loop_ref)
        status = validate_status(args.status)
        store.update_loop_status(loop.id, status=status, completed=status == "completed")
        store.add_loop_event(
            loop_id=loop.id,
            phase=args.phase,
            status=status,
            summary=args.summary,
            evidence=args.evidence,
        )
        print(f"Updated loop #{loop.id} to {status}: {loop.slug}")
        return 0

    if args.command == "seed-niches":
        store.init()
        niches = default_niches()
        store.upsert_niches(niches)
        print(f"Seeded {len(niches)} niches.")
        return 0

    if args.command == "list-niches":
        store.init()
        niches = store.list_niches()
        for niche in niches:
            print(f"{niche.slug} | fit {niche.automation_fit}/10 | {niche.name} | {niche.audience}")
        if not niches:
            print("No niches found. Run seed-niches first.")
        return 0

    if args.command == "generate-topics":
        store.init()
        store.upsert_niches(default_niches())
        loop = store.get_loop(args.loop) if args.loop else None
        loop_id = loop.id if loop else None
        store.clear_topic_candidates(loop_id)
        drafts = generate_candidate_drafts(args.count)
        for draft in drafts:
            store.add_topic_candidate(loop_id=loop_id, **draft)
        if loop is not None:
            store.add_loop_event(
                loop_id=loop.id,
                phase="implement",
                status="completed",
                summary=f"Generated {len(drafts)} topic candidates.",
                evidence=[f"topic_candidates:{len(drafts)}"],
            )
        print(f"Generated {len(drafts)} topic candidates.")
        return 0

    if args.command == "list-candidates":
        store.init()
        loop = store.get_loop(args.loop) if args.loop else None
        candidates = store.list_topic_candidates(
            loop_id=loop.id if loop else None,
            niche_slug=args.niche,
            limit=args.limit,
        )
        for candidate in candidates:
            print(
                f"#{candidate.id} score={candidate.score} risk={candidate.risk_level} "
                f"diff={candidate.automation_difficulty} {candidate.niche_slug} | {candidate.title}"
            )
        if not candidates:
            print("No candidates found. Run generate-topics first.")
        return 0

    if args.command == "export-week-plan":
        store.init()
        loop = store.get_loop(args.loop) if args.loop else None
        candidates = store.list_topic_candidates(loop_id=loop.id if loop else None)
        selected = select_week_plan(candidates, count=args.count)
        if len(selected) < args.count:
            raise SystemExit(f"Only {len(selected)} candidates available. Run generate-topics first.")
        output = args.output or default_week_plan_output(args.workspace, loop.slug if loop else "adhoc")
        write_week_plan(output, selected)
        store.create_content_plan(
            loop_id=loop.id if loop else None,
            name=output.stem,
            candidate_ids=[candidate.id for candidate in selected],
            output_path=output,
        )
        if loop is not None:
            store.add_loop_event(
                loop_id=loop.id,
                phase="verify",
                status="completed",
                summary=f"Exported a {len(selected)} item first-week content plan.",
                evidence=[str(output)],
            )
        print(f"Exported week plan: {output}")
        return 0

    if args.command == "record-metric":
        store.init()
        metric_id = store.add_publishing_metric(
            job_id=args.job_id,
            candidate_id=args.candidate_id,
            platform=args.platform,
            views=args.views,
            likes=args.likes,
            comments=args.comments,
            follows=args.follows,
            shares=args.shares,
            saves=args.saves,
            completion_rate=args.completion_rate,
            avg_watch_seconds=args.avg_watch_seconds,
            published_at=args.published_at,
        )
        print(f"Recorded metric #{metric_id} for {args.platform}.")
        return 0

    if args.command == "metrics-report":
        store.init()
        metrics = store.list_publishing_metrics(platform=args.platform)
        output = args.output or default_metrics_report_path(args.workspace, args.platform)
        write_metrics_report(output, metrics)
        print(f"Exported metrics report: {output}")
        return 0

    if args.command == "render-job":
        store.init()
        job = store.get_job(args.job_id)
        if not job["script_path"]:
            raise SystemExit(f"Job #{args.job_id} has no script. Run draft first.")
        try:
            manifest_path = render_job_manifest(
                job_id=args.job_id,
                script_path=Path(str(job["script_path"])),
                workspace=args.workspace,
                dry_run=args.dry_run,
                require_assets=args.require_assets,
                asset_plan_path=args.asset_plan,
            )
        except RuntimeError as error:
            raise SystemExit(str(error))
        print(f"Render manifest: {manifest_path}")
        return 0

    if args.command == "asset-search":
        store.init()
        scenes = store.get_scenes(args.job_id)
        try:
            output = search_scene_asset_candidates(
                job_id=args.job_id,
                scenes=scenes,
                workspace=args.workspace,
                provider=args.provider,
                media_type=args.media_type,
                limit=args.limit,
            )
        except RuntimeError as error:
            raise SystemExit(str(error))
        print(f"Exported asset candidates: {output}")
        return 0

    if args.command == "prepare-assets":
        store.init()
        scenes = store.get_scenes(args.job_id)
        try:
            output = prepare_scene_assets(
                job_id=args.job_id,
                scenes=scenes,
                workspace=args.workspace,
                provider=args.provider,
                media_type=args.media_type,
                limit=args.limit,
            )
        except RuntimeError as error:
            raise SystemExit(str(error))
        print(f"Prepared asset plan: {output}")
        return 0

    if args.command == "add-local-asset":
        store.init()
        asset_id = store.add_local_asset(
            path=args.path,
            media_type=args.media_type,
            tags=normalize_tags(args.tag),
            license_note=args.license_note,
            source=args.source,
        )
        print(f"Registered local asset #{asset_id}: {args.path}")
        return 0

    if args.command == "list-local-assets":
        store.init()
        assets = store.list_local_assets(media_type=args.media_type)
        for asset in assets:
            print(f"#{asset.id} {asset.media_type} {asset.path} | tags={','.join(asset.tags)}")
        if not assets:
            print("No local assets found.")
        return 0

    if args.command == "match-assets":
        store.init()
        scenes = store.get_scenes(args.job_id)
        assets = store.list_local_assets(media_type=args.media_type)
        matches = match_assets_to_scenes(scenes, assets)
        output = args.output or args.workspace / "asset-matches" / f"job-{args.job_id}.json"
        write_asset_matches(output, matches)
        print(f"Exported asset matches: {output}")
        return 0

    if args.command == "show-job":
        store.init()
        job = store.get_job(args.job_id)
        scenes = store.get_scenes(args.job_id)
        print(json.dumps(dict(job), ensure_ascii=False, indent=2))
        print(json.dumps([scene.__dict__ for scene in scenes], ensure_ascii=False, indent=2))
        return 0

    if args.command == "demo":
        store.init()
        topic_id = store.add_topic(
            title="普通人做短视频最容易忽略的一个细节",
            angle="大众受众、强共鸣、低成本可制作",
            source="demo",
            priority=90,
        )
        topic = store.get_topic(topic_id)
        draft = draft_script(topic, duration_target=45)
        job_id = store.create_job(topic.id, 45)
        script_path = write_script(args.workspace, job_id, draft)
        store.replace_scenes(job_id, draft.scenes)
        export_dir = write_review_package(args.workspace, job_id, topic, draft, script_path)
        store.update_job(job_id, status="export_ready", script_path=script_path, export_dir=export_dir)
        print(f"Demo topic #{topic_id}, job #{job_id}")
        print(f"Script: {script_path}")
        print(f"Export package: {export_dir}")
        return 0

    parser.print_help()
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="video-factory")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--workspace", type=Path, default=DEFAULT_WORKSPACE)

    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("init")

    add_topic = subparsers.add_parser("add-topic")
    add_topic.add_argument("title")
    add_topic.add_argument("--angle", default="")
    add_topic.add_argument("--source", default="manual")
    add_topic.add_argument("--priority", type=int, default=50)

    list_topics = subparsers.add_parser("list-topics")
    list_topics.add_argument("--status", default=None)

    draft = subparsers.add_parser("draft")
    draft.add_argument("topic_id", type=int)
    draft.add_argument("--duration", type=int, default=45)

    draft_candidate = subparsers.add_parser("draft-candidate")
    draft_candidate.add_argument("candidate_id", type=int)
    draft_candidate.add_argument("--duration", type=int, default=45)

    export = subparsers.add_parser("export")
    export.add_argument("job_id", type=int)

    loop_start = subparsers.add_parser("loop-start")
    loop_start.add_argument("slug")
    loop_start.add_argument("title")
    loop_start.add_argument("--objective", required=True)
    loop_start.add_argument("--criterion", action="append", default=[])
    loop_start.add_argument("--branch", default="")

    loop_list = subparsers.add_parser("loop-list")
    loop_list.add_argument("--status", default=None)

    loop_show = subparsers.add_parser("loop-show")
    loop_show.add_argument("loop_ref")

    loop_event = subparsers.add_parser("loop-event")
    loop_event.add_argument("loop_ref")
    loop_event.add_argument("--phase", required=True)
    loop_event.add_argument("--status", required=True)
    loop_event.add_argument("--summary", required=True)
    loop_event.add_argument("--evidence", action="append", default=[])

    loop_complete = subparsers.add_parser("loop-complete")
    loop_complete.add_argument("loop_ref")
    loop_complete.add_argument("--verification", action="append", default=[])

    loop_status = subparsers.add_parser("loop-status")
    loop_status.add_argument("loop_ref")
    loop_status.add_argument("--status", required=True)
    loop_status.add_argument("--phase", default="learn")
    loop_status.add_argument("--summary", required=True)
    loop_status.add_argument("--evidence", action="append", default=[])

    subparsers.add_parser("seed-niches")

    subparsers.add_parser("list-niches")

    generate_topics = subparsers.add_parser("generate-topics")
    generate_topics.add_argument("--loop", default=None)
    generate_topics.add_argument("--count", type=int, default=30)

    list_candidates = subparsers.add_parser("list-candidates")
    list_candidates.add_argument("--loop", default=None)
    list_candidates.add_argument("--niche", default=None)
    list_candidates.add_argument("--limit", type=int, default=20)

    export_week_plan = subparsers.add_parser("export-week-plan")
    export_week_plan.add_argument("--loop", default=None)
    export_week_plan.add_argument("--count", type=int, default=7)
    export_week_plan.add_argument("--output", type=Path, default=None)

    record_metric = subparsers.add_parser("record-metric")
    record_metric.add_argument("--job-id", type=int, default=None)
    record_metric.add_argument("--candidate-id", type=int, default=None)
    record_metric.add_argument("--platform", required=True)
    record_metric.add_argument("--views", type=int, required=True)
    record_metric.add_argument("--likes", type=int, default=0)
    record_metric.add_argument("--comments", type=int, default=0)
    record_metric.add_argument("--follows", type=int, default=0)
    record_metric.add_argument("--shares", type=int, default=0)
    record_metric.add_argument("--saves", type=int, default=0)
    record_metric.add_argument("--completion-rate", type=float, default=0)
    record_metric.add_argument("--avg-watch-seconds", type=float, default=0)
    record_metric.add_argument("--published-at", default="")

    metrics_report = subparsers.add_parser("metrics-report")
    metrics_report.add_argument("--platform", default=None)
    metrics_report.add_argument("--output", type=Path, default=None)

    render_job = subparsers.add_parser("render-job")
    render_job.add_argument("job_id", type=int)
    render_job.add_argument("--dry-run", action="store_true")
    render_job.add_argument("--require-assets", action="store_true")
    render_job.add_argument("--asset-plan", type=Path, default=None)

    asset_search = subparsers.add_parser("asset-search")
    asset_search.add_argument("job_id", type=int)
    asset_search.add_argument("--provider", choices=["mock", "pexels", "pixabay"], default="pexels")
    asset_search.add_argument("--media-type", choices=["image", "video"], default="video")
    asset_search.add_argument("--limit", type=int, default=3)

    prepare_assets = subparsers.add_parser("prepare-assets")
    prepare_assets.add_argument("job_id", type=int)
    prepare_assets.add_argument("--provider", choices=["mock", "pexels", "pixabay"], default="pexels")
    prepare_assets.add_argument("--media-type", choices=["image", "video"], default="video")
    prepare_assets.add_argument("--limit", type=int, default=3)

    add_local_asset = subparsers.add_parser("add-local-asset")
    add_local_asset.add_argument("path", type=Path)
    add_local_asset.add_argument("--media-type", choices=["image", "video", "audio"], required=True)
    add_local_asset.add_argument("--tag", action="append", default=[])
    add_local_asset.add_argument("--license-note", default="manual review required")
    add_local_asset.add_argument("--source", default="local")

    list_local_assets = subparsers.add_parser("list-local-assets")
    list_local_assets.add_argument("--media-type", default=None)

    match_assets = subparsers.add_parser("match-assets")
    match_assets.add_argument("job_id", type=int)
    match_assets.add_argument("--media-type", default=None)
    match_assets.add_argument("--output", type=Path, default=None)

    show_job = subparsers.add_parser("show-job")
    show_job.add_argument("job_id", type=int)

    subparsers.add_parser("demo")
    return parser


def draft_from_script_json(path: Path):
    from .domain import Scene, ScriptDraft

    payload = json.loads(path.read_text(encoding="utf-8"))
    return ScriptDraft(
        title=payload["title"],
        hook=payload["hook"],
        duration_target=int(payload["duration_target"]),
        disclosure_required=bool(payload.get("disclosure_required", True)),
        niche_slug=str(payload.get("niche_slug", "general")),
        structure=str(payload.get("structure", "通用短视频结构")),
        quality_checks=list(payload.get("quality_checks", [])),
        platform_notes=dict(payload.get("platform_notes", {})),
        hashtags=list(payload.get("hashtags", [])),
        scenes=[
            Scene(
                position=int(item["position"]),
                narration=str(item["narration"]),
                duration=float(item["duration"]),
                visual_strategy=str(item["visual_strategy"]),
                visual_prompt=str(item["visual_prompt"]),
                search_terms=list(item.get("search_terms", [])),
            )
            for item in payload["scenes"]
        ],
    )


def current_git_branch() -> str:
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return result.stdout.strip()


def default_week_plan_output(workspace: Path, slug: str) -> Path:
    return workspace / "week-plans" / f"{slug}-week-1.json"
