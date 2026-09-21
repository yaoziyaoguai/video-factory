import io
import json
import unittest
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from video_factory.stock_assets import search_stock_assets
from video_factory.worker import WORKER_PROTOCOL_VERSION, handle_request


def archive_item(identifier='clouds'):
    return {'metadata': {'identifier': identifier, 'mediatype': 'movies', 'collection': ['stock_footage'],
        'licenseurl': 'http://creativecommons.org/licenses/by/3.0/', 'creator': 'Camera operator', 'title': 'Clouds'},
        'files': [
            {'name': 'clouds.mp4', 'width': '1920', 'height': '1080', 'length': '32.5', 'size': '182000000'},
            {'name': 'clouds.webm', 'width': '1920', 'height': '1080', 'length': '32.5', 'size': '32375175'},
            {'name': 'clouds-small.mp4', 'width': '640', 'height': '360', 'length': '32.5', 'size': '2000000'},
        ]}


def metadata_response(value):
    return io.BytesIO(json.dumps(value).encode())


class ArchiveStockTest(unittest.TestCase):
    def test_formal_worker_verifies_real_video_and_retains_source_license(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = root / 'fixture.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=1280x720:d=4',
                            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(original)], check=True, timeout=30)
            body = original.read_bytes()
            item = archive_item()
            item['files'] = [{'name': 'clip.mp4', 'width': '1920', 'height': '1080', 'length': '32.5', 'size': str(len(body))}]
            def metadata(request, timeout):
                return metadata_response({'response': {'docs': [{'identifier': 'clouds'}]}} if '/advancedsearch.php?' in request.full_url else item)
            def media(request, timeout):
                result = io.BytesIO(body)
                result.headers = {'Content-Type': 'video/mp4', 'Content-Length': str(len(body))}
                return result
            script = root / 'script.json'
            script.write_text(json.dumps({'scenes': [{'position': 1, 'narration': '天空', 'duration': 4,
                'visual_strategy': 'stock', 'visual_prompt': 'clouds'}]}))
            with patch('urllib.request.OpenerDirector.open', side_effect=metadata), \
                 patch('video_factory.stock_assets.open_asset_request', side_effect=media):
                result = handle_request({'protocolVersion': WORKER_PROTOCOL_VERSION, 'commandId': 'cmd', 'runId': 'run',
                    'nodeRunId': 'assets', 'attempt': 1, 'capability': 'asset.prepare', 'outputDir': str(root / 'output'),
                    'input': {'scriptPath': str(script)}, 'parameters': {'provider': 'archive', 'mediaType': 'video'}})
            asset = json.loads(Path(result['output']['assetPlanPath']).read_text())['scene_assets'][0]
            self.assertEqual((asset['width'], asset['height'], asset['duration']), (1280, 720, 4))
            artifact = next(item for item in result['artifacts'] if item['kind'] == 'media_asset')
            self.assertEqual(artifact['provenance']['providerId'], 'archive-stock-v1')
            self.assertIn('需署名', artifact['provenance']['licenseNote'])
            self.assertEqual(asset['source_url'], 'https://archive.org/details/clouds')

    def search_item(self, item, query='clouds'):
        def opener(request, timeout):
            return metadata_response({'response': {'docs': [{'identifier': 'clouds'}]}} if '/advancedsearch.php?' in request.full_url else item)
        return search_stock_assets('archive', query, 'video', opener=opener)

    def test_noncommercial_is_allowed_but_ambiguous_and_no_derivatives_are_not(self):
        for license_name in ('by-nc', 'by-nc-sa'):
            item = archive_item()
            item['metadata']['licenseurl'] = f'https://creativecommons.org/licenses/{license_name}/4.0/'
            result = self.search_item(item)
            self.assertEqual(len(result), 1)
            self.assertIn('仅限非商业', result[0].license_note)
            if license_name.endswith('sa'):
                self.assertIn('相同或兼容许可', result[0].license_note)
        for license_url in (None, '', 'https://creativecommons.org/licenses/by-nd/4.0/',
                            'https://attacker.test/licenses/by/4.0/',
                            'http://creativecommons.org/licenses/publicdomain/',
                            ['https://creativecommons.org/licenses/by/4.0/']):
            item = archive_item()
            item['metadata']['licenseurl'] = license_url
            self.assertEqual(self.search_item(item), [])

    def test_restricted_wrong_collection_missing_credit_and_unsafe_files_are_rejected(self):
        for changes in ({'mediatype': 'audio'}, {'identifier': 'different'}, {'collection': ['opensource_movies']},
                        {'creator': None}, {'access-restricted-item': 'true'}):
            item = archive_item()
            item['metadata'].update(changes)
            self.assertEqual(self.search_item(item), [])
        self.assertEqual(self.search_item({**archive_item(), 'is_dark': True}), [])
        for changes in ({'private': 'true'}, {'name': '../clip.webm'}, {'name': '/clip.webm'},
                        {'width': '640'}, {'height': 'nan'}, {'length': 0}, {'size': '128000001'}, {'size': None}):
            item = archive_item()
            item['files'] = [{**item['files'][1], **changes}]
            self.assertEqual(self.search_item(item), [])
        item = archive_item()
        item['files'][1]['name'] = 'folder/clip with spaces.webm'
        self.assertIn('/folder/clip%20with%20spaces.webm', self.search_item(item)[0].download_url)

    def test_search_is_bounded_deduplicated_and_does_not_expose_query_operators(self):
        requests = []
        def opener(request, timeout):
            requests.append(request.full_url)
            if '/advancedsearch.php?' in request.full_url:
                return metadata_response({'response': {'docs': [{'identifier': 'clouds'}] * 20}})
            return metadata_response(archive_item())
        result = search_stock_assets('archive', '" OR collection:other', 'video', limit=12, opener=opener)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(requests), 2)
        params = parse_qs(urlsplit(requests[0]).query)
        self.assertEqual(params['rows'], ['6'])
        self.assertIn('("\\" OR collection:other")', params['q'][0])
        with self.assertRaisesRegex(ValueError, 'videos'):
            search_stock_assets('archive', 'clouds', 'image', opener=opener)

    def test_api_failures_are_not_silently_reported_as_empty_and_budget_is_shared(self):
        for payload in ({}, {'response': {'docs': None}}):
            with self.assertRaisesRegex(RuntimeError, 'invalid search'):
                search_stock_assets('archive', 'clouds', opener=lambda *a, **k: metadata_response(payload))
        now = [0.0]
        requests = []
        def opener(request, timeout):
            requests.append(request.full_url)
            now[0] += 11
            if '/advancedsearch.php?' in request.full_url:
                return metadata_response({'response': {'docs': [{'identifier': str(i)} for i in range(6)]}})
            item = archive_item()
            item['metadata']['licenseurl'] = ''
            return metadata_response(item)
        with patch('time.monotonic', side_effect=lambda: now[0]), self.assertRaisesRegex(RuntimeError, '时限'):
            search_stock_assets('archive', 'clouds', opener=opener)
        self.assertEqual(len(requests), 3)

    def test_selects_licensed_hd_within_budget_not_large_original_or_low_quality_derivative(self):
        requests = []
        def opener(request, timeout):
            requests.append(request.full_url)
            self.assertLessEqual(timeout, 10)
            if '/advancedsearch.php?' in request.full_url:
                return metadata_response({'response': {'docs': [{'identifier': 'clouds'}]}})
            return metadata_response(archive_item())
        items = search_stock_assets('archive', 'clouds', 'video', opener=opener)
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item.download_url, 'https://archive.org/download/clouds/clouds.webm')
        self.assertEqual((item.width, item.height, item.duration), (1920, 1080, 32.5))
        self.assertEqual(item.creator, 'Camera operator')
        self.assertIn('需署名', item.license_note)
        self.assertIn('https://creativecommons.org/licenses/by/3.0/', item.license_note)
        query = parse_qs(urlsplit(requests[0]).query)['q'][0]
        self.assertIn('collection:stock_footage', query)
        self.assertIn('mediatype:movies', query)
        self.assertEqual(len(requests), 2)


if __name__ == '__main__':
    unittest.main()
