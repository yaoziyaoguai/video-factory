import io
import json
import tempfile
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from video_factory.stock_assets import search_stock_assets


class PixabayCacheTest(unittest.TestCase):
    def test_a_new_worker_process_reuses_the_cached_response(self):
        code = """
import io, sys
from pathlib import Path
from video_factory.stock_assets import search_stock_assets
def opener(request, timeout):
    with (Path(sys.argv[1]) / 'requests.txt').open('a') as output:
        output.write('network request\\n')
    return io.BytesIO(b'{"hits":[]}')
search_stock_assets('pixabay', 'city', opener=opener, environ={'PIXABAY_API_KEY':'dummy', 'XDG_CACHE_HOME':sys.argv[1]})
"""
        with tempfile.TemporaryDirectory() as tmp:
            for _ in range(2):
                result = subprocess.run([sys.executable, "-c", code, tmp], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((Path(tmp) / "requests.txt").read_text().splitlines(), ["network request"])

    def test_concurrent_queries_share_a_persistent_24_hour_response(self):
        calls = []
        def opener(request, timeout):
            calls.append(request.full_url)
            return io.BytesIO(b'{"hits":[]}')
        with tempfile.TemporaryDirectory() as tmp:
            env = {"PIXABAY_API_KEY": "private-test-key", "XDG_CACHE_HOME": tmp}
            with patch("time.time", return_value=100000), ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: search_stock_assets("pixabay", "city", opener=opener, environ=env), range(4)))
            self.assertEqual(results, [[], [], [], []])
            self.assertEqual(len(calls), 1)
            with patch("time.time", return_value=100000 + 86399):
                search_stock_assets("pixabay", "city", opener=opener, environ=env)
            self.assertEqual(len(calls), 1)
            with patch("time.time", return_value=100000 + 86401):
                search_stock_assets("pixabay", "city", opener=opener, environ=env)
            self.assertEqual(len(calls), 2)
            for file in Path(tmp).rglob("*"):
                self.assertNotIn("private-test-key", str(file))
                if file.is_file():
                    self.assertNotIn("private-test-key", file.read_text())

    def test_account_query_media_and_page_size_are_isolated(self):
        calls = []
        def opener(request, timeout):
            calls.append(request.full_url)
            return io.BytesIO(b'{"hits":[]}')
        with tempfile.TemporaryDirectory() as tmp:
            for key, query, media, limit in [("a", "city", "video", 3), ("b", "city", "video", 3),
                                             ("a", "sea", "video", 3), ("a", "city", "image", 3), ("a", "city", "video", 6)]:
                search_stock_assets("pixabay", query, media, limit, opener=opener, environ={"PIXABAY_API_KEY": key, "XDG_CACHE_HOME": tmp})
            self.assertEqual(len(calls), 5)

    def test_failures_and_invalid_responses_are_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {"PIXABAY_API_KEY": "dummy", "XDG_CACHE_HOME": tmp}
            def limited(request, timeout):
                raise HTTPError(request.full_url, 429, "limited", {}, io.BytesIO(b"limited"))
            with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
                search_stock_assets("pixabay", "city", opener=limited, environ=env)
            for payload in ({"error": "invalid"}, {"hits": "invalid"}):
                with self.assertRaisesRegex(RuntimeError, "invalid"):
                    search_stock_assets("pixabay", "city", opener=lambda *a, **kw: io.BytesIO(json.dumps(payload).encode()), environ=env)
            calls = []
            def valid(request, timeout):
                calls.append(request)
                return io.BytesIO(b'{"hits":[]}')
            self.assertEqual(search_stock_assets("pixabay", "city", opener=valid, environ=env), [])
            self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
