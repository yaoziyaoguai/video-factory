"""纯本地排轨：复用完整原音频，只调整窗口/落点与显式留白。

禁止路径：不调用 synthesize_minimax_groups、不下载素材/字幕、不改词/音色/分组。
原 raw、原账本、旧有效版本只读；输出写新 attempt 目录。
"""

import hashlib
import json
import math
from pathlib import Path
from typing import Any

from .continuous_voiceover import (
    NarrationGroupDoesNotFitError,
    NarrationGroupDoesNotFitV2Error,
    assemble_narration_track,
)
from .materialized_voice_source import read_materialized_manifest, verify_materialized_manifest
from .narration_plan import (
    NARRATION_PLAN_V1_VERSION,
    NARRATION_PLAN_V2_VERSION,
    validate_narration_plan,
    validate_narration_plan_v2_standalone,
)
from .narration_subtitles import build_group_subtitles
from .voiceover import mastering_settings

LAYOUT_OPERATION_PREFIX = "relayout-"


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_relayout_layout(value: Any, original_plan: dict[str, Any]) -> dict[str, Any]:
    """layout.groups 必须以原顺序恰好列出全部 groupId；窗口/落点重新校验，v1 只许改 placement。"""
    if not isinstance(value, dict):
        raise ValueError("relayout 布局必须是对象。")
    version = value.get("narrationPlanVersion")
    original_version = original_plan.get("version")
    if version not in (NARRATION_PLAN_V1_VERSION, NARRATION_PLAN_V2_VERSION):
        raise ValueError("relayout 布局的计划版本未知。")
    if version != original_version:
        raise ValueError("relayout 不能隐式升级或降级计划版本。")
    groups = value.get("groups")
    if not isinstance(groups, list) or len(groups) != len(original_plan["groups"]):
        raise ValueError("relayout 布局必须以原顺序恰好列出全部分组。")
    seen = set()
    for entry, original in zip(groups, original_plan["groups"]):
        if not isinstance(entry, dict) or entry.get("groupId") != original["id"] or entry["groupId"] in seen:
            raise ValueError("relayout 布局的分组身份或顺序与原计划不一致。")
        if version == NARRATION_PLAN_V1_VERSION and entry.get("window") != original["window"]:
            raise ValueError("v1 只调整落点；窗口与分组不变。")
        seen.add(entry.get("groupId"))
    user_silences = value.get("userSilences")
    if version == NARRATION_PLAN_V1_VERSION:
        if user_silences not in (None, []):
            raise ValueError("v1 布局不能引入用户静默；显式留白是 v2 能力。")
        return {"version": version, "groups": groups, "userSilences": []}
    if not isinstance(user_silences, list):
        raise ValueError("v2 布局的用户静默必须是列表。")
    return {"version": version, "groups": groups, "userSilences": user_silences}


def build_relayout_target_plan(
    original_plan: dict[str, Any], layout: dict[str, Any],
    *, scenes: list[dict[str, Any]], script_sha256: str, visual_sha256: str,
    source_context_id: str | None,
) -> dict[str, Any]:
    """应用布局到原计划并整体校验：文字/分组/来源固定，只有窗口、落点与显式留白可变。"""
    target: dict[str, Any] = json.loads(json.dumps(original_plan, ensure_ascii=False))
    legacy_silences = [s for s in target.get("silences", []) if s.get("source") == "legacy_silent_scene"]
    if target["version"] == NARRATION_PLAN_V2_VERSION:
        target_groups = {group["id"]: group for group in target["groups"]}
        for entry in layout["groups"]:
            group = target_groups[entry["groupId"]]
            window, placement = entry.get("window"), entry.get("placement")
            if not isinstance(window, dict) or not isinstance(placement, dict):
                raise ValueError("relayout 布局的窗口或落点缺失。")
            group["window"] = dict(window)
            group["placement"] = dict(placement)
        # §4.2.5 局部排序修复：legacy 与 user 静默拼接后按 (startFrame, endFrame) 排序再整体校验，
        # 与 builder 的规范输出一致；不移动、删除或补写任何用户窗口。
        combined = legacy_silences + [
            {"id": f"ns-user-{s.get('startFrame')}-{s.get('endFrame')}",
             "startFrame": s.get("startFrame"), "endFrame": s.get("endFrame"), "source": "user"}
            for s in layout["userSilences"]]
        target["silences"] = sorted(combined, key=lambda s: (s["startFrame"], s["endFrame"]))
        if not isinstance(source_context_id, str) or not source_context_id:
            raise ValueError("v2 relayout 需要计划内的来源身份。")
        return validate_narration_plan_v2_standalone(target, scenes,
            script_sha256=script_sha256, visual_sha256=visual_sha256, source_context_id=source_context_id)
    for entry in layout["groups"]:
        group = next(g for g in target["groups"] if g["id"] == entry["groupId"])
        window, placement = entry.get("window"), entry.get("placement")
        if not isinstance(window, dict) or not isinstance(placement, dict):
            raise ValueError("relayout 布局的窗口或落点缺失。")
        if window != group["window"]:
            raise ValueError("v1 只调整落点；窗口与分组不变。")
        group["placement"] = dict(placement)
    return validate_narration_plan(target, scenes, script_sha256=script_sha256, visual_sha256=visual_sha256)


def perform_relayout(
    *, manifest_path: Path, layout: Any, scenes: list[dict[str, Any]],
    script_sha256: str, visual_sha256: str, output_dir: Path, node_root: Path,
    run_id: str, node_id: str, source_operation_id: str, relayout_source: str,
    source_identity: dict[str, Any],
    layout_operation_id: str | None = None,
) -> dict[str, Any]:
    """清单核验 → 读取原 raw → 真实排轨 → 字幕按新布局重映射；全程零外部发送。"""
    manifest = read_materialized_manifest(manifest_path, node_root)
    node_root = node_root.resolve()
    narration_plan_path_value = source_identity.get("narrationPlanPath")
    if not isinstance(narration_plan_path_value, str) or not narration_plan_path_value:
        raise ValueError("relayout 来源身份缺少原旁白计划路径。")
    narration_plan_path = Path(narration_plan_path_value).resolve()
    manifest_plan_path = (node_root / manifest["narrationPlan"]["relativePath"]).resolve()
    if narration_plan_path != manifest_plan_path:
        raise ValueError("relayout 来源身份与 manifest 的原旁白计划不一致。")
    original_plan = json.loads(narration_plan_path.read_text(encoding="utf-8"))
    verify_materialized_manifest(
        manifest, node_root,
        run_id=run_id, node_id=node_id, source_operation_id=source_operation_id,
        voice_input_version_id=source_identity.get("voiceInputVersionId"),
        source_context_id=source_identity.get("sourceContextId"),
        script_artifact_id=source_identity.get("scriptArtifactId"),
        script_output_version_id=source_identity.get("scriptOutputVersionId"),
        script_sha256=script_sha256,
        visual_artifact_id=source_identity.get("visualArtifactId"),
        visual_output_version_id=source_identity.get("visualOutputVersionId"),
        visual_sha256=visual_sha256,
        upstream_version_ids=source_identity.get("upstreamVersionIds") or [],
        narration_plan=original_plan, narration_plan_path=narration_plan_path,
    )
    parsed_layout = parse_relayout_layout(layout, original_plan)
    source_context_id = manifest.get("sourceContextId") if original_plan.get("version") == NARRATION_PLAN_V2_VERSION else None
    target_plan = build_relayout_target_plan(original_plan, parsed_layout,
        scenes=scenes, script_sha256=script_sha256, visual_sha256=visual_sha256,
        source_context_id=source_context_id)
    raw_audio: dict[str, Path] = {}
    for entry in manifest["groups"]:
        raw_audio[entry["groupId"]] = node_root / entry["raw"]["relativePath"]
    synthesis = manifest.get("synthesis") or {}
    mastering = mastering_settings(str(synthesis.get("masteringPreset") or "natural"))
    try:
        assembled = assemble_narration_track(target_plan, raw_audio, output_dir,
            mastering_filter=mastering["filter"])
    except NarrationGroupDoesNotFitV2Error:
        raise
    except NarrationGroupDoesNotFitError:
        raise
    subtitles = build_group_subtitles(
        node_root / manifest["ledger"]["snapshot"]["relativePath"], node_root, assembled,
        narration_plan_sha256=_digest_of_plan(target_plan), adapter_version=str(synthesis.get("adapterVersion") or "minimax-subtitles-v1"),
        allow_initial_download=False)
    from .worker import write_subtitle_sidecars
    write_subtitle_sidecars(subtitles, output_dir)
    # §4.2.5 两类身份不混淆：voiceOperationId 恒为原 TTS 操作；layoutOperationId 取本次
    # 预留的排轨操作身份（不由原 TTS 身份派生），重试同一操作保持稳定。
    resolved_layout_operation = layout_operation_id or f"{LAYOUT_OPERATION_PREFIX}{source_operation_id}"
    manifest_reference = _relative_within_node(manifest_path, node_root)
    assembled.update({
        "provider": str(synthesis.get("provider") or "minimax"),
        "voice": synthesis.get("voice"), "rate": synthesis.get("rate"),
        "voiceOperationId": manifest["sourceOperationId"],
        "trackSha256": hashlib.sha256(Path(assembled["track_path"]).read_bytes()).hexdigest(),
        "layoutOperationId": resolved_layout_operation,
        "sourceManifestSha256": manifest["manifestSha256"],
        # §4.2.5 origin manifest 显式引用：不再让后续调整从当前 attempt 同目录猜路径。
        "originManifest": {"relativePath": manifest_reference,
                           "fileSha256": _sha256_file(manifest_path),
                           "manifestSha256": manifest["manifestSha256"]},
        "originNarrationPlanSha256": manifest["narrationPlan"]["sha256"],
        "targetNarrationPlanSha256": _digest_of_plan(target_plan),
        "relayoutSource": relayout_source,
        "subtitles": subtitles,
        "mastering": {"preset": synthesis.get("masteringPreset") or "natural", **mastering},
    })
    return assembled


def _relative_within_node(path: Path, node_root: Path) -> str:
    resolved = Path(path).resolve()
    return resolved.relative_to(node_root.resolve()).as_posix()


def _digest_of_plan(plan: dict[str, Any]) -> str:
    from .narration_plan import canonical_json_v2
    return hashlib.sha256(canonical_json_v2(plan).encode("utf-8")).hexdigest()
