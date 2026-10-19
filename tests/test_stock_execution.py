import contextlib
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

    def test_progress_distinguishes_missing_and_explicit_values(self):
        # D 批次：None 表示「未提供新值」沿用旧值，显式 0/"" 才覆盖；
        # stopped/failed 默认不清 provider、候选数与最后失败，completed 清除失败摘要。
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "progress.json"
            execution = StockExecution({"stockProgressPath": str(file), "commandId": "op"})
            failure = {"provider": "pexels", "stage": "connect", "reason": "timeout"}
            execution.progress(1, 2, "searching", "pexels", 3)
            execution.progress(1, 2, "retrying", "pexels", last_failure=failure)
            execution.progress(1, 2, "stopped")
            scene = json.loads(file.read_text())["scenes"][0]
            self.assertEqual((scene["provider"], scene["candidateCount"]), ("pexels", 3))
            self.assertEqual(scene["lastFailure"], failure)
            self.assertEqual(scene["failedAttempts"], 1, "stop 不多加失败计数")

            # 显式 0 覆盖旧候选数；completed 清除 lastFailure，不被旧错误污染。
            execution.progress(1, 2, "searching", "pexels", 0)
            self.assertEqual(json.loads(file.read_text())["scenes"][0]["candidateCount"], 0)
            execution.progress(1, 2, "completed", "pexels")
            scene = json.loads(file.read_text())["scenes"][0]
            self.assertNotIn("lastFailure", scene)

    def test_progress_clears_stale_failure_when_provider_changes(self):
        # 换图库开始新尝试时，旧图库的失败原因不能继续当作本次原因。
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "progress.json"
            execution = StockExecution({"stockProgressPath": str(file), "commandId": "op"})
            execution.progress(1, 2, "retrying", "pexels",
                                last_failure={"provider": "pexels", "stage": "http", "reason": "http_error", "httpStatus": 429})
            execution.progress(1, 2, "downloading", "pixabay")
            scene = json.loads(file.read_text())["scenes"][0]
            self.assertEqual(scene["provider"], "pixabay")
            self.assertNotIn("lastFailure", scene)

    def test_progress_rejects_unsafe_failure_fields(self):
        # 写入侧即只接受白名单枚举与整数状态码；URL、原文等一律不落盘。
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "progress.json"
            execution = StockExecution({"stockProgressPath": str(file), "commandId": "op"})
            execution.progress(1, 2, "retrying", "pexels",
                               last_failure={"provider": "pexels", "stage": "connect", "reason": "timeout",
                                             "url": "https://signed.example/private", "raw": "boom"})
            execution.progress(1, 2, "retrying", "pexels",
                               last_failure={"provider": "pexels", "stage": "vpn", "reason": "guess"})
            scene = json.loads(file.read_text())["scenes"][0]
            self.assertEqual(scene["lastFailure"], {"provider": "pexels", "stage": "unknown", "reason": "unknown"})

    def test_download_failure_records_safe_last_failure_per_scene(self):
        # D 批次：下载失败经 cause 链分类写进逐镜进度；进度写失败不改变素材结果。
        from video_factory.asset_transport import AssetNetworkError
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            execution = StockExecution({"stockProgressPath": str(root / "progress.json"), "commandId": "op"})
            scene = Scene(1, "海", 5, "stock", "sea")
            candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="image", width=1080, height=1920,
                duration=0, preview_url="", download_url="https://images.pexels.com/sea.jpg", source_url="", creator="test", license_note="test", query="sea", score=90)
            plan = {"shots": [{"scenePosition": 1, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "query": "sea"}]}
            def download(_candidate, _target, **_controls):
                raise RuntimeError(
                    "Asset download failed after 3 attempts for pexels:sea: 连接失败（TimeoutError，直连）"
                ) from AssetNetworkError("连接失败（TimeoutError，直连）", stage="connect", reason="timeout")
            with patch("video_factory.stock_assets.search_stock_query_variants", return_value=[candidate]), \
                 patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                with self.assertRaises(StockPreparationStopped) as caught:
                    prepare_routed_scene_assets(1, [scene], root, plan, execution=execution)
            self.assertEqual(caught.exception.code, "STOCK_PREPARATION_UNAVAILABLE")
            saved = json.loads((root / "progress.json").read_text())["scenes"][0]
            self.assertEqual(saved["state"], "stopped")
            self.assertEqual(saved["provider"], "pexels", "停止时保留最后图库")
            self.assertEqual(saved["lastFailure"], {"provider": "pexels", "stage": "connect", "reason": "timeout"})
            self.assertNotIn("sea.jpg", (root / "progress.json").read_text())

    def test_media_rejection_is_not_classified_as_network_failure(self):
        # 媒体时长不足等非网络拒绝标 media/invalid_media，不冒充网络故障。
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            execution = StockExecution({"stockProgressPath": str(root / "progress.json"), "commandId": "op"})
            scene = Scene(1, "海", 5, "stock", "sea")
            candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="video", width=720, height=1280,
                duration=30, preview_url="", download_url="https://media.example/sea.mp4", source_url="", creator="test", license_note="test", query="sea", score=90)
            plan = {"shots": [{"scenePosition": 1, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_video", "query": "sea"}]}
            def download(_candidate, target, **_controls):
                raise RuntimeError("素材实际时长 2 秒不足以覆盖所需 5 秒")
            with patch("video_factory.stock_assets.search_stock_query_variants", return_value=[candidate]), \
                 patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                with self.assertRaises(StockPreparationStopped):
                    prepare_routed_scene_assets(1, [scene], root, plan, execution=execution)
            saved = json.loads((root / "progress.json").read_text())["scenes"][0]
            self.assertEqual(saved["lastFailure"], {"provider": "pexels", "stage": "media", "reason": "invalid_media"})


    # R2-06/R2-07（round2）：逐镜检索终态如实、正文/媒体边界携带结构化阶段；
    # 场景由 contract-stock-probe 迁移为期待正确行为的正式回归。

    def test_all_sources_failed_scene_is_recorded_failed_not_completed(self):
        # 全部尝试来源失败的镜记 failed：不清 lastFailure、不冒充完成；
        # asset.search 入口按既有合同抛 StockSearchUnavailableError（逐镜进度已先落盘）。
        from video_factory.asset_transport import AssetNetworkError
        from video_factory.stock_assets import StockSearchUnavailableError, search_routed_scene_asset_candidates
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            execution = StockExecution({"stockProgressPath": str(root / "progress.json"), "commandId": "op"})
            scene = Scene(1, "海", 5, "stock", "sea")
            plan = {"shots": [{"scenePosition": 1, "preferredProviderId": "pexels-stock-v1",
                               "alternativeProviderIds": ["pixabay-stock-v1"], "deliveryType": "stock_image", "query": "sea"}]}
            attempts = {"pexels": 0, "pixabay": 0}
            def search(provider, *_args, **_kwargs):
                attempts[provider] += 1
                raise AssetNetworkError("检索失败", stage="connect", reason="timeout")
            with patch("video_factory.stock_assets.search_stock_query_variants", side_effect=search):
                with self.assertRaises(StockSearchUnavailableError) as caught:
                    search_routed_scene_asset_candidates(1, [scene], root, plan, execution=execution)
            self.assertIn("全部来源失败", str(caught.exception))
            self.assertEqual(attempts, {"pexels": 1, "pixabay": 1})
            saved = json.loads((root / "progress.json").read_text())["scenes"][0]
            self.assertEqual(saved["state"], "failed", "全来源失败的镜不能记 completed")
            self.assertEqual(saved["provider"], "pixabay", "保留最后尝试的图库")
            self.assertEqual(saved["lastFailure"], {"provider": "pixabay", "stage": "connect", "reason": "timeout"},
                             "failed 不清除失败摘要")
            self.assertEqual(saved["failedAttempts"], 2)

    def test_single_failed_scene_is_not_masked_by_other_scene_success(self):
        # 第 2 镜全部来源失败不被第 1 镜成功掩盖：镜 1 completed、镜 2 failed，
        # 全局有成功来源不判整体失败，报告/库存照常写盘并携带 search_errors。
        from video_factory.asset_transport import AssetNetworkError
        from video_factory.stock_assets import search_routed_scene_asset_candidates
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            execution = StockExecution({"stockProgressPath": str(root / "progress.json"), "commandId": "op"})
            scenes = [Scene(1, "海", 5, "stock", "sea"), Scene(2, "山", 5, "stock", "mountain")]
            candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="image", width=1080, height=1920,
                duration=0, preview_url="", download_url="https://images.pexels.com/sea.jpg", source_url="", creator="test", license_note="test", query="sea", score=90)
            plan = {"shots": [
                {"scenePosition": 1, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "query": "sea"},
                {"scenePosition": 2, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "query": "mountain"},
            ]}
            def search(_provider, query, *_args, **_kwargs):
                if "mountain" in query:
                    raise AssetNetworkError("检索失败", stage="http", reason="http_error", http_status=503)
                return [candidate]
            with patch("video_factory.stock_assets.search_stock_query_variants", side_effect=search):
                report_path, inventory_path = search_routed_scene_asset_candidates(1, scenes, root, plan, execution=execution)
            saved = {row["scenePosition"]: row for row in json.loads((root / "progress.json").read_text())["scenes"]}
            self.assertEqual(saved[1]["state"], "completed")
            self.assertNotIn("lastFailure", saved[1])
            self.assertEqual(saved[2]["state"], "failed", "单独全失败的镜不被其他镜成功掩盖")
            self.assertEqual(saved[2]["lastFailure"], {"provider": "pexels", "stage": "http", "reason": "http_error", "httpStatus": 503})
            report = json.loads(report_path.read_text())
            self.assertEqual(len(report["scene_candidates"][1]["search_errors"]), 1)
            self.assertTrue(inventory_path.exists())

    def test_scene_with_partial_failure_then_success_stays_completed(self):
        # 防回归：失败后成功的镜仍 completed（清除 lastFailure），成功但 0 候选也 completed。
        from video_factory.stock_assets import search_routed_scene_asset_candidates
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            execution = StockExecution({"stockProgressPath": str(root / "progress.json"), "commandId": "op"})
            scenes = [Scene(1, "海", 5, "stock", "sea"), Scene(2, "山", 5, "stock", "mountain")]
            candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="image", width=1080, height=1920,
                duration=0, preview_url="", download_url="https://images.pexels.com/sea.jpg", source_url="", creator="test", license_note="test", query="sea", score=90)
            plan = {"shots": [
                {"scenePosition": 1, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": ["pixabay-stock-v1"], "deliveryType": "stock_image", "query": "sea"},
                {"scenePosition": 2, "preferredProviderId": "pexels-stock-v1", "alternativeProviderIds": [], "deliveryType": "stock_image", "query": "mountain"},
            ]}
            def search(provider, query, *_args, **_kwargs):
                if "mountain" in query:
                    return []
                if provider == "pexels":
                    raise RuntimeError("controlled provider failure")
                return [candidate]
            with patch("video_factory.stock_assets.search_stock_query_variants", side_effect=search):
                search_routed_scene_asset_candidates(1, scenes, root, plan, execution=execution)
            saved = {row["scenePosition"]: row for row in json.loads((root / "progress.json").read_text())["scenes"]}
            self.assertEqual(saved[1]["state"], "completed", "部分失败后成功仍记完成")
            self.assertNotIn("lastFailure", saved[1])
            self.assertEqual(saved[1]["provider"], "pixabay")
            self.assertEqual(saved[2]["state"], "completed", "成功但 0 候选是真实空检索，仍记完成")
            self.assertNotIn("lastFailure", saved[2])

    def test_body_boundary_failures_carry_structured_stage_without_changing_type(self):
        # 正文读取边界：裸 TimeoutError 保持原类型（重试语义不变）但携带 body/timeout；
        # 自造超限/超时携带 body/too_large、body/timeout，仍为 RuntimeError（不重试）。
        from video_factory.asset_transport import classify_network_failure
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            class TimeoutResponse(io.BytesIO):
                def read1(self, _size):
                    raise TimeoutError("body read timeout")

            with self.assertRaises(TimeoutError) as body_timeout:
                write_response_body(TimeoutResponse(b""), root / "partial.bin", 1024)
            self.assertEqual(getattr(body_timeout.exception, "asset_failure_facts", None), ("body", "timeout"))
            self.assertEqual(classify_network_failure(body_timeout.exception), ("body", "timeout", None))
            self.assertFalse((root / "partial.bin").exists())

            with self.assertRaises(RuntimeError) as too_large:
                write_response_body(io.BytesIO(b"x" * 10), root / "big.bin", 4, clock=lambda: 0.0)
            self.assertIn("exceeded", str(too_large.exception))
            self.assertEqual(getattr(too_large.exception, "asset_failure_facts", None), ("body", "too_large"))

            class NeverEnding(io.BytesIO):
                def read1(self, _size):
                    return b"chunk"

            ticks = iter([0.0, 1.0, 2.0, 3.0, 4.0])
            with self.assertRaises(RuntimeError) as timed_out:
                write_response_body(NeverEnding(b""), root / "slow.bin", 1024, max_seconds=1,
                                    clock=lambda: next(ticks))
            self.assertIn("timed out", str(timed_out.exception))
            self.assertEqual(getattr(timed_out.exception, "asset_failure_facts", None), ("body", "timeout"))
            self.assertFalse((root / "slow.bin").exists())

    def test_media_inspection_attaches_facts_by_cause_without_changing_message(self):
        # 媒体校验：消息仍是同一条受控文案，但按成因区分事实——工具缺失不算损坏。
        import subprocess as subprocess_module
        from video_factory.asset_transport import classify_network_failure
        from video_factory.stock_assets import _inspect_open_stock_file
        candidate = StockAssetCandidate(provider="pexels", asset_id="sea", media_type="video", width=720, height=1280,
            duration=30, preview_url="", download_url="https://media.example/sea.mp4", source_url="", creator="test", license_note="test", query="sea", score=90)
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "clip.mp4"
            media.write_bytes(b"not really a video")
            for cause, expected_reason in (
                (subprocess_module.CalledProcessError(1, "ffprobe"), "invalid_media"),
                (FileNotFoundError("ffprobe"), "unknown"),
                (subprocess_module.TimeoutExpired("ffprobe", 20), "timeout"),
            ):
                with self.subTest(cause=type(cause).__name__):
                    with patch("video_factory.stock_assets.subprocess.run", side_effect=cause):
                        with self.assertRaises(RuntimeError) as caught:
                            _inspect_open_stock_file(candidate, media)
                    self.assertEqual(str(caught.exception), "素材真实文件校验失败（pexels；尺寸不足、格式损坏或媒体工具不可用）")
                    self.assertEqual(classify_network_failure(caught.exception), ("media", expected_reason, None))
                    self.assertFalse(media.exists(), "校验失败不留下半成品文件")

    def test_corrupt_image_materialization_keeps_media_failure_in_progress_and_logs(self):
        from video_factory.asset_transport import classify_network_failure
        from video_factory.stock_assets import materialize_candidate, materialize_first_candidate
        from video_factory.stock_images import MAX_IMAGE_PIXELS

        class Response(io.BytesIO):
            headers = {"Content-Type": "image/png", "Content-Length": "12"}

        candidate = StockAssetCandidate(provider="met", asset_id="corrupt", media_type="image", width=1080, height=1920,
            duration=0, preview_url="", download_url="https://media.example/corrupt.png", source_url="", creator="test",
            license_note="fixture", query="image", score=1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            direct = root / "direct.png"
            log = io.StringIO()
            with patch("video_factory.stock_assets.open_asset_request", side_effect=lambda *_args, **_kwargs: Response(b"not-an-image")) as opener, \
                 contextlib.redirect_stderr(log):
                with self.assertRaises(RuntimeError) as caught:
                    materialize_candidate(candidate, direct)
                self.assertIs(type(caught.exception), RuntimeError, "不能变成网络异常而触发额外重试")
                self.assertEqual(str(caught.exception), f"图片校验失败：格式损坏、不支持或超过 {MAX_IMAGE_PIXELS} 像素上限")
                self.assertEqual(opener.call_count, 1, "媒体拒绝不增加下载尝试")
                self.assertFalse(direct.exists(), "坏图片仍被清理，不伪装成有效素材")
                failures = []
                execution = StockExecution({"stockProgressPath": str(root / "progress.json"), "commandId": "image-test"})
                accepted = materialize_first_candidate(Scene(1, "图片", 5, "stock", "image"), [candidate], root,
                    execution=execution, failures=failures)
            self.assertIsNone(accepted)
            self.assertEqual(opener.call_count, 2, "两次独立调用各下载一次，无内部重试")
            self.assertEqual(len(failures), 1)
            self.assertFalse([item for item in root.iterdir() if item.suffix in {".png", ".jpg", ".webp"}])
            progress = json.loads((root / "progress.json").read_text())["scenes"][0]
            self.assertEqual(progress["failedAttempts"], 1)
            self.assertEqual(classify_network_failure(caught.exception), ("media", "invalid_media", None))
            self.assertEqual(progress["lastFailure"], {"provider": "met", "stage": "media", "reason": "invalid_media"})
            failed_logs = [entry for entry in map(json.loads, log.getvalue().splitlines()) if entry["state"] == "failed"]
            self.assertEqual(len(failed_logs), 2)
            self.assertTrue(all(entry.get("errorStage") == "media" and entry.get("errorReason") == "invalid_media"
                                for entry in failed_logs))

    def test_image_inspection_does_not_call_filesystem_failures_corrupt(self):
        import errno
        from video_factory.asset_transport import classify_network_failure
        from video_factory.stock_images import inspect_image_dimensions
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.png"
            with self.assertRaises(RuntimeError) as caught:
                inspect_image_dimensions(missing)
            self.assertIsInstance(caught.exception.__cause__, FileNotFoundError)
            self.assertEqual(classify_network_failure(caught.exception), ("media", "unknown", None))
            for cause, reason in (
                (PermissionError(errno.EACCES, "denied"), "unknown"),
                (OSError(errno.EIO, "disk unavailable"), "unknown"),
                (OSError("unspecified I/O failure"), "unknown"),
                (TimeoutError("read timeout"), "timeout"),
            ):
                with self.subTest(cause=type(cause).__name__, reason=reason), \
                     patch("video_factory.stock_images.Image.open", side_effect=cause):
                    with self.assertRaises(RuntimeError) as caught:
                        inspect_image_dimensions(missing)
                    self.assertIs(type(caught.exception), RuntimeError)
                    self.assertIs(caught.exception.__cause__, cause)
                    self.assertEqual(classify_network_failure(caught.exception), ("media", reason, None))

    def test_valid_image_materialization_keeps_original_bytes_and_dimensions(self):
        from PIL import Image
        from video_factory.stock_assets import materialize_candidate, materialize_first_candidate
        from video_factory.stock_images import inspect_image_dimensions
        image_bytes = io.BytesIO()
        Image.new("RGB", (720, 1080), "navy").save(image_bytes, format="PNG")
        body = image_bytes.getvalue()
        def response(*_args, **_kwargs):
            result = io.BytesIO(body)
            result.headers = {"Content-Type": "image/png", "Content-Length": str(len(body))}
            return result
        candidate = StockAssetCandidate(provider="met", asset_id="valid", media_type="image", width=720, height=1080,
            duration=0, preview_url="", download_url="https://media.example/valid.png", source_url="", creator="test",
            license_note="fixture", query="image", score=1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "direct.png"
            log = io.StringIO()
            with patch("video_factory.stock_assets.open_asset_request", side_effect=response) as opener, \
                 contextlib.redirect_stderr(log):
                self.assertEqual(materialize_candidate(candidate, target), target)
                self.assertEqual(inspect_image_dimensions(target), (720, 1080))
                self.assertEqual(target.read_bytes(), body)
                accepted = materialize_first_candidate(Scene(1, "图片", 5, "stock", "image"), [candidate], root)
            self.assertIsNotNone(accepted)
            self.assertEqual((accepted.width, accepted.height), (720, 1080))
            self.assertEqual(Path(accepted.local_path).read_bytes(), body)
            self.assertEqual(opener.call_count, 2)
            self.assertTrue(all(entry["state"] != "failed" for entry in map(json.loads, log.getvalue().splitlines())))
