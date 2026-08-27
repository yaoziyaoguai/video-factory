import json
from pathlib import Path
from typing import Iterable, List

from .domain import LocalAsset, Scene


def normalize_tags(tags: Iterable[str]) -> List[str]:
    return [tag.strip().lower() for tag in tags if tag.strip()]


def match_assets_to_scenes(scenes: Iterable[Scene], assets: Iterable[LocalAsset]) -> List[dict]:
    asset_list = list(assets)
    matches = []
    for scene in scenes:
        ranked = sorted(
            asset_list,
            key=lambda asset: score_asset(scene, asset),
            reverse=True,
        )
        best = [asset for asset in ranked if score_asset(scene, asset) > 0][:3]
        matches.append(
            {
                "scene_position": scene.position,
                "visual_strategy": scene.visual_strategy,
                "search_terms": scene.search_terms,
                "suggestions": [
                    {
                        "asset_id": asset.id,
                        "path": asset.path,
                        "media_type": asset.media_type,
                        "tags": asset.tags,
                        "license_note": asset.license_note,
                        "score": score_asset(scene, asset),
                    }
                    for asset in best
                ],
            }
        )
    return matches


def score_asset(scene: Scene, asset: LocalAsset) -> int:
    haystack = " ".join(asset.tags + [asset.media_type, asset.source]).lower()
    score = 0
    for term in scene.search_terms:
        for token in normalize_tags([term]):
            if token and token in haystack:
                score += 3
    if scene.visual_strategy == "image" and asset.media_type == "image":
        score += 1
    if scene.visual_strategy == "stock" and asset.media_type in {"video", "image"}:
        score += 1
    if scene.visual_strategy == "local":
        score += 1
    return score


def write_asset_matches(path: Path, matches: List[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"matches": matches}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path
