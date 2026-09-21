"""可替代图库来源的失败隔离与“全部失败”可操作错误（DF-03）。

单个来源的任何异常（含 OSError/PermissionError 这类环境错误）只记为该来源失败，
其余来源的有效候选必须照常交付；只有全部来源都失败时才失败，并给出可操作信息。
"""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import video_factory.stock_assets as stock_assets
from video_factory.domain import Scene
from video_factory.stock_assets import (
    StockSearchUnavailableError,
    search_routed_scene_asset_candidates,
)
from video_factory.worker import WORKER_PROTOCOL_VERSION, handle_request


def response(value):
    return io.BytesIO(json.dumps(value).encode())


def sea_route(preferred="pexels-stock-v1", alternatives=("pixabay-stock-v1",)):
    return {"shots": [{"scenePosition": 1, "preferredProviderId": preferred,
        "alternativeProviderIds": list(alternatives), "deliveryType": "stock_video", "query": "sea waves"}]}


def pexels_opener(request, timeout):
    assert "api.pexels.com" in request.full_url
    return response({"videos": [{"id": 11, "duration": 8, "width": 1080, "height": 1920,
        "url": "https://www.pexels.com/video/11/", "user": {"name": "Ocean"},
        "video_files": [{"link": "https://www.pexels.com/download/11.mp4", "width": 1080, "height": 1920}]}]})


class StockSearchIsolationTest(unittest.TestCase):
    def test_one_source_oserror_keeps_the_other_sources_candidates(self):
        scene = Scene(position=1, narration="海", duration=6, visual_strategy="stock", visual_prompt="sea")
        real_search = stock_assets.search_stock_assets

        def routed(provider, query, media_type, limit, opener=None, environ=None):
            if provider == "pixabay":
                # 复现生产环境：只读根文件系统下缓存目录 mkdir 抛 PermissionError(OSError)。
                raise PermissionError(13, "Permission denied", "/app/.cache/videofactory")
            return real_search(provider=provider, query=query, media_type=media_type, limit=limit,
                opener=pexels_opener, environ={"PEXELS_API_KEY": "dummy"})

        with tempfile.TemporaryDirectory() as tmp, \
                patch("video_factory.stock_assets.search_stock_assets", side_effect=routed):
            public, _private = search_routed_scene_asset_candidates(1, [scene], Path(tmp), sea_route(), limit=3)
            row = json.loads(public.read_text())["scene_candidates"][0]
        self.assertEqual([candidate["provider_id"] for candidate in row["candidates"]], ["pexels-stock-v1"])
        self.assertEqual(row["search_errors"][0]["provider_id"], "pixabay-stock-v1")
        self.assertEqual(row["search_errors"][0]["error_type"], "PermissionError")

    def test_all_sources_failed_raises_an_actionable_error_through_the_worker(self):
        scene = Scene(position=1, narration="海", duration=6, visual_strategy="stock", visual_prompt="sea")

        def routed(provider, query, media_type, limit, opener=None, environ=None):
            raise OSError("network stack down")

        script = {"scenes": [{"position": 1, "narration": "海", "duration": 6,
            "visual_strategy": "stock", "visual_prompt": "sea", "search_terms": []}]}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "script.json").write_text(json.dumps(script))
            (root / "director_plan.json").write_text(json.dumps(sea_route()))
            with patch("video_factory.stock_assets.search_stock_assets", side_effect=routed):
                with self.assertRaises(StockSearchUnavailableError):
                    search_routed_scene_asset_candidates(1, [scene], root, json.loads((root / "director_plan.json").read_text()))
                result = handle_request({"protocolVersion": WORKER_PROTOCOL_VERSION, "commandId": "cmd-isolated",
                    "runId": "run", "nodeRunId": "creative-planning", "attempt": 1, "capability": "asset.search",
                    "outputDir": str(root / "output"), "input": {"scriptPath": str(root / "script.json"),
                    "directorPlanPath": str(root / "director_plan.json")}, "parameters": {"provider": "ai-router"}})
        self.assertEqual(result["status"], "failed")
        message = result["error"]["message"]
        self.assertNotIn("媒体处理失败", message)
        self.assertNotIn("network stack down", message)
        for token in ("pexels-stock-v1", "pixabay-stock-v1", "OSError"):
            self.assertIn(token, message)
        self.assertIn("恢复入口", message)

    def test_empty_results_from_all_sources_is_not_an_error(self):
        scene = Scene(position=1, narration="海", duration=6, visual_strategy="stock", visual_prompt="sea")
        real_search = stock_assets.search_stock_assets

        def empty(provider, query, media_type, limit, opener=None, environ=None):
            if provider == "pixabay":
                return []
            return real_search(provider=provider, query=query, media_type=media_type, limit=limit,
                opener=lambda *a, **k: response({"videos": []}), environ={"PEXELS_API_KEY": "dummy"})

        with tempfile.TemporaryDirectory() as tmp, \
                patch("video_factory.stock_assets.search_stock_assets", side_effect=empty):
            public, _private = search_routed_scene_asset_candidates(1, [scene], Path(tmp), sea_route(), limit=3)
            row = json.loads(public.read_text())["scene_candidates"][0]
        self.assertEqual(row["candidates"], [])
        self.assertEqual(row["search_errors"], [])

    def test_public_search_errors_never_carry_http_response_bodies(self):
        # fetch_json 会把 HTTP 错误正文拼进 RuntimeError；公开候选报告只允许受控投影
        # 字段：错误类型、HTTP 状态码、本模块常量构造的静态原因。任何异常原文不得
        # 公开——即使异常类名是受控类型（R4-05）。
        http = stock_assets.public_provider_error_fields(
            RuntimeError("Provider request failed with HTTP 401: full secret body with key=sk-abcdef123456"))
        self.assertEqual(http, {
            "error_type": "RuntimeError",
            "message": "Provider request failed with HTTP 401",
            "http_status": 401,
        })
        self.assertNotIn("secret", json.dumps(http))
        unknown = stock_assets.public_provider_error_fields(
            RuntimeError("unexpected internal path /app/.cache and token=abc"))
        self.assertEqual(unknown, {"error_type": "RuntimeError"})
        # 受控异常类型也只投影类型，不读取原文：原文可能被注入任意内容。
        missing_key = stock_assets.public_provider_error_fields(
            stock_assets.MissingProviderKey("PIXABAY_API_KEY is required for pixabay asset search. secret-marker"))
        self.assertEqual(missing_key, {"error_type": "MissingProviderKey"})
        # 受控静态原因保留：超时根因不得在投影中退化成裸 RuntimeError（R4-06）。
        timeout = stock_assets.public_provider_error_fields(
            RuntimeError("素材检索总时限已耗尽；请稍后重试或选择其他来源。"))
        self.assertEqual(timeout, {
            "error_type": "RuntimeError",
            "message": "素材检索总时限已耗尽；请稍后重试或选择其他来源。",
        })
        # 静态前缀后注入敏感内容：只投影常量本身（R6-01）。
        injected = stock_assets.public_provider_error_fields(
            RuntimeError("素材检索总时限已耗尽；请稍后重试或选择其他来源。SECRET_MARKER sig=ABC123"))
        self.assertNotIn("SECRET_MARKER", json.dumps(injected))

    def test_wrapped_timeouts_keep_their_controlled_identity(self):
        # 直接 TimeoutError 与 URLError(reason=TimeoutError) 都保留受控超时身份（R6-02）。
        import urllib.error
        from urllib.error import URLError
        direct = TimeoutError("timed out")
        wrapped = URLError(direct)
        for error in (direct, wrapped):
            fields = stock_assets.public_provider_error_fields(
                RuntimeError(f"Provider request timed out after 3 attempts: wrapper"))
            self.assertEqual(fields["message"], "Provider request timed out after 3 attempts")
            self.assertTrue(stock_assets._is_timeout_error(error))
        self.assertFalse(stock_assets._is_timeout_error(URLError(OSError(111, "refused"))))

    def test_flickr_wrapper_preserves_known_causes_and_neutralises_unknown(self):
        from video_factory import stock_assets as sa

        # HTTP 401：受控身份保留（公开投影应得到 configuration 可用的状态码）。
        def http_401(request, timeout=None):
            raise RuntimeError("Provider request failed with HTTP 401: oauth problem=permission_denied")

        client = sa.flickr_api_client(opener=http_401, environ={"FLICKR_API_KEY": "dummy"})
        with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
            client("flickr.photos.search", {"text": "sea"})

        # 超时：保留受控超时身份。
        def timeout_opener(request, timeout=None):
            raise TimeoutError("timed out")

        client_timeout = sa.flickr_api_client(opener=timeout_opener, environ={"FLICKR_API_KEY": "dummy"})
        with self.assertRaisesRegex(RuntimeError, "Provider request timed out"):
            client_timeout("flickr.photos.search", {"text": "sea"})

        # 未知错误：中性固定文案，不透传原文。
        def unknown_opener(request, timeout=None):
            raise ValueError("secret flickr internal detail sig=ABC123")

        client_unknown = sa.flickr_api_client(opener=unknown_opener, environ={"FLICKR_API_KEY": "dummy"})
        with self.assertRaisesRegex(RuntimeError, "Flickr 请求失败") as caught:
            client_unknown("flickr.photos.search", {"text": "sea"})
        self.assertNotIn("sig=", str(caught.exception))

    def test_later_variant_failure_keeps_candidates_from_earlier_queries(self):
        # 变体查询逐条隔离：第一个查询已拿到合法候选时，第二个查询失败不能把它们抹掉，
        # 也不能让该来源被记成失败（Oracle 审查 P06）。
        real_search = stock_assets.search_stock_assets

        def routed(provider, query, media_type, limit, opener=None, environ=None):
            if query == "second term":
                raise PermissionError(13, "Permission denied", "/app/.cache/videofactory")
            return real_search(provider=provider, query=query, media_type=media_type, limit=limit,
                opener=pexels_opener, environ={"PEXELS_API_KEY": "dummy"})

        with patch("video_factory.stock_assets.search_stock_assets", side_effect=routed):
            candidates = stock_assets.search_stock_query_variants(
                "pexels", "sea waves", ["second term"], "video", 3)
        self.assertEqual([candidate.provider for candidate in candidates], ["pexels"])

        def always_fails(provider, query, media_type, limit, opener=None, environ=None):
            raise PermissionError(13, "Permission denied", "/app/.cache/videofactory")

        with patch("video_factory.stock_assets.search_stock_assets", side_effect=always_fails):
            with self.assertRaises(PermissionError):
                stock_assets.search_stock_query_variants("pexels", "sea waves", ["second term"], "video", 3)

    def test_inventory_write_failure_does_not_publish_a_successful_result(self):
        # R3-11：报告写成功、私有库存写失败 → 整条命令必须失败且不返回任何 artifact，
        # 后续重试不得把上一批库存与本次报告配成有效候选集。
        scene = Scene(position=1, narration="海", duration=6, visual_strategy="stock", visual_prompt="sea")
        real_search = stock_assets.search_stock_assets

        def routed(provider, query, media_type, limit, opener=None, environ=None):
            return real_search(provider=provider, query=query, media_type=media_type, limit=limit,
                opener=pexels_opener, environ={"PEXELS_API_KEY": "dummy"})

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inventory_path = root / "output" / "assets" / "job-1" / "asset_candidate_inventory.private.json"
            (root / "script.json").write_text(json.dumps({"scenes": [
                {"position": 1, "narration": "海", "duration": 6, "visual_strategy": "stock",
                 "visual_prompt": "sea", "search_terms": []}]}))
            (root / "director_plan.json").write_text(json.dumps(sea_route()))
            with patch("video_factory.stock_assets.search_stock_assets", side_effect=routed):
                inventory_path.parent.mkdir(parents=True, exist_ok=True)
                inventory_path.mkdir()  # 占位成目录，迫使库存写入抛 IsADirectoryError
                # 异常向外传播：worker main 层会把它转为 failed 响应（无 artifact），
                # 命令不会以成功身份发布半套结果（R3-11）。
                with self.assertRaises(OSError):
                    handle_request({"protocolVersion": WORKER_PROTOCOL_VERSION, "commandId": "cmd-p10",
                        "runId": "run", "nodeRunId": "creative-planning", "attempt": 1, "capability": "asset.search",
                        "outputDir": str(root / "output"), "input": {"scriptPath": str(root / "script.json"),
                        "directorPlanPath": str(root / "director_plan.json")}, "parameters": {"provider": "ai-router"}})
                # 重试：移除占位目录后两条路径一起重写，成功结果携带当次的完整配对。
                inventory_path.rmdir()
                retried = handle_request({"protocolVersion": WORKER_PROTOCOL_VERSION, "commandId": "cmd-p10-r2",
                    "runId": "run", "nodeRunId": "creative-planning", "attempt": 2, "capability": "asset.search",
                    "outputDir": str(root / "output"), "input": {"scriptPath": str(root / "script.json"),
                    "directorPlanPath": str(root / "director_plan.json")}, "parameters": {"provider": "ai-router"}})
            self.assertEqual(retried["status"], "succeeded")
            report = json.loads(Path(retried["output"]["candidateSearchPath"]).read_text())
            inventory = json.loads(Path(retried["output"]["candidateInventoryPath"]).read_text())
            self.assertEqual(len(report["scene_candidates"]), 1)
            self.assertEqual(len(inventory["scene_candidates"]), 1)
            self.assertEqual(len(report["scene_candidates"][0]["candidates"]),
                             len(inventory["scene_candidates"][0]["candidates"]))


if __name__ == "__main__":
    unittest.main()
