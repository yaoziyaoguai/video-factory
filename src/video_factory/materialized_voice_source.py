"""声音来源清单（§2.3）：全部组音频物化后、排轨前的耐久完整登记。

清单是纯本地排轨（零重购）的唯一来源依据：写前崩溃按原命令/账本证明全组完成后重建，
写后崩溃按清单核验；两条路径都不允许"调用合成函数试一下缓存"。
"""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .voiceover import _write_json_durably

MANIFEST_VERSION = "video-factory/voice-source-manifest-v1"
RECEIPT_VERSION = "video-factory/voice-source-receipt-v1"
DECODED_PROFILE = {"sampleRate": 44_100, "channels": 1, "sampleFormat": "s16le"}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _relative_within_root(path: Path, node_root: Path) -> str:
    resolved = Path(path).resolve()
    root = node_root.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"voice 来源引用必须落在节点根内：{resolved}")
    return resolved.relative_to(root).as_posix()


def decoded_sample_count(raw_path: Path) -> int:
    """按完整解码样本校验 fit 的前提：真实解码计数，不信任容器元数据。"""
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-i", str(raw_path),
        "-map", "0:a:0", "-ar", str(DECODED_PROFILE["sampleRate"]), "-ac", "1",
        "-c:a", "pcm_s16le", "-f", "s16le", "-",
    ], check=True, capture_output=True, timeout=120)
    return len(result.stdout) // 2


def _file_reference(path: Path, node_root: Path, content_type: str) -> dict[str, Any]:
    data = Path(path)
    return {
        "relativePath": _relative_within_root(data, node_root),
        "sha256": hashlib.sha256(data.read_bytes()).hexdigest(),
        "byteSize": data.stat().st_size,
        "contentType": content_type,
    }


def build_materialized_manifest(
    *,
    run_id: str, node_id: str, source_operation_id: str,
    voice_input_version_id: str | None, source_context_id: str | None,
    narration_plan: dict[str, Any], narration_plan_path: Path, narration_plan_sha256: str,
    script_artifact_id: str | None, script_output_version_id: str | None, script_sha256: str,
    visual_artifact_id: str | None, visual_output_version_id: str | None, visual_sha256: str,
    parent_artifact_ids: list[str], upstream_version_ids: list[str],
    synthesis: dict[str, Any], ledger: dict[str, Any], ledger_path: Path,
    node_root: Path, output_dir: Path,
) -> dict[str, Any]:
    """从已结账本与原始响应收集全部组的不可变来源引用；缺一即失败，不生成部分清单。

    合法无旁白 0 组计划：账本按空组完成，清单 groups 为空但仍绑定计划/操作身份，
    供全片静音轨的排轨与恢复使用；不要求非空账本，也不伪造任何 TTS 事实。
    """
    node_root = node_root.resolve()
    items = ledger.get("items")
    if not isinstance(items, list):
        raise ValueError("voice 来源清单需要列表形式的合成账本。")
    plan_groups = {group["id"]: group for group in narration_plan["groups"]}
    if plan_groups:
        if not items:
            raise ValueError("voice 来源清单需要非空的合成账本。")
        if ledger.get("completed") is not True or any(item.get("state") != "materialized" for item in items):
            raise ValueError("voice 来源清单只能在全部组音频物化后生成。")
    else:
        if items:
            raise ValueError("无旁白 0 组计划的账本不应包含合成组。")
        if ledger.get("completed") is not True:
            raise ValueError("无旁白 0 组计划的账本未按完成状态结账。")
    groups: list[dict[str, Any]] = []
    for item in items:
        group_id = item.get("groupId")
        plan_group = plan_groups.get(group_id)
        if not isinstance(group_id, str) or plan_group is None:
            raise ValueError("voice 来源清单的组与计划不一致。")
        raw_path = Path(str(item.get("localPath") or item.get("pendingRawPath") or "")).resolve()
        if not raw_path.is_file():
            raise ValueError(f"voice 组 {group_id} 的原始音频缺失，不能登记来源。")
        raw = _file_reference(raw_path, node_root, "audio/mpeg")
        if raw["sha256"] != item.get("sha256") or raw["byteSize"] != item.get("sizeBytes"):
            raise ValueError(f"voice 组 {group_id} 的原始音频与账本身份不一致。")
        entry: dict[str, Any] = {
            "groupId": group_id,
            "sourceScenePositions": list(plan_group["sourceScenePositions"]),
            "textSha256": hashlib.sha256(plan_group["text"].encode("utf-8")).hexdigest(),
            "itemRequestId": item["itemRequestId"],
            "synthesisKey": item["synthesisKey"],
            "responseItemRequestId": item.get("responseItemRequestId") or item["itemRequestId"],
            "reusedFromOperationId": item.get("reusedFromOperationId", ""),
            "raw": raw,
            "decoded": {**DECODED_PROFILE, "sampleCount": decoded_sample_count(raw_path)},
        }
        source_range = plan_group.get("sourceRange")
        if source_range is not None:
            entry["sourceRange"] = dict(source_range)
        metadata_path = item.get("metadataPath")
        if not isinstance(metadata_path, str) or not metadata_path:
            raise ValueError(f"voice 组 {group_id} 的原始响应 metadata 缺失，不能登记来源。")
        meta = Path(metadata_path).resolve()
        if not meta.is_file():
            raise ValueError(f"voice 组 {group_id} 的原始响应 metadata 缺失，不能登记来源。")
        meta_reference = _file_reference(meta, node_root, "application/json")
        if meta_reference["sha256"] != item.get("metadataSha256"):
            raise ValueError(f"voice 组 {group_id} 的原始响应 metadata 与账本摘要不一致。")
        try:
            response = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError(f"voice 组 {group_id} 的原始响应 metadata 无法核验。") from error
        response_item_request_id = item.get("responseItemRequestId") or item["itemRequestId"]
        if not isinstance(response, dict) or response.get("request") != {
            "itemRequestId": response_item_request_id,
            "synthesisKey": item["synthesisKey"],
        } or response.get("audio_sha256") != raw["sha256"] \
                or response.get("audio_size_bytes") != raw["byteSize"]:
            raise ValueError(f"voice 组 {group_id} 的原始响应 metadata 与音频或响应身份不一致。")
        entry["meta"] = meta_reference
        groups.append(entry)
    ledger_snapshot_path = output_dir / "voice-operation-snapshot.json"
    shutil.copyfile(ledger_path, ledger_snapshot_path)
    manifest: dict[str, Any] = {
        "version": MANIFEST_VERSION,
        "runId": run_id,
        "nodeId": node_id,
        "sourceOperationId": source_operation_id,
        "voiceInputVersionId": voice_input_version_id,
        "sourceContextId": source_context_id,
        "narrationPlan": {"version": narration_plan.get("version"), "sha256": narration_plan_sha256,
                          "relativePath": _relative_within_root(narration_plan_path, node_root)},
        "script": {"artifactId": script_artifact_id, "outputVersionId": script_output_version_id, "sha256": script_sha256},
        "visualPlan": {"artifactId": visual_artifact_id, "outputVersionId": visual_output_version_id, "sha256": visual_sha256},
        "parentArtifactIds": list(parent_artifact_ids),
        "upstreamVersionIds": list(upstream_version_ids),
        "synthesis": dict(synthesis),
        "ledger": {"operationId": ledger.get("operationId"), "version": ledger.get("version"),
                   "identity": ledger.get("identity"), "actualCostSource": ledger.get("actualCostSource"),
                   "snapshot": _file_reference(ledger_snapshot_path, node_root, "application/json")},
        "groups": groups,
        "allAudioMaterialized": True,
        # 未独立核过的供应商实付保持未知；本地重排不改写原合成费用。
        "costProvenance": {"actualCostSource": ledger.get("actualCostSource"), "actualCostCny": ledger.get("actualCostCny"),
                           "providerSettled": None},
    }
    manifest["manifestSha256"] = _digest(manifest)
    return manifest


def write_materialized_manifest(manifest: dict[str, Any], output_dir: Path) -> Path:
    target = output_dir / "materialized_voice_source.json"
    _write_json_durably(target, manifest)
    return target


def read_materialized_manifest(path: Path, node_root: Path) -> dict[str, Any]:
    """读取并核验清单：自身摘要一致、全部引用 realpath 落在节点根内且 SHA 匹配。"""
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != MANIFEST_VERSION:
        raise ValueError("voice 来源清单版本未知。")
    recorded = manifest.get("manifestSha256")
    body = {key: value for key, value in manifest.items() if key != "manifestSha256"}
    if recorded != _digest(body):
        raise ValueError("voice 来源清单的完整摘要不一致。")
    node_root = node_root.resolve()

    def verify_reference(reference: Any, label: str, content_type: str) -> Path:
        if not isinstance(reference, dict):
            raise ValueError(f"voice 来源清单缺少{label}引用。")
        relative_path = reference.get("relativePath")
        if not isinstance(relative_path, str) or not relative_path:
            raise ValueError(f"voice 来源清单的{label}路径无效。")
        resolved = (node_root / relative_path).resolve()
        if not resolved.is_relative_to(node_root) or not resolved.is_file():
            raise ValueError(f"voice 来源引用越出节点根或缺失：{relative_path}")
        data = resolved.read_bytes()
        if hashlib.sha256(data).hexdigest() != reference.get("sha256"):
            raise ValueError(f"voice 来源引用与登记的 SHA 不一致：{relative_path}")
        if reference.get("byteSize") != len(data) or reference.get("contentType") != content_type:
            raise ValueError(f"voice 来源引用的大小或类型不一致：{relative_path}")
        return resolved

    groups = manifest.get("groups")
    if not isinstance(groups, list):
        raise ValueError("voice 来源清单的 groups 必须是列表。")
    for entry in groups:
        if not isinstance(entry, dict):
            raise ValueError("voice 来源清单的组记录无效。")
        raw_path = verify_reference(entry.get("raw"), "原始音频", "audio/mpeg")
        meta_path = verify_reference(entry.get("meta"), "原始响应 metadata", "application/json")
        try:
            response = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError("voice 来源清单的原始响应 metadata 无法解析。") from error
        if not isinstance(response, dict) or response.get("request") != {
            "itemRequestId": entry.get("responseItemRequestId"),
            "synthesisKey": entry.get("synthesisKey"),
        } or response.get("audio_sha256") != entry["raw"].get("sha256") \
                or response.get("audio_size_bytes") != raw_path.stat().st_size:
            raise ValueError("voice 来源清单的原始响应 metadata 与音频或响应身份不一致。")
    ledger = manifest.get("ledger")
    if not isinstance(ledger, dict):
        raise ValueError("voice 来源清单缺少原账本引用。")
    verify_reference(ledger.get("snapshot"), "账本快照", "application/json")
    if manifest.get("allAudioMaterialized") is not True:
        raise ValueError("voice 来源清单不是全组物化状态。")
    return manifest


def verify_materialized_manifest(
    manifest: dict[str, Any], node_root: Path, *,
    run_id: str, node_id: str, source_operation_id: str,
    voice_input_version_id: str | None, source_context_id: str | None,
    script_artifact_id: str | None, script_output_version_id: str | None, script_sha256: str,
    visual_artifact_id: str | None, visual_output_version_id: str | None, visual_sha256: str,
    upstream_version_ids: list[str],
    narration_plan: dict[str, Any], narration_plan_path: Path,
) -> None:
    """§4.2.4 来源闭环核验：排轨/恢复消费清单前的完整对账，read_ 只做结构层。

    逐项核：本 run/voice/原 operation/实际 input/sourceContext；script/visual 的 artifact
    与各自 outputVersion（同字节新上游版本也不继承旧身份）；原计划文件字节 SHA 与逐组
    数量/顺序/ID/text/range/scene 归属；账本快照的逐组响应身份与完成状态。任一不符即拒绝，
    不回填猜测、不把当前 SHA 重算后当原证据。
    """
    node_root = node_root.resolve()
    # 调用方先用 read_materialized_manifest 完成结构层核验（摘要/引用根内/SHA），
    # 本函数补齐身份与全组对账层；两层任一失败都在排轨/恢复执行前拒绝。
    if manifest.get("runId") != run_id or manifest.get("nodeId") != node_id:
        raise ValueError("voice 来源清单不属于当前 run/节点。")
    if manifest.get("sourceOperationId") != source_operation_id:
        raise ValueError("voice 来源清单的原操作身份与本次请求不一致。")
    if manifest.get("voiceInputVersionId") != voice_input_version_id:
        raise ValueError("voice 来源清单的声音输入版本与当前有效输入不一致。")
    if (manifest.get("sourceContextId") or None) != (source_context_id or None):
        raise ValueError("voice 来源清单的来源上下文与当前请求不一致。")
    for key, expected_id, expected_version, expected_sha in (
        ("script", script_artifact_id, script_output_version_id, script_sha256),
        ("visualPlan", visual_artifact_id, visual_output_version_id, visual_sha256),
    ):
        recorded = manifest.get(key) or {}
        if recorded.get("artifactId") != expected_id or recorded.get("outputVersionId") != expected_version:
            raise ValueError(f"voice 来源清单的{key}上游产物身份与当前有效版本不一致。")
        if recorded.get("sha256") != expected_sha:
            raise ValueError(f"voice 来源清单的{key}内容摘要与当前文件不一致。")
    if list(manifest.get("upstreamVersionIds") or []) != list(upstream_version_ids):
        raise ValueError("voice 来源清单的上游版本集合与当前请求不一致。")
    plan_reference = manifest.get("narrationPlan") or {}
    if plan_reference.get("version") != narration_plan.get("version"):
        raise ValueError("voice 来源清单绑定的计划版本与受核原计划不一致。")
    if hashlib.sha256(Path(narration_plan_path).read_bytes()).hexdigest() != plan_reference.get("sha256"):
        raise ValueError("voice 来源清单绑定的计划文件字节 SHA 与受核原计划不一致。")
    resolved_plan = Path(narration_plan_path).resolve()
    if not resolved_plan.is_relative_to(node_root) or not resolved_plan.is_file():
        raise ValueError("受核原计划文件必须位于节点根内。")
    plan_groups = narration_plan.get("groups") or []
    entries = manifest.get("groups") or []
    if [entry.get("groupId") for entry in entries] != [group.get("id") for group in plan_groups]:
        raise ValueError("voice 来源清单与原计划的组数量、顺序或身份不一致（漏组/重复组）。")
    for entry, group in zip(entries, plan_groups):
        if entry.get("sourceScenePositions") != list(group.get("sourceScenePositions") or []):
            raise ValueError(f"voice 组 {group.get('id')} 的镜头归属与原计划不一致。")
        if entry.get("textSha256") != hashlib.sha256(str(group.get("text", "")).encode("utf-8")).hexdigest():
            raise ValueError(f"voice 组 {group.get('id')} 的文字摘要与原计划不一致。")
        recorded_range = entry.get("sourceRange")
        plan_range = group.get("sourceRange")
        if (recorded_range or None) != (plan_range or None):
            raise ValueError(f"voice 组 {group.get('id')} 的来源范围与原计划不一致。")
        decoded = entry.get("decoded") or {}
        if not isinstance(decoded.get("sampleCount"), int) or isinstance(decoded.get("sampleCount"), bool) \
                or decoded.get("sampleCount") <= 0:
            raise ValueError(f"voice 组 {group.get('id')} 缺少真实解码样本数。")
    ledger_reference = manifest.get("ledger") or {}
    snapshot_reference = ledger_reference.get("snapshot") or {}
    snapshot_path = (node_root / str(snapshot_reference.get("relativePath", ""))).resolve()
    if not snapshot_path.is_relative_to(node_root) or not snapshot_path.is_file():
        raise ValueError("voice 来源清单的账本快照缺失或越出节点根。")
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    snapshot_items = snapshot.get("items") if isinstance(snapshot, dict) else None
    if not isinstance(snapshot_items, list) or snapshot.get("operationId") != source_operation_id:
        raise ValueError("voice 来源清单的账本快照与原操作不一致。")
    if ledger_reference.get("operationId") != source_operation_id \
            or ledger_reference.get("version") != snapshot.get("version") \
            or ledger_reference.get("identity") != snapshot.get("identity"):
        raise ValueError("voice 来源清单登记的账本身份与不可变快照不一致。")
    if snapshot.get("completed") is not True:
        raise ValueError("voice 来源清单的账本快照不是完成状态（unknown 账本不能排轨）。")
    if [item.get("groupId") for item in snapshot_items] != [entry.get("groupId") for entry in entries]:
        raise ValueError("voice 来源清单与账本快照的组对应不一致。")
    for item, entry in zip(snapshot_items, entries):
        if item.get("state") != "materialized":
            raise ValueError(f"voice 组 {entry.get('groupId')} 在账本快照中不是已完成物化状态。")
        for field in ("itemRequestId", "synthesisKey", "responseItemRequestId"):
            if item.get(field) != entry.get(field):
                raise ValueError(f"voice 组 {entry.get('groupId')} 的响应身份（{field}）与账本快照不一致。")
        if (item.get("reusedFromOperationId") or "") != (entry.get("reusedFromOperationId") or ""):
            raise ValueError(f"voice 组 {entry.get('groupId')} 的复用来源与账本快照不一致。")


def build_source_receipt(
    *, reason: str, run_id: str, node_id: str, source_operation_id: str,
    voice_input_version_id: str | None, source_context_id: str | None,
    manifest_artifact_id: str | None, manifest_sha256: str,
    narration_plan_version: str, narration_plan_sha256: str,
    script_sha256: str, visual_sha256: str,
    upstream_version_ids: list[str],
) -> dict[str, Any]:
    """首次排轨失败的可恢复来源收据：不是成功声音输出，不得把 voice 标为 succeeded。

    §4.2.4 计划引用必须是受核原计划自身的 version 与**计划文件字节 SHA**；
    manifestArtifactId 由宿主正式登记后回填，worker 侧保持 None 而不伪造。
    """
    if reason not in ("first_fit_conflict", "layout_incomplete"):
        raise ValueError("voice 来源收据原因未知。")
    return {
        "version": RECEIPT_VERSION,
        "reason": reason,
        "runId": run_id,
        "nodeId": node_id,
        "sourceOperationId": source_operation_id,
        "voiceInputVersionId": voice_input_version_id,
        "sourceContextId": source_context_id,
        # 正式 artifactId 由 Pipeline 登记时建立；worker 侧以清单完整摘要绑定同一份事实。
        "manifestArtifactId": manifest_artifact_id,
        "manifestSha256": manifest_sha256,
        "narrationPlan": {"version": narration_plan_version, "sha256": narration_plan_sha256},
        "script": {"sha256": script_sha256},
        "visualPlan": {"sha256": visual_sha256},
        "upstreamVersionIds": list(upstream_version_ids),
    }
