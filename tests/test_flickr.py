import io
import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs
from urllib.error import HTTPError
from PIL import Image

from video_factory.stock_assets import search_stock_assets, materialize_candidate, MissingProviderKey
from video_factory.worker import WORKER_PROTOCOL_VERSION, handle_request


def flickr_reply(method):
    if method == 'flickr.photos.licenses.getInfo':
        return {'stat': 'ok', 'licenses': {'license': [
            {'id': '99', 'name': 'CC BY-NC 4.0', 'url': 'https://creativecommons.org/licenses/by-nc/4.0/'},
            {'id': '0', 'name': 'All Rights Reserved', 'url': ''}]}}
    if method == 'flickr.photos.search':
        return {'stat': 'ok', 'photos': {'photo': [{'id': '123'}]}}
    if method == 'flickr.photos.getInfo':
        return {'stat': 'ok', 'photo': {'id': '123', 'license': '99', 'rotation': 0, 'media': 'photo',
            'visibility': {'ispublic': 1}, 'owner': {'nsid': '456@N01', 'username': '摄影师'},
            'title': {'_content': '上海街景'}}}
    return {'stat': 'ok', 'sizes': {'candownload': 1, 'size': [
        {'label': 'Small', 'media': 'photo', 'width': 320, 'height': 240, 'source': 'https://live.staticflickr.com/1/123_s.jpg'},
        {'label': 'Large', 'media': 'photo', 'width': 2400, 'height': 1600, 'source': 'https://live.staticflickr.com/1/123_b.jpg'}]}}


class FlickrTest(unittest.TestCase):
    def test_invalid_media_url_is_rejected_without_crashing_search(self):
        from video_factory.flickr_stock import flickr_media_url
        self.assertEqual(flickr_media_url('https://[invalid/image.jpg'), '')

    def opener(self, method_changes=None):
        def fetch(request, timeout):
            method = parse_qs(request.data.decode())['method'][0]
            payload = flickr_reply(method)
            if method_changes:
                method_changes(method, payload)
            return io.BytesIO(json.dumps(payload).encode())
        return fetch

    def test_missing_key_does_not_call_network_or_advertise_fake_results(self):
        with self.assertRaisesRegex(MissingProviderKey, 'FLICKR_API_KEY'):
            search_stock_assets('flickr', 'city', 'image', environ={}, opener=lambda *a, **k: self.fail('unexpected request'))

    def test_private_download_disabled_nd_and_unsafe_cdn_are_not_selected(self):
        def private(method, payload):
            if method == 'flickr.photos.getInfo': payload['photo']['visibility']['ispublic'] = 0
        def no_download(method, payload):
            if method == 'flickr.photos.getSizes': payload['sizes']['candownload'] = 0
        def nd(method, payload):
            if method == 'flickr.photos.licenses.getInfo': payload['licenses']['license'][0]['url'] = 'https://creativecommons.org/licenses/by-nd/4.0/'
        def unsafe(method, payload):
            if method == 'flickr.photos.getSizes': payload['sizes']['size'][1]['source'] = 'https://live.staticflickr.com.evil.test/a.jpg'
        for change in (private, no_download, nd, unsafe):
            self.assertEqual(search_stock_assets('flickr', 'city', 'image', opener=self.opener(change), environ={'FLICKR_API_KEY': 'test-key'}), [])

    def test_adoption_rechecks_permission_before_any_download(self):
        candidate = search_stock_assets('flickr', 'city', 'image', opener=self.opener(), environ={'FLICKR_API_KEY': 'test-key'})[0]
        def revoked(method, payload):
            if method == 'flickr.photos.getSizes': payload['sizes']['candownload'] = 0
        with tempfile.TemporaryDirectory() as tmp, patch.dict('os.environ', {'FLICKR_API_KEY': 'test-key'}), \
             patch('urllib.request.OpenerDirector.open', side_effect=self.opener(revoked)), \
             patch('video_factory.stock_assets.open_asset_request') as download:
            target = Path(tmp) / 'photo.jpg'
            with self.assertRaisesRegex(RuntimeError, '权限'):
                materialize_candidate(candidate, target)
            download.assert_not_called()
            self.assertFalse(target.exists())

    def test_upstream_errors_do_not_echo_credentials(self):
        def denied(request, timeout):
            raise HTTPError(request.full_url, 403, 'denied', {}, io.BytesIO(b'api_key=test-key'))
        with self.assertRaises(RuntimeError) as error:
            search_stock_assets('flickr', 'city', 'image', opener=denied, environ={'FLICKR_API_KEY': 'test-key'})
        self.assertNotIn('test-key', str(error.exception))

    def test_real_worker_download_records_dimensions_and_license_without_key(self):
        media = io.BytesIO()
        Image.new('RGB', (1600, 2400), 'blue').save(media, format='JPEG')
        def download(request, timeout):
            self.assertNotIn('test-key', request.full_url)
            self.assertIsNone(request.get_header('Authorization'))
            result = io.BytesIO(media.getvalue())
            result.headers = {'Content-Type': 'image/jpeg', 'Content-Length': str(len(media.getvalue()))}
            return result
        with tempfile.TemporaryDirectory() as tmp, patch.dict('os.environ', {'FLICKR_API_KEY': 'test-key'}):
            root = Path(tmp)
            script = root / 'script.json'
            script.write_text(json.dumps({'scenes': [{'position': 1, 'narration': '街景', 'duration': 4,
                'visual_strategy': 'stock', 'visual_prompt': 'city'}]}))
            with patch('urllib.request.OpenerDirector.open', side_effect=self.opener()), \
                 patch('video_factory.stock_assets.open_asset_request', side_effect=download):
                result = handle_request({'protocolVersion': WORKER_PROTOCOL_VERSION, 'commandId': 'cmd', 'runId': 'run',
                    'nodeRunId': 'assets', 'attempt': 1, 'capability': 'asset.prepare', 'outputDir': str(root / 'output'),
                    'input': {'scriptPath': str(script)}, 'parameters': {'provider': 'flickr', 'mediaType': 'image'}})
            plan = json.loads(Path(result['output']['assetPlanPath']).read_text())
            asset = plan['scene_assets'][0]
            self.assertEqual((asset['width'], asset['height']), (1600, 2400))
            artifact = next(item for item in result['artifacts'] if item['kind'] == 'media_asset')
            self.assertEqual(artifact['provenance']['providerId'], 'flickr-stock-v1')
            self.assertIn('仅限非商业', artifact['provenance']['licenseNote'])
            self.assertNotIn('test-key', json.dumps(result) + json.dumps(plan))

    def test_dynamic_license_ids_public_download_permission_and_real_sizes(self):
        requests = []
        def opener(request, timeout):
            self.assertEqual(request.full_url, 'https://www.flickr.com/services/rest/')
            self.assertNotIn('test-key', request.full_url)
            params = parse_qs(request.data.decode())
            requests.append(params)
            return io.BytesIO(json.dumps(flickr_reply(params['method'][0])).encode())
        candidates = search_stock_assets('flickr', '上海', 'image', opener=opener, environ={'FLICKR_API_KEY': 'test-key'})
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual((candidate.width, candidate.height), (2400, 1600))
        self.assertEqual(candidate.download_url, 'https://live.staticflickr.com/1/123_b.jpg')
        self.assertEqual(candidate.source_url, 'https://www.flickr.com/photos/456@N01/123/')
        self.assertIn('仅限非商业', candidate.license_note)
        self.assertEqual(requests[1]['license'], ['99'])
        self.assertEqual(requests[1]['text'], ['上海'])
        self.assertEqual(len(requests), 4)
