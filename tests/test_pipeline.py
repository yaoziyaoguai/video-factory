import json
import tempfile
import unittest
from pathlib import Path

from video_factory.cli import main
from video_factory.database import Store
from video_factory.exporter import write_review_package, write_script
from video_factory.script_service import draft_script


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
            exit_code = main(
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


if __name__ == "__main__":
    unittest.main()
