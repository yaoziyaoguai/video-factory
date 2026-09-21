"""Commons 图片、视频元数据归一化；下载和网络安全仍由现有 stock worker 负责。"""

import math
import re
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlsplit

from .domain import StockAssetCandidate


class MetadataText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def metadata_text(value: object) -> str:
    parser = MetadataText()
    parser.feed(value if isinstance(value, str) else "")
    return " ".join(" ".join(parser.parts).split())[:2000]


def public_url(value: object, hosts: set[str]) -> str:
    if not isinstance(value, str):
        return ""
    try:
        url = urlsplit(value)
        safe_query = all(key in {"utm_source", "utm_campaign", "utm_content"} for key, _ in parse_qsl(url.query, keep_blank_values=True))
        if url.scheme == "https" and url.hostname in hosts and safe_query and not (url.username or url.password or url.port or url.fragment):
            return value
    except ValueError:
        pass
    return ""


def positive_number(value: object) -> float:
    if isinstance(value, bool):
        return 0
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def license_note(metadata: dict, source_url: str) -> str:
    def text(key):
        entry = metadata.get(key)
        return metadata_text(entry.get("value")) if isinstance(entry, dict) else ""

    name, url = text("LicenseShortName"), text("LicenseUrl")
    if url.startswith("http://creativecommons.org/"):
        url = "https://" + url[len("http://"):]
    url = url.rstrip("/") + "/" if url else ""
    categories = text("Categories").lower()
    if re.search(r"licen[cs]e review (needed|failed)|copyright violations?|disputed|no machine-readable licen[cs]e|deletion requests", categories):
        return ""
    match = re.fullmatch(r"CC (BY(?:-SA)?) (1\.0|2\.0|2\.5|3\.0|4\.0)", name)
    if match:
        kind, version = match.groups()
        expected = f"https://creativecommons.org/licenses/{kind.lower()}/{version}/"
        if url != expected:
            return ""
        conditions = "需署名、链接许可并说明修改"
        if kind == "BY-SA":
            conditions += "；改编作品须按相同许可分享（ShareAlike），发布前请确认能履行"
        return f"Wikimedia Commons · {name} · {expected} · {conditions}；另核对人物、商标等第三方权利。"
    if name in {"CC0", "CC0 1.0"} and url == "https://creativecommons.org/publicdomain/zero/1.0/":
        return f"Wikimedia Commons · {name} · {url} · 保留作者与来源；另核对第三方权利。"
    if name == "Public domain" and (
        url == "https://creativecommons.org/publicdomain/mark/1.0/"
        or (not url and text("License").lower() == "pd" and text("Copyrighted").lower() == "false")
    ):
        return f"Wikimedia Commons · Public domain（公有领域，依据文件页声明） · {url or source_url} · 另核对第三方权利。"
    return ""


def video_candidate(page: dict, query: str, max_bytes: int) -> StockAssetCandidate | None:
    info = page["videoinfo"][0]
    if info.get("mediatype") != "VIDEO" or not str(info.get("mime", "")).startswith("video/"):
        return None
    page_id = page["pageid"]
    if not isinstance(page_id, int) or isinstance(page_id, bool) or page_id <= 0:
        return None
    duration = positive_number(info.get("duration"))
    if not duration or not positive_number(info.get("width")) or not positive_number(info.get("height")):
        return None
    source = public_url(info.get("descriptionurl"), {"commons.wikimedia.org"})
    metadata = info.get("extmetadata", {})
    creator = metadata_text(metadata.get("Artist", {}).get("value"))
    license = license_note(metadata, source)
    if not source or not creator or not license:
        return None
    variants = []
    for variant in info.get("derivatives", []):
        if not isinstance(variant, dict):
            continue
        mime = str(variant.get("type", "")).split(";", 1)[0].strip()
        url = public_url(variant.get("src"), {"upload.wikimedia.org"})
        width, height = positive_number(variant.get("width")), positive_number(variant.get("height"))
        size = positive_number(variant.get("bandwidth")) * duration / 8
        if url and mime in {"video/webm", "video/mp4", "video/ogg"} and min(width, height) >= 720 and 0 < size <= max_bytes:
            variants.append((width * height, -size, int(width), int(height), url))
    # 原片也可用，但必须有真实大小；不因原片超大而错过合适的转码版本。
    width, height, size = positive_number(info.get("width")), positive_number(info.get("height")), positive_number(info.get("size"))
    original = public_url(info.get("url"), {"upload.wikimedia.org"})
    if original and info.get("mime") in {"video/webm", "video/mp4", "video/ogg"} and min(width, height) >= 720 and 0 < size <= max_bytes:
        variants.append((width * height, -size, int(width), int(height), original))
    if not variants:
        return None
    _, _, width, height, download = max(variants)
    images = page.get("imageinfo") or [{}]
    preview = public_url(images[0].get("thumburl"), {"upload.wikimedia.org", "thumb.wikimedia.org"})
    return StockAssetCandidate(
        provider="wikimedia", asset_id=str(page_id), media_type="video", width=width, height=height,
        duration=duration, preview_url=preview, download_url=download, source_url=source,
        creator=creator, creator_url=source, license_note=license, query=query,
        score=width * height + (10000 if height >= width else 0) + (1000 if 4 <= duration <= 30 else 0),
    )


def normalize_videos(pages: list, query: str, max_bytes: int) -> list[StockAssetCandidate]:
    candidates = []
    for page in pages:
        try:
            candidate = video_candidate(page, query, max_bytes)
            if candidate:
                candidates.append(candidate)
        except (KeyError, IndexError, TypeError, ValueError, AttributeError, OverflowError):
            continue
    return candidates


def normalize_images(pages: list, query: str, max_bytes: int) -> list[StockAssetCandidate]:
    candidates = []
    for page in pages:
        try:
            info = page["imageinfo"][0]
            page_id = page["pageid"]
            if isinstance(page_id, bool) or not isinstance(page_id, int) or page_id <= 0:
                continue
            if info.get("mime") not in {"image/jpeg", "image/png", "image/webp"}:
                continue
            width, height, size = (positive_number(info.get(key)) for key in ("width", "height", "size"))
            source = public_url(info.get("descriptionurl"), {"commons.wikimedia.org"})
            download = public_url(info.get("url"), {"upload.wikimedia.org"})
            metadata = info.get("extmetadata", {})
            creator = metadata_text(metadata.get("Artist", {}).get("value"))
            note = license_note(metadata, source)
            if not all((source, download, creator, note)) or min(width, height) < 720 or not 0 < size <= max_bytes:
                continue
            candidates.append(StockAssetCandidate(
                provider="wikimedia", asset_id=str(page_id), media_type="image", width=int(width), height=int(height),
                duration=0, preview_url=public_url(info.get("thumburl"), {"upload.wikimedia.org", "thumb.wikimedia.org"}),
                download_url=download, source_url=source, creator=creator, creator_url=source,
                license_note=note, query=query, score=int(width * height),
            ))
        except (KeyError, IndexError, TypeError, ValueError, AttributeError, OverflowError):
            continue
    return candidates
