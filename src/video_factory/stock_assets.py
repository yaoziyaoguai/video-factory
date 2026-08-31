import ipaddress
import http.client
import json
import os
import re
import socket
import ssl
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
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
ASSET_PREPARE_WORKERS = 3
NETWORK_RETRY_DELAY_SECONDS = 0.25
ASSET_REDIRECT_LIMIT = 5
MIN_MODEL_SEMANTIC_SCORE = 40
UNSAFE_IPV6_NETWORKS = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
    ipaddress.ip_network("fec0::/10"),
)

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


@dataclass(frozen=True)
class RankedCandidatePreference:
    provider: str
    asset_id: str
    semantic_score: int
    locked: bool
    enforce_score: bool


def default_asset_plan_path(workspace: Path, job_id: int) -> Path:
    return workspace / "assets" / f"job-{job_id}" / "asset_plan.json"


def default_asset_search_report_path(workspace: Path, job_id: int) -> Path:
    return workspace / "assets" / f"job-{job_id}" / "asset_candidates.json"


def default_asset_candidate_inventory_path(workspace: Path, job_id: int) -> Path:
    return workspace / "assets" / f"job-{job_id}" / "asset_candidate_inventory.private.json"


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
                "candidates": [candidate_to_public_dict(candidate) for candidate in candidates],
            }
        )
    output = default_asset_search_report_path(workspace, job_id)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def search_routed_scene_asset_candidates(
    job_id: int,
    scenes: Iterable[Scene],
    workspace: Path,
    director_plan: dict,
    media_type: str = "video",
    limit: int = 6,
) -> tuple[Path, Path]:
    shots = director_plan.get("shots")
    if not isinstance(shots, list):
        raise ValueError("Director plan shots must be an array")
    routes = {int(shot["scenePosition"]): shot for shot in shots if isinstance(shot, dict)}
    report = {
        "version": "video-factory/asset-candidates-v1",
        "job_id": job_id,
        "provider": "ai-router",
        "media_type": media_type,
        "created_at": utc_now(),
        "scene_candidates": [],
    }
    inventory = {
        "version": "video-factory/asset-candidate-inventory-v1",
        "job_id": job_id,
        "created_at": report["created_at"],
        "scene_candidates": [],
    }
    for scene in scenes:
        route = routes.get(scene.position)
        if route is None:
            raise ValueError(f"Director plan is missing scene {scene.position}")
        preferred_id = required_route_text(route, "preferredProviderId", scene.position)
        alternatives = route.get("alternativeProviderIds", [])
        if not isinstance(alternatives, list) or any(not isinstance(item, str) or not item.strip() for item in alternatives):
            raise ValueError(f"Director plan alternatives are invalid for scene {scene.position}")
        director_query = required_route_text(route, "query", scene.position)
        delivery_type = str(route.get("deliveryType") or "").strip()
        route_media_type = {
            "stock_image": "image",
            "generated_image": "image",
            "stock_video": "video",
            "generated_video": "video",
        }.get(delivery_type, media_type)
        provider_ids = [preferred_id, *[item.strip() for item in alternatives if item.strip() != preferred_id]]
        public_candidates = []
        private_candidates = []
        search_errors = []
        for provider_id in provider_ids:
            if is_generative_provider(provider_id) or stock_provider_name(provider_id) == "local":
                continue
            provider = stock_provider_name(provider_id)
            stock_query = resolve_director_stock_query(scene, director_query)
            try:
                candidates = search_stock_assets(provider=provider, query=stock_query, media_type=route_media_type, limit=limit)
            except (RuntimeError, ValueError) as error:
                search_errors.append({"provider_id": provider_id, "message": str(error)[:500]})
                continue
            public_candidates.extend(candidate_to_public_dict(candidate, provider_id=provider_id) for candidate in candidates)
            private_candidates.extend(candidate_to_private_dict(candidate, provider_id) for candidate in candidates)
        report["scene_candidates"].append({
            "scene_position": scene.position,
            "intent": {
                "narrative_role": str(route.get("narrativeRole") or ""),
                "subject": str(route.get("subject") or ""),
                "environment": str(route.get("environment") or ""),
                "visible_action": str(route.get("visibleAction") or ""),
                "shot_size": str(route.get("shotSize") or ""),
                "camera": str(route.get("camera") or ""),
                "lighting": str(route.get("lighting") or ""),
                "generation_prompt": str(route.get("generationPrompt") or ""),
                "temporal_beats": " | ".join(str(beat) for beat in (route.get("temporalBeats") or []) if str(beat).strip()),
                "continuity_note": str(route.get("continuityNote") or ""),
            },
            "query": director_query,
            "candidates": public_candidates,
            "search_errors": search_errors,
        })
        inventory["scene_candidates"].append({
            "scene_position": scene.position,
            "candidates": private_candidates,
        })
    output = default_asset_search_report_path(workspace, job_id)
    inventory_output = default_asset_candidate_inventory_path(workspace, job_id)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    inventory_output.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output, inventory_output


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
    limit: int = 6,
    candidate_ranking: Optional[dict] = None,
    candidate_inventory: Optional[dict] = None,
) -> Path:
    asset_dir = workspace / "assets" / f"job-{job_id}"
    asset_dir.mkdir(parents=True, exist_ok=True)
    scene_list = list(scenes)
    shots = director_plan.get("shots")
    if not isinstance(shots, list):
        raise ValueError("Director plan shots must be an array")
    routes = {int(shot["scenePosition"]): shot for shot in shots if isinstance(shot, dict)}
    ranking_by_scene = ranking_candidate_ids_by_scene(candidate_ranking)
    inventory_by_scene = inventory_candidates_by_scene_provider(candidate_inventory)
    claimed_stock_assets: set[tuple[str, str]] = set()
    claim_lock = Lock()

    def claim_candidate(candidate: StockAssetCandidate) -> bool:
        key = (candidate.provider, candidate.asset_id)
        with claim_lock:
            if key in claimed_stock_assets:
                return False
            claimed_stock_assets.add(key)
            return True

    def release_candidate(candidate: StockAssetCandidate) -> None:
        with claim_lock:
            claimed_stock_assets.discard((candidate.provider, candidate.asset_id))

    def prepare_scene(scene: Scene):
        route = routes.get(scene.position)
        if route is None:
            raise ValueError(f"Director plan is missing scene {scene.position}")
        preferred_id = required_route_text(route, "preferredProviderId", scene.position)
        alternatives = route.get("alternativeProviderIds", [])
        if not isinstance(alternatives, list) or any(not isinstance(item, str) or not item.strip() for item in alternatives):
            raise ValueError(f"Director plan alternatives are invalid for scene {scene.position}")
        director_query = required_route_text(route, "query", scene.position)
        delivery_type = str(route.get("deliveryType") or "").strip()
        route_media_type = {
            "stock_image": "image",
            "generated_image": "image",
            "stock_video": "video",
            "generated_video": "video",
        }.get(delivery_type, media_type)
        provider_ids = [preferred_id, *[item.strip() for item in alternatives if item.strip() != preferred_id]]
        actual_asset = None
        actual_provider_id = None
        generation_pending = is_generative_provider(preferred_id)
        errors = []
        materialization_notes: list[str] = []
        duplicate_options: list[tuple[str, List[StockAssetCandidate]]] = []
        recognized_stock_route = False

        for provider_id in provider_ids:
            try:
                if is_generative_provider(provider_id):
                    actual_asset = materialize_local_scene(scene, director_query, asset_dir, route)
                    actual_provider_id = "local-editorial-v1"
                    break
                provider = stock_provider_name(provider_id)
                if provider == "local":
                    actual_asset = materialize_local_scene(scene, director_query, asset_dir, route)
                    actual_provider_id = provider_id
                    break
                recognized_stock_route = True
                stock_query = resolve_director_stock_query(scene, director_query)
                discovered_candidates = (
                    list(inventory_by_scene.get(scene.position, {}).get(provider_id, []))
                    if candidate_inventory is not None
                    else search_stock_assets(provider=provider, query=stock_query, media_type=route_media_type, limit=limit)
                )
                candidates = reorder_candidates(discovered_candidates, ranking_by_scene.get(scene.position, []))
                if discovered_candidates and not candidates:
                    materialization_notes.append(
                        f"{provider_id}: semantic review rejected {len(discovered_candidates)} candidate(s)"
                    )
                duplicate_options.append((provider_id, candidates))
                actual_asset = materialize_first_candidate(
                    scene,
                    candidates,
                    asset_dir,
                    claim=claim_candidate,
                    release=release_candidate,
                    failures=materialization_notes,
                )
                if actual_asset is not None:
                    actual_provider_id = provider_id
                    break
                errors.append(f"{provider_id}: no downloadable candidates")
            except (RuntimeError, ValueError) as error:
                errors.append(f"{provider_id}: {error}")

        if actual_asset is None:
            for provider_id, candidates in duplicate_options:
                actual_asset = materialize_first_candidate(
                    scene,
                    candidates,
                    asset_dir,
                    failures=materialization_notes,
                )
                if actual_asset is not None:
                    actual_provider_id = provider_id
                    break

        if actual_asset is None and recognized_stock_route:
            actual_asset = materialize_local_scene(scene, director_query, asset_dir, route)
            actual_provider_id = "local-editorial-v1"
            materialization_notes.append(
                "local-editorial-v1: fallback used because reviewed stock candidates were unavailable"
            )

        if actual_asset is None or actual_provider_id is None:
            raise RuntimeError(f"No director-selected asset could be prepared for scene {scene.position}: {'; '.join(errors)}")
        candidate_shortlist = []
        seen_candidates: set[tuple[str, str]] = set()
        for provider_id, candidates in duplicate_options:
            for candidate in candidates:
                key = (candidate.provider, candidate.asset_id)
                if key in seen_candidates:
                    continue
                seen_candidates.add(key)
                candidate_shortlist.append(candidate_to_public_dict(
                    candidate,
                    provider_id=provider_id,
                    selected=(
                        candidate.provider == actual_asset.provider
                        and candidate.asset_id == actual_asset.asset_id
                    ),
                ))

        routing_record = {
            "scene_position": scene.position,
            "preferred_provider_id": preferred_id,
            "actual_provider_id": actual_provider_id,
            "actual_provider": actual_asset.provider,
            "fallback_used": actual_provider_id != preferred_id and not generation_pending,
            "generation_pending": generation_pending,
            "director_query": director_query,
            "requested_media_type": route_media_type,
            "query": actual_asset.query,
            "rationale": str(route.get("rationale") or ""),
            "director_shot": route,
            "candidate_shortlist": candidate_shortlist,
        }
        if materialization_notes:
            routing_record["materialization_notes"] = list(dict.fromkeys(materialization_notes))
        return actual_asset, routing_record

    with ThreadPoolExecutor(max_workers=min(ASSET_PREPARE_WORKERS, max(1, len(scene_list)))) as executor:
        prepared = list(executor.map(prepare_scene, scene_list))
    scene_assets = [item[0] for item in prepared]
    routing_records = [item[1] for item in prepared]

    plan_path = write_asset_plan(default_asset_plan_path(workspace, job_id), job_id, scene_assets)
    payload = load_asset_plan(plan_path)
    payload["director_routing"] = routing_records
    payload["director_plan_version"] = str(director_plan.get("version") or "video-factory/director-plan-v1")
    plan_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return plan_path


def ranking_candidate_ids_by_scene(candidate_ranking: Optional[dict]) -> dict[int, list[RankedCandidatePreference]]:
    if candidate_ranking is None:
        return {}
    scenes = candidate_ranking.get("scenes")
    if not isinstance(scenes, list):
        raise ValueError("Candidate ranking scenes must be an array")
    result: dict[int, list[RankedCandidatePreference]] = {}
    enforce_score = candidate_ranking.get("source") == "model"
    for scene in scenes:
        if not isinstance(scene, dict) or not isinstance(scene.get("scenePosition"), int):
            raise ValueError("Candidate ranking scenePosition is invalid")
        candidates = scene.get("candidates")
        if not isinstance(candidates, list):
            raise ValueError("Candidate ranking candidates must be an array")
        ordered = sorted(candidates, key=lambda item: (
            0 if isinstance(item, dict) and item.get("locked") is True else 1,
            int(item.get("rank", 1_000_000)) if isinstance(item, dict) else 1_000_000,
        ))
        result[int(scene["scenePosition"])] = [
            RankedCandidatePreference(
                provider=str(item.get("provider") or ""),
                asset_id=str(item.get("assetId") or ""),
                semantic_score=int(item.get("semanticScore", 0)),
                locked=item.get("locked") is True,
                enforce_score=enforce_score,
            )
            for item in ordered
            if isinstance(item, dict) and item.get("provider") and item.get("assetId")
        ]
    return result


def inventory_candidates_by_scene_provider(candidate_inventory: Optional[dict]) -> dict[int, dict[str, List[StockAssetCandidate]]]:
    if candidate_inventory is None:
        return {}
    if candidate_inventory.get("version") != "video-factory/asset-candidate-inventory-v1":
        raise ValueError("Candidate inventory version is invalid")
    scenes = candidate_inventory.get("scene_candidates")
    if not isinstance(scenes, list):
        raise ValueError("Candidate inventory scenes must be an array")
    result: dict[int, dict[str, List[StockAssetCandidate]]] = {}
    for scene in scenes:
        if not isinstance(scene, dict) or not isinstance(scene.get("scene_position"), int):
            raise ValueError("Candidate inventory scene_position is invalid")
        by_provider: dict[str, List[StockAssetCandidate]] = {}
        candidates = scene.get("candidates")
        if not isinstance(candidates, list):
            raise ValueError("Candidate inventory candidates must be an array")
        for item in candidates:
            if not isinstance(item, dict):
                raise ValueError("Candidate inventory item is invalid")
            provider_id = item.get("provider_id")
            if not isinstance(provider_id, str) or not provider_id:
                raise ValueError("Candidate inventory provider_id is invalid")
            values = {key: value for key, value in item.items() if key != "provider_id"}
            try:
                candidate = StockAssetCandidate(**values)
            except TypeError as error:
                raise ValueError("Candidate inventory item is invalid") from error
            by_provider.setdefault(provider_id, []).append(candidate)
        result[int(scene["scene_position"])] = by_provider
    return result


def reorder_candidates(
    candidates: List[StockAssetCandidate],
    preferred: list[RankedCandidatePreference],
) -> List[StockAssetCandidate]:
    if not preferred:
        return candidates
    accepted = [
        item for item in preferred
        if item.locked or not item.enforce_score or item.semantic_score >= MIN_MODEL_SEMANTIC_SCORE
    ]
    positions = {(item.provider, item.asset_id): index for index, item in enumerate(accepted)}
    reviewed = [candidate for candidate in candidates if (candidate.provider, candidate.asset_id) in positions]
    return sorted(reviewed, key=lambda candidate: positions[(candidate.provider, candidate.asset_id)])


def materialize_local_scene(scene: Scene, query: str, asset_dir: Path, director_shot: Optional[dict] = None) -> SceneAsset:
    actual_path = write_local_scene_card(
        scene,
        asset_dir / f"scene_{scene.position:02d}_local_card.png",
        director_shot=director_shot,
    )
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
    claim: Optional[Callable[[StockAssetCandidate], bool]] = None,
    release: Optional[Callable[[StockAssetCandidate], None]] = None,
    failures: Optional[list[str]] = None,
) -> Optional[SceneAsset]:
    for candidate in candidates:
        if claim is not None and not claim(candidate):
            continue
        try:
            actual_path = materialize_candidate(candidate, asset_dir / local_filename(scene.position, candidate))
        except RuntimeError as error:
            if release is not None:
                release(candidate)
            if failures is not None:
                failures.append(f"{candidate.provider}:{candidate.asset_id}: {error}")
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
    return candidates[:limit]


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
    return candidates[:limit]


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
                preview_url="",
                download_url=str(best_file.get("url") or ""),
                source_url=str(item.get("pageURL") or ""),
                creator=str(item.get("user") or ""),
                license_note=PROVIDER_LICENSE_NOTE["pixabay"],
                query=query,
                score=quality_score(width, height, float(item.get("duration") or 0)),
            )
        )
    return candidates[:limit]


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
    return candidates[:limit]


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


def candidate_to_public_dict(
    candidate: StockAssetCandidate,
    provider_id: Optional[str] = None,
    selected: bool = False,
) -> dict:
    return {
        "provider": candidate.provider,
        "provider_id": provider_id,
        "asset_id": candidate.asset_id,
        "media_type": candidate.media_type,
        "width": candidate.width,
        "height": candidate.height,
        "duration": candidate.duration,
        "preview_url": candidate.preview_url,
        "source_url": candidate.source_url,
        "creator": candidate.creator,
        "license_note": candidate.license_note,
        "query": candidate.query,
        "score": candidate.score,
        "selected": selected,
    }


def candidate_to_private_dict(candidate: StockAssetCandidate, provider_id: str) -> dict:
    return {**asdict(candidate), "provider_id": provider_id}


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
    director_scene = Scene(
        position=scene.position,
        narration=scene.narration,
        duration=scene.duration,
        visual_strategy=scene.visual_strategy,
        visual_prompt=director_query,
        search_terms=[],
    )
    semantic_query = semantic_query_for_scene(director_scene)
    if semantic_query:
        return semantic_query
    explicit_query = english_query_from_visual_prompt(director_query)
    if explicit_query:
        return explicit_query
    return semantic_query_for_scene(scene) or query_for_scene(scene)


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


def materialize_candidate(
    candidate: StockAssetCandidate,
    local_path: Path,
    opener: Optional[Callable] = None,
) -> Path:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    if candidate.download_url.startswith("mock://"):
        return write_mock_image(candidate, local_path)
    validate_asset_download_url(candidate.download_url)
    request = urllib.request.Request(candidate.download_url, headers=download_headers(candidate.source_url))
    active_opener = opener or open_asset_request
    for attempt in range(1, ASSET_DOWNLOAD_ATTEMPTS + 1):
        try:
            with active_opener(request, timeout=60) as response:
                validate_asset_content_type(candidate.media_type, response.headers.get("Content-Type"))
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


def validate_asset_download_url(value: str) -> str:
    return resolve_asset_download_target(value)[0]


def resolve_asset_download_target(value: str) -> tuple[str, tuple[str, ...]]:
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as error:
        raise RuntimeError("Asset download URL is invalid.") from error
    if parsed.scheme.lower() not in {"http", "https"}:
        raise RuntimeError("Asset download URL must use HTTP or HTTPS.")
    if parsed.username or parsed.password or not parsed.hostname:
        raise RuntimeError("Asset download URL points to a private or unsafe network destination.")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise RuntimeError("Asset download URL points to a private or unsafe network destination.")
    try:
        resolved = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise RuntimeError("Asset download URL hostname could not be resolved.") from error
    addresses = {str(entry[4][0]).split("%", 1)[0] for entry in resolved if entry[4]}
    if not addresses or any(not is_public_ip_address(address) for address in addresses):
        raise RuntimeError("Asset download URL points to a private or unsafe network destination.")
    return parsed.geturl(), tuple(sorted(addresses))


def is_public_ip_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if isinstance(address, ipaddress.IPv6Address) and any(address in network for network in UNSAFE_IPV6_NETWORKS):
        return False
    return address.is_global


def open_asset_request(request: urllib.request.Request, timeout: float):
    current_url = request.full_url
    headers = dict(request.header_items())
    for redirect_count in range(ASSET_REDIRECT_LIMIT + 1):
        validated_url, addresses = resolve_asset_download_target(current_url)
        response = open_pinned_asset_response(validated_url, addresses, headers, timeout)
        if response.status not in {301, 302, 303, 307, 308}:
            if response.status >= 400:
                status = response.status
                reason = response.reason
                response_headers = response.headers
                response.close()
                raise HTTPError(validated_url, status, reason, response_headers, None)
            return response
        location = response.headers.get("Location")
        response.close()
        if not location:
            raise RuntimeError("Asset redirect did not include a location.")
        if redirect_count == ASSET_REDIRECT_LIMIT:
            raise RuntimeError("Asset download exceeded the redirect limit.")
        current_url = urllib.parse.urljoin(validated_url, location)
    raise AssertionError("Asset redirect loop exited unexpectedly")


def open_pinned_asset_response(
    value: str,
    addresses: tuple[str, ...],
    headers: dict,
    timeout: float,
):
    parsed = urllib.parse.urlsplit(value)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    last_error = None
    for address in addresses:
        connection = None
        raw_socket = None
        try:
            if parsed.scheme.lower() == "https":
                context = ssl.create_default_context()
                connection = http.client.HTTPSConnection(host, port, timeout=timeout, context=context)
                raw_socket = socket.create_connection((address, port), timeout=timeout)
                connection.sock = context.wrap_socket(raw_socket, server_hostname=host)
            else:
                connection = http.client.HTTPConnection(host, port, timeout=timeout)
                connection.sock = socket.create_connection((address, port), timeout=timeout)
            connection.request("GET", path, headers=headers)
            return PinnedAssetResponse(connection, connection.getresponse())
        except (OSError, ssl.SSLError, http.client.HTTPException) as error:
            last_error = error
            if connection is not None:
                connection.close()
            elif raw_socket is not None:
                raw_socket.close()
    raise URLError(last_error or f"Unable to connect to {host}")


class PinnedAssetResponse:
    def __init__(self, connection, response):
        self._connection = connection
        self._response = response
        self.status = response.status
        self.reason = response.reason
        self.headers = response.headers

    def read(self, *args, **kwargs):
        return self._response.read(*args, **kwargs)

    def read1(self, *args, **kwargs):
        read1 = getattr(self._response, "read1", self._response.read)
        return read1(*args, **kwargs)

    def close(self):
        try:
            self._response.close()
        finally:
            self._connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


def validate_asset_content_type(media_type: str, value: Optional[str]) -> str:
    content_type = (value or "").split(";", 1)[0].strip().lower()
    valid = content_type in {"application/octet-stream", "binary/octet-stream"}
    if media_type == "video":
        valid = valid or content_type.startswith("video/") or content_type in {"application/mp4", "audio/mp4"}
    elif media_type == "image":
        valid = valid or content_type.startswith("image/")
    if not valid:
        displayed = content_type or "missing"
        raise RuntimeError(f"Asset download returned unsupported content type '{displayed}'.")
    return content_type


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


def write_local_scene_card(scene: Scene, local_path: Path, director_shot: Optional[dict] = None) -> Path:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Pillow is required to create local scene cards.") from error

    local_path = local_path.with_suffix(".png")
    width, height = 1080, 1920
    spec = local_card_spec(scene, director_shot)
    style = local_card_semantic_style(spec)
    image = Image.new("RGB", (width, height), style["background"])
    draw = ImageDraw.Draw(image)
    draw_directed_card(draw, ImageFont, scene, spec, style, width, height)
    image.save(local_path)
    return local_path


def local_card_spec(scene: Scene, director_shot: Optional[dict] = None) -> dict:
    shot = director_shot if isinstance(director_shot, dict) else {}
    supporting_text = " ".join([
        scene.visual_prompt,
        str(shot.get("query") or ""),
        str(shot.get("subject") or ""),
        str(shot.get("visibleAction") or ""),
        " ".join(str(item) for item in shot.get("successCriteria", []) if isinstance(item, str)),
    ])
    quoted = quoted_display_text(supporting_text)
    query = str(shot.get("query") or "").lower()
    title, fallback_items, fallback_kicker = local_card_content(scene)
    evidence_items = [item for item in ("来源", "原文", "适用范围") if item in supporting_text]

    if "node output self review red team" in query:
        return {
            "layout": "audit_flow",
            "kicker": "节点审计",
            "title": "每个节点，都先过两关",
            "items": ["节点输出", "自审", "独立红队"],
            "status": "发现问题",
        }

    if "self review independent red team" in query:
        return {
            "layout": "audit_flow",
            "kicker": "审核顺序",
            "title": "先自审，再交独立红队",
            "items": ["自审", "独立红队"],
            "status": "",
        }

    if "overhead hand moving blank cards" in query:
        return {
            "layout": "card_pair",
            "kicker": "每个节点",
            "title": "同样走完两关",
            "items": ["自审", "独立红队"],
            "status": "重复执行",
        }

    if "paid step" in query and "confirmation" in query:
        return {
            "layout": "paid_gate",
            "kicker": "费用边界",
            "title": "付费前，停下来确认",
            "items": ["返回修改", "确认继续"],
            "status": "付费节点 · 未执行",
        }

    if "audit payment confirmation outro" in query:
        return {
            "layout": "audit_outro",
            "kicker": "生产口诀",
            "title": "每个节点：自审 → 红队",
            "items": ["付费前：用户确认", "继续生产"],
            "status": "",
        }

    if "status" in query and ("verification" in query or "核验" in supporting_text):
        flow = next((item for item in quoted if "→" in item), "")
        items = [part.strip() for part in flow.split("→") if part.strip()] if flow else [
            item for item in quoted if item in {"生成完成", "待证据核验", "等待发布"}
        ]
        if len(items) < 2:
            items = ["生成完成", "待证据核验"]
        return {"layout": "status_flow", "kicker": "证据门禁", "title": "发布前，先核验", "items": items[:2], "status": items[-1]}

    if "checklist" in query or len(evidence_items) == 3 or "缺一项" in scene.narration:
        items = evidence_items or ["来源", "原文", "适用范围"]
        pending = "缺" in scene.narration or "待核验" in supporting_text and "待发布" not in supporting_text
        status = "待核验" if pending else ("待发布" if "待发布" in supporting_text else "核验完成")
        return {
            "layout": "checklist",
            "kicker": "核验清单",
            "title": "缺一项，就先不发布" if pending else "三项齐，才进入下一步",
            "items": items[:3],
            "status": status,
            "pending_index": len(items[:3]) - 1 if pending else None,
        }

    if "missing source" in query or ("来源" in supporting_text and "未提供" in supporting_text):
        return {"layout": "form", "kicker": "来源核验", "title": "来源", "items": ["未提供"], "status": "退回待核验"}

    if "claim" in query or "typography" in query or "断言" in supporting_text:
        statement = next((item for item in quoted if "断言" in item), title)
        return {"layout": "statement", "kicker": "门禁拦截", "title": statement, "items": [], "status": "待证据核验"}

    if "start card" in query or "conclusion" in query or "只是起点" in supporting_text:
        conclusion = next((item for item in quoted if "起点" in item), title)
        lead = next((item for item in quoted if item != conclusion), "能生成")
        return {"layout": "conclusion", "kicker": "结论", "title": conclusion, "items": [lead], "status": ""}

    return {"layout": "list", "kicker": fallback_kicker, "title": title, "items": fallback_items, "status": ""}


def quoted_display_text(text: str) -> list[str]:
    values = re.findall(r"[“\"]([^”\"]{1,32})[”\"]", text)
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))


def draw_directed_card(draw, ImageFont, scene: Scene, spec: dict, style: dict, width: int, height: int) -> None:
    margin = 86
    small_font = local_card_font(ImageFont, 28)
    label_font = local_card_font(ImageFont, 36)
    kicker_font = local_card_font(ImageFont, 42)
    draw.rectangle((0, 0, 18, height), fill=style["accent"])
    draw.text((margin, 92), str(spec["kicker"]), font=small_font, fill=style["muted"])
    scene_label = f"{scene.position:02d} / {scene.duration:.1f}s"
    label_box = draw.textbbox((0, 0), scene_label, font=small_font)
    draw.text((width - margin - (label_box[2] - label_box[0]), 92), scene_label, font=small_font, fill=style["muted"])
    draw.line((margin, 160, width - margin, 160), fill=style["rule"], width=2)

    layout = str(spec["layout"])
    if layout == "audit_flow":
        title_font = local_card_font(ImageFont, local_card_title_size(str(spec["title"])))
        title_bottom = draw_wrapped_text(draw, str(spec["title"]), (margin, 250), title_font, style["ink"], width - margin * 2, 16)
        items = list(spec["items"])
        colors = ["#7d8da8", "#2f73d8", "#d05252"] if len(items) == 3 else ["#2f73d8", "#d05252"]
        top = max(570, title_bottom + 90)
        row_height = 170 if len(items) == 3 else 210
        row_gap = 78
        item_font = local_card_font(ImageFont, 48 if len(items) == 3 else 56)
        for index, item in enumerate(items):
            row_top = top + index * (row_height + row_gap)
            color = colors[index]
            draw.rounded_rectangle((margin, row_top, width - margin, row_top + row_height), radius=24, fill=style["surface"], outline=color, width=5)
            draw.ellipse((margin + 36, row_top + row_height // 2 - 30, margin + 96, row_top + row_height // 2 + 30), fill=color)
            draw.text((margin + 132, row_top + row_height // 2 - 35), item, font=item_font, fill=style["ink"])
            if index < len(items) - 1:
                arrow_y = row_top + row_height + 14
                draw.line((width // 2, arrow_y, width // 2, arrow_y + 42), fill=colors[index + 1], width=7)
                draw.polygon([(width // 2 - 14, arrow_y + 34), (width // 2 + 14, arrow_y + 34), (width // 2, arrow_y + 56)], fill=colors[index + 1])
        if spec.get("status"):
            status = str(spec["status"])
            status_font = local_card_font(ImageFont, 34)
            badge_top = min(1260, top + len(items) * (row_height + row_gap) + 8)
            draw.rounded_rectangle((width - margin - 260, badge_top, width - margin, badge_top + 76), radius=38, fill="#4b1f29")
            badge_box = draw.textbbox((0, 0), status, font=status_font)
            draw.text((width - margin - 130 - (badge_box[2] - badge_box[0]) / 2, badge_top + 19), status, font=status_font, fill="#ffb3b3")
        return

    if layout == "card_pair":
        title_font = local_card_font(ImageFont, 70)
        draw_wrapped_text(draw, str(spec["title"]), (margin, 270), title_font, style["ink"], width - margin * 2, 16)
        item_font = local_card_font(ImageFont, 48)
        card_width = 350
        card_top = 650
        card_height = 410
        lefts = [margin, width - margin - card_width]
        colors = ["#2f73d8", "#d05252"]
        for index, item in enumerate(list(spec["items"])[:2]):
            left = lefts[index]
            draw.rounded_rectangle((left, card_top, left + card_width, card_top + card_height), radius=26, fill=style["surface"], outline=colors[index], width=5)
            draw.rectangle((left + 34, card_top + 38, left + card_width - 34, card_top + 235), fill="#f7f8fb")
            label_box = draw.textbbox((0, 0), item, font=item_font)
            draw.text((left + card_width / 2 - (label_box[2] - label_box[0]) / 2, card_top + 290), item, font=item_font, fill=colors[index])
        arrow_y = card_top + card_height // 2
        draw.line((margin + card_width + 34, arrow_y, width - margin - card_width - 34, arrow_y), fill=style["accent"], width=7)
        draw.polygon([(width // 2 + 18, arrow_y - 14), (width // 2 + 18, arrow_y + 14), (width // 2 + 40, arrow_y)], fill=style["accent"])
        return

    if layout == "paid_gate":
        title_font = local_card_font(ImageFont, 70)
        title_bottom = draw_wrapped_text(draw, str(spec["title"]), (margin, 260), title_font, style["ink"], width - margin * 2, 16)
        boundary_y = max(590, title_bottom + 100)
        draw.line((margin, boundary_y, width - margin, boundary_y), fill="#f59e0b", width=10)
        boundary_font = local_card_font(ImageFont, 30)
        draw.rounded_rectangle((margin, boundary_y - 55, margin + 250, boundary_y + 12), radius=30, fill="#633b0b")
        draw.text((margin + 30, boundary_y - 40), "付费前确认", font=boundary_font, fill="#ffd18a")
        node_top = boundary_y + 110
        node_font = local_card_font(ImageFont, 42)
        draw.rounded_rectangle((margin, node_top, width - margin, node_top + 150), radius=24, fill="#172235", outline="#64748b", width=4)
        draw.ellipse((margin + 40, node_top + 48, margin + 94, node_top + 102), outline="#64748b", width=5)
        draw.text((margin + 130, node_top + 47), str(spec["status"]), font=node_font, fill="#9ba7b8")
        option_font = local_card_font(ImageFont, 38)
        option_top = node_top + 230
        option_width = (width - margin * 2 - 28) // 2
        for index, item in enumerate(list(spec["items"])[:2]):
            left = margin + index * (option_width + 28)
            draw.rounded_rectangle((left, option_top, left + option_width, option_top + 118), radius=18, fill=style["surface"], outline="#7d8da8", width=3)
            draw.ellipse((left + 28, option_top + 40, left + 64, option_top + 76), outline="#7d8da8", width=3)
            draw.text((left + 84, option_top + 35), item, font=option_font, fill=style["ink"])
        return

    if layout == "audit_outro":
        title_font = local_card_font(ImageFont, 70)
        draw_wrapped_text(draw, str(spec["title"]), (margin, 270), title_font, style["ink"], width - margin * 2, 16)
        rules = [(str(spec["items"][0]), "#f59e0b"), (str(spec["items"][1]), "#35a37a")]
        top = 700
        rule_font = local_card_font(ImageFont, 48)
        for index, (item, color) in enumerate(rules):
            row_top = top + index * 230
            draw.rounded_rectangle((margin, row_top, width - margin, row_top + 160), radius=22, fill=style["surface"], outline=color, width=5)
            draw.rectangle((margin, row_top, margin + 18, row_top + 160), fill=color)
            draw.text((margin + 58, row_top + 52), item, font=rule_font, fill=style["ink"])
        return

    if layout == "status_flow":
        title_font = local_card_font(ImageFont, 64)
        draw_wrapped_text(draw, str(spec["title"]), (margin, 270), title_font, style["ink"], width - margin * 2, 16)
        box_font = local_card_font(ImageFont, 54)
        items = list(spec["items"])
        for index, item in enumerate(items[:2]):
            top = 610 + index * 280
            active = index == 1
            fill = style["accent"] if active else style["surface"]
            ink = "#ffffff" if active else style["ink"]
            draw.rounded_rectangle((margin, top, width - margin, top + 190), radius=26, fill=fill)
            draw.text((margin + 56, top + 58), item, font=box_font, fill=ink)
            if index == 0:
                draw.line((width // 2, top + 206, width // 2, top + 252), fill=style["accent"], width=7)
                draw.polygon([(width // 2 - 14, top + 240), (width // 2 + 14, top + 240), (width // 2, top + 260)], fill=style["accent"])
        return

    if layout == "checklist":
        title_font = local_card_font(ImageFont, local_card_title_size(str(spec["title"])))
        title_bottom = draw_wrapped_text(draw, str(spec["title"]), (margin, 260), title_font, style["ink"], width - margin * 2, 16)
        row_font = local_card_font(ImageFont, 56)
        pending_index = spec.get("pending_index")
        for index, item in enumerate(list(spec["items"])[:3]):
            top = max(590, title_bottom + 80) + index * 190
            pending = pending_index == index
            color = "#c43d32" if pending else "#188465"
            draw.rounded_rectangle((margin, top, width - margin, top + 136), radius=18, fill=style["surface"], outline=color, width=4)
            draw.ellipse((margin + 34, top + 38, margin + 94, top + 98), fill=color)
            draw.text((margin + 128, top + 34), item, font=row_font, fill=style["ink"])
            if pending:
                draw.line((margin + 51, top + 68, margin + 77, top + 68), fill="#ffffff", width=6)
            else:
                draw.line((margin + 48, top + 68, margin + 59, top + 80), fill="#ffffff", width=6)
                draw.line((margin + 59, top + 80, margin + 81, top + 55), fill="#ffffff", width=6)
        status = str(spec.get("status") or "")
        if status:
            status_font = local_card_font(ImageFont, 40)
            status_color = "#c43d32" if "核验" in status or "退回" in status else "#188465"
            draw.rounded_rectangle((margin, 1230, width - margin, 1335), radius=52, outline=status_color, width=4)
            status_box = draw.textbbox((0, 0), status, font=status_font)
            draw.text(((width - (status_box[2] - status_box[0])) / 2, 1250), status, font=status_font, fill=status_color)
        return

    if layout == "form":
        title_font = local_card_font(ImageFont, 72)
        draw.text((margin, 300), "来源核验", font=title_font, fill=style["ink"])
        field_font = local_card_font(ImageFont, 48)
        draw.text((margin, 570), str(spec["title"]), font=kicker_font, fill=style["muted"])
        draw.rounded_rectangle((margin, 650, width - margin, 810), radius=20, fill="#ffffff", outline="#c43d32", width=6)
        draw.text((margin + 42, 698), str(spec["items"][0]), font=field_font, fill="#c43d32")
        status_font = local_card_font(ImageFont, 48)
        draw.text((margin, 940), str(spec["status"]), font=status_font, fill="#c43d32")
        return

    if layout in {"statement", "conclusion"}:
        lead = str(spec["items"][0]) if spec.get("items") else str(spec["kicker"])
        lead_font = local_card_font(ImageFont, 44)
        lead_box = draw.textbbox((0, 0), lead, font=lead_font)
        draw.text(((width - (lead_box[2] - lead_box[0])) / 2, 500), lead, font=lead_font, fill=style["muted"])
        title_font = local_card_font(ImageFont, 100 if len(str(spec["title"])) <= 6 else 76)
        lines = wrap_text_by_pixels(draw, str(spec["title"]), title_font, width - margin * 2)
        line_height = 126
        top = 640
        for index, line in enumerate(lines):
            box = draw.textbbox((0, 0), line, font=title_font)
            draw.text(((width - (box[2] - box[0])) / 2, top + index * line_height), line, font=title_font, fill=style["ink"])
        draw.line((250, top + len(lines) * line_height + 60, width - 250, top + len(lines) * line_height + 60), fill=style["accent"], width=10)
        if spec.get("status"):
            draw.text((margin, 1180), str(spec["status"]), font=kicker_font, fill=style["accent"])
        return

    draw_editorial_background(draw, width, height, style)
    title = str(spec["title"])
    items = list(spec["items"])
    title_font = local_card_font(ImageFont, local_card_title_size(title))
    draw.text((margin, 260), str(spec["kicker"]), font=kicker_font, fill=style["accent"])
    title_bottom = draw_wrapped_text(draw, title, (margin, 330), title_font, style["ink"], width - margin * 2 - 120, 20)
    item_font = local_card_font(ImageFont, local_card_item_size(items))
    y = max(720, title_bottom + 90)
    for index, item in enumerate(items[:4], start=1):
        draw.text((margin, y + 6), f"{index:02d}", font=label_font, fill=style["accent"])
        y = draw_wrapped_text(draw, item, (margin + 118, y), item_font, style["ink"], width - margin * 2 - 118, 16)
        draw.line((margin + 118, y + 20, width - margin, y + 20), fill=style["rule"], width=2)
        y += 74


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


def local_card_semantic_style(spec: dict) -> dict:
    layout = str(spec.get("layout") or "list")
    if layout == "checklist" and spec.get("pending_index") is None:
        return {
            "background": "#f2f6f3", "surface": "#e5efe9", "ink": "#14211d",
            "muted": "#5b6f67", "accent": "#188465", "rule": "#cadbd2",
        }
    if layout == "form" or (layout == "checklist" and spec.get("pending_index") is not None):
        return {
            "background": "#f8f3ef", "surface": "#f0e6df", "ink": "#211915",
            "muted": "#77665c", "accent": "#c43d32", "rule": "#dfcfc5",
        }
    if layout in {"audit_flow", "card_pair", "paid_gate", "audit_outro"}:
        return {
            "background": "#0b1220", "surface": "#142238", "ink": "#f6f8fb",
            "muted": "#aab5c5", "accent": "#f59e0b", "rule": "#2b3a50",
        }
    if layout in {"status_flow", "statement", "conclusion"}:
        return {
            "background": "#f7f3ea", "surface": "#eee7d9", "ink": "#111827",
            "muted": "#6b6257", "accent": "#d97706", "rule": "#d9cdbb",
        }
    return local_card_style(2)


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
