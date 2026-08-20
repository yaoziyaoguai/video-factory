import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.cli import main
from video_factory.database import Store
from video_factory.domain import Scene
from video_factory.exporter import write_review_package, write_script
from video_factory.script_service import draft_script, draft_script_from_values
from video_factory.stock_assets import api_headers, download_headers, media_file_score, prepare_scene_assets, query_for_scene


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

    def test_candidate_draft_exports_niche_aware_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "loop-start",
                    "loop-2-script-quality",
                    "Loop 2: Script Quality",
                    "--objective",
                    "Generate niche-aware scripts.",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "generate-topics",
                    "--loop",
                    "loop-2-script-quality",
                    "--count",
                    "30",
                ]
            )
            candidates = Store(db).list_topic_candidates(limit=1)
            exit_code = run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft-candidate",
                    str(candidates[0].id),
                ]
            )

            script_path = workspace / "exports" / "1" / "script.json"
            script = json.loads(script_path.read_text(encoding="utf-8"))
            self.assertEqual(exit_code, 0)
            self.assertNotEqual(script["niche_slug"], "general")
            self.assertTrue(script["structure"])
            self.assertGreaterEqual(len(script["quality_checks"]), 2)
            self.assertEqual(len(script["scenes"]), 5)
            self.assertIn(script["title"], script["scenes"][0]["search_terms"])

    def test_record_metric_and_export_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            record_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "record-metric",
                    "--platform",
                    "douyin",
                    "--views",
                    "1000",
                    "--likes",
                    "80",
                    "--comments",
                    "12",
                    "--follows",
                    "9",
                    "--shares",
                    "5",
                    "--saves",
                    "20",
                    "--completion-rate",
                    "0.41",
                    "--avg-watch-seconds",
                    "18.5",
                    "--published-at",
                    "2026-08-20T20:00:00+08:00",
                ]
            )
            report_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "metrics-report",
                    "--platform",
                    "douyin",
                ]
            )

            report_path = workspace / "reports" / "metrics-douyin.json"
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(record_exit, 0)
            self.assertEqual(report_exit, 0)
            self.assertEqual(report["count"], 1)
            self.assertEqual(report["items"][0]["follow_rate"], 0.009)
            self.assertEqual(report["totals"]["views"], 1000)

    def test_render_job_dry_run_exports_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "add-topic",
                    "普通人做决定前最该避开的 3 个坑",
                    "--angle",
                    "强收藏清单",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft",
                    "1",
                ]
            )
            render_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "render-job",
                    "1",
                    "--dry-run",
                ]
            )

            manifest_path = workspace / "renders" / "1" / "render_manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(render_exit, 0)
            self.assertEqual(manifest["resolution"], "1080x1920")
            self.assertEqual(len(manifest["slides"]), 5)

    def test_render_job_writes_mp4_manifest_when_ffmpeg_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "add-topic",
                    "普通人做决定前最该避开的 3 个坑",
                    "--angle",
                    "强收藏清单",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft",
                    "1",
                ]
            )

            def fake_subprocess_run(command, check, capture_output, text):
                if command[0] == "ffmpeg":
                    Path(command[-1]).write_bytes(b"fake-mp4")
                    return subprocess.CompletedProcess(command, 0, "", "")
                if command[0] == "ffprobe":
                    payload = {
                        "streams": [
                            {
                                "codec_name": "h264",
                                "codec_type": "video",
                                "width": 1080,
                                "height": 1920,
                            }
                        ],
                        "format": {"duration": "45.000000"},
                    }
                    return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")
                raise AssertionError(command)

            with patch("video_factory.renderer.ffmpeg_available", return_value=True), patch(
                "video_factory.renderer.subprocess.run",
                side_effect=fake_subprocess_run,
            ):
                render_exit = run_cli(
                    [
                        "--db",
                        str(db),
                        "--workspace",
                        str(workspace),
                        "render-job",
                        "1",
                    ]
                )

            render_dir = workspace / "renders" / "1"
            manifest = json.loads((render_dir / "render_manifest.json").read_text(encoding="utf-8"))
            concat_lines = (render_dir / "concat.txt").read_text(encoding="utf-8").splitlines()
            self.assertEqual(render_exit, 0)
            self.assertTrue((render_dir / "final.mp4").exists())
            self.assertTrue((render_dir / "frames" / "scene_01.png").exists())
            self.assertEqual(sum(1 for line in concat_lines if line.startswith("file ")), 5)
            self.assertTrue(manifest["rendered"])
            self.assertEqual(manifest["probe"]["streams"][0]["height"], 1920)

    def test_prepare_assets_writes_license_aware_asset_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "add-topic",
                    "普通人做决定前最该避开的 3 个坑",
                    "--angle",
                    "强收藏清单",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft",
                    "1",
                ]
            )
            exit_code = run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "prepare-assets",
                    "1",
                    "--provider",
                    "mock",
                    "--media-type",
                    "image",
                ]
            )

            plan_path = workspace / "assets" / "job-1" / "asset_plan.json"
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            self.assertEqual(exit_code, 0)
            self.assertEqual(plan["job_id"], 1)
            self.assertEqual(len(plan["scene_assets"]), 5)
            first = plan["scene_assets"][0]
            self.assertEqual(first["provider"], "mock")
            self.assertTrue(Path(first["local_path"]).exists())
            self.assertIn("license_note", first)
            self.assertIn("source_url", first)
            self.assertIn("creator", first)

    def test_asset_search_reports_missing_provider_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "add-topic",
                    "普通人做决定前最该避开的 3 个坑",
                    "--angle",
                    "强收藏清单",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft",
                    "1",
                ]
            )

            with patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit) as error:
                run_cli(
                    [
                        "--db",
                        str(db),
                        "--workspace",
                        str(workspace),
                        "asset-search",
                        "1",
                        "--provider",
                        "pexels",
                    ]
                )

            self.assertIn("PEXELS_API_KEY", str(error.exception))

    def test_stock_asset_queries_prefer_english_visual_prompt(self):
        scene = Scene(
            position=1,
            narration="做选择前先停三秒。",
            duration=8,
            visual_strategy="stock",
            visual_prompt="busy ordinary person, decision stress, vertical, topic: 普通人做决定",
            search_terms=["普通人做决定前最该避开的 3 个坑", "选择困难"],
        )

        self.assertEqual(query_for_scene(scene), "busy ordinary person, decision stress, vertical")

    def test_stock_asset_requests_include_provider_safe_headers(self):
        headers = api_headers({"Authorization": "test-key"})

        self.assertIn("VideoFactory/0.1", headers["User-Agent"])
        self.assertEqual(headers["Accept"], "application/json")
        self.assertEqual(headers["Authorization"], "test-key")

    def test_stock_asset_download_headers_accept_media(self):
        headers = download_headers("https://www.pexels.com/video/example/")

        self.assertIn("video/mp4", headers["Accept"])
        self.assertEqual(headers["Referer"], "https://www.pexels.com/video/example/")
        self.assertNotEqual(headers["Accept"], "application/json")

    def test_stock_asset_file_score_prefers_vertical_1080p_over_large_4k(self):
        self.assertGreater(
            media_file_score(1080, 1920, 2_800_000),
            media_file_score(2160, 3840, 13_000_000),
        )

    def test_life_avoidance_script_carries_director_constraints(self):
        draft = draft_script_from_values(
            title="普通人做决定前最该避开的 3 个坑",
            angle="强收藏清单",
            niche_slug="life-avoidance",
            audience="普通上班族",
        )

        self.assertIn("art_direction", draft.platform_notes)
        self.assertEqual([scene.visual_strategy for scene in draft.scenes], ["stock", "local", "local", "local", "local"])
        self.assertLessEqual(max(len(scene.narration) for scene in draft.scenes), 32)

    def test_prepare_assets_generates_local_cards_for_local_strategy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            draft = draft_script_from_values(
                title="普通人做决定前最该避开的 3 个坑",
                angle="强收藏清单",
                niche_slug="life-avoidance",
                audience="普通上班族",
            )

            plan_path = prepare_scene_assets(
                job_id=1,
                scenes=draft.scenes,
                workspace=workspace,
                provider="mock",
                media_type="image",
            )

            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            providers = [asset["provider"] for asset in plan["scene_assets"]]
            self.assertEqual(providers, ["mock", "local", "local", "local", "local"])
            for asset in plan["scene_assets"]:
                self.assertTrue(Path(asset["local_path"]).exists())
            self.assertEqual(plan["scene_assets"][1]["license_note"], "Owner-generated local graphic card; no external stock license required.")

    def test_render_job_requires_assets_when_requested(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "add-topic",
                    "普通人做决定前最该避开的 3 个坑",
                    "--angle",
                    "强收藏清单",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft",
                    "1",
                ]
            )

            with self.assertRaises(SystemExit) as error:
                run_cli(
                    [
                        "--db",
                        str(db),
                        "--workspace",
                        str(workspace),
                        "render-job",
                        "1",
                        "--require-assets",
                    ]
                )

            self.assertIn("requires an asset plan", str(error.exception))

    def test_render_job_uses_prepared_assets_when_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "add-topic",
                    "普通人做决定前最该避开的 3 个坑",
                    "--angle",
                    "强收藏清单",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft",
                    "1",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "prepare-assets",
                    "1",
                    "--provider",
                    "mock",
                    "--media-type",
                    "image",
                ]
            )

            def fake_subprocess_run(command, check, capture_output, text):
                if command[0] == "ffmpeg":
                    Path(command[-1]).write_bytes(b"fake-mp4")
                    return subprocess.CompletedProcess(command, 0, "", "")
                if command[0] == "ffprobe":
                    payload = {
                        "streams": [
                            {
                                "codec_name": "h264",
                                "codec_type": "video",
                                "width": 1080,
                                "height": 1920,
                            }
                        ],
                        "format": {"duration": "45.000000"},
                    }
                    return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")
                raise AssertionError(command)

            with patch("video_factory.renderer.ffmpeg_available", return_value=True), patch(
                "video_factory.renderer.subprocess.run",
                side_effect=fake_subprocess_run,
            ):
                render_exit = run_cli(
                    [
                        "--db",
                        str(db),
                        "--workspace",
                        str(workspace),
                        "render-job",
                        "1",
                        "--require-assets",
                    ]
                )

            manifest = json.loads((workspace / "renders" / "1" / "render_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(render_exit, 0)
            self.assertEqual(manifest["visual_quality"], "stock_asset")
            self.assertEqual(len(manifest["asset_plan"]["scene_assets"]), 5)
            self.assertTrue((workspace / "renders" / "1" / "captions" / "scene_01.png").exists())

    def test_local_asset_matching(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "data" / "video_factory.sqlite"
            workspace = root / "workspace"

            run_cli(
                [
                    "--db",
                    str(db),
                    "add-topic",
                    "普通人做决定前最该避开的 3 个坑",
                    "--angle",
                    "强收藏清单",
                ]
            )
            run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "draft",
                    "1",
                ]
            )
            add_asset_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "add-local-asset",
                    str(workspace / "assets" / "decision-checklist.png"),
                    "--media-type",
                    "image",
                    "--tag",
                    "普通人做决定前最该避开的 3 个坑",
                    "--tag",
                    "checklist",
                    "--license-note",
                    "created by owner",
                ]
            )
            match_exit = run_cli(
                [
                    "--db",
                    str(db),
                    "--workspace",
                    str(workspace),
                    "match-assets",
                    "1",
                ]
            )

            match_path = workspace / "asset-matches" / "job-1.json"
            matches = json.loads(match_path.read_text(encoding="utf-8"))
            self.assertEqual(add_asset_exit, 0)
            self.assertEqual(match_exit, 0)
            self.assertTrue(matches["matches"][0]["suggestions"])
            self.assertEqual(matches["matches"][0]["suggestions"][0]["media_type"], "image")


if __name__ == "__main__":
    unittest.main()
