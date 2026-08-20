import json
import os
import re
import urllib.parse
import urllib.request
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, List, Optional

from .domain import Scene, SceneAsset, StockAssetCandidate


PROVIDER_KEY_ENV = {
    "pexels": "PEXELS_API_KEY",
    "pixabay": "PIXABAY_API_KEY",
}

PROVIDER_LICENSE_NOTE = {
    "pexels": "Pexels free stock license; review current provider license before publishing.",
    "pixabay": "Pixabay Content License; cache API responses for 24h and avoid systematic mass downloads.",
    "mock": "Generated local placeholder for tests and visual pipeline checks; not a real stock asset.",
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
        candidates = search_stock_assets(
            provider=provider,
            query=query,
            media_type=media_type,
            limit=limit,
        )
        if not candidates:
            raise RuntimeError(f"No {provider} {media_type} asset found for scene {scene.position}: {query}")
        candidate = candidates[0]
        local_path = asset_dir / local_filename(scene.position, candidate)
        actual_path = materialize_candidate(candidate, local_path)
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
    request = urllib.request.Request(url, headers={"Authorization": key})
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
    payload = fetch_json(urllib.request.Request(url), opener)
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
    for term in scene.search_terms:
        if term.strip():
            return term.strip()
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
    with active_opener(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def materialize_candidate(candidate: StockAssetCandidate, local_path: Path) -> Path:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    if candidate.download_url.startswith("mock://"):
        return write_mock_image(candidate, local_path)
    with urllib.request.urlopen(candidate.download_url, timeout=60) as response:
        local_path.write_bytes(response.read())
    return local_path


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
        key=lambda item: quality_score(
            int(item.get("width") or 0),
            int(item.get("height") or 0),
            0,
        ),
        reverse=True,
    )[0]


def best_pixabay_video(videos: dict) -> Optional[dict]:
    usable = [value for value in videos.values() if isinstance(value, dict) and value.get("url")]
    if not usable:
        return None
    return sorted(
        usable,
        key=lambda item: quality_score(
            int(item.get("width") or 0),
            int(item.get("height") or 0),
            0,
        ),
        reverse=True,
    )[0]


def quality_score(width: int, height: int, duration: float) -> int:
    orientation_bonus = 10000 if height >= width else 0
    duration_bonus = 1000 if 4 <= duration <= 30 else 0
    return orientation_bonus + duration_bonus + width * height


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower()).strip("-")
    return slug[:64] or "asset"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
