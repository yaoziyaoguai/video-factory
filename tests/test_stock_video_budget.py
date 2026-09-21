import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.domain import StockAssetCandidate
from video_factory.stock_assets import materialize_candidate, MAX_ASSET_DOWNLOAD_BYTES


class StockVideoBudgetTest(unittest.TestCase):
    def test_video_download_budget_is_128mb_and_keeps_header_and_stream_guards(self):
        self.assertEqual(MAX_ASSET_DOWNLOAD_BYTES, 128_000_000)
        candidate = StockAssetCandidate(provider='archive', asset_id='clip', media_type='video',
            width=1920, height=1080, duration=4, preview_url='', download_url='https://media.example/clip.mp4',
            source_url='', creator='', license_note='', query='', score=0)
        with tempfile.TemporaryDirectory() as tmp, \
             patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
            target = Path(tmp) / 'clip.mp4'
            body = b'x' * 13_000_000
            def valid(request, timeout):
                result = io.BytesIO(body)
                result.headers = {'Content-Type': 'video/mp4', 'Content-Length': str(len(body))}
                return result
            self.assertEqual(materialize_candidate(candidate, target, opener=valid).stat().st_size, len(body))
            def oversized(request, timeout):
                result = io.BytesIO(b'')
                result.headers = {'Content-Type': 'video/mp4', 'Content-Length': str(MAX_ASSET_DOWNLOAD_BYTES + 1)}
                return result
            with self.assertRaisesRegex(RuntimeError, 'too large'):
                materialize_candidate(candidate, Path(tmp) / 'oversized.mp4', opener=oversized)
            def streamed(request, timeout):
                result = io.BytesIO(b'x' * 2048)
                result.headers = {'Content-Type': 'video/mp4'}
                return result
            streamed_target = Path(tmp) / 'streamed.mp4'
            with patch('video_factory.stock_assets.MAX_ASSET_DOWNLOAD_BYTES', 1024):
                with self.assertRaisesRegex(RuntimeError, 'exceeded'):
                    materialize_candidate(candidate, streamed_target, opener=streamed)
            self.assertFalse(streamed_target.exists())
