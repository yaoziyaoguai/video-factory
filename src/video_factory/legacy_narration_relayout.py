"""核对旧逐镜 TTS 的真实账本后本地移位；不迁移账本、不伪造供应商字幕。"""

import hashlib
import json
from pathlib import Path
from typing import Any

from .continuous_voiceover import assemble_narration_track
from .narration_plan import build_narration_plan, validate_narration_plan
from .narration_relayout import build_relayout_target_plan, parse_relayout_layout
from .voiceover import mastering_settings


def _digest(value: Any) -> str:
    # 必须沿用旧账本的序列化规则，尤其不能将参数中的 1.0 改成 1。
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def perform_legacy_relayout(*, source: dict, layout: Any, scenes: list[dict],
                            script_sha256: str, visual_sha256: str, node_root: Path,
                            output_dir: Path, source_operation_id: str,
                            layout_operation_id: str) -> dict:
    node_root = node_root.resolve()

    def verified_file(value: str, sha256: str, size: int | None = None) -> Path:
        path = Path(value).resolve()
        if not path.is_relative_to(node_root) or path.is_relative_to(output_dir.resolve()):
            raise ValueError("旧配音来源必须保留在同一声音节点内，不能引用本次输出。")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != sha256 or size is not None and len(content) != size:
            raise ValueError("旧配音来源字节与原记录不一致；原声音保留，请核查原记录。")
        return path

    original_path = verified_file(source["voicePlanPath"], source["voicePlanSha256"])
    original = json.loads(original_path.read_bytes())
    if original.get("version") != "video-factory/voiceover-plan-v2" or original.get("provider") != "minimax":
        raise ValueError("旧配音移位只读取具有原始逐镜账本的 MiniMax 声音。")
    verified_file(original["track_path"], source["trackSha256"])
    ledger_path = node_root / ".voice-operations" / (hashlib.sha256(source_operation_id.encode()).hexdigest() + ".json")
    if Path(source["ledgerPath"]).resolve() != ledger_path:
        raise ValueError("旧配音账本不是原操作的账本。")
    ledger = json.loads(verified_file(str(ledger_path), source["ledgerSha256"]).read_bytes())
    items = ledger.get("items")
    if (ledger.get("version") != "video-factory/paid-operation-v2"
            or ledger.get("operationId") != source_operation_id or ledger.get("completed") is not True
            or not isinstance(items, list) or len(items) != len(scenes)
            or any(item.get("state") != "materialized" for item in items)):
        raise ValueError("旧配音原请求尚未全部核实完成；只核对原请求，不重新购买。")
    original_scenes = original.get("scenes")
    if not isinstance(original_scenes, list) or len(original_scenes) != len(scenes):
        raise ValueError("旧配音与当前画面数量不一致。")
    source_fingerprint = _digest([{"scenePosition": s["position"], "narration": s["narration"]} for s in scenes])
    plan = build_narration_plan(scenes, script_sha256=script_sha256, visual_sha256=visual_sha256)
    plan["groups"] = []
    raw = {}
    cursor = 0
    for scene, old, item in zip(scenes, original_scenes, items):
        position, text = scene["position"], scene["narration"]
        if (old.get("position") != position or old.get("narration") != text
                or old.get("duration") != round(scene["duration"], 3)
                or item.get("scenePosition") != position):
            raise ValueError("旧配音文字或画面时间已变化，不能借用原音频冒充新内容。")
        parameters = item.get("parameters") or {}
        direction = original.get("direction") or {}
        if (parameters.get("voice") != original.get("voice") or parameters.get("rate") != original.get("rate")
                or parameters.get("pauseScale") != direction.get("pause_scale")):
            raise ValueError("旧配音音色或语速与账本不一致。")
        fingerprint = _digest({"scenePosition": position, "narration": text,
            "providerId": ledger["providerId"], "modelId": ledger["modelId"],
            "sourceFingerprint": source_fingerprint, "parameters": parameters})
        item_id = "paid-item-" + hashlib.sha256(f"{source_operation_id}\0{fingerprint}".encode()).hexdigest()[:24]
        if (item.get("inputFingerprint") != fingerprint or item.get("sourceFingerprint") != source_fingerprint
                or item.get("itemRequestId") != item_id or item.get("providerId") != ledger["providerId"]
                or item.get("modelId") != ledger["modelId"]):
            raise ValueError("旧配音原请求身份不匹配。")
        audio = verified_file(item["localPath"], item["sha256"], item["sizeBytes"])
        end = cursor + round(scene["duration"] * 30)
        if any(character.isalnum() for character in text):
            group_id = f"legacy-scene-{position}"
            plan["groups"].append({"id": group_id, "sourceScenePositions": [position], "text": text.strip(),
                "window": {"startFrame": cursor, "endFrame": end},
                "placement": {"anchor": "start", "offsetFrames": 0}})
            raw[group_id] = audio
        cursor = end
    if source.get("currentPlan") is not None:
        current = validate_narration_plan(source["currentPlan"], scenes,
            script_sha256=script_sha256, visual_sha256=visual_sha256)
        if len(current["groups"]) != len(plan["groups"]) or any(
                {k: v for k, v in a.items() if k != "placement"} != {k: v for k, v in b.items() if k != "placement"}
                for a, b in zip(current["groups"], plan["groups"])):
            raise ValueError("旧配音只能移位，不能改分组或窗口。")
        plan = current
    target = build_relayout_target_plan(plan, parse_relayout_layout(layout, plan), scenes=scenes,
        script_sha256=script_sha256, visual_sha256=visual_sha256, source_context_id=None)
    preset = (original.get("mastering") or {}).get("preset", "natural")
    mastering = mastering_settings(preset)
    assembled = assemble_narration_track(target, raw, output_dir, mastering_filter=mastering["filter"])
    assembled.update({"version": "video-factory/voiceover-plan-v2", "provider": original["provider"],
        "voice": original["voice"], "rate": original["rate"], "direction": original["direction"],
        "mastering": {"preset": preset, **mastering}, "voiceOperationId": source_operation_id,
        "layoutOperationId": layout_operation_id, "relayoutSource": "legacy_voice_version",
        "trackSha256": hashlib.sha256(Path(assembled["track_path"]).read_bytes()).hexdigest(),
        "legacyVoiceSource": {k: v for k, v in source.items() if k != "currentPlan"},
        "subtitles": {"status": "unavailable", "reason": "legacy_scene_text_not_sentence_timing", "cues": []}})
    return assembled
