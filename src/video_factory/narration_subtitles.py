"""保存同次合成的原始字幕证据；未核实服务商 cue 合同前绝不猜时间。"""

import hashlib
import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request

from .asset_transport import open_asset_request
from .voiceover import _minimax_operation_lock as _subtitle_evidence_lock
from .voiceover import _write_bytes_durably, _write_json_durably

MAX_SUBTITLE_BYTES = 1024 * 1024
SUBTITLES_CONTRACT_VERSION = "video-factory/narration-subtitles-v1"
SAMPLE_RATE = 44100
SAMPLES_PER_FRAME = 1470
MAX_CUE_TEXT = 500


def _parse_internal_sample_cues(raw: bytes) -> list[dict]:
    """内部规范化 cue 夹具（video-factory/internal-sample-cues-v1）。

    只用于消费链测试与已规范化 cue 文件的恢复；它不是服务商协议验收，
    也不是任何真实 TTS 响应的形状。
    """
    document = json.loads(raw)
    if not isinstance(document, dict) or document.get("version") != "video-factory/internal-sample-cues-v1":
        raise ValueError("sample cue document must declare the internal sample-cues version")
    return _validated_seconds_cues(document.get("cues"))


def _validated_seconds_cues(cues: object) -> list[dict]:
    if not isinstance(cues, list):
        raise ValueError("cues must be a list")
    validated: list[dict] = []
    previous_end = -1.0
    for cue in cues:
        if not isinstance(cue, dict):
            raise ValueError("each cue must be an object")
        text = cue.get("text")
        start = cue.get("start")
        end = cue.get("end")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_CUE_TEXT:
            raise ValueError("cue text must be a non-empty string within the length cap")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            raise ValueError("cue times must be numbers in seconds")
        start_f, end_f = float(start), float(end)
        if not math.isfinite(start_f) or not math.isfinite(end_f) or start_f < 0 or end_f <= start_f:
            raise ValueError("cue times must be finite, non-negative, and end after start")
        if start_f < previous_end:
            raise ValueError("cues must be ordered and non-overlapping")
        previous_end = end_f
        validated.append({"start": start_f, "end": end_f, "text": text.strip()})
    return validated


def _parse_minimax_sentence_cues(raw: bytes) -> list[dict]:
    """MiniMax 同次 TTS 字幕（subtitle_type=sentence，2026-09-27 实测核实）。

    已核实事实：顶层为 cue 数组；每个 cue 带 text、time_begin、time_end，
    时间单位为毫秒、原点为本次音频起点、粒度为句。字段以实测样本
    （.local 证据 T05，sha256 be29c171…a6e）为准；不含跨句或词级证据。
    """
    document = json.loads(raw)
    if not isinstance(document, list):
        raise ValueError("minimax subtitle document must be a cue array")
    cues: list[dict] = []
    previous_end = -1.0
    for cue in document:
        if not isinstance(cue, dict):
            raise ValueError("each minimax cue must be an object")
        text = cue.get("text")
        begin = cue.get("time_begin")
        end = cue.get("time_end")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_CUE_TEXT:
            raise ValueError("minimax cue text must be a non-empty string within the length cap")
        if not isinstance(begin, (int, float)) or not isinstance(end, (int, float)):
            raise ValueError("minimax cue times must be numbers in milliseconds")
        start_s, end_s = float(begin) / 1000, float(end) / 1000
        if not math.isfinite(start_s) or not math.isfinite(end_s) or start_s < 0 or end_s <= start_s:
            raise ValueError("minimax cue times must be finite, non-negative, and end after start")
        if start_s < previous_end:
            raise ValueError("minimax cues must be ordered and non-overlapping")
        previous_end = end_s
        cues.append({"start": start_s, "end": end_s, "text": text.strip()})
    return cues


# 已核实的字幕协议 adapter 清单。minimax-subtitles-v1 已于 2026-09-27 以最小真实
# 采样核实（句级、毫秒、音频起点原点）；内部规范化夹具仅用于消费链测试与已规范化
# 文件的受控恢复，不冒充服务商响应。
_VERIFIED_ADAPTERS = {
    "video-factory/internal-sample-cues-v1": _parse_internal_sample_cues,
    "minimax-subtitles-v1": _parse_minimax_sentence_cues,
}


def parse_provider_subtitle_cues(raw: bytes, *, adapter_version: str) -> dict:
    """只处理已核实协议；未知 schema 一律 unavailable，绝不猜时间单位。"""
    parser = _VERIFIED_ADAPTERS.get(adapter_version)
    if parser is None:
        return {"status": "unavailable", "reason": "provider_schema_unverified", "cues": []}
    try:
        cues = parser(raw)
    except (ValueError, TypeError):
        return {"status": "unavailable", "reason": "invalid_cue_document", "cues": []}
    return {"status": "verified", "reason": None, "cues": cues, "adapterVersion": adapter_version}


def map_cues_to_narration_timeline(
    cues: list[dict],
    group: dict,
    *,
    sample_rate: int = SAMPLE_RATE,
) -> list[dict]:
    """把规范化秒制 cue 映射到已确认排轨的 sample 时轴。

    group 必须来自 assemble_narration_track 的输出（真实 startSample、源音频样本数、
    画面窗口）；映射只做坐标换算与边界校验，不截断、不缩放、不改音频速度。
    """
    for field in ("startSample", "sourceAudioSamples"):
        value = group.get(field)
        if not isinstance(value, int) or value < 0:
            raise ValueError(f"narration group is missing a valid '{field}'")
    start_sample = group["startSample"]
    source_samples = group["sourceAudioSamples"]
    window = group.get("window") or {}
    window_end_sample = None
    if isinstance(window.get("endFrame"), int):
        window_end_sample = window["endFrame"] * SAMPLES_PER_FRAME
    mapped: list[dict] = []
    for cue in cues:
        start = cue["start"]
        end = cue["end"]
        local_start = math.floor(start * sample_rate)
        local_end = math.ceil(end * sample_rate)
        if local_start < 0 or local_end <= local_start:
            raise ValueError("cue maps to an empty or negative sample range")
        if local_end > source_samples:
            raise ValueError("cue extends beyond the original group audio; refusing to truncate")
        if window_end_sample is not None and start_sample + local_end > window_end_sample:
            raise ValueError("cue extends beyond the confirmed narration window")
        mapped.append({
            "groupId": group.get("id"),
            "text": cue["text"],
            "localStartSample": local_start,
            "localEndSample": local_end,
            "startSample": start_sample + local_start,
            "endSample": start_sample + local_end,
        })
    return mapped


def cues_to_vtt(cues: list[dict]) -> str:
    """预览/旁挂用 WebVTT；sample 坐标是权威时轴，这里只做展示换算。"""
    lines = ["WEBVTT", ""]
    for index, cue in enumerate(cues, start=1):
        lines.append(str(index))
        lines.append(f"{_vtt_time(cue['startSample'])} --> {_vtt_time(cue['endSample'])}")
        lines.append(cue["text"])
        lines.append("")
    return "\n".join(lines)


def _vtt_time(samples: int, sample_rate: int = SAMPLE_RATE) -> str:
    total_ms = round(samples * 1000 / sample_rate)
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def cues_to_ass(cues: list[dict], *, width: int = 1080, height: int = 1920, font_name: str = "PingFang SC", font_size: int = 56) -> str:
    """烧录用 ASS（PlayRes 与成片一致）；文本按 ASS 规则转义。"""
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Narration,{_ass_escape(font_name)},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,0,0,0,0,100,100,0,0,1,2,0,2,{round(60 * width / 1080)},{round(60 * width / 1080)},{round(180 * height / 1920)},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = []
    for cue in cues:
        start = _ass_time(cue["startSample"])
        end = _ass_time(cue["endSample"])
        events.append(f"Dialogue: 0,{start},{end},Narration,,0,0,0,,{_ass_escape(cue['text'])}")
    return header + "\n".join(events) + "\n"


def _ass_time(samples: int, sample_rate: int = SAMPLE_RATE) -> str:
    total_cs = round(samples * 100 / sample_rate)
    hours, remainder = divmod(total_cs, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    seconds, centis = divmod(remainder, 100)
    return f"{hours:d}:{minutes:02d}:{seconds:02d}.{centis:02d}"


def _ass_escape(text: str) -> str:
    # ASS 特殊字符：换行显式转 \N，花括号转义防止被当覆盖标签；不改变文本内容。
    escaped = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    return re.sub(r"\s*\n\s*", lambda _match: "\\N", escaped)


def build_group_subtitles(
    ledger_path: Path,
    node_root: Path,
    assembled: dict,
    *,
    narration_plan_sha256: str,
    adapter_version: str,
    refetch_reason: str | None = None,
    allow_initial_download: bool = True,
) -> dict:
    """把已捕获的字幕证据经已核实 adapter 解析并映射到总时轴；任何缺失都如实保持不可用。"""
    groups_by_id = {group["id"]: group for group in assembled.get("groups", [])}
    evidence_result = capture_subtitle_evidence(ledger_path, node_root,
        refetch_reason=refetch_reason, allow_initial_download=allow_initial_download)
    contract = {
        "version": SUBTITLES_CONTRACT_VERSION,
        "status": "unavailable",
        "adapterVersion": adapter_version,
        "acceptedNarrationPlanSha256": narration_plan_sha256,
        "script": assembled.get("narrationPlan", {}).get("script"),
        "visualPlan": assembled.get("narrationPlan", {}).get("visualPlan"),
        "layoutKey": assembled.get("layoutKey"),
        "clock": {"sampleRate": SAMPLE_RATE},
        "groups": [],
        "reason": evidence_result.get("reason"),
        "cues": [],
    }
    cues: list[dict] = []
    for evidence in evidence_result.get("evidence", []):
        group_id = evidence.get("groupId")
        entry = {key: evidence.get(key) for key in ("groupId", "status", "audioSha256", "metadataSha256",
            "sourceRequestId", "synthesisKey")}
        group = groups_by_id.get(group_id)
        if group is None:
            entry["status"] = "unavailable"
            contract["groups"].append(entry)
            continue
        if evidence.get("status") != "captured_unverified":
            contract["groups"].append(entry)
            continue
        if group.get("rawAudioSha256") is not None and group["rawAudioSha256"] != evidence.get("audioSha256"):
            entry["status"] = "invalid_binding"
            contract["groups"].append(entry)
            continue
        try:
            raw_path = Path(evidence["path"]).resolve()
            if not raw_path.is_relative_to(node_root.resolve()):
                raise ValueError("Subtitle evidence is outside the voice node.")
            raw = raw_path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != evidence.get("sha256"):
                raise ValueError("Subtitle evidence content changed.")
        except (OSError, ValueError):
            entry["status"] = "invalid_binding"
            contract["groups"].append(entry)
            continue
        parsed = parse_provider_subtitle_cues(raw, adapter_version=adapter_version)
        if parsed["status"] != "verified":
            entry["status"] = "unavailable"
            entry["reason"] = parsed["reason"]
            contract["groups"].append(entry)
            continue
        try:
            mapped = map_cues_to_narration_timeline(parsed["cues"], group)
        except ValueError:
            entry["status"] = "invalid_binding"
            contract["groups"].append(entry)
            continue
        entry["status"] = "verified"
        entry["cues"] = mapped
        entry["subtitleSha256"] = evidence.get("sha256")
        contract["groups"].append(entry)
        cues.extend(mapped)
    evidence_groups = [entry.get("groupId") for entry in contract["groups"]]
    complete_groups = len(evidence_groups) == len(groups_by_id) and set(evidence_groups) == set(groups_by_id)
    if contract["groups"] and complete_groups and all(entry.get("status") == "verified" for entry in contract["groups"]):
        contract["status"] = "verified"
        contract["cues"] = cues
        contract["reason"] = None
    elif any(entry.get("status") == "invalid_binding" for entry in contract["groups"]):
        contract["reason"] = "字幕与音频/窗口绑定校验失败；已保留配音，不消费可疑 cue。"
    else:
        contract["reason"] = contract["reason"] or "同步字幕尚未核实；不会使用逐镜旁白冒充对齐字幕。"
    return contract


def recover_subtitles(
    ledger_path: Path,
    node_root: Path,
    assembled: dict,
    *,
    narration_plan_sha256: str,
    adapter_version: str,
    refetch: bool = False,
    refetch_reason: str | None = None,
) -> dict:
    """纯字幕恢复：对已缓存证据按（新）adapter 重新解析；有新依据时至多重取一次原始字幕。

    不调用 synthesize，不重购声音；重取次数与结果由 .subtitle-evidence 的回执耐久记录。
    """
    return build_group_subtitles(
        ledger_path, node_root, assembled,
        narration_plan_sha256=narration_plan_sha256,
        adapter_version=adapter_version,
        refetch_reason=refetch_reason if refetch else None,
        allow_initial_download=False,
    )


def capture_subtitle_evidence(ledger_path: Path, node_root: Path, *,
                             refetch_reason: str | None = None,
                             allow_initial_download: bool = True) -> dict:
    result = {"status": "unavailable", "cues": [], "evidence": [],
              "reason": "同步字幕尚未核实；不会使用逐镜旁白冒充对齐字幕。"}
    node_root = node_root.resolve()
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        for item in ledger["items"]:
            result["evidence"].append(_capture_group(item, node_root,
                refetch_reason=refetch_reason, allow_initial_download=allow_initial_download))
    except (OSError, ValueError, KeyError, TypeError):
        # 配音已经成功，字幕证据失败不得变成再次调用 TTS 的理由。
        result["reason"] = "字幕证据暂时无法读取；已生成配音保留，不会自动重新合成。"
    return result


def _capture_group(item: dict, node_root: Path, *, refetch_reason: str | None,
                   allow_initial_download: bool) -> dict:
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
    source_binding = {**binding, "sourceRequestId": request["itemRequestId"], "synthesisKey": request["synthesisKey"]}
    key = hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()
    directory = node_root / ".subtitle-evidence"
    if not directory.resolve().is_relative_to(node_root):
        return unavailable
    target, receipt = directory / f"{key}.json", directory / f"{key}.receipt.json"
    if any(not path.resolve().is_relative_to(directory.resolve()) for path in (target, receipt)):
        return unavailable
    # 复用同一文件锁和原子落盘合同，先消耗重取次数再联网，崩溃/并发不能重置上限。
    with _subtitle_evidence_lock(receipt):
        saved = None
        if receipt.is_file():
            saved = json.loads(receipt.read_text())
            if saved.get("binding") != binding:
                return unavailable
            if saved.get("status") == "captured_unverified":
                if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != saved.get("sha256"):
                    return unavailable
                return {**source_binding, "groupId": item["groupId"], "status": "captured_unverified", "path": str(target), "sha256": saved["sha256"]}
            if saved.get("status") not in ("unavailable", "downloading"):
                return unavailable
            if not isinstance(refetch_reason, str) or not refetch_reason.strip() or saved.get("refetchCount", 0) != 0:
                return unavailable
        elif not allow_initial_download:
            return unavailable
        record = {"binding": binding, "status": "downloading", "refetchCount": 1 if saved else 0}
        if saved:
            record["refetchReason"] = refetch_reason.strip()[:500]
        _write_json_durably(receipt, record)
        try:
            # 复用已有 SSRF/DNS 固定/跳转/代理防护，单次下载最多15秒、1MiB，无携带鉴权。
            with open_asset_request(Request(subtitle_url, headers={"Accept": "application/json"}), timeout=15) as response:
                content = response.read(MAX_SUBTITLE_BYTES + 1)
            if len(content) > MAX_SUBTITLE_BYTES:
                raise ValueError("Subtitle response is too large.")
            json.loads(content)
            _write_bytes_durably(target, content)
            sha256 = hashlib.sha256(content).hexdigest()
            _write_json_durably(receipt, {**record, "status": "captured_unverified", "sha256": sha256})
            return {**source_binding, "groupId": item["groupId"], "status": "captured_unverified", "path": str(target), "sha256": sha256}
        except (OSError, ValueError, RuntimeError):
            _write_json_durably(receipt, {**record, "status": "unavailable"})
            return unavailable
