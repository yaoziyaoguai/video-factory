import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from video_factory.domain import StockAssetCandidate
from video_factory.worker import WorkerProtocolError, handle_request, validate_request


class WorkerContractTest(unittest.TestCase):
    def test_worker_module_is_available_as_the_machine_interface(self):
        self.assertIsNotNone(importlib.util.find_spec("video_factory.worker"))

    def test_rejects_an_incompatible_protocol_version(self):
        with self.assertRaisesRegex(WorkerProtocolError, "Unsupported protocolVersion"):
            validate_request({"protocolVersion": "video-factory/worker-v0"})

    def test_rejects_an_unknown_capability(self):
        request = self.valid_request("unknown.capability", Path("/tmp/output"))
        with self.assertRaisesRegex(WorkerProtocolError, "Unsupported capability"):
            validate_request(request)

    def test_script_draft_writes_a_hashed_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "attempt-1"
            response = handle_request(self.valid_request("script.draft", output_dir))

            self.assertEqual(response["protocolVersion"], "video-factory/worker-v1")
            self.assertEqual(response["status"], "succeeded")
            self.assertEqual(response["commandId"], "command-1")
            artifact = response["artifacts"][0]
            script_path = Path(artifact["uri"])
            self.assertTrue(script_path.exists())
            self.assertEqual(artifact["kind"], "script")
            self.assertEqual(artifact["contentType"], "application/json")
            self.assertEqual(len(artifact["sha256"]), 64)
            self.assertGreater(artifact["sizeBytes"], 100)
            self.assertEqual(artifact["provenance"]["providerId"], "python-template-v1")
            script = json.loads(script_path.read_text(encoding="utf-8"))
            self.assertEqual(script["title"], "做决定前，先避开这 3 个坑")
            self.assertEqual(len(script["scenes"]), 5)

    def test_module_entrypoint_writes_exactly_one_json_response_to_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            request = self.valid_request("script.draft", Path(tmp) / "script")
            result = subprocess.run(
                ["python3", "-m", "video_factory.worker"],
                input=json.dumps(request, ensure_ascii=False),
                check=True,
                capture_output=True,
                text=True,
            )

            lines = result.stdout.strip().splitlines()
            self.assertEqual(len(lines), 1)
            response = json.loads(lines[0])
            self.assertEqual(response["status"], "succeeded")
            self.assertEqual(response["commandId"], "command-1")

    def test_module_entrypoint_converts_parameter_errors_to_one_json_response(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"]
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {"scriptPath": script_path}
            request["parameters"] = {
                "providerId": "local-editorial-v1",
                "provider": "local",
                "limit": "not-a-number",
            }

            result = subprocess.run(
                ["python3", "-m", "video_factory.worker"],
                input=json.dumps(request, ensure_ascii=False),
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0)
            lines = result.stdout.strip().splitlines()
            self.assertEqual(len(lines), 1)
            response = json.loads(lines[0])
            self.assertEqual(response["commandId"], "command-1")
            self.assertEqual(response["status"], "failed")
            self.assertIn("error", response)

    def test_local_asset_provider_materializes_every_scene_without_an_api_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_response = handle_request(self.valid_request("script.draft", root / "script"))
            script_path = script_response["output"]["scriptPath"]
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {"scriptPath": script_path}
            request["parameters"] = {
                "providerId": "local-editorial-v1",
                "provider": "local",
                "mediaType": "image",
            }

            response = handle_request(request)

            plan_path = Path(response["output"]["assetPlanPath"])
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            self.assertEqual(response["status"], "succeeded")
            self.assertEqual(len(plan["scene_assets"]), 5)
            self.assertEqual({item["provider"] for item in plan["scene_assets"]}, {"local"})
            self.assertTrue(all(Path(item["local_path"]).exists() for item in plan["scene_assets"]))
            self.assertTrue(all(item["license_note"] for item in plan["scene_assets"]))

    def test_ai_router_materializes_each_scene_from_the_director_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = Path(handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"])
            script = json.loads(script_path.read_text(encoding="utf-8"))
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({
                "version": "video-factory/director-plan-v1",
                "shots": [
                    {
                        "scenePosition": scene["position"],
                        "preferredProviderId": "pexels-stock-v1" if scene["position"] == 2 else "local-editorial-v1",
                        "alternativeProviderIds": ["local-editorial-v1"],
                        "query": f"director query {scene['position']}",
                        "generationPrompt": scene["visual_prompt"],
                        "rationale": "AI director decision",
                    }
                    for scene in script["scenes"]
                ],
            }, ensure_ascii=False), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {"scriptPath": str(script_path), "directorPlanPath": str(director_plan_path)}
            request["parameters"] = {
                "providerId": "ai-shot-router-v1",
                "provider": "ai-router",
                "mediaType": "video",
            }

            def candidate(*_args, **_kwargs):
                return [StockAssetCandidate(
                    provider="pexels",
                    asset_id="pexels-2",
                    media_type="video",
                    width=1080,
                    height=1920,
                    duration=5,
                    preview_url="https://example.com/preview.mp4",
                    download_url="https://example.com/video.mp4",
                    source_url="https://pexels.com/video/2",
                    creator="Creator",
                    license_note="Pexels license",
                    query="director query 2",
                    score=90,
                )]

            def materialize(_candidate, target):
                target.write_bytes(b"video")
                return target

            with patch("video_factory.stock_assets.search_stock_assets", side_effect=candidate), patch(
                "video_factory.stock_assets.materialize_candidate", side_effect=materialize
            ):
                response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            self.assertEqual([item["provider"] for item in plan["scene_assets"]], ["local", "pexels", "local", "local", "local"])
            self.assertEqual(plan["director_routing"][1]["preferred_provider_id"], "pexels-stock-v1")
            self.assertEqual(plan["director_routing"][1]["actual_provider"], "pexels")
            self.assertFalse(plan["director_routing"][1]["fallback_used"])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_voice_provider_builds_a_non_silent_timeline_for_every_scene(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_response = handle_request(self.valid_request("script.draft", root / "script"))
            script_path = script_response["output"]["scriptPath"]
            request = self.valid_request("voice.synthesize", root / "voice")
            request["input"] = {"scriptPath": script_path}
            request["parameters"] = {
                "providerId": "ffmpeg-tone-test-v1",
                "provider": "tone",
                "profileId": "tone:test-tone",
                "rate": 176,
                "pauseScale": 1.3,
                "masteringPreset": "social",
            }

            response = handle_request(request)

            plan_path = Path(response["output"]["voiceoverPlanPath"])
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            self.assertEqual(response["status"], "succeeded")
            self.assertEqual(len(plan["scenes"]), 5)
            self.assertTrue(Path(plan["track_path"]).exists())
            self.assertTrue(all(Path(scene["audio_path"]).exists() for scene in plan["scenes"]))
            self.assertGreater(plan["duration"], 20)
            self.assertTrue(all(scene["duration"] >= scene["speech_duration"] for scene in plan["scenes"]))
            self.assertEqual(plan["version"], "video-factory/voiceover-plan-v2")
            self.assertEqual(plan["direction"], {
                "profile_id": "tone:test-tone",
                "rate": 176,
                "pause_scale": 1.3,
                "mastering_preset": "social",
            })
            self.assertEqual(plan["mastering"]["target_lufs"], -14)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_kokoro_provider_requires_a_verified_isolated_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"]
            request = self.valid_request("voice.synthesize", root / "voice")
            request["input"] = {"scriptPath": script_path}
            request["parameters"] = {
                "providerId": "kokoro-local-v1",
                "provider": "kokoro",
                "profileId": "kokoro:zf_001",
                "voice": "zf_001",
                "rate": 180,
                "pauseScale": 1,
                "masteringPreset": "natural",
            }

            with patch.dict(os.environ, {"VIDEO_FACTORY_VOICE_RUNTIME": str(root / "missing-runtime")}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "setup-local-voice"):
                    handle_request(request)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_render_and_review_produce_decodable_video_with_audible_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_request = self.valid_request("script.draft", root / "script")
            script_request["input"]["brief"]["durationSeconds"] = 20
            script_path = handle_request(script_request)["output"]["scriptPath"]

            asset_request = self.valid_request("asset.prepare", root / "assets")
            asset_request["input"] = {"scriptPath": script_path}
            asset_request["parameters"] = {
                "providerId": "local-editorial-v1",
                "provider": "local",
                "mediaType": "image",
            }
            asset_plan_path = handle_request(asset_request)["output"]["assetPlanPath"]

            voice_request = self.valid_request("voice.synthesize", root / "voice")
            voice_request["input"] = {"scriptPath": script_path}
            voice_request["parameters"] = {
                "providerId": "ffmpeg-tone-test-v1",
                "provider": "tone",
            }
            voice_plan_path = handle_request(voice_request)["output"]["voiceoverPlanPath"]

            render_request = self.valid_request("video.render", root / "render")
            render_request["input"] = {
                "scriptPath": script_path,
                "assetPlanPath": asset_plan_path,
                "voiceoverPlanPath": voice_plan_path,
            }
            render_request["parameters"] = {
                "providerId": "python-ffmpeg-v1",
                "resolution": "360x640",
            }
            render_response = handle_request(render_request)
            final_path = Path(render_response["output"]["videoPath"])

            review_request = self.valid_request("quality.review", root / "review")
            review_request["input"] = {
                "videoPath": str(final_path),
                "assetPlanPath": asset_plan_path,
                "scriptPath": script_path,
            }
            review_request["parameters"] = {
                "providerId": "python-technical-review-v1",
                "expectedWidth": 360,
                "expectedHeight": 640,
                "production": False,
            }
            review_response = handle_request(review_request)
            report = json.loads(Path(review_response["output"]["reviewPath"]).read_text(encoding="utf-8"))

            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(final_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            streams = json.loads(probe.stdout)["streams"]
            self.assertTrue(final_path.exists())
            self.assertEqual({stream["codec_type"] for stream in streams}, {"video", "audio"})
            self.assertEqual(report["status"], "passed")
            self.assertGreater(report["audio"]["max_volume_db"], -60)
            self.assertTrue(all(check["passed"] for check in report["checks"]))
            self.assertTrue(next(check for check in report["checks"] if check["id"] == "target_duration")["passed"])

    @staticmethod
    def valid_request(capability: str, output_dir: Path) -> dict:
        return {
            "protocolVersion": "video-factory/worker-v1",
            "commandId": "command-1",
            "runId": "run-1",
            "nodeRunId": capability.replace(".", "-"),
            "attempt": 1,
            "capability": capability,
            "input": {
                "brief": {
                    "protocolVersion": "video-factory/brief-v1",
                    "title": "做决定前，先避开这 3 个坑",
                    "angle": "低风险、可收藏的生活清单",
                    "audience": "有决策压力的普通上班族",
                    "nicheSlug": "life-avoidance",
                    "durationSeconds": 30,
                    "platform": "douyin",
                }
            },
            "parameters": {"providerId": "python-template-v1"},
            "outputDir": str(output_dir),
        }


if __name__ == "__main__":
    unittest.main()
