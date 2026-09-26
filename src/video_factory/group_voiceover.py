"""连续配音组的耐久合成与复用；排轨、镜头编号和全片脚本不使原音频失效。"""

import hashlib
import json
import math
import os
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from typing import Any

from .voiceover import (
    _MiniMaxTerminalError, _execute_minimax_audio_request, _minimax_audio_payload,
    _minimax_operation_lock, _minimax_reuse_lock, _prepare_minimax_audio_request,
    _verified_materialized_minimax_path, _write_json_durably,
)

VERSION = "video-factory/voice-operation-v3"
# 2026-09-27 官方按量价；仅作配置价估算，资源包折扣/实际扣费仍需服务商核账。
# https://platform.minimaxi.com/docs/guides/pricing-paygo
UNIT_PRICES = {f"speech-{version}-{tier}": price
               for version in ("2.8", "2.6", "02") for tier, price in (("turbo", "2.00"), ("hd", "3.50"))}
# 与 Studio 已提供的系统音色一致；自定义/克隆音色可能另收首次使用费，不借字符报价放行。
SYSTEM_VOICES = frozenset({"Chinese (Mandarin)_News_Anchor", "Chinese (Mandarin)_Reliable_Executive",
                         "male-qn-qingse", "male-qn-jingying", "male-qn-daxuesheng", "female-shaonv",
                         "female-yujie", "female-chengshu", "female-tianmei"})


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _estimate(units: int, unit_price: str) -> float:
    return float((Decimal(units) * Decimal(unit_price) / 10_000).quantize(Decimal("0.01"), rounding=ROUND_CEILING))


def _group_items(plan: dict[str, Any], *, operation_id: str, voice: str, rate: int,
                 pause_scale: float, model_id: str, provider_id: str) -> list[dict[str, Any]]:
    if model_id not in UNIT_PRICES:
        raise ValueError("This voice model has no reviewed group pricing; configure a supported quote before synthesis.")
    if voice not in SYSTEM_VOICES:
        raise ValueError("Continuous narration currently requires a reviewed system voice; cloning fees are not authorized.")
    endpoint = (os.environ.get("MINIMAX_TTS_BASE_URL") or "https://api.minimaxi.com/v1").rstrip("/")
    items = []
    for group in plan["groups"]:
        payload = _minimax_audio_payload(group["text"], voice, rate, pause_scale, model_id, subtitle_enable=True)
        key = _digest({"provider": provider_id, "endpoint": endpoint, "payload": payload})
        # 汉字按2、其他字符按1计费；统一按每个输入字符2计，作为发送前的保守上界。
        units = len(payload["text"]) * 2
        items.append({
            "groupId": group["id"], "sourceScenePositions": group["sourceScenePositions"],
            "itemRequestId": "voice-group-" + _digest([operation_id, group["id"], key])[:32],
            "synthesisKey": key, "providerId": provider_id, "modelId": model_id,
            "quote": {"unit": "10000_characters", "unitPriceCny": UNIT_PRICES[model_id],
                      "estimatedUnits": units, "maxCostCny": _estimate(units, UNIT_PRICES[model_id])},
            "state": "prepared", "stateHistory": ["prepared"],
        })
    return items


def forecast_minimax_groups(plan: dict[str, Any], node_root: Path, *, voice: str, rate: int,
                            pause_scale: float, model_id: str, provider_id: str = "minimax-tts-v1") -> dict[str, Any]:
    """只读报价与实际合成使用相同文本转换、价格及音频身份；执行时仍在锁内重新核验。"""
    items = _group_items(plan, operation_id="quote-only", voice=voice, rate=rate, pause_scale=pause_scale,
                        model_id=model_id, provider_id=provider_id)
    preview = {"items": items}
    _reuse_groups(preview, node_root.resolve() / ".voice-operations" / "quote-only", node_root.resolve())
    result = [{"groupId": item["groupId"], "estimatedUnits": item["quote"]["estimatedUnits"],
               "maxCostCny": 0 if item["state"] == "materialized" else item["quote"]["maxCostCny"],
               "reused": item["state"] == "materialized"} for item in items]
    total = round(sum(item["maxCostCny"] for item in result), 2)
    return {"estimatedCostCny": total, "maxCostCny": total, "unitPriceCny": UNIT_PRICES[model_id],
            "source": "configured_rate", "items": result}


def synthesize_minimax_groups(
    plan: dict[str, Any], output_dir: Path, *, operation_id: str, voice: str, rate: int,
    pause_scale: float, model_id: str, authorization_cny: float, provider_id: str = "minimax-tts-v1",
) -> dict[str, Any]:
    if (not operation_id or not isinstance(authorization_cny, (int, float)) or isinstance(authorization_cny, bool)
            or not math.isfinite(authorization_cny) or authorization_cny < 0):
        raise ValueError("Group voice synthesis requires an operation identity and a finite authorization limit.")
    items = _group_items(plan, operation_id=operation_id, voice=voice, rate=rate, pause_scale=pause_scale,
                        model_id=model_id, provider_id=provider_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    node_root = output_dir.parent.resolve()
    ledger_path = node_root / ".voice-operations" / (hashlib.sha256(operation_id.encode()).hexdigest() + ".json")
    endpoint = (os.environ.get("MINIMAX_TTS_BASE_URL") or "https://api.minimaxi.com/v1").rstrip("/")
    identity = _digest({"operationId": operation_id, "plan": plan, "items": items,
                        "authorizationCny": authorization_cny})
    with _minimax_operation_lock(ledger_path):
        if ledger_path.is_file():
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            if (ledger.get("version") != VERSION or ledger.get("identity") != identity
                    or not isinstance(ledger.get("items"), list) or len(ledger["items"]) != len(items)
                    or any(not isinstance(saved, dict) or any(saved.get(key) != expected[key]
                           for key in ("groupId", "itemRequestId", "synthesisKey", "quote"))
                           for saved, expected in zip(ledger["items"], items))):
                raise RuntimeError("The original voice operation is bound to a different confirmed plan.")
        else:
            ledger = {"version": VERSION, "operationId": operation_id, "identity": identity,
                      "providerId": provider_id, "modelId": model_id, "authorizationCny": authorization_cny,
                      "estimatedCostCny": 0, "items": items, "completed": False}
            with _minimax_reuse_lock(ledger_path.parent):
                _reuse_groups(ledger, ledger_path, node_root)
                ledger["estimatedCostCny"] = round(sum(item["quote"]["maxCostCny"] for item in items
                                                       if item["state"] == "prepared"), 2)
                if ledger["estimatedCostCny"] > authorization_cny:
                    raise RuntimeError("Group narration exceeds its authorized amount; request approval before synthesis.")
                _write_json_durably(ledger_path, ledger)
        for group, item in zip(plan["groups"], ledger["items"]):
            if item["state"] == "materialized":
                _verified_materialized_minimax_path(item, node_root)
                continue
            if item["state"] == "unknown":
                # 受理后已完整保存响应，只是最后记账失败：仅采用本地证据，不重发请求。
                response = _verified_response(item, node_root)
                if response is not None:
                    _record_group(ledger, item, response, ledger_path)
                    continue
            if item["state"] != "prepared":
                raise RuntimeError("The original voice request is unsettled or failed; refusing another paid request.")
            if round(ledger.get("actualCostCny", 0) + item["quote"]["maxCostCny"], 2) > authorization_cny:
                raise RuntimeError("The remaining voice authorization is insufficient; keep existing audio and request approval.")
            request = _prepare_minimax_audio_request(group["text"], voice, rate, pause_scale,
                                                     model=model_id, base_url=endpoint, subtitle_enable=True)
            raw = output_dir / f"{item['itemRequestId']}.mp3"
            metadata = raw.with_suffix(".response.json")
            item["pendingRawPath"], item["metadataPath"] = str(raw.resolve()), str(metadata.resolve())
            item["state"] = "unknown"
            item["stateHistory"].append("unknown")
            _write_json_durably(ledger_path, ledger)
            try:
                _execute_minimax_audio_request(request, raw, metadata_path=metadata, response_binding=_response_binding(item))
            except _MiniMaxTerminalError:
                item["state"] = "terminal_failed"
                item["stateHistory"].append("terminal_failed")
                _write_json_durably(ledger_path, ledger)
                raise
            response = _verified_response(item, node_root)
            if response is None:
                raise RuntimeError("The paid audio response cannot be verified; keep it and do not resubmit.")
            _record_group(ledger, item, response, ledger_path)
        return {"rawAudio": {item["groupId"]: _verified_materialized_minimax_path(item, node_root)
                             for item in ledger["items"]}, "ledgerPath": str(ledger_path)}


def _reuse_groups(ledger: dict[str, Any], ledger_path: Path, node_root: Path) -> None:
    for candidate_path in sorted(ledger_path.parent.glob("*.json")):
        candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
        if not isinstance(candidate, dict) or not isinstance(candidate.get("items"), list):
            raise RuntimeError("Cannot verify an existing voice operation; do not create another paid request.")
        for prior in candidate["items"]:
            if not isinstance(prior, dict):
                raise RuntimeError("Cannot verify an existing voice item.")
            if prior.get("state") in ("unknown", "submitted", "provider_succeeded", "prepared"):
                raise RuntimeError("An earlier voice operation is unsettled; do not bypass it with a new plan.")
            if candidate.get("version") != VERSION or prior.get("state") != "materialized":
                continue
            for item in ledger["items"]:
                if item["state"] == "materialized" or prior.get("synthesisKey") != item["synthesisKey"]:
                    continue
                raw = _verified_materialized_minimax_path(prior, node_root)
                item.update({"state": "materialized", "stateHistory": ["prepared", "reused_materialized"],
                             "localPath": str(raw), "sha256": prior["sha256"], "sizeBytes": prior["sizeBytes"],
                             "reusedFromOperationId": candidate["operationId"],
                             "reusedFromItemRequestId": prior["itemRequestId"],
                             # 复用来源用于费用追溯；响应身份始终属于最初那次合成，不能随复用次数变化。
                             "responseItemRequestId": prior.get("responseItemRequestId", prior.get("reusedFromItemRequestId", prior["itemRequestId"])),
                             "actualCostCny": 0})
                for field in ("metadataPath", "metadataSha256"):
                    if field in prior:
                        item[field] = prior[field]
    ledger["completed"] = all(item["state"] == "materialized" for item in ledger["items"])
    ledger["actualCostCny"] = 0
    ledger["actualCostSource"] = "configured_rate"


def _response_binding(item: dict[str, Any]) -> dict[str, str]:
    return {key: item[key] for key in ("itemRequestId", "synthesisKey")}


def _verified_response(item: dict[str, Any], node_root: Path) -> dict[str, Any] | None:
    raw, metadata = Path(item.get("pendingRawPath", "")).resolve(), Path(item.get("metadataPath", "")).resolve()
    if (not raw.is_relative_to(node_root) or not metadata.is_relative_to(node_root)
            or not raw.is_file() or not metadata.is_file()):
        return None
    try:
        response = json.loads(metadata.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if (not isinstance(response, dict) or response.get("request") != _response_binding(item)
            or response.get("audio_size_bytes") != raw.stat().st_size
            or response.get("audio_sha256") != hashlib.sha256(raw.read_bytes()).hexdigest()):
        return None
    return response


def _record_group(ledger: dict[str, Any], item: dict[str, Any], response: dict[str, Any], ledger_path: Path) -> None:
    item.update({"state": "materialized", "localPath": item["pendingRawPath"],
                 "responseItemRequestId": item["itemRequestId"],
                 "sha256": response["audio_sha256"], "sizeBytes": response["audio_size_bytes"],
                 "metadataSha256": hashlib.sha256(Path(item["metadataPath"]).read_bytes()).hexdigest(),
                 "actualCostCny": item["quote"]["maxCostCny"], "actualCostSource": "configured_rate"})
    extra = response.get("extra_info")
    usage = extra.get("usage_characters") if isinstance(extra, dict) else None
    if type(usage) is int and usage >= 0:
        item["usageCharacters"] = usage
        item["actualCostCny"] = _estimate(usage, item["quote"]["unitPriceCny"])
    item["stateHistory"].append("materialized")
    ledger["actualCostCny"] = round(sum(row.get("actualCostCny", 0) for row in ledger["items"]), 2)
    ledger["actualCostSource"] = "configured_rate"
    ledger["completed"] = all(row["state"] == "materialized" for row in ledger["items"])
    _write_json_durably(ledger_path, ledger)
