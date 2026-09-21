"""Internet Archive 开放素材片段；集合与逐项许可必须同时满足。"""

import re
from urllib.parse import quote, urlencode

from .domain import StockAssetCandidate
from .wikimedia import metadata_text, positive_number
from .stock_licenses import creative_commons_notice


def archive_file_url(identifier: str, name: object) -> str:
    if not isinstance(name, str) or not name or '\\' in name or any(ord(c) < 32 for c in name):
        return ''
    if any(part in {'', '.', '..'} for part in name.split('/')):
        return ''
    return f'https://archive.org/download/{identifier}/' + quote(name, safe='/')


def is_restricted(item: dict) -> bool:
    return any(item.get(key) not in (None, False, 'false', '0', 0) for key in
               ('private', 'is_dark', 'is_restricted', 'access-restricted-item'))


def search_archive(query: str, media_type: str, limit: int, fetch, max_bytes: int) -> list[StockAssetCandidate]:
    if media_type != 'video':
        raise ValueError('Internet Archive only provides stock videos in VideoFactory.')
    # 引号内的用户搜索词不能改变 collection/mediatype/许可的服务端过滤条件。
    escaped = query.replace('\\', '\\\\').replace('"', '\\"')
    payload = fetch('https://archive.org/advancedsearch.php?' + urlencode({
        'q': f'collection:stock_footage AND mediatype:movies AND licenseurl:* AND ("{escaped}")',
        'fl[]': 'identifier', 'rows': min(6, max(3, limit * 2)), 'output': 'json',
    }))
    response = payload.get('response')
    docs = response.get('docs') if isinstance(response, dict) else None
    if not isinstance(docs, list):
        raise RuntimeError('Internet Archive returned invalid search results.')
    result, seen = [], set()
    for doc in docs[:6]:
        identifier = doc.get('identifier') if isinstance(doc, dict) else None
        if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', identifier) or identifier in seen:
            continue
        seen.add(identifier)
        detail = fetch('https://archive.org/metadata/' + identifier)
        metadata, files = detail.get('metadata'), detail.get('files')
        if not isinstance(metadata, dict) or not isinstance(files, list):
            raise RuntimeError('Internet Archive returned invalid item metadata.')
        collections = metadata.get('collection')
        collections = [collections] if isinstance(collections, str) else collections
        if (metadata.get('identifier') != identifier or metadata.get('mediatype') != 'movies'
                or not isinstance(collections, list) or 'stock_footage' not in collections
                or is_restricted(detail) or is_restricted(metadata)):
            continue
        license_note = creative_commons_notice(metadata.get('licenseurl'))
        creators = metadata.get('creator')
        creator = '; '.join(filter(None, map(metadata_text, creators))) if isinstance(creators, list) else metadata_text(creators)
        if not license_note or not creator:
            continue
        variants, preview = [], ''
        for file in files:
            if not isinstance(file, dict) or is_restricted(file):
                continue
            name = file.get('name')
            url = archive_file_url(identifier, name)
            if not url:
                continue
            if file.get('format') == 'Thumbnail' and str(name).lower().endswith(('.jpg', '.png')) and not preview:
                preview = url
            if not str(name).lower().endswith(('.mp4', '.webm')):
                continue
            width, height = positive_number(file.get('width')), positive_number(file.get('height'))
            size, duration = positive_number(file.get('size')), positive_number(file.get('length'))
            if min(width, height) < 720 or not 0 < size <= max_bytes or duration <= 0:
                continue
            variants.append((width * height, -size, url, int(width), int(height), duration))
        if not variants:
            continue
        _, _, download, width, height, duration = max(variants)
        source = 'https://archive.org/details/' + identifier
        result.append(StockAssetCandidate(
            provider='archive', asset_id=identifier, media_type='video', width=width, height=height, duration=duration,
            download_url=download, preview_url=preview, source_url=source, creator=creator, creator_url=source,
            license_note='Internet Archive 上传者声明 · ' + license_note + ' · ' + metadata_text(metadata.get('title'))
                         + '。集合归属不构成版权担保，公开使用前核对原文件页。',
            query=query, score=width * height,
        ))
        if len(result) >= limit:
            break
    return result
