import io
import json
import unittest
import urllib.parse
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from video_factory.stock_assets import candidate_to_public_dict, search_stock_assets, local_filename
from video_factory.worker import handle_request, WORKER_PROTOCOL_VERSION


def video_page():
    return {"pageid": 42, "videoinfo": [{
        "width": 1920, "height": 1080, "duration": 10, "size": 300_000_000,
        "mime": "video/webm", "mediatype": "VIDEO",
        "url": "https://upload.wikimedia.org/original.webm",
        "descriptionurl": "https://commons.wikimedia.org/wiki/File:City.webm",
        "derivatives": [{"src": "https://upload.wikimedia.org/720p.webm", "type": "video/webm",
                         "width": 1280, "height": 720, "bandwidth": 1_000_000}],
        "extmetadata": {
            "Artist": {"value": "<a>作者 &amp; 团队</a>"},
            "LicenseShortName": {"value": "CC BY 4.0"},
            "LicenseUrl": {"value": "https://creativecommons.org/licenses/by/4.0/"},
        },
    }], "imageinfo": [{"thumburl": "https://thumb.wikimedia.org/city.jpg"}]}


def search_page(page):
    return search_stock_assets("wikimedia", "city", opener=lambda request, timeout: io.BytesIO(
        json.dumps({"query": {"pages": [page]}}).encode()))


class WikimediaCommonsTest(unittest.TestCase):
    def test_images_use_imageinfo_and_keep_full_resolution_and_license(self):
        page = {"pageid": 81, "imageinfo": [{
            "mediatype": "BITMAP", "mime": "image/jpeg", "width": 3000, "height": 4000, "size": 17000000,
            "url": "https://upload.wikimedia.org/art.jpg", "thumburl": "https://thumb.wikimedia.org/art.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Art.jpg",
            "extmetadata": video_page()["videoinfo"][0]["extmetadata"],
        }]}
        requests = []
        def opener(request, timeout):
            requests.append(request)
            return io.BytesIO(json.dumps({"query": {"pages": [page]}}).encode())
        result = search_stock_assets("wikimedia", "中国书画", "image", opener=opener)
        self.assertEqual((result[0].media_type, result[0].width, result[0].height), ("image", 3000, 4000))
        self.assertIn("imageinfo", urllib.parse.parse_qs(urllib.parse.urlsplit(requests[0].full_url).query)["prop"][0])
        self.assertIn("需署名", result[0].license_note)

    def test_video_extension_and_worker_provenance_survive_materialization(self):
        candidate = search_page(video_page())[0]
        self.assertTrue(local_filename(1, candidate).endswith(".webm"))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "script.json"
            script.write_text(json.dumps({"scenes": [{"position": 1, "narration": "城市", "duration": 4,
                "visual_strategy": "stock", "visual_prompt": "city"}]}))
            source = root / "fixture.webm"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=blue:s=720x1280:r=25",
                            "-t", "10", "-an", "-c:v", "libvpx", "-deadline", "realtime", str(source)],
                           check=True, capture_output=True, timeout=30)
            body = source.read_bytes()
            def media(request, timeout):
                response = io.BytesIO(body)
                response.headers = {"Content-Type": "video/webm", "Content-Length": str(len(body))}
                return response
            with patch("urllib.request.OpenerDirector.open", side_effect=lambda *a, **kw: io.BytesIO(json.dumps({"query": {"pages": [video_page()]}}).encode())), \
                 patch("video_factory.stock_assets.open_asset_request", side_effect=media), \
                 patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
                result = handle_request({"protocolVersion": WORKER_PROTOCOL_VERSION, "commandId": "cmd", "runId": "run",
                    "nodeRunId": "assets", "attempt": 1, "capability": "asset.prepare", "outputDir": str(root / "output"),
                    "input": {"scriptPath": str(script)}, "parameters": {"provider": "wikimedia", "mediaType": "video"}})
            artifact = next(item for item in result["artifacts"] if item["kind"] == "media_asset")
            self.assertEqual(artifact["contentType"], "video/webm")
            self.assertEqual(artifact["provenance"]["providerId"], "wikimedia-stock-v1")
            self.assertEqual(artifact["provenance"]["creator"], "作者 & 团队")
            self.assertIn("creativecommons.org/licenses/by/4.0", artifact["provenance"]["licenseNote"])
            plan = json.loads(Path(result["output"]["assetPlanPath"]).read_text())
            self.assertEqual(plan["scene_assets"][0]["license_note"], artifact["provenance"]["licenseNote"])

    def test_license_conditions_are_preserved_without_html(self):
        for name, url in (("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"),
                          ("CC0", "https://creativecommons.org/publicdomain/zero/1.0/"),
                          ("Public domain", "https://creativecommons.org/publicdomain/mark/1.0/")):
            with self.subTest(name=name):
                page = video_page()
                meta = page["videoinfo"][0]["extmetadata"]
                meta["LicenseShortName"]["value"], meta["LicenseUrl"]["value"] = name, url
                candidate = search_page(page)[0]
                self.assertEqual(candidate.creator, "作者 & 团队")
                self.assertIn(url, candidate.license_note)
                self.assertEqual(candidate.preview_url, "https://thumb.wikimedia.org/city.jpg")
                if "BY-SA" in name:
                    self.assertIn("相同许可分享", candidate.license_note)

    def test_real_api_license_and_referral_urls_are_supported(self):
        page = video_page()
        info = page["videoinfo"][0]
        info["extmetadata"]["LicenseUrl"]["value"] = "https://creativecommons.org/licenses/by/4.0"
        info["derivatives"][0]["src"] += "?utm_source=commons.wikimedia.org&utm_campaign=api&utm_content=original"
        self.assertEqual(len(search_page(page)), 1)

    def test_uncertain_licenses_and_missing_authors_are_not_auto_selected(self):
        changes = [
            ("Artist", ""), ("LicenseShortName", ""), ("LicenseShortName", "CC BY 4.0 or unknown"),
            ("LicenseUrl", "https://attacker.test/licenses/by/4.0/"),
            ("Categories", "City|License review needed (video)"), ("Categories", "Copyright violations"),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                page = video_page()
                page["videoinfo"][0]["extmetadata"][key] = {"value": value}
                self.assertEqual(search_page(page), [])

    def test_rejects_unsafe_and_nonfinite_media_without_low_resolution_fallback(self):
        for changes in ({"src": "https://127.0.0.1/a.webm"}, {"src": "https://upload.wikimedia.org.attacker.test/a.webm"},
                        {"src": "https://secret@upload.wikimedia.org/a.webm"}, {"src": "https://upload.wikimedia.org/a.webm?token=secret"},
                        {"width": 426, "height": 240}, {"bandwidth": 200_000_000},
                        {"bandwidth": float("nan")}, {"width": float("inf")}):
            with self.subTest(changes=changes):
                page = video_page()
                page["videoinfo"][0]["derivatives"][0].update(changes)
                self.assertEqual(search_page(page), [])
        for duration in (0, -1, float("nan"), float("inf"), True):
            page = video_page()
            page["videoinfo"][0]["duration"] = duration
            self.assertEqual(search_page(page), [])

    def test_pagination_is_bounded_and_deduplicates_page_ids(self):
        requests = []
        def opener(request, timeout):
            requests.append(request)
            return io.BytesIO(json.dumps({"query": {"pages": [video_page()]}, "continue": {"gsroffset": len(requests) * 6}}).encode())
        results = search_stock_assets("wikimedia", "city", limit=3, opener=opener)
        self.assertEqual(len(results), 1)
        self.assertEqual(len(requests), 2)
        self.assertIsNone(requests[0].get_header("Authorization"))
        self.assertIn("VideoFactory", requests[0].get_header("User-agent"))

    def test_empty_results_errors_and_nonvideo_requests_are_distinct(self):
        empty = lambda request, timeout: io.BytesIO(b'{"batchcomplete":true}')
        self.assertEqual(search_stock_assets("wikimedia", "city", opener=empty), [])
        for media_type in ("audio",):
            with self.assertRaisesRegex(ValueError, "image or video"):
                search_stock_assets("wikimedia", "city", media_type, opener=lambda *a, **kw: self.fail("unexpected network"))
        for payload in ({"error": {"code": "ratelimited"}}, {"query": None}):
            with self.assertRaisesRegex(RuntimeError, "invalid|error"):
                search_stock_assets("wikimedia", "city", opener=lambda *a, **kw: io.BytesIO(json.dumps(payload).encode()))
        requests = []
        def limited(request, timeout):
            requests.append(request)
            raise HTTPError(request.full_url, 429, "limited", {}, io.BytesIO(b"rate limited"))
        with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
            search_stock_assets("wikimedia", "city", opener=limited)
        self.assertEqual(len(requests), 1)

    def test_search_returns_traceable_free_video_with_bounded_download(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            payload = {
                "query": {
                    "pages": [{
                        "pageid": 42,
                        "title": "File:City at night.webm",
                        "videoinfo": [{
                            "width": 1920,
                            "height": 1080,
                            "duration": 12.5,
                            "mime": "video/webm",
                            "mediatype": "VIDEO",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:City_at_night.webm",
                            "derivatives": [
                                {
                                    "src": "https://upload.wikimedia.org/city-240p.webm",
                                    "type": "video/webm; codecs=\"vp9, opus\"",
                                    "width": 426,
                                    "height": 240,
                                    "bandwidth": 300_000,
                                },
                                {
                                    "src": "https://upload.wikimedia.org/city-1080p.webm",
                                    "type": "video/webm; codecs=\"vp9, opus\"",
                                    "width": 1920,
                                    "height": 1080,
                                    "bandwidth": 4_000_000,
                                },
                            ],
                            "extmetadata": {
                                "Artist": {"value": "<a href=\"https://example.test/creator\">Night Creator</a>"},
                                "LicenseShortName": {"value": "CC BY 4.0"},
                                "LicenseUrl": {"value": "https://creativecommons.org/licenses/by/4.0/"},
                                "AttributionRequired": {"value": "true"},
                            },
                        }],
                        "imageinfo": [{
                            "thumburl": "https://upload.wikimedia.org/city-thumb.jpg",
                        }],
                    }],
                },
            }
            return io.BytesIO(json.dumps(payload).encode())

        candidates = search_stock_assets(
            "wikimedia",
            "city night",
            "video",
            limit=1,
            opener=opener,
        )

        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate.provider, "wikimedia")
        self.assertEqual(candidate.asset_id, "42")
        self.assertEqual(candidate.width, 1920)
        self.assertEqual(candidate.height, 1080)
        self.assertEqual(candidate.duration, 12.5)
        self.assertEqual(candidate.creator, "Night Creator")
        self.assertEqual(candidate.download_url, "https://upload.wikimedia.org/city-1080p.webm")
        self.assertEqual(candidate.source_url, "https://commons.wikimedia.org/wiki/File:City_at_night.webm")
        self.assertIn("CC BY 4.0", candidate.license_note)
        self.assertIn("creativecommons.org/licenses/by/4.0", candidate.license_note)

        query = urllib.parse.parse_qs(urllib.parse.urlsplit(requests[0].full_url).query)
        self.assertEqual(query["gsrsearch"], ["city night filetype:video"])
        self.assertEqual(query["prop"], ["videoinfo|imageinfo"])
        self.assertEqual(query["viprop"], ["url|size|mime|mediatype|derivatives|extmetadata"])

        public = candidate_to_public_dict(candidate, provider_id="wikimedia-stock-v1")
        self.assertNotIn("download_url", public)
        self.assertIn("Night Creator", json.dumps(public))


if __name__ == "__main__":
    unittest.main()
