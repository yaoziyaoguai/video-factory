import json
import os
import re
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, List, Optional

from .domain import Scene, SceneAsset, StockAssetCandidate


PROVIDER_KEY_ENV = {
    "pexels": "PEXELS_API_KEY",
    "pixabay": "PIXABAY_API_KEY",
}
MAX_ASSET_DOWNLOAD_BYTES = 12_000_000

PROVIDER_LICENSE_NOTE = {
    "pexels": "Pexels free stock license; review current provider license before publishing.",
    "pixabay": "Pixabay Content License; cache API responses for 24h and avoid systematic mass downloads.",
    "mock": "Generated local placeholder for tests and visual pipeline checks; not a real stock asset.",
    "local": "Owner-generated local graphic card; no external stock license required.",
}


class MissingProviderKey(RuntimeError):
    pass


def default_asset_plan_path(workspace: Path, job_id: int) -> Path:
    return workspace / "assets" / f"job-{job_id}" / "asset_plan.json"


def default_asset_search_report_path(workspace: Path, job_id: int) -> Path:
    return workspace / "assets" / f"job-{job_id}" / "asset_candidates.json"


def search_scene_asset_candidates(
    job_id: int,
    scenes: Iterable[Scene],
    workspace: Path,
    provider: str,
    media_type: str = "video",
    limit: int = 3,
) -> Path:
    report = {
        "job_id": job_id,
        "provider": provider,
        "media_type": media_type,
        "created_at": utc_now(),
        "scene_candidates": [],
    }
    for scene in scenes:
        query = query_for_scene(scene)
        if scene.visual_strategy == "local":
            candidates = [local_card_candidate(scene, query)]
        else:
            candidates = search_stock_assets(
                provider=provider,
                query=query,
                media_type=media_type,
                limit=limit,
            )
        report["scene_candidates"].append(
            {
                "scene_position": scene.position,
                "query": query,
                "candidates": [candidate_to_dict(candidate) for candidate in candidates],
            }
        )
    output = default_asset_search_report_path(workspace, job_id)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def prepare_scene_assets(
    job_id: int,
    scenes: Iterable[Scene],
    workspace: Path,
    provider: str,
    media_type: str = "video",
    limit: int = 3,
) -> Path:
    asset_dir = workspace / "assets" / f"job-{job_id}"
    asset_dir.mkdir(parents=True, exist_ok=True)
    scene_assets: List[SceneAsset] = []

    for scene in scenes:
        query = query_for_scene(scene)
        if scene.visual_strategy == "local":
            actual_path = write_local_scene_card(scene, asset_dir / f"scene_{scene.position:02d}_local_card.png")
            scene_assets.append(
                SceneAsset(
                    scene_position=scene.position,
                    provider="local",
                    asset_id=f"scene-{scene.position:02d}-card",
                    media_type="image",
                    width=1080,
                    height=1920,
                    duration=float(scene.duration),
                    local_path=str(actual_path),
                    source_url="local://video-factory/card",
                    creator="VideoFactory",
                    license_note=PROVIDER_LICENSE_NOTE["local"],
                    query=query,
                )
            )
            continue
        candidates = search_stock_assets(
            provider=provider,
            query=query,
            media_type=media_type,
            limit=limit,
        )
        if not candidates:
            raise RuntimeError(f"No {provider} {media_type} asset found for scene {scene.position}: {query}")
        last_error: Optional[RuntimeError] = None
        for candidate in candidates:
            local_path = asset_dir / local_filename(scene.position, candidate)
            try:
                actual_path = materialize_candidate(candidate, local_path)
            except RuntimeError as error:
                last_error = error
                continue
            scene_assets.append(
                SceneAsset(
                    scene_position=scene.position,
                    provider=candidate.provider,
                    asset_id=candidate.asset_id,
                    media_type=candidate.media_type,
                    width=candidate.width,
                    height=candidate.height,
                    duration=candidate.duration,
                    local_path=str(actual_path),
                    source_url=candidate.source_url,
                    creator=candidate.creator,
                    license_note=candidate.license_note,
                    query=candidate.query,
                )
            )
            break
        else:
            detail = f" Last error: {last_error}" if last_error else ""
            raise RuntimeError(f"No downloadable {provider} {media_type} asset found for scene {scene.position}: {query}.{detail}")

    return write_asset_plan(default_asset_plan_path(workspace, job_id), job_id, scene_assets)


def search_stock_assets(
    provider: str,
    query: str,
    media_type: str = "video",
    limit: int = 3,
    opener: Optional[Callable] = None,
    environ: Optional[dict] = None,
) -> List[StockAssetCandidate]:
    provider = provider.lower()
    media_type = media_type.lower()
    if provider == "mock":
        return mock_asset_candidates(query, media_type, limit)
    if provider == "pexels":
        return search_pexels(query, media_type, limit, opener=opener, environ=environ)
    if provider == "pixabay":
        return search_pixabay(query, media_type, limit, opener=opener, environ=environ)
    raise ValueError(f"Unsupported asset provider: {provider}")


def search_pexels(
    query: str,
    media_type: str,
    limit: int,
    opener: Optional[Callable] = None,
    environ: Optional[dict] = None,
) -> List[StockAssetCandidate]:
    key = provider_key("pexels", environ)
    if media_type == "video":
        url = "https://api.pexels.com/videos/search?" + urllib.parse.urlencode(
            {
                "query": query,
                "orientation": "portrait",
                "per_page": limit,
            }
        )
    elif media_type == "image":
        url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode(
            {
                "query": query,
                "orientation": "portrait",
                "per_page": limit,
            }
        )
    else:
        raise ValueError(f"Unsupported media_type for Pexels: {media_type}")
    request = urllib.request.Request(url, headers=api_headers({"Authorization": key}))
    payload = fetch_json(request, opener)
    if media_type == "video":
        return normalize_pexels_videos(payload, query, limit)
    return normalize_pexels_images(payload, query, limit)


def search_pixabay(
    query: str,
    media_type: str,
    limit: int,
    opener: Optional[Callable] = None,
    environ: Optional[dict] = None,
) -> List[StockAssetCandidate]:
    key = provider_key("pixabay", environ)
    if media_type == "video":
        url = "https://pixabay.com/api/videos/?" + urllib.parse.urlencode(
            {
                "key": key,
                "q": query,
                "orientation": "vertical",
                "per_page": limit,
                "safesearch": "true",
            }
        )
    elif media_type == "image":
        url = "https://pixabay.com/api/?" + urllib.parse.urlencode(
            {
                "key": key,
                "q": query,
                "orientation": "vertical",
                "image_type": "photo",
                "per_page": limit,
                "safesearch": "true",
            }
        )
    else:
        raise ValueError(f"Unsupported media_type for Pixabay: {media_type}")
    payload = fetch_json(urllib.request.Request(url, headers=api_headers()), opener)
    if media_type == "video":
        return normalize_pixabay_videos(payload, query, limit)
    return normalize_pixabay_images(payload, query, limit)


def normalize_pexels_videos(payload: dict, query: str, limit: int) -> List[StockAssetCandidate]:
    candidates = []
    for item in payload.get("videos", []):
        best_file = best_media_file(item.get("video_files", []))
        if not best_file:
            continue
        width = int(best_file.get("width") or item.get("width") or 0)
        height = int(best_file.get("height") or item.get("height") or 0)
        candidates.append(
            StockAssetCandidate(
                provider="pexels",
                asset_id=str(item.get("id", "")),
                media_type="video",
                width=width,
                height=height,
                duration=float(item.get("duration") or 0),
                preview_url=str(item.get("image") or ""),
                download_url=str(best_file.get("link") or ""),
                source_url=str(item.get("url") or ""),
                creator=str(item.get("user", {}).get("name") or ""),
                license_note=PROVIDER_LICENSE_NOTE["pexels"],
                query=query,
                score=quality_score(width, height, float(item.get("duration") or 0)),
            )
        )
    return sorted(candidates, key=lambda candidate: candidate.score, reverse=True)[:limit]


def normalize_pexels_images(payload: dict, query: str, limit: int) -> List[StockAssetCandidate]:
    candidates = []
    for item in payload.get("photos", []):
        src = item.get("src", {})
        width = int(item.get("width") or 0)
        height = int(item.get("height") or 0)
        candidates.append(
            StockAssetCandidate(
                provider="pexels",
                asset_id=str(item.get("id", "")),
                media_type="image",
                width=width,
                height=height,
                duration=0,
                preview_url=str(src.get("medium") or ""),
                download_url=str(src.get("large2x") or src.get("original") or ""),
                source_url=str(item.get("url") or ""),
                creator=str(item.get("photographer") or ""),
                license_note=PROVIDER_LICENSE_NOTE["pexels"],
                query=query,
                score=quality_score(width, height, 0),
            )
        )
    return sorted(candidates, key=lambda candidate: candidate.score, reverse=True)[:limit]


def normalize_pixabay_videos(payload: dict, query: str, limit: int) -> List[StockAssetCandidate]:
    candidates = []
    for item in payload.get("hits", []):
        best_file = best_pixabay_video(item.get("videos", {}))
        if not best_file:
            continue
        width = int(best_file.get("width") or 0)
        height = int(best_file.get("height") or 0)
        candidates.append(
            StockAssetCandidate(
                provider="pixabay",
                asset_id=str(item.get("id", "")),
                media_type="video",
                width=width,
                height=height,
                duration=float(item.get("duration") or 0),
                preview_url=str(item.get("picture_id") or ""),
                download_url=str(best_file.get("url") or ""),
                source_url=str(item.get("pageURL") or ""),
                creator=str(item.get("user") or ""),
                license_note=PROVIDER_LICENSE_NOTE["pixabay"],
                query=query,
                score=quality_score(width, height, float(item.get("duration") or 0)),
            )
        )
    return sorted(candidates, key=lambda candidate: candidate.score, reverse=True)[:limit]


def normalize_pixabay_images(payload: dict, query: str, limit: int) -> List[StockAssetCandidate]:
    candidates = []
    for item in payload.get("hits", []):
        width = int(item.get("imageWidth") or 0)
        height = int(item.get("imageHeight") or 0)
        candidates.append(
            StockAssetCandidate(
                provider="pixabay",
                asset_id=str(item.get("id", "")),
                media_type="image",
                width=width,
                height=height,
                duration=0,
                preview_url=str(item.get("previewURL") or ""),
                download_url=str(item.get("largeImageURL") or item.get("webformatURL") or ""),
                source_url=str(item.get("pageURL") or ""),
                creator=str(item.get("user") or ""),
                license_note=PROVIDER_LICENSE_NOTE["pixabay"],
                query=query,
                score=quality_score(width, height, 0),
            )
        )
    return sorted(candidates, key=lambda candidate: candidate.score, reverse=True)[:limit]


def mock_asset_candidates(query: str, media_type: str, limit: int) -> List[StockAssetCandidate]:
    normalized_media_type = "image" if media_type not in {"image", "video"} else media_type
    return [
        StockAssetCandidate(
            provider="mock",
            asset_id=f"mock-{safe_slug(query)}-{index + 1}",
            media_type=normalized_media_type,
            width=1080,
            height=1920,
            duration=12,
            preview_url=f"mock://preview/{safe_slug(query)}",
            download_url=f"mock://asset/{safe_slug(query)}",
            source_url=f"mock://source/{safe_slug(query)}",
            creator="VideoFactory",
            license_note=PROVIDER_LICENSE_NOTE["mock"],
            query=query,
            score=100 - index,
        )
        for index in range(limit)
    ]


def local_card_candidate(scene: Scene, query: str) -> StockAssetCandidate:
    return StockAssetCandidate(
        provider="local",
        asset_id=f"scene-{scene.position:02d}-card",
        media_type="image",
        width=1080,
        height=1920,
        duration=float(scene.duration),
        preview_url=f"local://video-factory/card/{scene.position}",
        download_url=f"local://video-factory/card/{scene.position}",
        source_url="local://video-factory/card",
        creator="VideoFactory",
        license_note=PROVIDER_LICENSE_NOTE["local"],
        query=query,
        score=1000,
    )


def write_asset_plan(path: Path, job_id: int, scene_assets: Iterable[SceneAsset]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "job_id": job_id,
        "created_at": utc_now(),
        "scene_assets": [asdict(asset) for asset in scene_assets],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def load_asset_plan(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def candidate_to_dict(candidate: StockAssetCandidate) -> dict:
    return asdict(candidate)


def query_for_scene(scene: Scene) -> str:
    visual_query = english_query_from_visual_prompt(scene.visual_prompt)
    if visual_query:
        return visual_query
    for term in scene.search_terms:
        cleaned_term = english_query_from_visual_prompt(term)
        if cleaned_term:
            return cleaned_term
    for term in scene.search_terms:
        if term.strip():
            return term.strip()[:100]
    return scene.visual_prompt.strip()


def provider_key(provider: str, environ: Optional[dict] = None) -> str:
    env = os.environ if environ is None else environ
    env_name = PROVIDER_KEY_ENV[provider]
    key = str(env.get(env_name, "")).strip()
    if not key:
        raise MissingProviderKey(f"{env_name} is required for {provider} asset search.")
    return key


def fetch_json(request: urllib.request.Request, opener: Optional[Callable] = None) -> dict:
    active_opener = opener or urllib.request.urlopen
    try:
        with active_opener(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"Provider request failed with HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Provider request failed: {error}") from error


def materialize_candidate(candidate: StockAssetCandidate, local_path: Path) -> Path:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    if candidate.download_url.startswith("mock://"):
        return write_mock_image(candidate, local_path)
    request = urllib.request.Request(candidate.download_url, headers=download_headers(candidate.source_url))
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content_length = int(response.headers.get("Content-Length") or 0)
            if content_length > MAX_ASSET_DOWNLOAD_BYTES:
                raise RuntimeError(
                    f"Asset download is too large ({content_length} bytes) for {candidate.provider}:{candidate.asset_id}"
                )
            write_response_body(response, local_path, MAX_ASSET_DOWNLOAD_BYTES)
    except HTTPError as error:
        raise RuntimeError(
            f"Asset download failed with HTTP {error.code} for {candidate.provider}:{candidate.asset_id}"
        ) from error
    except URLError as error:
        raise RuntimeError(f"Asset download failed for {candidate.provider}:{candidate.asset_id}: {error}") from error
    return local_path


def write_response_body(response, local_path: Path, max_bytes: int) -> None:
    downloaded = 0
    try:
        with local_path.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                downloaded += len(chunk)
                if downloaded > max_bytes:
                    raise RuntimeError(f"Asset download exceeded {max_bytes} bytes: {local_path}")
                output.write(chunk)
    except Exception:
        local_path.unlink(missing_ok=True)
        raise


def write_mock_image(candidate: StockAssetCandidate, local_path: Path) -> Path:
    try:
        from PIL import Image, ImageDraw
    except ImportError as error:
        raise RuntimeError("Pillow is required to create mock assets.") from error

    local_path = local_path.with_suffix(".png")
    image = Image.new("RGB", (1080, 1920), "#0f172a")
    draw = ImageDraw.Draw(image)
    for y in range(0, 1920, 12):
        ratio = y / 1920
        color = (
            int(18 + 45 * ratio),
            int(30 + 95 * ratio),
            int(50 + 115 * ratio),
        )
        draw.rectangle((0, y, 1080, y + 12), fill=color)
    draw.polygon([(0, 1180), (1080, 920), (1080, 1920), (0, 1920)], fill="#164e63")
    draw.polygon([(0, 1440), (1080, 1260), (1080, 1920), (0, 1920)], fill="#155e75")
    draw.rectangle((0, 0, 1080, 1920), outline="#0f172a", width=28)
    image.save(local_path)
    return local_path


def write_local_scene_card(scene: Scene, local_path: Path) -> Path:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Pillow is required to create local scene cards.") from error

    local_path = local_path.with_suffix(".png")
    width, height = 1080, 1920
    style = local_card_style(scene.position)
    title, items, kicker = local_card_content(scene)
    image = Image.new("RGB", (width, height), style["background"])
    draw = ImageDraw.Draw(image)

    draw_editorial_background(draw, width, height, style)
    label_font = local_card_font(ImageFont, 34)
    title_font = local_card_font(ImageFont, 86)
    kicker_font = local_card_font(ImageFont, 42)
    item_font = local_card_font(ImageFont, local_card_item_size(items))
    small_font = local_card_font(ImageFont, 28)
    margin = 86

    draw.text((margin, 90), "生活避坑清单", font=small_font, fill=style["muted"])
    draw.text((width - margin - 118, 84), f"{scene.position:02d}", font=label_font, fill=style["accent"])
    draw.line((margin, 158, width - margin, 158), fill=style["rule"], width=3)
    draw.text((margin, 260), kicker, font=kicker_font, fill=style["accent"])
    draw_wrapped_text(
        draw,
        title,
        (margin, 330),
        title_font,
        style["ink"],
        width - margin * 2,
        line_spacing=20,
    )

    y = 760
    for index, item in enumerate(items[:4], start=1):
        number = f"{index:02d}"
        draw.text((margin, y + 6), number, font=label_font, fill=style["accent"])
        y = draw_wrapped_text(
            draw,
            item,
            (margin + 118, y),
            item_font,
            style["ink"],
            width - margin * 2 - 118,
            line_spacing=16,
        )
        draw.line((margin + 118, y + 20, width - margin, y + 20), fill=style["rule"], width=2)
        y += 74

    draw.text((margin, height - 150), "少一点临场发挥，多一个提前规则。", font=small_font, fill=style["muted"])
    image.save(local_path)
    return local_path


def local_card_style(scene_position: int) -> dict:
    styles = [
        {
            "background": "#f6f8fb",
            "ink": "#111827",
            "muted": "#64748b",
            "accent": "#dc2626",
            "rule": "#cbd5e1",
        },
        {
            "background": "#101828",
            "ink": "#f8fafc",
            "muted": "#94a3b8",
            "accent": "#facc15",
            "rule": "#334155",
        },
        {
            "background": "#f8fafc",
            "ink": "#0f172a",
            "muted": "#475569",
            "accent": "#0f766e",
            "rule": "#cbd5e1",
        },
    ]
    return styles[scene_position % len(styles)]


def local_card_content(scene: Scene) -> tuple[str, list[str], str]:
    sentences = split_chinese_sentences(scene.narration)
    if scene.position == 2 or len(sentences) >= 3:
        return "先避开这 3 个坑", sentences[:3], "收藏清单"
    if "低成本提醒" in scene.narration or "道理" in scene.narration:
        return "真正有用的是提醒", ["别靠临场发挥", "提前放一个低成本提醒"], "反直觉"
    if "今天" in scene.narration or "一件事" in scene.narration:
        return "下次先停三秒", ["写下最像你的那个坑", "遇到时先停三秒", "再决定"], "马上能做"
    if "收藏" in scene.narration or "评论" in scene.narration:
        return "把这张清单留下", ["收藏备用", "评论区告诉我：你最想避开什么坑？"], "留给下次"
    return "记住这一句", sentences[:2] or [scene.narration], "关键提醒"


def split_chinese_sentences(text: str) -> list[str]:
    parts = [part.strip(" ；;。.") for part in re.split(r"[。；;]", text) if part.strip(" ；;。.")]
    return parts or [text.strip()]


def draw_editorial_background(draw, width: int, height: int, style: dict) -> None:
    for y in range(0, height, 240):
        draw.line((0, y, width, y), fill=style["rule"], width=1)
    draw.rectangle((0, height - 300, width, height), fill=style["background"])
    draw.line((0, height - 300, width, height - 300), fill=style["rule"], width=2)


def draw_wrapped_text(draw, text: str, position: tuple[int, int], font, fill: str, max_width: int, line_spacing: int) -> int:
    x, y = position
    for line in wrap_text_by_pixels(draw, text, font, max_width):
        draw.text((x, y), line, font=font, fill=fill)
        box = draw.textbbox((x, y), line, font=font)
        y += box[3] - box[1] + line_spacing
    return y


def local_card_item_size(items: list[str]) -> int:
    longest = max((len(item) for item in items), default=0)
    if longest >= 24:
        return 48
    if longest >= 18:
        return 52
    return 58


def wrap_text_by_pixels(draw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for char in text:
        candidate = current + char
        box = draw.textbbox((0, 0), candidate, font=font)
        if current and box[2] - box[0] > max_width:
            lines.append(current)
            current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def local_card_font(ImageFont, size: int):
    for candidate in [
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/STHeiti Light.ttc"),
        Path("/Library/Fonts/Arial Unicode.ttf"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    ]:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def local_filename(scene_position: int, candidate: StockAssetCandidate) -> str:
    return f"scene_{scene_position:02d}_{candidate.provider}_{safe_slug(candidate.asset_id)}{extension_for(candidate)}"


def extension_for(candidate: StockAssetCandidate) -> str:
    parsed = urllib.parse.urlparse(candidate.download_url)
    suffix = Path(parsed.path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov"}:
        return suffix
    if candidate.media_type == "video":
        return ".mp4"
    return ".png"


def best_media_file(files: Iterable[dict]) -> Optional[dict]:
    usable = [item for item in files if item.get("link")]
    if not usable:
        return None
    return sorted(
        usable,
        key=lambda item: media_file_score(
            int(item.get("width") or 0),
            int(item.get("height") or 0),
            int(item.get("size") or 0),
        ),
        reverse=True,
    )[0]


def best_pixabay_video(videos: dict) -> Optional[dict]:
    usable = [value for value in videos.values() if isinstance(value, dict) and value.get("url")]
    if not usable:
        return None
    return sorted(
        usable,
        key=lambda item: media_file_score(
            int(item.get("width") or 0),
            int(item.get("height") or 0),
            int(item.get("size") or 0),
        ),
        reverse=True,
    )[0]


def api_headers(extra: Optional[dict] = None) -> dict:
    headers = {
        "Accept": "application/json",
        "User-Agent": "VideoFactory/0.1 (https://github.com/yaoziyaoguai/vedio-factory)",
    }
    if extra:
        headers.update(extra)
    return headers


def download_headers(source_url: str = "") -> dict:
    headers = {
        "Accept": "video/mp4,image/*,*/*",
        "User-Agent": "VideoFactory/0.1 (https://github.com/yaoziyaoguai/vedio-factory)",
    }
    if source_url:
        headers["Referer"] = source_url
    return headers


def english_query_from_visual_prompt(value: str) -> str:
    before_topic = value.split("topic:", 1)[0]
    ascii_parts = re.findall(r"[A-Za-z][A-Za-z0-9 ,'-]{2,}", before_topic)
    query = " ".join(part.strip(" ,") for part in ascii_parts if part.strip(" ,"))
    return " ".join(query.split())[:100]


def media_file_score(width: int, height: int, size: int) -> int:
    if width <= 0 or height <= 0:
        return 0
    orientation_bonus = 1_000_000 if height >= width else 0
    minimum_bonus = 500_000 if width >= 720 and height >= 1280 else 0
    target_penalty = abs(width - 1080) + abs(height - 1920)
    oversized_penalty = max(0, size - 4_000_000) // 1000
    return orientation_bonus + minimum_bonus - target_penalty - oversized_penalty


def quality_score(width: int, height: int, duration: float) -> int:
    orientation_bonus = 10000 if height >= width else 0
    duration_bonus = 1000 if 4 <= duration <= 30 else 0
    return orientation_bonus + duration_bonus + width * height


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower()).strip("-")
    return slug[:64] or "asset"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
