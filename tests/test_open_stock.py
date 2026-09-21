import io
import json
import unittest
import urllib.parse
import tempfile
from pathlib import Path
from unittest.mock import patch
from PIL import Image

from video_factory.stock_assets import search_stock_assets, search_routed_scene_asset_candidates
from video_factory.domain import Scene
from video_factory.worker import handle_request, WORKER_PROTOCOL_VERSION


def response(value):
    return io.BytesIO(json.dumps(value).encode())


class OpenStockTest(unittest.TestCase):
    def test_cleveland_rejects_invalid_rights_hosts_sizes_and_duplicate_records(self):
        item = {'id': 1, 'share_license_status': 'CC0', 'url': 'https://clevelandart.org/art/1',
                'images': {'print': {'url': 'https://openaccess-cdn.clevelandart.org/1/a.jpg',
                                     'width': '2000', 'height': '3000'}}}
        image = item['images']['print']
        invalid = [None, {**item, 'share_license_status': None}, {**item, 'id': True},
                   {**item, 'images': None}, {**item, 'url': 'https://127.0.0.1/internal'},
                   *[{**item, 'images': {'print': {**image, **fields}}} for fields in (
                       {'url': 'https://openaccess-cdn.clevelandart.org.evil.test/a.jpg'},
                       {'url': 'https://openaccess-cdn.clevelandart.org/a.tif'},
                       {'width': '600'}, {'width': 'nan'}, {'height': None})]]
        items = search_stock_assets('cleveland', 'art', 'image',
            opener=lambda *a, **k: response({'data': [*invalid, item, item]}))
        self.assertEqual([candidate.asset_id for candidate in items], ['1'])
        with self.assertRaisesRegex(RuntimeError, 'invalid search'):
            search_stock_assets('cleveland', 'art', 'image', opener=lambda *a, **k: response({'data': None}))

    def test_cleveland_real_worker_keeps_provenance_and_checks_actual_dimensions(self):
        media = io.BytesIO()
        Image.new('RGB', (1600, 2400), 'blue').save(media, format='JPEG')
        def metadata(request, timeout):
            return response({'data': [{'id': 1, 'share_license_status': 'CC0',
                'url': 'https://clevelandart.org/art/1', 'images': {'print': {
                    'url': 'https://openaccess-cdn.clevelandart.org/1/print.jpg',
                    'width': '2302', 'height': '3400'}}}]})
        def download(request, timeout):
            result = io.BytesIO(media.getvalue())
            result.headers = {'Content-Type': 'image/jpeg', 'Content-Length': str(len(media.getvalue()))}
            return result
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / 'script.json'
            script.write_text(json.dumps({'scenes': [{'position': 1, 'narration': '文物', 'duration': 4,
                'visual_strategy': 'stock', 'visual_prompt': 'China'}]}))
            with patch('urllib.request.OpenerDirector.open', side_effect=metadata), \
                 patch('video_factory.stock_assets.open_asset_request', side_effect=download):
                result = handle_request({'protocolVersion': WORKER_PROTOCOL_VERSION, 'commandId': 'cmd', 'runId': 'run',
                    'nodeRunId': 'assets', 'attempt': 1, 'capability': 'asset.prepare', 'outputDir': str(root / 'output'),
                    'input': {'scriptPath': str(script)}, 'parameters': {'provider': 'cleveland', 'mediaType': 'image'}})
            plan = json.loads(Path(result['output']['assetPlanPath']).read_text())
            asset = plan['scene_assets'][0]
            self.assertEqual((asset['width'], asset['height']), (1600, 2400))
            artifact = next(item for item in result['artifacts'] if item['kind'] == 'media_asset')
            self.assertEqual(artifact['provenance']['providerId'], 'cleveland-stock-v1')
            self.assertIn('CC0', artifact['provenance']['licenseNote'])

    def test_cleveland_uses_cc0_print_images_not_small_previews_or_tiffs(self):
        requests = []
        item = {'id': 130939, 'share_license_status': 'CC0', 'title': '牛首玉人',
                'creation_date': '4700–2920 BCE', 'creators': [],
                'url': 'https://clevelandart.org/art/1953.628', 'images': {
                    'web': {'url': 'https://openaccess-cdn.clevelandart.org/1953.628/web.jpg'},
                    'print': {'url': 'https://openaccess-cdn.clevelandart.org/1953.628/print.jpg',
                              'width': '2302', 'height': '3400', 'filesize': '3300878'},
                    'full': {'url': 'https://openaccess-cdn.clevelandart.org/1953.628/full.tif'}}}
        def opener(request, timeout):
            requests.append(request.full_url)
            return response({'data': [item, {**item, 'id': 2, 'share_license_status': 'Copyright'}]})
        items = search_stock_assets('cleveland', 'China', 'image', opener=opener)
        self.assertEqual([candidate.asset_id for candidate in items], ['130939'])
        self.assertTrue(items[0].download_url.endswith('/print.jpg'))
        self.assertEqual((items[0].width, items[0].height), (2302, 3400))
        self.assertIn('CC0', items[0].license_note)
        self.assertIn('牛首玉人', items[0].license_note)
        self.assertEqual(len(requests), 1)
        self.assertIn('cc0=1', requests[0])
        with self.assertRaisesRegex(ValueError, 'images'):
            search_stock_assets('cleveland', 'China', 'video', opener=opener)

    def test_same_original_from_two_libraries_is_one_director_candidate(self):
        source = 'https://www.metmuseum.org/art/collection/search/1'
        download = 'https://images.metmuseum.org/art.jpg'
        def opener(request, timeout):
            if 'openverse.org' in request.full_url:
                return response({'results': [{'id': 'mirror-1', 'foreign_landing_url': source, 'url': download,
                    'creator': 'Met', 'license': 'cc0', 'license_version': '1.0',
                    'license_url': 'https://creativecommons.org/publicdomain/zero/1.0/'}]})
            if '/search?' in request.full_url:
                return response({'total': 1, 'objectIDs': [1]})
            return response({'objectID': 1, 'isPublicDomain': True, 'objectURL': source, 'primaryImage': download})
        scene = Scene(position=1, narration='馆藏', duration=4, visual_strategy='stock', visual_prompt='art')
        route = {'shots': [{'scenePosition': 1, 'preferredProviderId': 'met-stock-v1',
            'alternativeProviderIds': ['openverse-stock-v1'], 'deliveryType': 'stock_image', 'query': 'art'}]}
        with tempfile.TemporaryDirectory() as tmp, patch('urllib.request.OpenerDirector.open', side_effect=opener):
            public, private = search_routed_scene_asset_candidates(1, [scene], Path(tmp), route, limit=1)
            for path in (public, private):
                candidates = json.loads(path.read_text())['scene_candidates'][0]['candidates']
                self.assertEqual(len(candidates), 1)
                self.assertEqual(candidates[0]['provider_id'], 'met-stock-v1')

    def test_nasa_rejects_malformed_collections_and_ignores_invalid_items(self):
        with self.assertRaisesRegex(RuntimeError, 'invalid'):
            search_stock_assets('nasa', 'moon', 'image', opener=lambda *a, **k: response({'collection': None}))
        items = search_stock_assets('nasa', 'moon', 'image', opener=lambda *a, **k: response({
            'collection': {'items': [{'data': [None]}, {'data': []}, None]}}))
        self.assertEqual(items, [])

    def test_open_source_details_share_one_search_budget(self):
        now = [100.0]
        requests = []
        def opener(request, timeout):
            requests.append(request.full_url)
            self.assertLessEqual(timeout, 10)
            now[0] += 11
            if '/search?' in request.full_url:
                return response({'total': 12, 'objectIDs': list(range(1, 13))})
            return response({'objectID': 1, 'isPublicDomain': False})
        with patch('time.monotonic', side_effect=lambda: now[0]):
            with self.assertRaisesRegex(RuntimeError, '时限'):
                search_stock_assets('met', 'painting', 'image', opener=opener)
        self.assertEqual(len(requests), 3)

    def test_director_query_and_bilingual_alternatives_are_bounded_and_not_topic_rewritten(self):
        requests = []
        scene = Scene(position=1, narration='街景', duration=4, visual_strategy='stock',
                      visual_prompt='城市咖啡店外街景', search_terms=['city cafe exterior', 'street storefront', 'ignored'])
        route = {'shots': [{'scenePosition': 1, 'preferredProviderId': 'met-stock-v1',
                           'alternativeProviderIds': [], 'deliveryType': 'stock_image', 'query': '城市咖啡店外街景'}]}
        def metadata(request, timeout):
            requests.append(urllib.parse.parse_qs(urllib.parse.urlsplit(request.full_url).query).get('q', [''])[0])
            return response({'total': 0, 'objectIDs': []})
        with tempfile.TemporaryDirectory() as tmp, patch('urllib.request.OpenerDirector.open', side_effect=metadata):
            search_routed_scene_asset_candidates(1, [scene], Path(tmp), route, limit=2)
        self.assertEqual(requests, ['城市咖啡店外街景', 'city cafe exterior', 'street storefront'])

    def test_real_worker_records_downloaded_image_dimensions_not_missing_api_dimensions(self):
        media = io.BytesIO()
        Image.new('RGB', (1600, 2400), 'blue').save(media, format='JPEG')
        def metadata(request, timeout):
            if '/search?' in request.full_url:
                return response({'total': 1, 'objectIDs': [1]})
            return response({'objectID': 1, 'isPublicDomain': True,
                             'primaryImage': 'https://images.metmuseum.org/art.jpg',
                             'objectURL': 'https://www.metmuseum.org/art/collection/search/1'})
        def download(request, timeout):
            result = io.BytesIO(media.getvalue())
            result.headers = {'Content-Type': 'image/jpeg', 'Content-Length': str(len(media.getvalue()))}
            return result
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / 'script.json'
            script.write_text(json.dumps({'scenes': [{'position': 1, 'narration': '文物', 'duration': 4,
                                                     'visual_strategy': 'stock', 'visual_prompt': 'vase'}]}))
            with patch('urllib.request.OpenerDirector.open', side_effect=metadata), \
                 patch('video_factory.stock_assets.open_asset_request', side_effect=download):
                result = handle_request({'protocolVersion': WORKER_PROTOCOL_VERSION, 'commandId': 'cmd', 'runId': 'run',
                    'nodeRunId': 'assets', 'attempt': 1, 'capability': 'asset.prepare', 'outputDir': str(root / 'output'),
                    'input': {'scriptPath': str(script)}, 'parameters': {'provider': 'met', 'mediaType': 'image'}})
            plan = json.loads(Path(result['output']['assetPlanPath']).read_text())
            asset = plan['scene_assets'][0]
            self.assertEqual((asset['width'], asset['height']), (1600, 2400))
            artifact = next(item for item in result['artifacts'] if item['kind'] == 'media_asset')
            self.assertEqual(artifact['provenance']['providerId'], 'met-stock-v1')
            self.assertIn('CC0', artifact['provenance']['licenseNote'])

    def test_openverse_retains_noncommercial_terms_and_rejects_nd_and_duplicates(self):
        item = {'id': 'img-1', 'title': '城市', 'width': 2400, 'height': 3600,
                'url': 'https://live.staticflickr.com/1/photo.jpg',
                'thumbnail': 'https://api.openverse.org/v1/images/img-1/thumb/',
                'foreign_landing_url': 'https://www.flickr.com/photos/author/1',
                'creator': '摄影师', 'license': 'by-nc', 'license_version': '4.0',
                'license_url': 'https://creativecommons.org/licenses/by-nc/4.0/'}
        def opener(request, timeout):
            return response({'results': [item, item, {**item, 'id': 'img-2', 'license': 'by-nd'},
                                         {**item, 'id': 'img-3', 'url': 'https://127.0.0.1/private.jpg'}]})
        items = search_stock_assets('openverse', '城市', 'image', opener=opener)
        self.assertEqual([item.asset_id for item in items], ['img-1'])
        self.assertIn('仅限非商业', items[0].license_note)
        self.assertIn('flickr.com', items[0].source_url)
        self.assertEqual(items[0].width, 2400)
        with self.assertRaisesRegex(ValueError, 'images'):
            search_stock_assets('openverse', '城市', 'video', opener=opener)

    def test_nasa_uses_asset_manifest_not_thumbnails_and_preserves_credit(self):
        requests = []
        def opener(request, timeout):
            requests.append(request.full_url)
            if '/search?' in request.full_url:
                return response({'collection': {'items': [{'data': [{'nasa_id': 'Earth Test', 'center': 'GSFC',
                    'media_type': 'video', 'title': 'Earth observations', 'secondary_creator': 'NASA/GSFC'}],
                    'links': [{'render': 'image', 'href': 'https://images-assets.nasa.gov/thumb.jpg'}]}]}})
            return response({'collection': {'items': [
                {'href': 'http://images-assets.nasa.gov/video/Earth Test/movie~medium.mp4'},
                {'href': 'http://images-assets.nasa.gov/video/Earth%20Test/movie~small.mp4'},
                {'href': 'http://images-assets.nasa.gov/video/Earth%20Test/movie.jpg'},
            ]}})
        items = search_stock_assets('nasa', 'Earth', 'video', opener=opener)
        self.assertIn('/asset/Earth%20Test', requests[1])
        self.assertTrue(items[0].download_url.endswith('~medium.mp4'))
        self.assertTrue(items[0].download_url.startswith('https://'))
        self.assertNotIn(' ', items[0].download_url)
        self.assertIn('Earth%20Test', items[0].download_url)
        self.assertEqual(items[0].duration, 0)
        self.assertIn('NASA/GSFC', items[0].creator)
        self.assertIn('第三方', items[0].license_note)

    def test_met_uses_paginated_api_and_only_adopts_open_original_images(self):
        requests = []
        def opener(request, timeout):
            requests.append(request.full_url)
            if '/search?' in request.full_url:
                return response({'total': 3, 'objectIDs': [1, 2, 3]})
            object_id = int(request.full_url.rsplit('/', 1)[1])
            return response({'objectID': object_id, 'isPublicDomain': object_id == 2,
                             'primaryImage': 'https://images.metmuseum.org/CRDImages/as/original/art.jpg',
                             'primaryImageSmall': 'https://images.metmuseum.org/CRDImages/as/web-large/art.jpg',
                             'objectURL': f'https://www.metmuseum.org/art/collection/search/{object_id}',
                             'artistDisplayName': '作者', 'title': '山水', 'objectDate': '明代'})
        candidates = search_stock_assets('met', '山水', 'image', opener=opener)
        self.assertEqual([item.asset_id for item in candidates], ['2'])
        self.assertIn('/v1.1/search?', requests[0])
        self.assertIn('isPublicDomain=true', requests[0])
        self.assertEqual(candidates[0].width, 0)  # API 未给原文件尺寸，不伪造 1080p。
        self.assertIn('CC0', candidates[0].license_note)
        self.assertIn('明代', candidates[0].license_note)


if __name__ == '__main__':
    unittest.main()
