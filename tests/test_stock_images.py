import io
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from video_factory.domain import StockAssetCandidate
from video_factory.stock_assets import materialize_candidate


class StockImagesTest(unittest.TestCase):
    def test_render_corrects_orientation_and_keeps_transparency_without_upscaling(self):
        from video_factory.stock_images import prepare_render_image
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'rotated.png'
            exif = Image.Exif()
            exif[274] = 6
            Image.new('RGBA', (1200, 800), (10, 20, 30, 100)).save(source, exif=exif)
            target = prepare_render_image(source, root / 'render.png', 1080, 1920)
            with Image.open(target) as image:
                self.assertEqual(image.size, (800, 1200))
                self.assertEqual(image.getpixel((0, 0))[3], 100)
                self.assertNotIn(274, image.getexif())

    def test_pixel_limit_and_corrupt_input_do_not_modify_original_or_leave_derivative(self):
        from video_factory.stock_images import prepare_render_image, inspect_image_dimensions
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'original.png'
            Image.new('RGB', (1000, 1000), 'navy').save(source)
            original = source.read_bytes()
            with patch('video_factory.stock_images.MAX_IMAGE_PIXELS', 900_000):
                with self.assertRaisesRegex(RuntimeError, '像素'):
                    inspect_image_dimensions(source)
                with self.assertRaisesRegex(RuntimeError, '像素'):
                    prepare_render_image(source, root / 'render.png', 1080, 1920)
            self.assertEqual(source.read_bytes(), original)
            bad = root / 'corrupt.png'
            bad.write_bytes(b'not an image')
            with self.assertRaises(RuntimeError):
                prepare_render_image(bad, root / 'render.png', 1080, 1920)
            self.assertFalse((root / 'render.png').exists())
            self.assertFalse(list(root.glob('*.partial.*')))

    def test_image_byte_limits_apply_to_header_and_stream_and_remove_partial_file(self):
        from video_factory.stock_assets import MAX_IMAGE_DOWNLOAD_BYTES
        candidate = StockAssetCandidate(provider='met', asset_id='x', media_type='image', width=0, height=0,
            duration=0, preview_url='', download_url='https://media.example/asset', source_url='', creator='',
            license_note='', query='', score=0)
        with tempfile.TemporaryDirectory() as tmp, \
             patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
            def oversized(request, timeout):
                result = io.BytesIO(b'')
                result.headers = {'Content-Type': 'image/png', 'Content-Length': str(MAX_IMAGE_DOWNLOAD_BYTES + 1)}
                return result
            target = Path(tmp) / 'download.png'
            with self.assertRaisesRegex(RuntimeError, 'too large'):
                materialize_candidate(candidate, target, opener=oversized)
            def streamed(request, timeout):
                result = io.BytesIO(b'x' * 2048)
                result.headers = {'Content-Type': 'image/png'}
                return result
            with patch('video_factory.stock_assets.MAX_IMAGE_DOWNLOAD_BYTES', 1024):
                with self.assertRaisesRegex(RuntimeError, 'exceeded'):
                    materialize_candidate(candidate, target, opener=streamed)
            self.assertFalse(target.exists())

    def test_render_derivative_preserves_crop_pixels_and_original_provenance(self):
        from video_factory.stock_images import prepare_render_image
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'original.png'
            Image.new('RGB', (6000, 4000), 'navy').save(source)
            original_sha = hashlib.sha256(source.read_bytes()).hexdigest()
            target = root / 'render.png'
            self.assertEqual(prepare_render_image(source, target, 1080, 1920), target)
            with Image.open(target) as image:
                self.assertEqual(image.size, (4320, 2880))
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_sha)
            record = json.loads(target.with_suffix('.json').read_text())
            self.assertEqual(record['source_sha256'], original_sha)
            self.assertEqual(record['output_size'], [4320, 2880])
            # 同一原图用于更高分辨率输出时重新计算，不能复用低清衍生图。
            self.assertEqual(prepare_render_image(source, root / '4k.png', 2160, 3840), source)

    def test_large_image_download_allowed_under_separate_image_budget(self):
        media = io.BytesIO()
        Image.new('RGB', (2200, 2200), 'navy').save(media, format='PNG', compress_level=0)
        body = media.getvalue()
        self.assertGreater(len(body), 12_000_000)
        def opener(request, timeout):
            result = io.BytesIO(body)
            result.headers = {'Content-Type': 'application/octet-stream', 'Content-Length': str(len(body))}
            return result
        with tempfile.TemporaryDirectory() as tmp, \
             patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
            candidate = StockAssetCandidate(provider='nasa', asset_id='large', media_type='image',
                width=0, height=0, duration=0, preview_url='', download_url='https://media.example/asset',
                source_url='https://images.nasa.gov/details/large', creator='NASA', license_note='source terms',
                query='earth', score=0)
            target = Path(tmp) / 'image'
            self.assertEqual(materialize_candidate(candidate, target, opener=opener).stat().st_size, len(body))
