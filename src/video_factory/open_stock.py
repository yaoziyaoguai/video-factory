"""零凭据公开素材源；仅发现候选，下载仍走统一安全传输。"""

import ipaddress
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

from .domain import StockAssetCandidate
from .wikimedia import metadata_text, positive_number, public_url


def search_cleveland(query: str, media_type: str, limit: int, fetch) -> list[StockAssetCandidate]:
    if media_type != 'image':
        raise ValueError('Cleveland only provides images.')
    payload = fetch('https://openaccess-api.clevelandart.org/api/artworks/?' + urlencode({
        'q': query, 'cc0': 1, 'has_image': 1, 'limit': min(24, max(6, limit * 2)),
    }))
    items = payload.get('data')
    if not isinstance(items, list):
        raise RuntimeError('Cleveland returned invalid search results.')
    results = []
    seen = set()
    for item in items[:24]:
        if not isinstance(item, dict) or item.get('share_license_status') != 'CC0':
            continue
        asset_id = item.get('id')
        images = item.get('images')
        if type(asset_id) is not int or asset_id <= 0 or asset_id in seen or not isinstance(images, dict):
            continue
        # print 是官方高清 JPEG；web 是缩略图，full 可能是巨型 TIFF，不能互相冒充。
        printable = images.get('print')
        if not isinstance(printable, dict):
            continue
        download = public_url(printable.get('url'), {'openaccess-cdn.clevelandart.org'})
        source = public_url(item.get('url'), {'clevelandart.org', 'www.clevelandart.org'})
        width, height = positive_number(printable.get('width')), positive_number(printable.get('height'))
        if not download or not source or not urlsplit(download).path.lower().endswith(('.jpg', '.jpeg')) or min(width, height) < 720:
            continue
        preview = images.get('web')
        creators = item.get('creators')
        creator = '; '.join(filter(None, (metadata_text(entry.get('description')) for entry in creators
                            if isinstance(entry, dict)))) if isinstance(creators, list) else ''
        results.append(StockAssetCandidate(
            provider='cleveland', asset_id=str(asset_id), media_type='image',
            width=int(width), height=int(height), duration=0,
            preview_url=public_url(preview.get('url'), {'openaccess-cdn.clevelandart.org'}) if isinstance(preview, dict) else '',
            download_url=download, source_url=source,
            creator=creator or 'The Cleveland Museum of Art（作者未注明）', creator_url=source,
            license_note='Cleveland Open Access · CC0 · https://creativecommons.org/publicdomain/zero/1.0/ · '
                         + metadata_text(item.get('title')) + '；' + metadata_text(item.get('creation_date'))
                         + '。保留馆藏信息，不暗示机构背书。',
            query=query, score=int(width * height),
        ))
        seen.add(asset_id)
        if len(results) >= limit:
            break
    return results


def search_met(query: str, media_type: str, limit: int, fetch) -> list[StockAssetCandidate]:
    if media_type != "image":
        raise ValueError("Met only provides images.")
    result = []
    seen = set()
    page_size = min(12, max(3, limit * 2))
    for offset in (0, page_size):
        payload = fetch("https://collectionapi.metmuseum.org/public/collection/v1.1/search?" + urlencode({
            "q": query, "isPublicDomain": "true", "hasImages": "true", "limit": page_size, "offset": offset,
        }))
        ids = payload.get("objectIDs")
        if ids is None and payload.get("total") == 0:
            break
        if not isinstance(ids, list):
            raise RuntimeError("Met returned invalid search results.")
        for object_id in ids[:page_size]:
            if type(object_id) is not int or object_id <= 0 or object_id in seen:
                continue
            seen.add(object_id)
            item = fetch(f"https://collectionapi.metmuseum.org/public/collection/v1/objects/{object_id}")
            if item.get("isPublicDomain") is not True or item.get("objectID") != object_id:
                continue
            download = public_url(item.get("primaryImage"), {"images.metmuseum.org"})
            source = public_url(item.get("objectURL"), {"www.metmuseum.org", "metmuseum.org"})
            if not source or not download:
                continue
            creator = metadata_text(item.get("artistDisplayName")) or "The Metropolitan Museum of Art（作者未注明）"
            title, date = metadata_text(item.get("title")), metadata_text(item.get("objectDate"))
            result.append(StockAssetCandidate(
                provider="met", asset_id=str(object_id), media_type="image", width=0, height=0, duration=0,
                preview_url=public_url(item.get("primaryImageSmall"), {"images.metmuseum.org"}),
                download_url=download, source_url=source, creator=creator, creator_url=source,
                license_note=f"The Met Open Access · CC0 · https://creativecommons.org/publicdomain/zero/1.0/ · {title}；{date}。原文件尺寸采用时核验；保留馆藏信息。",
                query=query, score=0,
            ))
            if len(result) >= limit:
                return result
        if len(ids) < page_size:
            break
    return result


def nasa_url(value: object) -> str:
    # 官方旧版清单给 http URL；只将已知 NASA CDN 升级为 HTTPS，绝不降级。
    if isinstance(value, str) and value.startswith("http://images-assets.nasa.gov/"):
        value = "https://" + value[len("http://"):]
    url = public_url(value, {"images-assets.nasa.gov"})
    if not url:
        return ''
    parsed = urlsplit(url)
    # 官方清单有未编码的空格路径；保留已有百分号编码，避免二次编码。
    return parsed._replace(path=quote(parsed.path, safe='/%')).geturl()


def search_nasa(query: str, media_type: str, limit: int, fetch) -> list[StockAssetCandidate]:
    if media_type not in {"image", "video"}:
        raise ValueError("NASA supports image or video only.")
    payload = fetch("https://images-api.nasa.gov/search?" + urlencode({
        "q": query, "media_type": media_type, "page_size": min(12, max(3, limit * 2)),
    }))
    collection = payload.get('collection')
    items = collection.get('items') if isinstance(collection, dict) else None
    if not isinstance(items, list):
        raise RuntimeError("NASA returned invalid search results.")
    result = []
    seen = set()
    for item in items[:12]:
        if not isinstance(item, dict) or not isinstance(item.get("data"), list) or not item["data"]:
            continue
        data = item["data"][0]
        if not isinstance(data, dict):
            continue
        asset_id = data.get("nasa_id")
        if not isinstance(asset_id, str) or not asset_id or asset_id in seen or data.get("media_type") != media_type:
            continue
        seen.add(asset_id)
        # 明示第三方版权的内容不按机构的一般媒体使用规则自动采用。
        if data.get("copyright") or not data.get("center"):
            continue
        manifest = fetch("https://images-api.nasa.gov/asset/" + quote(asset_id, safe=""))
        collection = manifest.get('collection')
        files = collection.get('items') if isinstance(collection, dict) else None
        if not isinstance(files, list):
            raise RuntimeError("NASA returned invalid asset manifest.")
        variants = []
        for file in files:
            url = nasa_url(file.get("href")) if isinstance(file, dict) else ""
            suffix = urlsplit(url).path.lower()
            if media_type == "video" and suffix.endswith('.mp4'):
                # 预览/手机版不能当正式原片；真实像素、时长须下载后核验。
                if any(tag in suffix for tag in ('~preview.', '~mobile.', '~small.')):
                    continue
                priority = 2 if '~orig.' in suffix else 1
                variants.append((priority, url))
            elif media_type == "image" and suffix.endswith(('.jpg', '.jpeg', '.png')) and '~orig.' in suffix:
                variants.append((1, url))
        if not variants:
            continue
        links = item.get('links') if isinstance(item.get('links'), list) else []
        preview = next((nasa_url(link.get("href")) for link in links
                        if isinstance(link, dict) and link.get("render") == "image" and nasa_url(link.get("href"))), "")
        source = "https://images.nasa.gov/details/" + quote(asset_id, safe="")
        creator = metadata_text(data.get("secondary_creator")) or "NASA / " + metadata_text(data.get("center"))
        result.append(StockAssetCandidate(
            provider="nasa", asset_id=asset_id, media_type=media_type, width=0, height=0, duration=0,
            preview_url=preview, download_url=max(variants)[1], source_url=source,
            creator=creator, creator_url=source, query=query, score=0,
            license_note="NASA 媒体使用指南 · https://www.nasa.gov/nasa-brand-center/images-and-media/ · "
                         "保留 NASA 与原始创作者署名；另核对第三方版权、人物与标识，不得暗示官方背书。" + metadata_text(data.get("title")),
        ))
        if len(result) >= limit:
            break
    return result


def openverse_public_url(value: object) -> str:
    if not isinstance(value, str):
        return ""
    try:
        url = urlsplit(value)
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.port or url.fragment:
            return ""
        if url.hostname == 'localhost' or '.' not in url.hostname or url.hostname.endswith(('.local', '.internal')):
            return ""
        if any(key.lower() not in {'curid', 'id', 'v'} for key, _ in parse_qsl(url.query, keep_blank_values=True)):
            return ""
        try:
            ipaddress.ip_address(url.hostname)
            return ""  # 聚合服务只接受有原站域名的来源；下载阶段还会重新校验 DNS。
        except ValueError:
            return value
    except ValueError:
        return ""


def search_openverse(query: str, media_type: str, limit: int, fetch) -> list[StockAssetCandidate]:
    if media_type != 'image':
        raise ValueError('Openverse only provides images in VideoFactory.')
    results = []
    seen = set()
    for page in (1, 2):
        payload = fetch('https://api.openverse.org/v1/images/?' + urlencode({
            'q': query, 'page': page, 'page_size': min(20, max(6, limit * 2)),
            'license': 'cc0,pdm,by,by-sa,by-nc,by-nc-sa', 'mature': 'false',
        }))
        items = payload.get('results')
        if not isinstance(items, list):
            raise RuntimeError('Openverse returned invalid search results.')
        for item in items:
            if not isinstance(item, dict):
                continue
            license = item.get('license')
            version = item.get('license_version')
            if license in {'cc0', 'pdm'}:
                expected = f"https://creativecommons.org/publicdomain/{'zero' if license == 'cc0' else 'mark'}/1.0/"
            elif license in {'by', 'by-sa', 'by-nc', 'by-nc-sa'} and version in {'1.0', '2.0', '2.5', '3.0', '4.0'}:
                expected = f'https://creativecommons.org/licenses/{license}/{version}/'
            else:
                continue
            stated = str(item.get('license_url', '')).replace('http://creativecommons.org/', 'https://creativecommons.org/').rstrip('/') + '/'
            if stated != expected or item.get('mature') is True:
                continue
            asset_id = item.get('id')
            source = openverse_public_url(item.get('foreign_landing_url'))
            download = openverse_public_url(item.get('url'))
            creator = metadata_text(item.get('creator'))
            if not isinstance(asset_id, str) or not asset_id or not source or not download or not creator or source in seen:
                continue
            width, height = positive_number(item.get('width')), positive_number(item.get('height'))
            if width and height and min(width, height) < 720:
                continue
            terms = '需署名、链接许可并说明修改'
            if 'nc' in license:
                terms += '；仅限非商业使用（个人非商业公开分享可按许可使用）'
            if 'sa' in license:
                terms += '；改编部分须遵循相同或兼容许可'
            if license in {'cc0', 'pdm'}:
                terms = '保留来源并核对第三方权利'
            results.append(StockAssetCandidate(
                provider='openverse', asset_id=asset_id, media_type='image', width=int(width), height=int(height), duration=0,
                preview_url=public_url(item.get('thumbnail'), {'api.openverse.org'}),
                download_url=download, source_url=source, creator=creator, creator_url=source,
                license_note=f'Openverse 原站许可索引 · {license.upper()} {version or ""} · {expected} · {terms}。原站链接随素材保留，公开使用前核对原站许可。',
                query=query, score=int(width * height),
            ))
            seen.add(source)
            if len(results) >= limit:
                return results
        if not payload.get('next'):
            break
    return results
