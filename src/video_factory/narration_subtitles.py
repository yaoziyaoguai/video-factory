"""保存同次合成的原始字幕证据；未核实服务商 cue 合同前绝不猜时间。"""

import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request

from .asset_transport import open_asset_request
from .voiceover import _write_bytes_durably, _write_json_durably

MAX_SUBTITLE_BYTES = 1024 * 1024


def capture_subtitle_evidence(ledger_path: Path, node_root: Path) -> dict:
    result = {"status": "unavailable", "cues": [], "evidence": [],
              "reason": "同步字幕尚未核实；不会使用逐镜旁白冒充对齐字幕。"}
    node_root = node_root.resolve()
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        for item in ledger["items"]:
            result["evidence"].append(_capture_group(item, node_root))
    except (OSError, ValueError, KeyError, TypeError):
        # 配音已经成功，字幕证据失败不得变成再次调用 TTS 的理由。
        result["reason"] = "字幕证据暂时无法读取；已生成配音保留，不会自动重新合成。"
    return result


def _capture_group(item: dict, node_root: Path) -> dict:
    unavailable = {"groupId": item["groupId"], "status": "unavailable"}
    metadata_path = Path(item.get("metadataPath", "")).resolve()
    if not metadata_path.is_relative_to(node_root) or not metadata_path.is_file():
        return unavailable
    metadata_bytes = metadata_path.read_bytes()
    if hashlib.sha256(metadata_bytes).hexdigest() != item.get("metadataSha256"):
        return unavailable
    metadata = json.loads(metadata_bytes)
    request = metadata.get("request")
    if (metadata.get("audio_sha256") != item.get("sha256") or not isinstance(request, dict)
            or request.get("synthesisKey") != item.get("synthesisKey")
            or request.get("itemRequestId") != item.get("responseItemRequestId", item.get("reusedFromItemRequestId", item.get("itemRequestId")))):
        return unavailable
    subtitle_url = metadata.get("subtitle_file")
    if not isinstance(subtitle_url, str) or urlsplit(subtitle_url).scheme != "https":
        return unavailable
    # URL 不进入 UI 或异常；缓存绑定本次音频与原始响应，不能跨音频借用字幕。
    binding = {"audioSha256": item["sha256"], "metadataSha256": item["metadataSha256"]}
    key = hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()
    directory = node_root / ".subtitle-evidence"
    target, receipt = directory / f"{key}.json", directory / f"{key}.receipt.json"
    if receipt.is_file():
        saved = json.loads(receipt.read_text())
        if saved.get("binding") != binding:
            return unavailable
        if saved.get("status") != "captured_unverified":
            return unavailable
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != saved.get("sha256"):
            return unavailable
        return {"groupId": item["groupId"], "status": "captured_unverified", "path": str(target), "sha256": saved["sha256"]}
    directory.mkdir(parents=True, exist_ok=True)
    try:
        # 复用已有 SSRF/DNS 固定/跳转/代理防护，单次下载最多15秒、1MiB，无携带鉴权。
        with open_asset_request(Request(subtitle_url, headers={"Accept": "application/json"}), timeout=15) as response:
            content = response.read(MAX_SUBTITLE_BYTES + 1)
        if len(content) > MAX_SUBTITLE_BYTES:
            raise ValueError("Subtitle response is too large.")
        json.loads(content)
        _write_bytes_durably(target, content)
        sha256 = hashlib.sha256(content).hexdigest()
        _write_json_durably(receipt, {"binding": binding, "status": "captured_unverified", "sha256": sha256})
        return {"groupId": item["groupId"], "status": "captured_unverified", "path": str(target), "sha256": sha256}
    except (OSError, ValueError, RuntimeError):
        _write_json_durably(receipt, {"binding": binding, "status": "unavailable"})
        return unavailable
