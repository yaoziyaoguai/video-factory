import argparse
import json
from pathlib import Path
from typing import Optional

from .database import Store
from .exporter import write_review_package, write_script
from .script_service import draft_script


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

    export = subparsers.add_parser("export")
    export.add_argument("job_id", type=int)

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
