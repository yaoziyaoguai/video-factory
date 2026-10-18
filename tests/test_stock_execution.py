import io
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from video_factory.domain import Scene, StockAssetCandidate
from video_factory.stock_assets import prepare_routed_scene_assets, prepare_scene_assets, write_response_body
from video_factory.stock_execution import StockExecution, StockPreparationStopped


class StockExecutionTest(unittest.TestCase):
    def test_stop_during_search_keeps_previously_completed_assets(self):
        for routed, reason in ((False, "deadline"), (True, "deadline"), (False, "pause"), (True, "pause")):
            with self.subTest(routed=routed, reason=reason), tempfile.TemporaryDirectory() as tmp:
                pause = Path(tmp) / "pause.json"
                execution = StockExecution({"pauseRequestPath": str(pause)})
                scenes = [Scene(n, "海", 5, "stock", "sea") for n in (1, 2)]
                candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="image", width=1080, height=1920,
                    duration=0, preview_url="", download_url="https://images.pexels.com/sea.jpg", source_url="", creator="test", license_note="test", query="sea", score=90)
                searches = 0
                def search(*_args, **_kwargs):
                    nonlocal searches
                    searches += 1
                    if searches == 1:
                        return [candidate]
                    if reason == "deadline":
                        execution.deadline = time.monotonic() - 1
                    else:
                        pause.write_text("{}")
                    raise RuntimeError("search request timed out")
                def download(_candidate, target, **_controls):
                    target.write_bytes(b"complete-image")
                    return target
                search_name = "search_stock_query_variants" if routed else "search_stock_assets"
                with patch("video_factory.stock_assets.ASSET_PREPARE_WORKERS", 1), \
                     patch(f"video_factory.stock_assets.{search_name}", side_effect=search), \
                     patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                    with self.assertRaises(StockPreparationStopped) as caught:
                        if routed:
                            plan = {"shots": [{"scenePosition": n, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "query": "sea"} for n in (1, 2)]}
                            prepare_routed_scene_assets(1, scenes, Path(tmp), plan, execution=execution)
                        else:
                            prepare_scene_assets(1, scenes, Path(tmp), "pexels", execution=execution)
                self.assertEqual(caught.exception.code, "STOCK_PREPARATION_DEADLINE" if reason == "deadline" else "STOCK_PREPARATION_PAUSED")
                partial = json.loads(caught.exception.plan_path.read_text())
                self.assertIs(partial["preparation_complete"], False)
                self.assertEqual([item["scene_position"] for item in partial["scene_assets"]], [1])
                self.assertEqual(Path(partial["scene_assets"][0]["local_path"]).read_bytes(), b"complete-image")

    def test_failed_candidate_is_not_downloaded_again_by_duplicate_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            scene = Scene(1, "海", 5, "stock", "sea")
            candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="image", width=1080, height=1920,
                duration=0, preview_url="", download_url="https://images.pexels.com/sea.jpg", source_url="", creator="test", license_note="test", query="sea", score=90)
            plan = {"shots": [{"scenePosition": 1, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "query": "sea"}]}
            with patch("video_factory.stock_assets.search_stock_query_variants", return_value=[candidate]), \
                 patch("video_factory.stock_assets.materialize_candidate", side_effect=RuntimeError("network timeout")) as download:
                with self.assertRaises(StockPreparationStopped) as caught:
                    prepare_routed_scene_assets(1, [scene], Path(tmp), plan, execution=StockExecution({}))
            self.assertEqual(caught.exception.code, "STOCK_PREPARATION_UNAVAILABLE")
            self.assertEqual(download.call_count, 1, "第二轮只允许采用别镜已占用、但本镜尚未下载的候选")
            self.assertEqual(json.loads(caught.exception.plan_path.read_text())["scene_assets"], [])

    def test_direct_provider_pause_resumes_with_verified_completed_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pause = root / "pause.json"
            scenes = [Scene(n, "海", 5, "stock", "sea") for n in (1, 2)]
            candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="image", width=1080, height=1920,
                duration=0, preview_url="", download_url="https://images.pexels.com/sea.jpg", source_url="", creator="test", license_note="test", query="sea", score=90)
            def download(_candidate, target, **_controls):
                target.write_bytes(b"complete-image")
                pause.write_text("{}")
                return target
            with patch("video_factory.stock_assets.search_stock_assets", return_value=[candidate]), \
                 patch("video_factory.stock_assets.materialize_candidate", side_effect=download) as materialize:
                with self.assertRaises(StockPreparationStopped) as caught:
                    prepare_scene_assets(1, scenes, root, "pexels", execution=StockExecution({"pauseRequestPath": str(pause)}))
                partial = json.loads(caught.exception.plan_path.read_text())
                self.assertEqual(len(partial["scene_assets"]), 1)
                source = Path(partial["scene_assets"][0]["local_path"])
                pause.unlink()
                result = prepare_scene_assets(1, scenes, root / "retry", "pexels", execution=StockExecution({}),
                    reusable_assets=[{"scenePosition": 1, "provider": "pexels", "assetId": "sea", "localPath": str(source),
                                      "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}])
            self.assertEqual(materialize.call_count, 2, "第二次只获取尚未完成的镜头")
            self.assertEqual(len(json.loads(result.read_text())["scene_assets"]), 2)
            self.assertEqual(source.read_bytes(), b"complete-image")

    def test_pause_keeps_completed_asset_and_does_not_start_next_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pause = root / "pause.json"
            execution = StockExecution({"pauseRequestPath": str(pause), "stockProgressPath": str(root / "progress.json"), "commandId": "op"})
            scenes = [Scene(position=n, duration=5, narration="", visual_strategy="stock", visual_prompt="sea", search_terms=[]) for n in (1, 2)]
            plan = {"shots": [{"scenePosition": n, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "query": "sea"} for n in (1, 2)]}
            candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="image", width=1080, height=1920,
                duration=0, preview_url="", download_url="https://images.pexels.com/sea.jpg", source_url="", creator="test", license_note="test", query="sea", score=90)
            def download(_candidate, target, **_controls):
                target.write_bytes(b"complete-image")
                pause.write_text("{}")
                return target
            with patch("video_factory.stock_assets.ASSET_PREPARE_WORKERS", 1), patch("video_factory.stock_assets.search_stock_query_variants", return_value=[candidate]), patch("video_factory.stock_assets.materialize_candidate", side_effect=download) as materialize:
                with self.assertRaises(StockPreparationStopped) as caught:
                    prepare_routed_scene_assets(1, scenes, root, plan, execution=execution)
            self.assertEqual(caught.exception.code, "STOCK_PREPARATION_PAUSED")
            self.assertEqual(materialize.call_count, 1)
            partial = json.loads(caught.exception.plan_path.read_text())
            self.assertIs(partial["preparation_complete"], False)
            self.assertEqual([item["scene_position"] for item in partial["scene_assets"]], [1])
            self.assertEqual(Path(partial["scene_assets"][0]["local_path"]).read_bytes(), b"complete-image")
            progress = json.loads((root / "progress.json").read_text())
            self.assertEqual(progress["operationId"], "op")
            self.assertEqual({item["state"] for item in progress["scenes"]}, {"completed", "stopped"})

    def test_pause_during_body_removes_only_incomplete_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pause = root / "pause.json"
            completed = root / "previous.jpg"
            completed.write_bytes(b"previous")
            execution = StockExecution({"pauseRequestPath": str(pause)})
            class SlowResponse(io.BytesIO):
                def read1(self, size):
                    pause.write_text("{}")
                    return super().read1(1)
            with self.assertRaises(StockPreparationStopped):
                write_response_body(SlowResponse(b"image"), root / "partial.jpg", 100, execution=execution)
            self.assertFalse((root / "partial.jpg").exists())
            self.assertEqual(completed.read_bytes(), b"previous")

    def test_expired_execution_does_not_allocate_another_download_window(self):
        execution = StockExecution({"executionDeadlineUnixMs": time.time() * 1000 - 1})
        with self.assertRaises(StockPreparationStopped) as caught:
            execution.check()
        self.assertEqual(caught.exception.code, "STOCK_PREPARATION_DEADLINE")

    def test_progress_only_contains_safe_facts_and_keeps_failure_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "progress.json"
            execution = StockExecution({"stockProgressPath": str(file), "commandId": "op", "input": {"secret": "not-public"}})
            execution.progress(1, 2, "retrying", "pixabay")
            execution.progress(1, 2, "completed", "pixabay")
            saved = json.loads(file.read_text())
            self.assertEqual(saved["scenes"][0]["failedAttempts"], 1)
            self.assertNotIn("not-public", file.read_text())
