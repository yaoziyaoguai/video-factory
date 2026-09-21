import io
import json
import unittest
import urllib.parse
import urllib.request
from email.message import Message
from dataclasses import replace
from unittest.mock import patch

from video_factory.stock_assets import candidate_to_public_dict, search_stock_assets


class CoverrTest(unittest.TestCase):
    def test_filtered_first_page_is_backfilled_with_a_bounded_second_page(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            params = urllib.parse.parse_qs(urllib.parse.urlsplit(request.full_url).query)
            page = int(params.get("page", ["0"])[0])
            count = int(params["page_size"][0])
            hits = [{"id": f"{page}-{i}", "is_premium": page == 0,
                     "duration": 8, "max_width": 1920, "max_height": 1080,
                     "urls": {"mp4_download": f"https://cdn.coverr.co/{page}-{i}.mp4"}}
                    for i in range(count)]
            return io.BytesIO(json.dumps({"hits": hits}).encode())

        candidates = search_stock_assets("coverr", "city", limit=3, opener=opener, environ={"COVERR_API_KEY": "dummy"})
        self.assertEqual(len(candidates), 3)
        self.assertTrue(all(c.asset_id.startswith("1-") for c in candidates))
        self.assertEqual(len(requests), 2)

    def test_signed_thumbnail_uses_unsigned_poster_without_leaking_query(self):
        def opener(request, timeout):
            return io.BytesIO(json.dumps({"hits": [{
                "id": "a", "max_width": 1920, "max_height": 1080, "duration": 8,
                "thumbnail": "https://cdn.coverr.co/a.jpg?token=private",
                "poster": "https://cdn.coverr.co/poster.jpg",
                "urls": {"mp4_download": "https://cdn.coverr.co/a.mp4?token=private"},
            }]}).encode())

        candidate = search_stock_assets("coverr", "city", opener=opener, environ={"COVERR_API_KEY": "dummy"})[0]
        self.assertEqual(candidate.preview_url, "https://cdn.coverr.co/poster.jpg")
        stored = replace(candidate, preview_url="https://cdn.coverr.co/a.jpg?token=private")
        self.assertEqual(candidate_to_public_dict(stored)["preview_url"], "")

    def test_authenticated_search_does_not_follow_redirects(self):
        for status in (301, 302, 307, 308):
            with self.subTest(status=status):
                requests = []

                def transport(handler, request):
                    requests.append(request)
                    headers = Message()
                    headers["Location"] = "https://untrusted.example/collect"
                    response = urllib.response.addinfourl(io.BytesIO(b"redirect"), headers, request.full_url, status)
                    response.msg = "Redirect"
                    return response

                with patch.object(urllib.request.HTTPSHandler, "https_open", transport):
                    with self.assertRaisesRegex(RuntimeError, f"HTTP {status}"):
                        search_stock_assets("coverr", "city", environ={"COVERR_API_KEY": "dummy-key"})
                self.assertEqual(len(requests), 1)
                self.assertEqual(urllib.parse.urlsplit(requests[0].full_url).hostname, "api.coverr.co")

    def test_search_returns_traceable_video_without_exposing_signed_download_url(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            return io.BytesIO(json.dumps({"hits": [{
                "id": "video-1",
                "slug": "city-night-video-1",
                "title": "City at night",
                "thumbnail": "https://cdn.coverr.co/city.jpg",
                "duration": 12.5,
                "max_width": 1080,
                "max_height": 1920,
                "contributor_name": "Creator",
                "contributor_url": "https://coverr.co/creators/creator",
                "urls": {
                    "mp4_preview": "https://cdn.coverr.co/videos/video-1/preview?token=private",
                    "mp4_download": "https://cdn.coverr.co/videos/video-1/download?token=private",
                },
            }]}).encode())

        candidates = search_stock_assets(
            "coverr",
            "city night",
            "video",
            limit=1,
            opener=opener,
            environ={"COVERR_API_KEY": "test-key"},
        )

        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate.provider, "coverr")
        self.assertEqual(candidate.media_type, "video")
        self.assertEqual(candidate.creator, "Creator")
        self.assertEqual(candidate.creator_url, "https://coverr.co/creators/creator")
        self.assertEqual(candidate.source_url, "https://coverr.co/videos/city-night-video-1")
        self.assertIn("Coverr", candidate.license_note)
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer test-key")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(requests[0].full_url).query)
        self.assertEqual(query["query"], ["city night"])
        self.assertEqual(query["urls"], ["true"])
        self.assertLessEqual(int(query["page_size"][0]), 50)
        public = candidate_to_public_dict(candidate, provider_id="coverr-stock-v1")
        self.assertNotIn("private", json.dumps(public))
        self.assertNotIn("test-key", json.dumps(public))

    def test_coverr_excludes_ai_generated_and_premium_results(self):
        def item(asset_id, *, is_ai_generated=False, is_premium=False):
            return {
                "id": asset_id,
                "slug": asset_id,
                "thumbnail": f"https://cdn.coverr.co/{asset_id}.jpg",
                "duration": "8.5",
                "max_width": 1920,
                "max_height": 1080,
                "is_ai_generated": is_ai_generated,
                "is_premium": is_premium,
                "urls": {
                    "mp4_download": f"https://cdn.coverr.co/{asset_id}.mp4?token=private",
                },
            }

        def opener(request, timeout):
            return io.BytesIO(json.dumps({"hits": [
                item("ai-video", is_ai_generated=True),
                item("premium-video", is_premium=True),
                item("free-stock-video"),
            ]}).encode())

        candidates = search_stock_assets(
            "coverr",
            "city",
            "video",
            limit=3,
            opener=opener,
            environ={"COVERR_API_KEY": "test-key"},
        )

        self.assertEqual([candidate.asset_id for candidate in candidates], ["free-stock-video"])

    def test_coverr_rejects_images_without_calling_the_api(self):
        def opener(request, timeout):
            self.fail("Coverr API should not be called for image search")

        with self.assertRaisesRegex(ValueError, "only provides stock video"):
            search_stock_assets(
                "coverr",
                "city",
                "image",
                opener=opener,
                environ={"COVERR_API_KEY": "test-key"},
            )


if __name__ == "__main__":
    unittest.main()
