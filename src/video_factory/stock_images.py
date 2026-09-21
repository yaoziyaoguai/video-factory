"""保留图库原件，按真实渲染尺寸制作有界的静态图衍生文件。"""

import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageOps


MAX_IMAGE_PIXELS = 80_000_000
RENDER_OVERSCAN = 1.5


def checked_image_size(image) -> tuple[int, int]:
    width, height = image.size
    if width * height > MAX_IMAGE_PIXELS:
        raise ValueError(f'image exceeds {MAX_IMAGE_PIXELS} pixel limit')
    if image.format not in {'JPEG', 'PNG', 'WEBP'} or getattr(image, 'n_frames', 1) != 1:
        raise ValueError('requires a static JPEG, PNG or WebP image')
    if image.getexif().get(274) in {5, 6, 7, 8}:
        return height, width
    return width, height


def inspect_image_dimensions(path: Path) -> tuple[int, int]:
    try:
        with Image.open(path) as image:
            size = checked_image_size(image)
        with Image.open(path) as image:
            image.verify()
        return size
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
        raise RuntimeError(f'图片校验失败：格式损坏、不支持或超过 {MAX_IMAGE_PIXELS} 像素上限') from error


def prepare_render_image(source: Path, target: Path, width: int, height: int) -> Path:
    """不覆盖原件；按 cover 裁剪需要计算比例，不能只限制横图的长边。"""
    if width <= 0 or height <= 0:
        raise ValueError('Render image dimensions must be positive.')
    if source.resolve() == target.resolve():
        raise ValueError('Render derivative must not overwrite its source.')
    temporary = target.with_suffix('.partial.png')
    record_path = target.with_suffix('.json')
    record_temporary = record_path.with_suffix('.partial.json')
    try:
        with Image.open(source) as image:
            original_size = image.size
            oriented_width, oriented_height = checked_image_size(image)
            scale = min(1.0, max(width * RENDER_OVERSCAN / oriented_width,
                                 height * RENDER_OVERSCAN / oriented_height))
            output_size = (math.ceil(oriented_width * scale), math.ceil(oriented_height * scale))
            orientation = image.getexif().get(274, 1)
            image.load()
            if scale == 1 and orientation == 1:
                return source
            oriented = ImageOps.exif_transpose(image) if orientation != 1 else image
            if oriented.mode not in {'RGB', 'RGBA', 'L', 'LA'}:
                # 不自行猜测 CMYK 等色彩转换；原文件交给既有渲染器。
                return source
            target.parent.mkdir(parents=True, exist_ok=True)
            resized = oriented.resize(output_size, Image.Resampling.LANCZOS) if output_size != oriented.size else oriented
            resized.save(temporary, format='PNG', icc_profile=image.info.get('icc_profile'))
        digest = hashlib.sha256()
        with source.open('rb') as file:
            for block in iter(lambda: file.read(1024 * 1024), b''):
                digest.update(block)
        record = {'source_path': str(source), 'source_sha256': digest.hexdigest(),
                  'source_bytes': source.stat().st_size, 'source_size': list(original_size),
                  'oriented_size': [oriented_width, oriented_height], 'output_size': list(output_size),
                  'output_path': str(target), 'render_size': [width, height], 'overscan': RENDER_OVERSCAN,
                  'operation': 'EXIF orientation + proportional Lanczos resize; lossless PNG encoding'}
        record_temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(target)
        record_temporary.replace(record_path)
        return target
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
        raise RuntimeError('图片渲染预处理失败：文件损坏、像素超限或无法写入衍生文件') from error
    finally:
        temporary.unlink(missing_ok=True)
        record_temporary.unlink(missing_ok=True)
