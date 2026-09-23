import importlib.util
import io
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from video_factory.domain import SceneAsset, StockAssetCandidate
from video_factory.voiceover import VoiceDoesNotFitError
from video_factory.worker import WorkerProtocolError, handle_request, validate_request


class WorkerContractTest(unittest.TestCase):
    def test_ai_router_materializes_accepted_low_score_image_and_rejects_changed_scope(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = {"scenes": [{"position": 1, "duration": 3, "narration": "示意", "visual_strategy": "stock", "visual_prompt": "landscape", "search_terms": []}]}
            director = {"shots": [{"scenePosition": 1, "preferredProviderId": "nasa-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "authenticityPolicy": "illustrative", "query": "landscape"}]}
            inventory = {"version": "video-factory/asset-candidate-inventory-v1", "scene_candidates": [{"scene_position": 1, "candidates": [{
                "provider": "nasa", "provider_id": "nasa-stock-v1", "asset_id": "low", "media_type": "image", "width": 720, "height": 1280, "duration": 0,
                "preview_url": "", "download_url": "https://images-assets.nasa.gov/fixture.png", "source_url": "https://images.nasa.gov/fixture", "creator": "NASA", "license_note": "Public domain test fixture", "query": "landscape", "score": 90,
            }]}]}
            paths = {}
            for key, value in (("scriptPath", script), ("directorPlanPath", director), ("candidateInventoryPath", inventory)):
                target = root / f"{key}.json"
                target.write_text(json.dumps(value), encoding="utf-8")
                paths[key] = str(target)
            ranking = {"version": "video-factory/asset-ranking-v1", "source": "model", "scenes": [{"scenePosition": 1, "candidates": [{"provider": "nasa", "assetId": "low", "rank": 1, "semanticScore": 20, "locked": False}]}]}
            ranking["deliveryAcceptance"] = {
                "policyVersion": "playable-first-v1", "scopeDigest": "a" * 64, "scenePositions": [1], "actor": "creator", "commandId": "accept", "confirmedAt": "2026-09-22T00:00:00Z",
                **{name: hashlib.sha256(Path(paths[key]).read_bytes()).hexdigest() for name, key in (("scriptSha256", "scriptPath"), ("directorPlanSha256", "directorPlanPath"), ("inventorySha256", "candidateInventoryPath"))},
            }
            ranking_path = root / "ranking.json"
            ranking_path.write_text(json.dumps(ranking), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "output")
            request["input"] = {**paths, "candidateRankingPath": str(ranking_path)}
            request["parameters"] = {"provider": "ai-router", "mediaType": "image"}
            image_bytes = io.BytesIO()
            Image.new("RGB", (720, 1280), "navy").save(image_bytes, format="PNG")
            response_body = io.BytesIO(image_bytes.getvalue())
            response_body.headers = {"Content-Type": "image/png"}
            with patch("video_factory.stock_assets.open_asset_request", return_value=response_body) as download:
                response = handle_request(request)
            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text())
            with Image.open(plan["scene_assets"][0]["local_path"]) as decoded:
                self.assertEqual(decoded.size, (720, 1280))
            self.assertEqual(download.call_count, 1)
            self.assertEqual(plan["director_routing"][0]["selection_basis"], "accepted_quality_risk")
            self.assertEqual(plan["director_routing"][0]["quality_review_status"], "unverified")
            self.assertEqual(json.loads(ranking_path.read_text())["scenes"][0]["candidates"][0]["semanticScore"], 20)
            Path(paths["directorPlanPath"]).write_text(json.dumps({**director, "changed": True}))
            with patch("video_factory.stock_assets.open_asset_request") as download:
                with self.assertRaisesRegex(WorkerProtocolError, "acceptance.*match"):
                    handle_request(request)
                download.assert_not_called()

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
                [sys.executable, "-m", "video_factory.worker"],
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
                [sys.executable, "-m", "video_factory.worker"],
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

    def test_direct_local_asset_provider_requires_an_explicit_director_route(self):
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

            with self.assertRaisesRegex(WorkerProtocolError, "explicit director route.*editorial_card"):
                handle_request(request)

    def test_asset_worker_projects_the_executable_plan_into_scene_timings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({
                "duration_target": 24,
                "scenes": [
                    {
                        "position": position,
                        "narration": f"第 {position} 段旁白",
                        "duration": duration,
                        "visual_strategy": "stock",
                        "visual_prompt": f"第 {position} 段动作",
                        "search_terms": [],
                    }
                    for position, duration in ((1, 10), (2, 10), (3, 11.5))
                ],
            }, ensure_ascii=False), encoding="utf-8")
            executable_plan_path = root / "executable_plan.json"
            executable_plan_path.write_text(json.dumps({
                "version": "video-factory/executable-plan-v1",
                "scriptArtifactId": "artifact-script",
                "directorArtifactId": "artifact-director",
                "candidateArtifactIds": [],
                "durationRange": {"minSeconds": 20, "maxSeconds": 34},
                "fps": 30,
                "totalFrames": 945,
                "cuts": [
                    {
                        "scenePosition": 1,
                        "beatId": "legacy-scene-1",
                        "assetKey": "asset-scene-1",
                        "startFrame": 0,
                        "frameCount": 300,
                        "sourceInFrame": 0,
                    },
                    {
                        "scenePosition": 2,
                        "beatId": "legacy-scene-2",
                        "assetKey": "asset-scene-1",
                        "startFrame": 300,
                        "frameCount": 300,
                        "sourceInFrame": 120,
                    },
                    {
                        "scenePosition": 3,
                        "beatId": "legacy-scene-3",
                        "assetKey": "asset-scene-3",
                        "startFrame": 600,
                        "frameCount": 345,
                        "sourceInFrame": 0,
                    },
                ],
            }), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {
                "scriptPath": str(script_path),
                "executablePlanPath": str(executable_plan_path),
            }
            request["parameters"] = {
                "providerId": "mock-stock-v1",
                "provider": "mock",
                "mediaType": "video",
            }

            response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            self.assertEqual(plan["duration_target"], 31.5)
            self.assertEqual(plan["duration_range"], {"minSeconds": 20, "maxSeconds": 34})
            self.assertEqual([
                {
                    key: scene[key]
                    for key in ("scene_position", "start_frame", "duration_frames", "source_in_frame", "asset_key", "duration")
                }
                for scene in plan["scene_assets"]
            ], [
                {"scene_position": 1, "start_frame": 0, "duration_frames": 300, "source_in_frame": 0, "asset_key": "asset-scene-1", "duration": 10},
                {"scene_position": 2, "start_frame": 300, "duration_frames": 300, "source_in_frame": 120, "asset_key": "asset-scene-1", "duration": 10},
                {"scene_position": 3, "start_frame": 600, "duration_frames": 345, "source_in_frame": 0, "asset_key": "asset-scene-3", "duration": 11.5},
            ])

    def test_worker_rejects_a_corrupt_executable_plan_before_preparing_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({
                "scenes": [{
                    "position": 1,
                    "narration": "旁白",
                    "duration": 20,
                    "visual_strategy": "stock",
                    "visual_prompt": "动作",
                }],
            }), encoding="utf-8")
            executable_plan_path = root / "executable_plan.json"
            executable_plan = {
                "version": "video-factory/executable-plan-v1",
                "durationRange": {"minSeconds": 20, "maxSeconds": 34},
                "fps": 30,
                "totalFrames": 600,
                "cuts": [{
                    "scenePosition": 1,
                    "assetKey": "asset-scene-1",
                    "startFrame": 0,
                    "frameCount": 599,
                    "sourceInFrame": 0,
                }],
            }
            executable_plan_path.write_text(json.dumps(executable_plan), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {
                "scriptPath": str(script_path),
                "executablePlanPath": str(executable_plan_path),
            }
            request["parameters"] = {"providerId": "mock-stock-v1", "provider": "mock"}

            with self.assertRaisesRegex(WorkerProtocolError, "cuts do not equal totalFrames"):
                handle_request(request)

            executable_plan["totalFrames"] = True
            executable_plan_path.write_text(json.dumps(executable_plan), encoding="utf-8")
            with self.assertRaisesRegex(WorkerProtocolError, "invalid frame metadata"):
                handle_request(request)

    def test_video_render_binds_the_asset_plan_to_the_executable_cut_before_rendering(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1, "narration": "旁白", "duration": 20,
                "visual_strategy": "stock", "visual_prompt": "移动镜头",
            }]}), encoding="utf-8")
            executable_plan_path = root / "executable_plan.json"
            executable_plan = {
                "version": "video-factory/executable-plan-v1",
                "durationRange": {"minSeconds": 20, "maxSeconds": 20},
                "fps": 30,
                "totalFrames": 600,
                "cuts": [{
                    "scenePosition": 1, "beatId": "scene-1", "assetKey": "master-1",
                    "startFrame": 0, "frameCount": 600, "sourceInFrame": 120,
                }],
            }
            executable_plan_path.write_text(json.dumps(executable_plan), encoding="utf-8")
            asset_plan_path = root / "asset_plan.json"
            valid_asset = {
                "scene_position": 1, "media_type": "video", "local_path": str(root / "master.mp4"),
                "duration_frames": 600, "source_in_frame": 120, "asset_key": "master-1",
            }
            asset_plan_path.write_text(json.dumps({"scene_assets": [valid_asset]}), encoding="utf-8")
            voice_plan_path = root / "voice.json"
            voice_plan_path.write_text("{}", encoding="utf-8")
            rendered_video = root / "rendered.mp4"
            render_manifest = root / "render_manifest.json"

            def fake_render(**kwargs):
                bound_plan = json.loads(Path(kwargs["asset_plan_path"]).read_text(encoding="utf-8"))
                self.assertEqual(
                    {key: bound_plan["scene_assets"][0][key] for key in ("duration_frames", "source_in_frame", "asset_key")},
                    {"duration_frames": 600, "source_in_frame": 120, "asset_key": "master-1"},
                )
                rendered_video.write_bytes(b"video")
                render_manifest.write_text(json.dumps({"output_file": str(rendered_video)}), encoding="utf-8")
                return render_manifest

            request = self.valid_request("video.render", root / "render-valid")
            request["input"] = {
                "scriptPath": str(script_path),
                "executablePlanPath": str(executable_plan_path),
                "assetPlanPath": str(asset_plan_path),
                "voiceoverPlanPath": str(voice_plan_path),
            }
            with patch("video_factory.worker.render_job_manifest", side_effect=fake_render) as render:
                self.assertEqual(handle_request(request)["status"], "succeeded")
                render.assert_called_once()

            invalid_assets = [
                {key: value for key, value in valid_asset.items() if key != "source_in_frame"},
                {**valid_asset, "duration_frames": 599},
                {**valid_asset, "source_in_frame": 0},
                {**valid_asset, "asset_key": "stale-master"},
                [valid_asset, valid_asset],
                [],
            ]
            for index, invalid in enumerate(invalid_assets):
                with self.subTest(case=index):
                    scenes = invalid if isinstance(invalid, list) else [invalid]
                    asset_plan_path.write_text(json.dumps({"scene_assets": scenes}), encoding="utf-8")
                    request["outputDir"] = str(root / f"render-invalid-{index}")
                    with patch("video_factory.worker.render_job_manifest") as render:
                        with self.assertRaisesRegex(WorkerProtocolError, "Asset plan.*executable production cuts"):
                            handle_request(request)
                        render.assert_not_called()

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
                        "preferredProviderId": (
                            "pexels-stock-v1" if scene["position"] == 2
                            else "seedream-image-v1" if scene["position"] == 3
                            else "local-editorial-v1"
                        ),
                        "alternativeProviderIds": ["local-editorial-v1"],
                        "deliveryType": (
                            "stock_video" if scene["position"] == 2
                            else "generated_image" if scene["position"] == 3
                            else "editorial_card"
                        ),
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
                return [
                    StockAssetCandidate(
                        provider="pexels",
                        asset_id="pexels-2",
                        media_type="video",
                        width=1080,
                        height=1920,
                        duration=5,
                        preview_url="https://example.com/preview-2.jpg",
                        download_url="https://example.com/video-2.mp4?temporary=secret",
                        source_url="https://pexels.com/video/2",
                        creator="Creator",
                        license_note="Pexels license",
                        query="director query 2",
                        score=90,
                    ),
                    StockAssetCandidate(
                        provider="pexels",
                        asset_id="pexels-3",
                        media_type="video",
                        width=720,
                        height=1280,
                        duration=7,
                        preview_url="https://example.com/preview-3.jpg",
                        download_url="https://example.com/video-3.mp4?temporary=secret",
                        source_url="https://pexels.com/video/3",
                        creator="Alternate Creator",
                        license_note="Pexels license",
                        query="director query 2",
                        score=80,
                    ),
                ]

            def materialize(_candidate, target):
                target.write_bytes(b"video")
                return target

            with patch("video_factory.stock_assets.search_stock_assets", side_effect=candidate) as search_assets, patch(
                "video_factory.stock_assets.materialize_candidate", side_effect=materialize
            ):
                response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            self.assertEqual([item["provider"] for item in plan["scene_assets"]], ["local", "pexels", "seedream-image-v1", "local", "local"])
            self.assertEqual(plan["director_routing"][1]["preferred_provider_id"], "pexels-stock-v1")
            self.assertEqual(plan["director_routing"][1]["actual_provider"], "pexels")
            self.assertFalse(plan["director_routing"][1]["fallback_used"])
            shortlist = plan["director_routing"][1]["candidate_shortlist"]
            self.assertEqual([item["asset_id"] for item in shortlist], ["pexels-2", "pexels-3"])
            self.assertTrue(shortlist[0]["selected"])
            self.assertFalse(shortlist[1]["selected"])
            self.assertNotIn("download_url", shortlist[0])
            self.assertEqual(shortlist[0]["provider_id"], "pexels-stock-v1")
            self.assertEqual(plan["director_routing"][2]["preferred_provider_id"], "seedream-image-v1")
            self.assertEqual(plan["director_routing"][2]["actual_provider"], "seedream-image-v1")
            self.assertTrue(plan["director_routing"][2]["generation_pending"])
            self.assertFalse(plan["director_routing"][2]["fallback_used"])
            self.assertEqual(plan["scene_assets"][2]["local_path"], "")
            self.assertTrue(search_assets.call_args_list)
            self.assertTrue(all(call.kwargs["limit"] == 6 for call in search_assets.call_args_list))

    def test_ai_router_reuses_an_earlier_locked_master_without_searching_or_falling_back_to_a_card(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [
                {
                    "position": 1, "narration": "杯影正在移动。", "duration": 4,
                    "visual_strategy": "generated", "visual_prompt": "固定机位水杯延时摄影",
                },
                {
                    "position": 2, "narration": "同一只杯子的亮斑也在移动。", "duration": 4,
                    "visual_strategy": "stock", "visual_prompt": "复用同一母片的近裁",
                },
            ]}, ensure_ascii=False), encoding="utf-8")
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({"shots": [
                {
                    "scenePosition": 1, "preferredProviderId": "hailuo-video-v1",
                    "alternativeProviderIds": ["local-editorial-v1"],
                    "deliveryType": "generated_video",
                    "query": "glass water sunlight shadow windowsill timelapse",
                    "generationPrompt": "固定机位拍摄窗边水杯与移动的杯影。",
                },
                {
                    "scenePosition": 2, "preferredProviderId": "pexels-stock-v1",
                    "alternativeProviderIds": ["local-editorial-v1"],
                    "deliveryType": "stock_video",
                    "query": "REUSE_ONLY scene one locked master crop",
                    "generationPrompt": "复用第一镜母片并近裁杯底亮斑。",
                },
            ]}, ensure_ascii=False), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {"scriptPath": str(script_path), "directorPlanPath": str(director_plan_path)}
            request["parameters"] = {
                "providerId": "ai-shot-router-v1", "provider": "ai-router", "mediaType": "video",
            }

            with patch("video_factory.stock_assets.search_stock_assets") as search_assets:
                response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            first, reused = plan["scene_assets"]
            self.assertEqual(reused["local_path"], first["local_path"])
            self.assertEqual(reused["asset_id"], first["asset_id"])
            self.assertEqual(first["provider"], "hailuo-video-v1")
            self.assertEqual(first["local_path"], "")
            self.assertEqual(reused["scene_position"], 2)
            self.assertEqual(plan["director_routing"][1]["reuse_from_scene_position"], 1)
            self.assertTrue(plan["director_routing"][1]["generation_pending"])
            search_assets.assert_not_called()

    def test_ai_router_rejects_duplicate_director_scenes_before_materializing_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1, "narration": "唯一镜头", "duration": 4,
                "visual_strategy": "local", "visual_prompt": "唯一说明卡",
            }]}, ensure_ascii=False), encoding="utf-8")
            director_plan_path = root / "director_plan.json"
            shot = {
                "scenePosition": 1,
                "preferredProviderId": "local-editorial-v1",
                "alternativeProviderIds": [],
                "deliveryType": "editorial_card",
                "query": "唯一说明卡",
            }
            director_plan_path.write_text(json.dumps({"shots": [shot, shot]}), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {"scriptPath": str(script_path), "directorPlanPath": str(director_plan_path)}
            request["parameters"] = {"providerId": "ai-shot-router-v1", "provider": "ai-router"}

            with self.assertRaisesRegex(ValueError, "exactly cover every script scene"):
                handle_request(request)

    def test_ai_router_resolves_an_out_of_order_indirect_reuse_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            scenes = [
                {"position": position, "narration": f"scene {position}", "duration": 4,
                 "visual_strategy": "generated", "visual_prompt": f"shot {position}"}
                for position in (3, 1, 2)
            ]
            script_path.write_text(json.dumps({"scenes": scenes}), encoding="utf-8")
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({"shots": [
                {"scenePosition": 3, "preferredProviderId": "pexels-stock-v1", "deliveryType": "stock_video",
                 "reuseFromScenePosition": 2, "query": "REUSE_ONLY scene 2", "generationPrompt": "reuse two"},
                {"scenePosition": 1, "preferredProviderId": "hailuo-video-v1", "deliveryType": "generated_video",
                 "query": "master shot", "generationPrompt": "master shot"},
                {"scenePosition": 2, "preferredProviderId": "pexels-stock-v1", "deliveryType": "stock_video",
                 "reuseFromScenePosition": 1, "query": "REUSE_ONLY scene 1", "generationPrompt": "reuse one"},
            ]}), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {"scriptPath": str(script_path), "directorPlanPath": str(director_plan_path)}
            request["parameters"] = {"providerId": "ai-shot-router-v1", "provider": "ai-router", "mediaType": "video"}

            with patch("video_factory.stock_assets.search_stock_assets") as search_assets:
                response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            assets = {asset["scene_position"]: asset for asset in plan["scene_assets"]}
            routes = {route["scene_position"]: route for route in plan["director_routing"]}
            self.assertEqual({assets[position]["asset_id"] for position in (1, 2, 3)}, {assets[1]["asset_id"]})
            self.assertEqual({assets[position]["local_path"] for position in (1, 2, 3)}, {""})
            self.assertTrue(all(routes[position]["generation_pending"] for position in (1, 2, 3)))
            search_assets.assert_not_called()

    def test_ai_router_rejects_invalid_reuse_graphs_before_materializing_assets(self):
        cases = {
            "missing source": {2: 9},
            "self reference": {2: 2},
            "forward reference": {1: 2},
            "invalid indirect chain": {2: 1, 3: 4},
        }
        for name, sources in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                script_path = root / "script.json"
                script_path.write_text(json.dumps({"scenes": [
                    {
                        "position": position,
                        "narration": f"scene {position}",
                        "duration": 4,
                        "visual_strategy": "generated",
                        "visual_prompt": f"shot {position}",
                    }
                    for position in (1, 2, 3)
                ]}), encoding="utf-8")
                shots = []
                for position in (1, 2, 3):
                    source = sources.get(position)
                    if source is None:
                        shots.append({
                            "scenePosition": position,
                            "preferredProviderId": "hailuo-video-v1",
                            "deliveryType": "generated_video",
                            "query": f"master {position}",
                            "generationPrompt": f"master {position}",
                        })
                    else:
                        shots.append({
                            "scenePosition": position,
                            "preferredProviderId": "pexels-stock-v1",
                            "deliveryType": "stock_video",
                            "reuseFromScenePosition": source,
                            "query": f"REUSE_ONLY scene {source}",
                            "generationPrompt": f"reuse {source}",
                        })
                director_plan_path = root / "director_plan.json"
                director_plan_path.write_text(json.dumps({"shots": shots}), encoding="utf-8")
                request = self.valid_request("asset.prepare", root / "assets")
                request["input"] = {"scriptPath": str(script_path), "directorPlanPath": str(director_plan_path)}
                request["parameters"] = {"providerId": "ai-shot-router-v1", "provider": "ai-router"}

                with patch("video_factory.stock_assets.search_stock_assets") as search_assets:
                    with self.assertRaisesRegex(ValueError, "must reuse an earlier existing scene"):
                        handle_request(request)

                search_assets.assert_not_called()
                self.assertEqual(list((root / "assets").rglob("*.png")), [])
                self.assertEqual(list((root / "assets").rglob("*.mp4")), [])

    def test_asset_search_returns_preview_candidates_without_downloading_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = Path(handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"])
            script = json.loads(script_path.read_text(encoding="utf-8"))
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({
                "shots": [{
                    "scenePosition": scene["position"],
                    "preferredProviderId": "pexels-stock-v1" if scene["position"] == 1 else "local-editorial-v1",
                    "alternativeProviderIds": ["local-editorial-v1"],
                    "deliveryType": "stock_video" if scene["position"] == 1 else "editorial_card",
                    "query": f"scene query {scene['position']}",
                    "subject": "人物",
                    "environment": "室内",
                    "visibleAction": "抬头",
                    "lighting": "清晨侧逆光",
                    "generationPrompt": "人物在早餐摊前接过热豆浆",
                    "temporalBeats": ["先看向摊主", "再接过豆浆"],
                } for scene in script["scenes"]],
            }, ensure_ascii=False), encoding="utf-8")
            request = self.valid_request("asset.search", root / "candidates")
            request["input"] = {"scriptPath": str(script_path), "directorPlanPath": str(director_plan_path)}
            request["parameters"] = {"providerId": "asset-candidate-search-v1", "mediaType": "video", "limit": 3}
            candidate = StockAssetCandidate(
                provider="pexels", asset_id="candidate-1", media_type="video", width=1080, height=1920,
                duration=5, preview_url="https://images.pexels.com/preview.jpg",
                download_url="https://example.invalid/private.mp4?token=secret",
                source_url="https://www.pexels.com/video/1", creator="Creator", license_note="Pexels license",
                query="scene query 1", score=100,
            )

            with patch("video_factory.stock_assets.search_stock_assets", return_value=[candidate]), patch(
                "video_factory.stock_assets.materialize_candidate",
            ) as materialize:
                response = handle_request(request)

            report = json.loads(Path(response["output"]["candidateSearchPath"]).read_text(encoding="utf-8"))
            inventory = json.loads(Path(response["output"]["candidateInventoryPath"]).read_text(encoding="utf-8"))
            self.assertEqual(response["status"], "succeeded")
            self.assertEqual(report["version"], "video-factory/asset-candidates-v1")
            self.assertEqual(report["scene_candidates"][0]["candidates"][0]["asset_id"], "candidate-1")
            self.assertEqual(report["scene_candidates"][0]["intent"]["generation_prompt"], "人物在早餐摊前接过热豆浆")
            self.assertEqual(report["scene_candidates"][0]["intent"]["temporal_beats"], "先看向摊主 | 再接过豆浆")
            self.assertEqual(report["scene_candidates"][0]["intent"]["lighting"], "清晨侧逆光")
            self.assertNotIn("download_url", json.dumps(report))
            self.assertNotIn("secret", json.dumps(report))
            self.assertEqual(inventory["version"], "video-factory/asset-candidate-inventory-v1")
            self.assertIn("token=secret", json.dumps(inventory))
            materialize.assert_not_called()

    def test_ai_router_honors_a_reviewed_candidate_ranking(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = Path(handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"])
            script = json.loads(script_path.read_text(encoding="utf-8"))
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({
                "shots": [{
                    "scenePosition": scene["position"],
                    "preferredProviderId": "pexels-stock-v1" if scene["position"] == 1 else "local-editorial-v1",
                    "alternativeProviderIds": ["local-editorial-v1"],
                    "deliveryType": "stock_video" if scene["position"] == 1 else "editorial_card",
                    "query": f"scene query {scene['position']}",
                } for scene in script["scenes"]],
            }, ensure_ascii=False), encoding="utf-8")
            ranking_path = root / "ranking.json"
            ranking_path.write_text(json.dumps({
                "version": "video-factory/asset-ranking-v1",
                "source": "model",
                "scenes": [{
                    "scenePosition": 1,
                    "candidates": [
                        {"provider": "pexels", "assetId": "candidate-2", "rank": 1, "semanticScore": 88, "locked": False},
                        {"provider": "pexels", "assetId": "candidate-1", "rank": 2, "semanticScore": 64, "locked": False},
                    ],
                }],
            }), encoding="utf-8")
            inventory_path = root / "candidate_inventory.private.json"
            inventory_path.write_text(json.dumps({
                "version": "video-factory/asset-candidate-inventory-v1",
                "scene_candidates": [{
                    "scene_position": 1,
                    "candidates": [
                        {
                            "provider": "pexels", "provider_id": "pexels-stock-v1", "asset_id": "candidate-1",
                            "media_type": "video", "width": 1080, "height": 1920, "duration": 5,
                            "preview_url": "", "download_url": "mock://one", "source_url": "", "creator": "",
                            "license_note": "", "query": "q", "score": 100,
                        },
                        {
                            "provider": "pexels", "provider_id": "pexels-stock-v1", "asset_id": "candidate-2",
                            "media_type": "video", "width": 1080, "height": 1920, "duration": 5,
                            "preview_url": "", "download_url": "mock://two", "source_url": "", "creator": "",
                            "license_note": "", "query": "q", "score": 90,
                        },
                    ],
                }],
            }), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {
                "scriptPath": str(script_path),
                "directorPlanPath": str(director_plan_path),
                "candidateRankingPath": str(ranking_path),
                "candidateInventoryPath": str(inventory_path),
            }
            request["parameters"] = {"providerId": "ai-shot-router-v1", "provider": "ai-router", "mediaType": "video"}
            def materialize(_candidate, target):
                target.write_bytes(b"video")
                return target

            def materialize_local(scene, query, asset_dir, _director_shot=None):
                target = asset_dir / f"scene_{scene.position:02d}_local.png"
                target.write_bytes(b"image")
                return SceneAsset(
                    scene_position=scene.position, provider="local", asset_id=f"local-{scene.position}",
                    media_type="image", width=1080, height=1920, duration=scene.duration,
                    local_path=str(target), source_url="local://card", creator="VideoFactory",
                    license_note="local", query=query,
                )

            with patch("video_factory.stock_assets.search_stock_assets", side_effect=AssertionError("reviewed candidates must not be searched again")) as search_assets, patch(
                "video_factory.stock_assets.materialize_candidate", side_effect=materialize
            ), patch(
                "video_factory.stock_assets.materialize_local_scene", side_effect=materialize_local
            ):
                response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            self.assertEqual(plan["scene_assets"][0]["asset_id"], "candidate-2")
            search_assets.assert_not_called()

    def test_ai_router_fails_when_reviewed_stock_candidates_cannot_be_materialized(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = Path(handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"])
            script = json.loads(script_path.read_text(encoding="utf-8"))
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({
                "shots": [{
                    "scenePosition": scene["position"],
                    "preferredProviderId": "pexels-stock-v1" if scene["position"] == 1 else "local-editorial-v1",
                    "alternativeProviderIds": ["local-editorial-v1"],
                    "deliveryType": "stock_video" if scene["position"] == 1 else "editorial_card",
                    "query": f"scene query {scene['position']}",
                } for scene in script["scenes"]],
            }), encoding="utf-8")
            ranking_path = root / "ranking.json"
            ranking_path.write_text(json.dumps({
                "version": "video-factory/asset-ranking-v1",
                "source": "model",
                "scenes": [{
                    "scenePosition": 1,
                    "candidates": [{
                        "provider": "pexels", "assetId": "best", "rank": 1,
                        "semanticScore": 88, "locked": False,
                    }],
                }],
            }), encoding="utf-8")
            inventory_path = root / "candidate_inventory.private.json"
            inventory_path.write_text(json.dumps({
                "version": "video-factory/asset-candidate-inventory-v1",
                "scene_candidates": [{
                    "scene_position": 1,
                    "candidates": [{
                        "provider": "pexels", "provider_id": "pexels-stock-v1", "asset_id": "best",
                        "media_type": "video", "width": 1080, "height": 1920, "duration": 5,
                        "preview_url": "", "download_url": "mock://best", "source_url": "",
                        "creator": "", "license_note": "", "query": "q", "score": 90,
                    }],
                }],
            }), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {
                "scriptPath": str(script_path),
                "directorPlanPath": str(director_plan_path),
                "candidateRankingPath": str(ranking_path),
                "candidateInventoryPath": str(inventory_path),
            }
            request["parameters"] = {"providerId": "ai-shot-router-v1", "provider": "ai-router", "mediaType": "video"}

            with patch("video_factory.stock_assets.materialize_candidate", side_effect=RuntimeError("download timed out")):
                with self.assertRaisesRegex(RuntimeError, "download timed out"):
                    handle_request(request)


    def test_ai_router_fails_when_reviewed_stock_has_no_usable_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = Path(handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"])
            script = json.loads(script_path.read_text(encoding="utf-8"))
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({
                "shots": [{
                    "scenePosition": scene["position"],
                    "preferredProviderId": "pexels-stock-v1" if scene["position"] == 1 else "local-editorial-v1",
                    "alternativeProviderIds": ["pixabay-stock-v1"] if scene["position"] == 1 else [],
                    "deliveryType": "stock_video" if scene["position"] == 1 else "editorial_card",
                    "query": f"scene query {scene['position']}",
                } for scene in script["scenes"]],
            }, ensure_ascii=False), encoding="utf-8")
            ranking_path = root / "ranking.json"
            ranking_path.write_text(json.dumps({
                "version": "video-factory/asset-ranking-v1",
                "source": "model",
                "scenes": [{
                    "scenePosition": 1,
                    "candidates": [
                        {"provider": "pexels", "assetId": "weak-pexels", "rank": 1, "semanticScore": 20, "locked": False},
                        {"provider": "pixabay", "assetId": "weak-pixabay", "rank": 2, "semanticScore": 18, "locked": False},
                    ],
                }],
            }), encoding="utf-8")
            inventory_path = root / "candidate_inventory.private.json"
            inventory_path.write_text(json.dumps({
                "version": "video-factory/asset-candidate-inventory-v1",
                "scene_candidates": [{
                    "scene_position": 1,
                    "candidates": [{
                        "provider": provider,
                        "provider_id": f"{provider}-stock-v1",
                        "asset_id": f"weak-{provider}",
                        "media_type": "video",
                        "width": 1080,
                        "height": 1920,
                        "duration": 5,
                        "preview_url": "",
                        "download_url": f"mock://weak-{provider}",
                        "source_url": "",
                        "creator": "",
                        "license_note": "",
                        "query": "q",
                        "score": 80,
                    } for provider in ("pexels", "pixabay")],
                }],
            }), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {
                "scriptPath": str(script_path),
                "directorPlanPath": str(director_plan_path),
                "candidateRankingPath": str(ranking_path),
                "candidateInventoryPath": str(inventory_path),
            }
            request["parameters"] = {"providerId": "ai-shot-router-v1", "provider": "ai-router", "mediaType": "video"}

            with self.assertRaisesRegex(RuntimeError, "semantic review"):
                handle_request(request)

    def test_ai_router_rejects_low_semantic_candidates_without_inserting_a_card(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = Path(handle_request(self.valid_request("script.draft", root / "script"))["output"]["scriptPath"])
            script = json.loads(script_path.read_text(encoding="utf-8"))
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({
                "shots": [{
                    "scenePosition": scene["position"],
                    "preferredProviderId": "pexels-stock-v1" if scene["position"] in {1, 2} else "local-editorial-v1",
                    "alternativeProviderIds": ["local-editorial-v1"],
                    "deliveryType": "stock_video" if scene["position"] in {1, 2} else "editorial_card",
                    "query": f"scene query {scene['position']}",
                } for scene in script["scenes"]],
            }, ensure_ascii=False), encoding="utf-8")
            ranking_path = root / "ranking.json"
            ranking_path.write_text(json.dumps({
                "version": "video-factory/asset-ranking-v1",
                "source": "model",
                "scenes": [
                    {
                        "scenePosition": 1,
                        "candidates": [{
                            "provider": "pexels", "assetId": "low-score", "rank": 1,
                            "semanticScore": 20, "locked": False,
                        }],
                    },
                    {
                        "scenePosition": 2,
                        "candidates": [{
                            "provider": "pexels", "assetId": "human-choice", "rank": 1,
                            "semanticScore": 20, "locked": True,
                        }],
                    },
                ],
            }), encoding="utf-8")
            inventory_path = root / "candidate_inventory.private.json"
            inventory_path.write_text(json.dumps({
                "version": "video-factory/asset-candidate-inventory-v1",
                "scene_candidates": [
                    {
                        "scene_position": position,
                        "candidates": [{
                            "provider": "pexels", "provider_id": "pexels-stock-v1", "asset_id": asset_id,
                            "media_type": "video", "width": 1080, "height": 1920, "duration": 5,
                            "preview_url": "", "download_url": f"mock://{asset_id}", "source_url": "",
                            "creator": "", "license_note": "", "query": "q", "score": 90,
                        }],
                    }
                    for position, asset_id in ((1, "low-score"), (2, "human-choice"))
                ],
            }), encoding="utf-8")
            request = self.valid_request("asset.prepare", root / "assets")
            request["input"] = {
                "scriptPath": str(script_path),
                "directorPlanPath": str(director_plan_path),
                "candidateRankingPath": str(ranking_path),
                "candidateInventoryPath": str(inventory_path),
            }
            request["parameters"] = {"providerId": "ai-shot-router-v1", "provider": "ai-router", "mediaType": "video"}

            with self.assertRaisesRegex(RuntimeError, "semantic review"):
                handle_request(request)

    def test_ai_router_prepares_independent_scenes_with_bounded_concurrency(self):
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
                        "preferredProviderId": "local-editorial-v1",
                        "alternativeProviderIds": [],
                        "deliveryType": "editorial_card",
                        "query": f"director query {scene['position']}",
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
            state = {"active": 0, "peak": 0}
            lock = threading.Lock()

            def materialize(scene, query, asset_dir, _director_shot=None):
                with lock:
                    state["active"] += 1
                    state["peak"] = max(state["peak"], state["active"])
                try:
                    time.sleep(0.05)
                    path = asset_dir / f"scene_{scene.position:02d}_local_card.png"
                    path.write_bytes(b"image")
                    return SceneAsset(
                        scene_position=scene.position,
                        provider="local",
                        asset_id=f"scene-{scene.position:02d}-card",
                        media_type="image",
                        width=1080,
                        height=1920,
                        duration=float(scene.duration),
                        local_path=str(path),
                        source_url="local://video-factory/card",
                        creator="VideoFactory",
                        license_note="local",
                        query=query,
                    )
                finally:
                    with lock:
                        state["active"] -= 1

            with patch("video_factory.stock_assets.materialize_local_scene", side_effect=materialize):
                response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            self.assertGreater(state["peak"], 1)
            self.assertLessEqual(state["peak"], 3)
            self.assertEqual(
                [item["scene_position"] for item in plan["scene_assets"]],
                sorted(item["scene_position"] for item in plan["scene_assets"]),
            )

    def test_ai_router_avoids_reusing_a_stock_asset_when_alternatives_exist(self):
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
                        "preferredProviderId": "pexels-stock-v1",
                        "alternativeProviderIds": [],
                        "deliveryType": "stock_image" if scene["position"] == 1 else "stock_video",
                        "query": f"director query {scene['position']}",
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

            requested_media = {}

            def candidates(provider, query, media_type, limit):
                del provider, limit
                unique_id = query.rsplit(" ", 1)[-1]
                requested_media[unique_id] = media_type
                return [
                    StockAssetCandidate(
                        provider="pexels",
                        asset_id="shared",
                        media_type=media_type,
                        width=720,
                        height=1280,
                        duration=5,
                        preview_url="https://example.com/shared.jpg",
                        download_url="https://example.com/shared.mp4",
                        source_url="https://pexels.com/shared",
                        creator="Creator",
                        license_note="Pexels license",
                        query=query,
                        score=90,
                    ),
                    StockAssetCandidate(
                        provider="pexels",
                        asset_id=f"unique-{unique_id}",
                        media_type=media_type,
                        width=720,
                        height=1280,
                        duration=5,
                        preview_url=f"https://example.com/{unique_id}.jpg",
                        download_url=f"https://example.com/{unique_id}.mp4",
                        source_url=f"https://pexels.com/{unique_id}",
                        creator="Creator",
                        license_note="Pexels license",
                        query=query,
                        score=80,
                    ),
                ]

            def materialize(_candidate, target):
                target.write_bytes(b"video")
                return target

            with patch("video_factory.stock_assets.search_stock_assets", side_effect=candidates), patch(
                "video_factory.stock_assets.materialize_candidate", side_effect=materialize,
            ):
                response = handle_request(request)

            plan = json.loads(Path(response["output"]["assetPlanPath"]).read_text(encoding="utf-8"))
            asset_ids = [item["asset_id"] for item in plan["scene_assets"]]
            self.assertEqual(len(asset_ids), len(set(asset_ids)))
            self.assertEqual(asset_ids.count("shared"), 1)
            self.assertEqual(requested_media["1"], "image")
            self.assertEqual(requested_media["2"], "video")
            self.assertEqual(plan["scene_assets"][0]["media_type"], "image")

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
            request["input"].update({
                "voice": "manual-tone",
                "rate": 164,
                "pause_scale": 1.1,
                "mastering_preset": "intimate",
            })

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
                "profile_id": "tone:manual-tone",
                "rate": 164,
                "pause_scale": 1.1,
                "mastering_preset": "intimate",
            })
            self.assertEqual(plan["mastering"]["target_lufs"], -17)

    def test_minimax_voice_records_the_authorized_configured_cost_after_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [
                {"position": 1, "narration": "第一段", "duration": 2},
                {"position": 2, "narration": "第二段", "duration": 2},
            ]}), encoding="utf-8")
            output_dir = root / "voice"
            output_dir.mkdir()
            track_path = output_dir / "narration.m4a"
            track_path.write_bytes(b"audio")
            plan_path = output_dir / "voiceover_plan.json"
            plan_path.write_text(json.dumps({
                "track_path": str(track_path),
                "scenes": [{"position": 1}, {"position": 2}],
            }), encoding="utf-8")
            request = self.valid_request("voice.synthesize", output_dir)
            request["input"] = {"scriptPath": str(script_path)}
            request["parameters"] = {
                "providerId": "minimax-tts-v1",
                "provider": "minimax",
                "maxCostCny": 2,
                "estimatedCostCny": 0.5,
            }

            with patch("video_factory.worker.synthesize_voiceover_plan", return_value=plan_path) as synthesize:
                response = handle_request(request)

            self.assertEqual(synthesize.call_args.kwargs.get("operation_id"), "command-1")
            self.assertEqual(synthesize.call_args.kwargs.get("provider_id"), "minimax-tts-v1")
            self.assertEqual(synthesize.call_args.kwargs.get("estimated_cost_cny"), 0.5)
            self.assertEqual(response["diagnostics"]["actualCostCny"], 0.5)
            self.assertEqual(response["diagnostics"]["actualCostSource"], "configured_rate")
            self.assertEqual(response["diagnostics"]["meteredAttemptCount"], 2)
            self.assertEqual(response["diagnostics"]["meteredFailedAttemptCount"], 0)

    def test_voice_timing_conflict_preserves_materialized_audio_and_paid_operation_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [
                {
                    "position": 1, "narration": "第一段自然旁白", "duration": 8,
                    "visual_strategy": "stock", "visual_prompt": "第一个动作",
                },
                {
                    "position": 2, "narration": "第二段自然旁白", "duration": 12,
                    "visual_strategy": "stock", "visual_prompt": "第二个动作",
                },
            ]}), encoding="utf-8")
            executable_plan_path = root / "executable_plan.json"
            executable_plan_path.write_text(json.dumps({
                "version": "video-factory/executable-plan-v1",
                "durationRange": {"minSeconds": 20, "maxSeconds": 34},
                "fps": 30,
                "totalFrames": 600,
                "cuts": [
                    {
                        "scenePosition": 1, "assetKey": "asset-scene-1",
                        "startFrame": 0, "frameCount": 240, "sourceInFrame": 0,
                    },
                    {
                        "scenePosition": 2, "assetKey": "asset-scene-2",
                        "startFrame": 240, "frameCount": 360, "sourceInFrame": 0,
                    },
                ],
            }), encoding="utf-8")
            output_dir = root / "nodes" / "voice" / "attempt-1"
            output_dir.mkdir(parents=True)
            raw_path = output_dir / "scene_01_raw.mp3"
            raw_path.write_bytes(b"paid-natural-voice")
            ledger_path = output_dir.parent / ".voice-operations" / (
                hashlib.sha256(b"command-1").hexdigest() + ".json"
            )
            ledger_path.parent.mkdir(parents=True)
            ledger_path.write_text(json.dumps({
                "version": "video-factory/paid-operation-v2",
                "operationId": "command-1",
                "completed": True,
                "providerId": "minimax-tts-v1",
                "modelId": "speech-test",
                "estimatedCostCny": 0.5,
                "actualCostCny": 0.5,
                "actualCostSource": "configured_rate",
                "items": [{
                    "itemRequestId": "voice-scene-1",
                    "state": "materialized",
                    "stateHistory": ["prepared", "unknown", "materialized"],
                    "localPath": str(raw_path.resolve()),
                }],
            }), encoding="utf-8")
            request = self.valid_request("voice.synthesize", output_dir)
            request["input"] = {
                "scriptPath": str(script_path),
                "executablePlanPath": str(executable_plan_path),
            }
            request["parameters"] = {
                "providerId": "minimax-tts-v1",
                "provider": "minimax",
                "modelId": "speech-test",
                "estimatedCostCny": 0.5,
            }

            with patch(
                "video_factory.worker.synthesize_voiceover_plan",
                side_effect=VoiceDoesNotFitError(1, 8, 8.2, raw_path),
            ):
                response = handle_request(request)

            self.assertEqual(response["status"], "rejected")
            self.assertEqual(response["error"]["code"], "VOICE_DOES_NOT_FIT")
            conflict = response["output"]["conflict"]
            self.assertEqual(conflict["scenePosition"], 1)
            self.assertEqual(conflict["plannedSeconds"], 8)
            self.assertEqual(conflict["speechSeconds"], 8.2)
            self.assertEqual(conflict["requiredSeconds"], 8.2)
            self.assertEqual(conflict["audioArtifact"]["uri"], str(raw_path.resolve()))
            self.assertEqual(conflict["audioArtifact"]["sha256"], hashlib.sha256(b"paid-natural-voice").hexdigest())
            self.assertEqual(response["artifacts"][0], conflict["audioArtifact"])
            self.assertEqual(response["diagnostics"]["actualCostCny"], 0.5)
            self.assertEqual(response["diagnostics"]["meteredAttemptCount"], 1)
            self.assertTrue(response["diagnostics"]["providerOutcomeKnown"])

    def test_reused_minimax_voice_reports_zero_new_provider_calls_and_cost(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1, "narration": "复用已有自然旁白", "duration": 8.4,
            }]}), encoding="utf-8")
            output_dir = root / "nodes" / "voice" / "attempt-2"
            output_dir.mkdir(parents=True)
            track_path = output_dir / "narration.m4a"
            track_path.write_bytes(b"normalized-reused-audio")
            plan_path = output_dir / "voiceover_plan.json"
            plan_path.write_text(json.dumps({
                "track_path": str(track_path.resolve()),
                "scenes": [{"position": 1}],
            }), encoding="utf-8")
            ledger_path = output_dir.parent / ".voice-operations" / (
                hashlib.sha256(b"command-1").hexdigest() + ".json"
            )
            ledger_path.parent.mkdir(parents=True)
            ledger_path.write_text(json.dumps({
                "version": "video-factory/paid-operation-v2",
                "operationId": "command-1",
                "completed": True,
                "providerId": "minimax-tts-v1",
                "modelId": "speech-test",
                "estimatedCostCny": 0.5,
                "actualCostCny": 0,
                "actualCostSource": "configured_rate",
                "items": [{
                    "itemRequestId": "voice-scene-1-reuse",
                    "state": "materialized",
                    "stateHistory": ["prepared", "reused_materialized"],
                }],
            }), encoding="utf-8")
            request = self.valid_request("voice.synthesize", output_dir)
            request["input"] = {"scriptPath": str(script_path)}
            request["parameters"] = {
                "providerId": "minimax-tts-v1",
                "provider": "minimax",
                "modelId": "speech-test",
                "estimatedCostCny": 0.5,
            }

            with patch("video_factory.worker.synthesize_voiceover_plan", return_value=plan_path):
                response = handle_request(request)

            self.assertEqual(response["status"], "succeeded")
            self.assertEqual(response["diagnostics"]["actualCostCny"], 0)
            self.assertEqual(response["diagnostics"]["meteredAttemptCount"], 0)
            self.assertEqual(response["diagnostics"]["meteredFailedAttemptCount"], 0)
            self.assertTrue(response["diagnostics"]["providerOutcomeKnown"])

    def test_minimax_voice_reports_a_definitive_provider_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [
                {"position": 1, "narration": "明确拒绝", "duration": 2},
            ]}), encoding="utf-8")
            output_dir = root / "nodes" / "voice" / "attempt-1"
            request = self.valid_request("voice.synthesize", output_dir)
            request["input"] = {"scriptPath": str(script_path)}
            request["parameters"] = {
                "providerId": "minimax-tts-v1",
                "provider": "minimax",
                "estimatedCostCny": 0.5,
            }

            def reject_with_ledger(**_kwargs):
                ledger_path = output_dir.parent / ".voice-operations" / (
                    hashlib.sha256(b"command-1").hexdigest() + ".json"
                )
                ledger_path.parent.mkdir(parents=True)
                ledger_path.write_text(json.dumps({
                    "version": "video-factory/paid-operation-v2",
                    "operationId": "command-1",
                    "completed": False,
                    "providerId": "minimax-tts-v1",
                    "modelId": "speech-2.8-turbo",
                    "estimatedCostCny": 0.5,
                    "items": [{
                        "itemRequestId": "voice-scene-1",
                        "state": "terminal_failed",
                        "stateHistory": ["prepared", "unknown", "terminal_failed"],
                    }],
                }), encoding="utf-8")
                raise RuntimeError("MiniMax speech synthesis failed: invalid request")

            with patch("video_factory.worker.synthesize_voiceover_plan", side_effect=reject_with_ledger):
                response = handle_request(request)

            self.assertEqual(response["status"], "failed")
            self.assertEqual(response["diagnostics"]["meteredAttemptCount"], 1)
            self.assertEqual(response["diagnostics"]["meteredFailedAttemptCount"], 1)
            self.assertEqual(response["diagnostics"]["actualCostCny"], 0)
            self.assertTrue(response["diagnostics"]["providerOutcomeKnown"])

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
                with self.assertRaisesRegex(RuntimeError, "not provisioned in this deployment"):
                    handle_request(request)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_render_and_review_produce_decodable_video_with_audible_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_request = self.valid_request("script.draft", root / "script")
            script_request["input"]["brief"]["durationSeconds"] = 20
            script_path = handle_request(script_request)["output"]["scriptPath"]
            script = json.loads(Path(script_path).read_text(encoding="utf-8"))
            director_plan_path = root / "director_plan.json"
            director_plan_path.write_text(json.dumps({"shots": [{
                "scenePosition": scene["position"],
                "preferredProviderId": "local-editorial-v1",
                "alternativeProviderIds": [],
                "deliveryType": "editorial_card",
                "query": scene["visual_prompt"],
            } for scene in script["scenes"]]}), encoding="utf-8")

            asset_request = self.valid_request("asset.prepare", root / "assets")
            asset_request["input"] = {"scriptPath": script_path, "directorPlanPath": str(director_plan_path)}
            asset_request["parameters"] = {
                "providerId": "ai-shot-router-v1",
                "provider": "ai-router",
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
