import json
import os
import re
import time
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
MAX_ASSET_DOWNLOAD_SECONDS = 45
PROVIDER_REQUEST_ATTEMPTS = 3
ASSET_DOWNLOAD_ATTEMPTS = 2
NETWORK_RETRY_DELAY_SECONDS = 0.25

TOPIC_SHOT_QUERIES = (
    (("下班", "上班", "职场", "工作", "加班"), (
        "asian office worker tired after work",
        "asian office worker commute home evening",
        "asian person quiet reflection night",
        "asian person journaling at home",
    )),
    (("篮球", "男篮", "女篮", "冠军", "世锦赛"), (
        "asian athlete basketball close up",
        "basketball team training gym",
        "athlete focused before game",
        "basketball coach writing strategy",
    )),
    (("台风", "天气", "暴雨", "高温", "降温"), (
        "storm clouds city close up",
        "asian city rain street",
        "weather radar storm map",
        "person checking weather phone",
    )),
    (("经济", "数据", "消费", "就业", "房价"), (
        "asian city business people close up",
        "people shopping asian city",
        "financial data screen close up",
        "person planning budget notebook",
    )),
    (("开学", "学生", "学校", "考试", "教育"), (
        "asian student school close up",
        "students walking campus",
        "student studying alone library",
        "student writing study plan",
    )),
    (("乡村", "农村", "留守", "回家"), (
        "asian family reunion close up",
        "chinese rural village daily life",
        "quiet village home evening",
        "family preparing dinner home",
    )),
    (("美食", "餐厅", "面", "小吃", "咖啡"), (
        "asian street food close up",
        "chinese restaurant daily life",
        "chef preparing food detail",
        "person writing food review",
    )),
    (("睡眠", "失眠", "睡前", "熬夜", "疲惫"), (
        "asian person tired close up",
        "quiet bedroom night routine",
        "person reflecting by window night",
        "person writing bedtime journal",
    )),
)

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
        if provider == "local" or scene.visual_strategy == "local":
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
        if provider == "local" or scene.visual_strategy == "local":
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


def prepare_routed_scene_assets(
    job_id: int,
    scenes: Iterable[Scene],
    workspace: Path,
    director_plan: dict,
    media_type: str = "video",
    limit: int = 3,
) -> Path:
    asset_dir = workspace / "assets" / f"job-{job_id}"
    asset_dir.mkdir(parents=True, exist_ok=True)
    shots = director_plan.get("shots")
    if not isinstance(shots, list):
        raise ValueError("Director plan shots must be an array")
    routes = {int(shot["scenePosition"]): shot for shot in shots if isinstance(shot, dict)}
    scene_assets: List[SceneAsset] = []
    routing_records = []

    for scene in scenes:
        route = routes.get(scene.position)
        if route is None:
            raise ValueError(f"Director plan is missing scene {scene.position}")
        preferred_id = required_route_text(route, "preferredProviderId", scene.position)
        alternatives = route.get("alternativeProviderIds", [])
        if not isinstance(alternatives, list) or any(not isinstance(item, str) or not item.strip() for item in alternatives):
            raise ValueError(f"Director plan alternatives are invalid for scene {scene.position}")
        director_query = required_route_text(route, "query", scene.position)
        provider_ids = [preferred_id, *[item.strip() for item in alternatives if item.strip() != preferred_id]]
        actual_asset = None
        actual_provider_id = None
        generation_pending = is_generative_provider(preferred_id)
        errors = []

        for provider_id in provider_ids:
            try:
                if is_generative_provider(provider_id):
                    actual_asset = materialize_local_scene(scene, director_query, asset_dir)
                    actual_provider_id = "local-editorial-v1"
                    break
                provider = stock_provider_name(provider_id)
                if provider == "local":
                    actual_asset = materialize_local_scene(scene, director_query, asset_dir)
                    actual_provider_id = provider_id
                    break
                stock_query = resolve_director_stock_query(scene, director_query)
                candidates = search_stock_assets(provider=provider, query=stock_query, media_type=media_type, limit=limit)
                actual_asset = materialize_first_candidate(scene, candidates, asset_dir)
                if actual_asset is not None:
                    actual_provider_id = provider_id
                    break
                errors.append(f"{provider_id}: no downloadable candidates")
            except (RuntimeError, ValueError) as error:
                errors.append(f"{provider_id}: {error}")

        if actual_asset is None or actual_provider_id is None:
            raise RuntimeError(f"No director-selected asset could be prepared for scene {scene.position}: {'; '.join(errors)}")
        scene_assets.append(actual_asset)
        routing_records.append({
            "scene_position": scene.position,
            "preferred_provider_id": preferred_id,
            "actual_provider_id": actual_provider_id,
            "actual_provider": actual_asset.provider,
            "fallback_used": actual_provider_id != preferred_id and not generation_pending,
            "generation_pending": generation_pending,
            "director_query": director_query,
            "query": actual_asset.query,
            "rationale": str(route.get("rationale") or ""),
        })

    plan_path = write_asset_plan(default_asset_plan_path(workspace, job_id), job_id, scene_assets)
    payload = load_asset_plan(plan_path)
    payload["director_routing"] = routing_records
    payload["director_plan_version"] = str(director_plan.get("version") or "video-factory/director-plan-v1")
    plan_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return plan_path


def materialize_local_scene(scene: Scene, query: str, asset_dir: Path) -> SceneAsset:
    actual_path = write_local_scene_card(scene, asset_dir / f"scene_{scene.position:02d}_local_card.png")
    return SceneAsset(
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


def materialize_first_candidate(
    scene: Scene,
    candidates: Iterable[StockAssetCandidate],
    asset_dir: Path,
) -> Optional[SceneAsset]:
    for candidate in candidates:
        try:
            actual_path = materialize_candidate(candidate, asset_dir / local_filename(scene.position, candidate))
        except RuntimeError:
            continue
        return SceneAsset(
            scene_position=scene.position,
            provider=candidate.provider,
            asset_id=candidate.asset_id,
            media_type=candidate.media_type,
            width=candidate.width,
            height=candidate.height,
            duration=scene.duration,
            local_path=str(actual_path),
            source_url=candidate.source_url,
            creator=candidate.creator,
            license_note=candidate.license_note,
            query=candidate.query,
        )
    return None


def stock_provider_name(provider_id: str) -> str:
    providers = {
        "local-editorial-v1": "local",
        "pexels-stock-v1": "pexels",
        "pixabay-stock-v1": "pixabay",
    }
    provider = providers.get(provider_id)
    if provider is None:
        raise ValueError(f"Unsupported director asset provider: {provider_id}")
    return provider


def is_generative_provider(provider_id: str) -> bool:
    return provider_id in {
        "seedream-image-v1",
        "seedance-video-v1",
        "wan-video-v1",
        "kling-video-v1",
        "hailuo-video-v1",
        "vidu-video-v1",
    }


def required_route_text(route: dict, field: str, scene_position: int) -> str:
    value = route.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Director plan {field} is invalid for scene {scene_position}")
    return value.strip()


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
    request_limit = max(limit, 3)
    if media_type == "video":
        url = "https://pixabay.com/api/videos/?" + urllib.parse.urlencode(
            {
                "key": key,
                "q": query,
                "orientation": "vertical",
                "per_page": request_limit,
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
                "per_page": request_limit,
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
    semantic_query = semantic_query_for_scene(scene)
    if semantic_query:
        return semantic_query
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


def resolve_director_stock_query(scene: Scene, director_query: str) -> str:
    contextual_scene = Scene(
        position=scene.position,
        narration=scene.narration,
        duration=scene.duration,
        visual_strategy=scene.visual_strategy,
        visual_prompt=director_query,
        search_terms=[*scene.search_terms, scene.visual_prompt, scene.narration],
    )
    semantic_query = semantic_query_for_scene(contextual_scene)
    if semantic_query:
        return semantic_query
    return english_query_from_visual_prompt(director_query) or query_for_scene(scene)


def semantic_query_for_scene(scene: Scene) -> str:
    source = " ".join([scene.visual_prompt, *scene.search_terms])
    lowered = source.lower()
    search_terms = {term.strip().lower() for term in scene.search_terms}
    shot_index = 0
    if any(marker in lowered for marker in ("daily life", "relatable problem")) or search_terms.intersection({"scene", "setting", "list"}):
        shot_index = 1
    elif any(marker in lowered for marker in ("conceptual", "hidden reason")) or search_terms.intersection({"insight", "mechanism", "turn", "explain"}):
        shot_index = 2
    elif any(marker in lowered for marker in ("taking notes", "practical takeaway")) or search_terms.intersection({"takeaway", "action", "tip"}):
        shot_index = 3
    for keywords, queries in TOPIC_SHOT_QUERIES:
        if any(keyword in source for keyword in keywords):
            return queries[shot_index]
    return ""


def provider_key(provider: str, environ: Optional[dict] = None) -> str:
    env = os.environ if environ is None else environ
    env_name = PROVIDER_KEY_ENV[provider]
    key = str(env.get(env_name, "")).strip()
    if not key:
        raise MissingProviderKey(f"{env_name} is required for {provider} asset search.")
    return key


def fetch_json(request: urllib.request.Request, opener: Optional[Callable] = None) -> dict:
    active_opener = opener or urllib.request.urlopen
    for attempt in range(1, PROVIDER_REQUEST_ATTEMPTS + 1):
        try:
            with active_opener(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"Provider request failed with HTTP {error.code}: {detail}") from error
        except (URLError, ConnectionError, TimeoutError) as error:
            if attempt == PROVIDER_REQUEST_ATTEMPTS:
                raise RuntimeError(
                    f"Provider request failed after {attempt} attempts: {type(error).__name__}"
                ) from error
            time.sleep(NETWORK_RETRY_DELAY_SECONDS * attempt)
    raise AssertionError("Provider request retry loop exited unexpectedly")


def materialize_candidate(candidate: StockAssetCandidate, local_path: Path) -> Path:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    if candidate.download_url.startswith("mock://"):
        return write_mock_image(candidate, local_path)
    request = urllib.request.Request(candidate.download_url, headers=download_headers(candidate.source_url))
    for attempt in range(1, ASSET_DOWNLOAD_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                content_length = int(response.headers.get("Content-Length") or 0)
                if content_length > MAX_ASSET_DOWNLOAD_BYTES:
                    raise RuntimeError(
                        f"Asset download is too large ({content_length} bytes) for {candidate.provider}:{candidate.asset_id}"
                    )
                write_response_body(response, local_path, MAX_ASSET_DOWNLOAD_BYTES)
            return local_path
        except HTTPError as error:
            raise RuntimeError(
                f"Asset download failed with HTTP {error.code} for {candidate.provider}:{candidate.asset_id}"
            ) from error
        except (URLError, ConnectionError, TimeoutError) as error:
            local_path.unlink(missing_ok=True)
            if attempt == ASSET_DOWNLOAD_ATTEMPTS:
                raise RuntimeError(
                    f"Asset download failed after {attempt} attempts for "
                    f"{candidate.provider}:{candidate.asset_id}: {type(error).__name__}"
                ) from error
            time.sleep(NETWORK_RETRY_DELAY_SECONDS * attempt)
    raise AssertionError("Asset download retry loop exited unexpectedly")


def write_response_body(
    response,
    local_path: Path,
    max_bytes: int,
    max_seconds: float = MAX_ASSET_DOWNLOAD_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    downloaded = 0
    started_at = clock()
    read_chunk = getattr(response, "read1", None) or response.read
    try:
        with local_path.open("wb") as output:
            while True:
                if clock() - started_at > max_seconds:
                    raise RuntimeError(f"Asset download timed out after {max_seconds:g}s: {local_path}")
                # read1 returns currently buffered bytes instead of waiting to fill a large chunk.
                chunk = read_chunk(64 * 1024)
                if clock() - started_at > max_seconds:
                    raise RuntimeError(f"Asset download timed out after {max_seconds:g}s: {local_path}")
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
    title_font = local_card_font(ImageFont, local_card_title_size(title))
    kicker_font = local_card_font(ImageFont, 42)
    item_font = local_card_font(ImageFont, local_card_item_size(items))
    small_font = local_card_font(ImageFont, 28)
    margin = 86

    draw.text((margin, 90), "视觉笔记", font=small_font, fill=style["muted"])
    draw.text((width - margin - 118, 84), f"{scene.position:02d}", font=label_font, fill=style["accent"])
    draw.line((margin, 158, width - margin, 158), fill=style["rule"], width=3)
    draw.text((margin, 260), kicker, font=kicker_font, fill=style["accent"])
    title_bottom = draw_wrapped_text(
        draw,
        title,
        (margin, 330),
        title_font,
        style["ink"],
        width - margin * 2 - 160,
        line_spacing=20,
    )

    y = max(720, title_bottom + 90)
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

    draw.text((margin, 1280), f"SCENE {scene.position:02d}  ·  {scene.duration:.1f}s", font=small_font, fill=style["muted"])
    image.save(local_path)
    return local_path


def local_card_style(scene_position: int) -> dict:
    styles = [
        {
            "background": "#f7f3ea",
            "surface": "#efe7d8",
            "ink": "#111827",
            "muted": "#6b6257",
            "accent": "#c3412f",
            "rule": "#d8cdbd",
        },
        {
            "background": "#f2f6f4",
            "surface": "#e2ede8",
            "ink": "#14211d",
            "muted": "#5b6f67",
            "accent": "#167d6a",
            "rule": "#c7d9d1",
        },
        {
            "background": "#f5f2f7",
            "surface": "#e9e2ee",
            "ink": "#211a27",
            "muted": "#706478",
            "accent": "#6b5aa6",
            "rule": "#d8cede",
        },
    ]
    return styles[(scene_position - 2) % len(styles)]


def local_card_content(scene: Scene) -> tuple[str, list[str], str]:
    clauses = split_chinese_clauses(scene.narration)
    while len(clauses) > 1 and clauses[0] in {"所以", "但是", "不过", "然后", "其实", "最后", "那么"}:
        clauses.pop(0)
    title = clauses[0] if clauses else scene.narration.strip()
    items = clauses[1:4]
    if not items:
        prompt_clauses = split_chinese_clauses(scene.visual_prompt)
        items = prompt_clauses[:2] or [scene.narration.strip()]
    return title, items, "镜头要点"


def split_chinese_sentences(text: str) -> list[str]:
    parts = [part.strip(" ；;。.") for part in re.split(r"[。；;]", text) if part.strip(" ；;。.")]
    return parts or [text.strip()]


def split_chinese_clauses(text: str) -> list[str]:
    parts = [part.strip(" ，,：:；;。！？!?") for part in re.split(r"[，,：:；;。！？!?]", text)]
    return [part for part in parts if part]


def draw_editorial_background(draw, width: int, height: int, style: dict) -> None:
    draw.rectangle((0, 0, 24, height), fill=style["accent"])
    draw.rectangle((760, 190, width, 560), fill=style["surface"])
    draw.arc((690, 120, 1190, 620), 95, 265, fill=style["accent"], width=8)
    for y in range(158, 1380, 244):
        draw.line((86, y, width - 86, y), fill=style["rule"], width=1)
    draw.line((86, 1345, width - 86, 1345), fill=style["rule"], width=2)


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


def local_card_title_size(title: str) -> int:
    if len(title) >= 11:
        return 62
    if len(title) >= 8:
        return 70
    return 86


def wrap_text_by_pixels(draw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for char in text:
        candidate = current + char
        box = draw.textbbox((0, 0), candidate, font=font)
        if current and box[2] - box[0] > max_width:
            if char in "，。！？；：、）】》」』…,.!?;:":
                lines.append(candidate)
                current = ""
            else:
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
        Path("/usr/share/fonts/noto/NotoSansCJK-Regular.ttc"),
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
