import json
from pathlib import Path
from typing import Dict

from .domain import ScriptDraft, Topic
from .script_service import draft_to_dict


def write_script(workspace: Path, job_id: int, draft: ScriptDraft) -> Path:
    job_dir = workspace / "jobs" / str(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    path = job_dir / "script.json"
    path.write_text(
        json.dumps(draft_to_dict(draft), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def write_review_package(
    workspace: Path,
    job_id: int,
    topic: Topic,
    draft: ScriptDraft,
    script_path: Path,
) -> Path:
    export_dir = workspace / "exports" / str(job_id)
    export_dir.mkdir(parents=True, exist_ok=True)

    title = draft.title
    description = build_description(draft)
    hashtags = " ".join(f"#{tag}" for tag in draft.hashtags)
    compliance = build_compliance(topic, draft)
    assets = build_asset_manifest(job_id, draft)

    (export_dir / "title.txt").write_text(title + "\n", encoding="utf-8")
    (export_dir / "description.txt").write_text(description + "\n", encoding="utf-8")
    (export_dir / "hashtags.txt").write_text(hashtags + "\n", encoding="utf-8")
    (export_dir / "script.json").write_text(script_path.read_text(encoding="utf-8"), encoding="utf-8")
    (export_dir / "compliance.json").write_text(
        json.dumps(compliance, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (export_dir / "asset_manifest.json").write_text(
        json.dumps(assets, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return export_dir


def build_description(draft: ScriptDraft) -> str:
    return f"{draft.hook}\n\n这条是 VideoFactory 的选题验证样片，发布前请人工复核事实、版权和 AIGC 标识。"


def build_compliance(topic: Topic, draft: ScriptDraft) -> Dict[str, object]:
    return {
        "topic_id": topic.id,
        "is_ai_assisted": True,
        "disclosure_required": draft.disclosure_required,
        "suggested_disclosure_text": "本视频脚本/配音/画面可能包含 AI 辅助生成内容。",
        "human_review_required": True,
        "platform_publish_mode": "manual",
        "risk_notes": [
            "发布前检查事实准确性。",
            "发布前检查素材来源和授权。",
            "按平台要求填写 AIGC 标识。",
        ],
    }


def build_asset_manifest(job_id: int, draft: ScriptDraft) -> Dict[str, object]:
    return {
        "job_id": job_id,
        "assets_ready": False,
        "notes": "MVP 暂未下载素材；后续由 stock/image/video provider 写入真实来源。",
        "planned_assets": [
            {
                "scene_position": scene.position,
                "visual_strategy": scene.visual_strategy,
                "visual_prompt": scene.visual_prompt,
                "search_terms": scene.search_terms,
                "provider": "pending",
                "source_url": None,
                "license_note": None,
            }
            for scene in draft.scenes
        ],
    }
