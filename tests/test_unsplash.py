import io
import json
import unittest
import urllib.parse
import tempfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from video_factory.domain import StockAssetCandidate
from video_factory.stock_assets import search_stock_assets, candidate_to_public_dict, materialize_candidate
from video_factory.worker import handle_request, WORKER_PROTOCOL_VERSION


class UnsplashTest(unittest.TestCase):
    def candidate(self):
        return StockAssetCandidate(
            provider="unsplash", asset_id="photo-1", media_type="image", width=1200, height=1800,
            duration=0, preview_url="https://images.unsplash.com/photo-1?w=400",
            download_url="https://images.unsplash.com/photo-1?w=1080",
            source_url="https://unsplash.com/photos/photo-1", creator="Photographer",
            license_note="Photo by Photographer on Unsplash", query="city", score=80,
            creator_url="https://unsplash.com/@photographer",
            download_tracking_url="https://api.unsplash.com/photos/photo-1/download?ixid=tracking",
        )

    def test_search_preserves_identity_credit_and_cdn_url_without_exposing_tracking(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            return io.BytesIO(json.dumps({"results": [{
                "id": "photo-1", "width": 1200, "height": 1800,
                "urls": {"small": "https://images.unsplash.com/photo-1?w=400&ixid=attribution",
                         "regular": "https://images.unsplash.com/photo-1?w=1080&ixid=attribution"},
                "links": {"html": "https://unsplash.com/photos/photo-1",
                          "download_location": "https://api.unsplash.com/photos/photo-1/download?ixid=tracking"},
                "user": {"name": "Photographer", "links": {"html": "https://unsplash.com/@photographer"}},
            }]}).encode())

        candidates = search_stock_assets("unsplash", "city", "image", 3, opener=opener,
                                         environ={"UNSPLASH_ACCESS_KEY": "test-key"})
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate.provider, "unsplash")
        self.assertEqual(candidate.asset_id, "photo-1")
        self.assertIn("Photographer", candidate.license_note)
        self.assertEqual(candidate.creator_url, "https://unsplash.com/@photographer?utm_source=videofactory&utm_medium=referral")
        self.assertIn("ixid=attribution", candidate.preview_url)
        public = candidate_to_public_dict(candidate)
        self.assertEqual(public["creator_url"], candidate.creator_url)
        self.assertNotIn("tracking", json.dumps(public))
        self.assertNotIn("test-key", json.dumps(public))
        self.assertEqual(requests[0].get_header("Authorization"), "Client-ID test-key")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(requests[0].full_url).query)
        self.assertEqual(query["content_filter"], ["high"])

    def test_selected_download_is_tracked_before_media_without_sending_key_to_cdn(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            if urllib.parse.urlsplit(request.full_url).hostname == "api.unsplash.com":
                return io.BytesIO(b'{"url":"https://images.unsplash.com/photo-1"}')
            response = io.BytesIO(b"image-bytes")
            response.headers = {"Content-Type": "image/jpeg", "Content-Length": "11"}
            return response

        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {"UNSPLASH_ACCESS_KEY": "test-key"}), \
             patch("video_factory.stock_assets.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            result = materialize_candidate(self.candidate(), Path(tmp) / "image.jpg", opener=opener)
            self.assertEqual(result.read_bytes(), b"image-bytes")
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].full_url, self.candidate().download_tracking_url)
        self.assertEqual(requests[0].get_header("Authorization"), "Client-ID test-key")
        self.assertIsNone(requests[1].get_header("Authorization"))

    def test_missing_or_foreign_tracking_cannot_leak_credentials_or_download(self):
        for tracking in ("", "https://attacker.example/photos/photo-1/download", "https://api.unsplash.com/photos/other/download"):
            with self.subTest(tracking=tracking), tempfile.TemporaryDirectory() as tmp, \
                 patch("video_factory.stock_assets.open_asset_request") as opener, \
                 patch("video_factory.stock_assets.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
                with self.assertRaisesRegex((RuntimeError, ValueError), "Unsplash"):
                    materialize_candidate(replace(self.candidate(), download_tracking_url=tracking), Path(tmp) / "x.jpg")
                opener.assert_not_called()

    def test_video_is_rejected_without_network_or_silent_image_substitution(self):
        with patch("urllib.request.urlopen") as opener:
            with self.assertRaisesRegex(ValueError, "not video"):
                search_stock_assets("unsplash", "city", "video", environ={"UNSPLASH_ACCESS_KEY": "test-key"})
            opener.assert_not_called()

    def test_failed_download_tracking_does_not_download_or_retry(self):
        requests = []

        def opener(request, timeout):
            requests.append(request.full_url)
            raise TimeoutError("simulated tracking timeout")

        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {"UNSPLASH_ACCESS_KEY": "test-key"}):
            target = Path(tmp) / "image.jpg"
            with self.assertRaisesRegex(RuntimeError, "tracking failed"):
                materialize_candidate(self.candidate(), target, opener=opener)
            self.assertFalse(target.exists())
        self.assertEqual(requests, [self.candidate().download_tracking_url])

    def test_search_rejects_malformed_payload_instead_of_reporting_no_results(self):
        with self.assertRaisesRegex(RuntimeError, "invalid response"):
            search_stock_assets("unsplash", "city", "image", environ={"UNSPLASH_ACCESS_KEY": "test-key"},
                                opener=lambda request, timeout: io.BytesIO(b'{"errors":["rate limited"]}'))

    def test_worker_preserves_attribution_and_preview_in_the_authoritative_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "script.json"
            script.write_text(json.dumps({"scenes": [{"position": 1, "narration": "城市",
                "duration": 3, "visual_strategy": "image", "visual_prompt": "city"}]}))

            def download(candidate, target):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"test-image")
                return target

            with patch("video_factory.stock_assets.search_stock_assets", return_value=[self.candidate()]), \
                 patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                result = handle_request({"protocolVersion": WORKER_PROTOCOL_VERSION,
                    "commandId": "cmd", "runId": "run", "nodeRunId": "assets", "attempt": 1,
                    "capability": "asset.prepare", "outputDir": str(root / "output"),
                    "input": {"scriptPath": str(script)}, "parameters": {"provider": "unsplash", "mediaType": "image"}})
            media = next(item for item in result["artifacts"] if item["kind"] == "media_asset")
            self.assertEqual(media["provenance"]["providerId"], "unsplash-stock-v1")
            self.assertEqual(media["provenance"]["creatorUrl"], self.candidate().creator_url)
            self.assertEqual(media["provenance"]["previewUrl"], self.candidate().preview_url)
            plan = json.loads(Path(result["output"]["assetPlanPath"]).read_text())
            self.assertEqual(plan["scene_assets"][0]["duration"], 3)
            self.assertNotIn("download_tracking_url", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
