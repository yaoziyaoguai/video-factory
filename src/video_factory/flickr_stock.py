"""Flickr 公开摄影图片：动态许可、下载权限和采用前复核。"""

import re
from urllib.parse import urlsplit

from .domain import StockAssetCandidate
from .stock_licenses import creative_commons_notice
from .wikimedia import metadata_text, positive_number, public_url


def flickr_media_url(value: object) -> str:
    if not isinstance(value, str):
        return ''
    try:
        host = urlsplit(value).hostname or ''
    except ValueError:
        return ''
    if not re.fullmatch(r'(live|farm[0-9]*)\.staticflickr\.com', host):
        return ''
    if value.startswith('http://'):
        value = 'https://' + value[len('http://'):]
    return public_url(value, {host})


def license_catalog(call) -> dict[str, str]:
    payload = call('flickr.photos.licenses.getInfo', {})
    licenses = payload.get('licenses')
    items = licenses.get('license') if isinstance(licenses, dict) else None
    if not isinstance(items, list):
        raise RuntimeError('Flickr returned invalid licenses.')
    result = {}
    for item in items:
        if not isinstance(item, dict) or not re.fullmatch(r'\d+', str(item.get('id'))):
            continue
        notice = creative_commons_notice(item.get('url'))
        if notice:
            result[str(item['id'])] = notice
    return result


def photo_candidate(photo_id: str, query: str, licenses: dict[str, str], call):
    if not re.fullmatch(r'\d+', photo_id):
        return None
    photo = call('flickr.photos.getInfo', {'photo_id': photo_id}).get('photo')
    if not isinstance(photo, dict) or str(photo.get('id')) != photo_id:
        raise RuntimeError('Flickr returned invalid photo details.')
    visibility, owner = photo.get('visibility'), photo.get('owner')
    license_note = licenses.get(str(photo.get('license')))
    if (not license_note or photo.get('media', 'photo') != 'photo'
            or not isinstance(visibility, dict) or str(visibility.get('ispublic')) != '1'
            or not isinstance(owner, dict) or not re.fullmatch(r'\d+@N\d+', str(owner.get('nsid')))):
        return None
    sizes = call('flickr.photos.getSizes', {'photo_id': photo_id}).get('sizes')
    if not isinstance(sizes, dict) or not isinstance(sizes.get('size'), list):
        raise RuntimeError('Flickr returned invalid image sizes.')
    if str(sizes.get('candownload')) != '1':
        return None
    variants, previews = [], []
    for size in sizes['size']:
        if not isinstance(size, dict) or size.get('media') != 'photo':
            continue
        url = flickr_media_url(size.get('source'))
        width, height = positive_number(size.get('width')), positive_number(size.get('height'))
        if not url or not urlsplit(url).path.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
            continue
        if min(width, height) >= 200:
            previews.append((width * height, url))
        # Flickr 的手动旋转不一定写在原图 EXIF；旋转未知时只取服务器已处理的版本。
        if size.get('label') == 'Original' and str(photo.get('rotation')) != '0':
            continue
        if min(width, height) >= 720:
            variants.append((width * height, url, int(width), int(height)))
    if not variants:
        return None
    _, download, width, height = max(variants)
    profile = f'https://www.flickr.com/photos/{owner["nsid"]}/'
    title = photo.get('title')
    return StockAssetCandidate(
        provider='flickr', asset_id=photo_id, media_type='image', width=width, height=height, duration=0,
        preview_url=min(previews)[1] if previews else '', download_url=download, source_url=profile + photo_id + '/',
        creator=metadata_text(owner.get('realname')) or metadata_text(owner.get('username')) or str(owner['nsid']),
        creator_url=profile, license_note='Flickr · ' + license_note + ' · '
            + metadata_text(title.get('_content') if isinstance(title, dict) else title), query=query, score=width * height,
    )


def search_flickr(query: str, media_type: str, limit: int, call) -> list[StockAssetCandidate]:
    if media_type != 'image':
        raise ValueError('Flickr only provides images in VideoFactory.')
    licenses = license_catalog(call)
    if not licenses:
        return []
    photos = call('flickr.photos.search', {'text': query, 'license': ','.join(licenses),
        'media': 'photos', 'safe_search': 1, 'content_type': 1, 'sort': 'relevance',
        'per_page': min(6, max(3, limit * 2)), 'page': 1}).get('photos')
    if not isinstance(photos, dict) or not isinstance(photos.get('photo'), list):
        raise RuntimeError('Flickr returned invalid search results.')
    result, seen = [], set()
    for item in photos['photo'][:6]:
        photo_id = str(item.get('id')) if isinstance(item, dict) else ''
        if photo_id in seen:
            continue
        seen.add(photo_id)
        candidate = photo_candidate(photo_id, query, licenses, call)
        if candidate:
            result.append(candidate)
        if len(result) >= limit:
            break
    return result


def validate_flickr_adoption(candidate: StockAssetCandidate, call) -> None:
    fresh = photo_candidate(candidate.asset_id, candidate.query, license_catalog(call), call)
    if not fresh or any(getattr(fresh, field) != getattr(candidate, field)
                        for field in ('download_url', 'source_url', 'creator', 'license_note')):
        raise RuntimeError('Flickr 素材权限、许可或版本已变化；请重新检索确认，未下载文件。')
