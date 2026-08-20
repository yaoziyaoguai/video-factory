import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from video_factory.cli import main
from video_factory.database import Store
from video_factory.exporter import write_review_package, write_script
from video_factory.script_service import draft_script


def run_cli(args):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        return main(args)


class PipelineTest(unittest.TestCase):
    def test_topic_to_review_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = Store(root / "data.sqlite")
            workspace = root / "workspace"
            store.init()

            topic_id = store.add_topic(
                "30岁以后才懂的生活真相",
                angle="大众受众、情绪共鸣",
            )
            topic = store.get_topic(topic_id)
            draft = draft_script(topic, duration_target=45)
            job_id = store.create_job(topic.id, 45)
            script_path = write_script(workspace, job_id, draft)
            store.replace_scenes(job_id, draft.scenes)
            export_dir = write_review_package(workspace, job_id, topic, draft, script_path)
            store.update_job(job_id, status="export_ready", script_path=script_path, export_dir=export_dir)

            self.assertTrue(script_path.exists())
            self.assertTrue((export_dir / "compliance.json").exists())
            self.assertEqual(len(store.get_scenes(job_id)), 5)

            script = json.loads(script_path.read_text(encoding="utf-8"))
            compliance = json.loads((export_dir / "compliance.json").read_text(encoding="utf-8"))
            self.assertEqual(script["duration_target"], 45)
            self.assertTrue(compliance["human_review_required"])

    def test_cli_demo_with_custom_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            exit_code = run_cli(
                [
                    "--db",
                    str(root / "data" / "video_factory.sqlite"),
                    "--workspace",
                    str(root / "workspace"),
                    "demo",
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertTrue((root / "workspace" / "exports" / "1" / "script.json").exists())

    def test_loop_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"

            start_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "loop-start",
                    "Loop 1 Topic Experiments",
                    "Loop 1: Topic Experiments",
                    "--objective",
                    "Build a repeatable way to choose the first week of video topics.",
                    "--criterion",
                    "Generate a first-week content plan.",
                    "--criterion",
                    "Record verification evidence.",
                    "--branch",
                    "codex/loop-engineering-foundation",
                ]
            )
            repeat_start_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "loop-start",
                    "loop-1-topic-experiments",
                    "Loop 1: Topic Experiments",
                    "--objective",
                    "Duplicate invocation should return the existing loop.",
                ]
            )
            event_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "loop-event",
                    "loop-1-topic-experiments",
                    "--phase",
                    "plan",
                    "--status",
                    "completed",
                    "--summary",
                    "Plan written.",
                    "--evidence",
                    "docs/loops/001-topic-experiment.md",
                ]
            )
            complete_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "loop-complete",
                    "loop-1-topic-experiments",
                    "--verification",
                    "make test",
                ]
            )

            store = Store(db)
            loop = store.get_loop("loop-1-topic-experiments")
            events = store.get_loop_events(loop.id)
            self.assertEqual(start_exit, 0)
            self.assertEqual(repeat_start_exit, 0)
            self.assertEqual(event_exit, 0)
            self.assertEqual(complete_exit, 0)
            self.assertEqual(loop.status, "completed")
            self.assertEqual(len(events), 3)

    def test_topic_candidates_and_week_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "loop-start",
                    "loop-1-topic-experiments",
                    "Loop 1: Topic Experiments",
                    "--objective",
                    "Choose first-week topics.",
                ]
            )
            generate_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "generate-topics",
                    "--loop",
                    "loop-1-topic-experiments",
                    "--count",
                    "30",
                ]
            )
            export_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "export-week-plan",
                    "--loop",
                    "loop-1-topic-experiments",
                    "--count",
                    "7",
                ]
            )

            store = Store(db)
            loop = store.get_loop("loop-1-topic-experiments")
            candidates = store.list_topic_candidates(loop_id=loop.id)
            plan_path = workspace / "week-plans" / "loop-1-topic-experiments-week-1.json"
            plan = json.loads(plan_path.read_text(encoding="utf-8"))

            self.assertEqual(generate_exit, 0)
            self.assertEqual(export_exit, 0)
            self.assertEqual(len(candidates), 30)
            self.assertEqual(len(plan["items"]), 7)
            self.assertIn("risk_level", plan["items"][0])
            self.assertIn("automation_difficulty", plan["items"][0])


if __name__ == "__main__":
    unittest.main()
