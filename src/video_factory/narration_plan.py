"""旁白编排独立于画面切点；本模块不调用模型、不改写已确认的文字。"""

import copy
import math
import re
from typing import Any

FPS = 30
SAMPLE_RATE = 44_100
SAMPLES_PER_FRAME = SAMPLE_RATE // FPS


def build_narration_plan(
    scenes: list[dict[str, Any]], *, script_sha256: str, visual_sha256: str,
) -> dict[str, Any]:
    if not all(re.fullmatch(r"[a-f0-9]{64}", value) for value in (script_sha256, visual_sha256)):
        raise ValueError("Narration plan requires exact script and visual SHA256 identities.")
    timings = _scene_timings(scenes)
    total_frames = timings[-1][2]
    groups: list[dict[str, Any]] = []
    silences: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for scene, start, end in timings:
        position = scene["position"]
        if not any(character.isalnum() for character in scene["narration"]):
            silences.append({"id": f"silence-{position}", "startFrame": start, "endFrame": end,
                             "source": "legacy_silent_scene"})
            current = None
            continue
        if current is None:
            current = {"id": f"narration-{position}", "sourceScenePositions": [], "text": "",
                       "window": {"startFrame": start, "endFrame": end},
                       "placement": {"anchor": "start", "offsetFrames": 0}}
            groups.append(current)
        # 换镜不是换段；只加空格避免英文粘连，不凭镜头边界新增段落停顿或标点。
        current["text"] += (" " if current["sourceScenePositions"] else "") + scene["narration"].strip()
        current["sourceScenePositions"].append(position)
        current["window"]["endFrame"] = end
    return {
        "version": "video-factory/narration-plan-v1",
        "mode": "continuous_groups",
        "script": {"sha256": script_sha256},
        "visualPlan": {"sha256": visual_sha256, "fps": FPS, "totalFrames": total_frames},
        "edgeTrim": "none",
        "subtitleMode": "provider_sentence",
        "silences": silences,
        "groups": groups,
    }


def _scene_timings(scenes: list[dict[str, Any]]) -> list[tuple[dict[str, Any], int, int]]:
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("Narration plan requires confirmed visual scenes.")
    timings = []
    cursor = 0
    for position, scene in enumerate(scenes, 1):
        if (not isinstance(scene, dict) or type(scene.get("position")) is not int
                or scene["position"] != position or not isinstance(scene.get("narration"), str)):
            raise ValueError("Narration sources must match the ordered visual scenes.")
        duration = scene.get("duration")
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
            raise ValueError("Narration visual duration must be finite and positive.")
        frames = round(duration * FPS)
        if frames <= 0 or abs(frames - duration * FPS) > 1e-6:
            raise ValueError("Narration visual cuts must use the confirmed 30 fps timeline.")
        timings.append((scene, cursor, cursor + frames))
        cursor += frames
    if cursor > 180 * FPS:
        raise ValueError("Narration plan exceeds the supported short-video duration.")
    return timings


def validate_narration_plan(
    value: Any, scenes: list[dict[str, Any]], *, script_sha256: str, visual_sha256: str,
) -> dict[str, Any]:
    expected = build_narration_plan(scenes, script_sha256=script_sha256, visual_sha256=visual_sha256)
    if not isinstance(value, dict) or any(value.get(key) != expected[key] for key in (
        "version", "mode", "script", "visualPlan", "edgeTrim", "subtitleMode", "silences",
    )):
        raise ValueError("Narration plan does not match its confirmed script, visual timeline or silences.")
    groups = value.get("groups")
    if not isinstance(groups, list) or len(groups) > len(scenes):
        raise ValueError("Narration plan groups are invalid.")
    timings = {scene["position"]: (scene, start, end) for scene, start, end in _scene_timings(scenes)}
    expected_positions = [position for group in expected["groups"] for position in group["sourceScenePositions"]]
    positions: list[int] = []
    identifiers: set[str] = set()
    previous_end = 0
    for group in groups:
        if not isinstance(group, dict):
            raise ValueError("Narration group must be an object.")
        group_id = group.get("id")
        source = group.get("sourceScenePositions")
        if (not isinstance(group_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", group_id)
                or group_id in identifiers or not isinstance(source, list) or not source
                or any(type(position) is not int or position not in timings for position in source)
                or source != list(range(source[0], source[-1] + 1))):
            raise ValueError("Narration group identity or source scenes are invalid.")
        identifiers.add(group_id)
        if any(position not in expected_positions for position in source):
            raise ValueError("Narration groups must not cross an explicit silence.")
        text = " ".join(timings[position][0]["narration"].strip() for position in source)
        if group.get("text") != text:
            raise ValueError("Narration text must preserve the confirmed script; revise the script to change words.")
        window, placement = group.get("window"), group.get("placement")
        if not isinstance(window, dict) or not isinstance(placement, dict):
            raise ValueError("Narration group has no valid window or placement.")
        start, end, offset = window.get("startFrame"), window.get("endFrame"), placement.get("offsetFrames")
        if (any(type(number) is not int for number in (start, end, offset))
                or not timings[source[0]][1] <= start < end <= timings[source[-1]][2]
                or start < previous_end or not 0 <= offset < end - start
                or placement.get("anchor") not in ("start", "end")):
            raise ValueError("Narration window or placement exceeds its confirmed visual interval.")
        positions.extend(source)
        previous_end = end
    if positions != expected_positions:
        raise ValueError("Narration groups must cover every spoken scene exactly once, in order.")
    return copy.deepcopy(value)


# ══ v2 显式分段合同（narration-text-v1；v1 与无计划路径不受影响） ══

import hashlib
import json

from video_factory.narration_text_rules import (
    NARRATION_TEXT_RULE_NAME,
    NARRATION_TEXT_TRIM_CODEPOINTS,
    is_narration_word_code_point,
)

_TRIM_SET = frozenset(NARRATION_TEXT_TRIM_CODEPOINTS)
_CLOSERS = "”’\"'」』）》】)]}"
_SENTENCE_ENDS = "。！？!?；;"


def trim_v2(text: str) -> str:
    """narration-text-v1：仅去除两端固定集合空白；拒绝孤立代理对；不做 NFC/内部压缩。"""
    # 孤立代理对检测：Python str 可含孤立代理（UTF-32 码点视角 D800–DFFF）。
    for character in text:
        code = ord(character)
        if 0xD800 <= code <= 0xDFFF:
            raise ValueError("narration-text-v1 拒绝孤立代理码点（surrogate）。")
    start = 0
    end = len(text)
    while start < end and ord(text[start]) in _TRIM_SET:
        start += 1
    while end > start and ord(text[end - 1]) in _TRIM_SET:
        end -= 1
    return text[start:end]


def is_wordy_v2(text: str) -> bool:
    """有词判定：任一码点命中冻结 L/N 区间表。"""
    return any(is_narration_word_code_point(ord(character)) for character in text)


def canonical_json_v2(value: Any) -> str:
    """规范 JSON：键按 ASCII 名排序、数组保序、UTF-8、无多余空白；拒绝非安全数值。"""
    def walk(item: Any) -> Any:
        if isinstance(item, bool):
            return item
        if isinstance(item, int):
            if not -(2**53) < item < 2**53:
                raise ValueError("narration-text-v1 仅接受安全整数。")
            return item
        if isinstance(item, float):
            raise ValueError("narration-text-v1 不接受浮点数（先量化为整数帧）。")
        if isinstance(item, str):
            for character in item:
                if 0xD800 <= ord(character) <= 0xDFFF:
                    raise ValueError("narration-text-v1 拒绝孤立代理码点。")
            return item
        if isinstance(item, list):
            return [walk(entry) for entry in item]
        if isinstance(item, dict):
            # 键限定 ASCII：Python 按码点排序、JS 按 UTF-16 排序，非 ASCII 键可能两端不同序。
            for key in item:
                if not re.fullmatch(r"[ -~]+", key):
                    raise ValueError("canonical JSON 对象键必须是 ASCII，保证两端字节一致。")
            return {key: walk(item[key]) for key in sorted(item)}
        raise ValueError("narration-text-v1 仅接受 JSON 类型。")
    return json.dumps(walk(value), ensure_ascii=False, separators=(",", ":"), sort_keys=False)


def _identity_sha(payload: Any) -> str:
    return hashlib.sha256(canonical_json_v2(payload).encode("utf-8")).hexdigest()


def _derive_v2_facts(scenes: list[dict[str, Any]]) -> dict[str, Any]:
    """派生基础有词区、镜头静默与总帧：v2 的有词判定统一用冻结规则表（trim 后判 L/N）。"""
    base_groups: list[dict[str, Any]] = []
    legacy_silences: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    cursor = 0
    for position, scene in enumerate(scenes, start=1):
        duration = scene.get("duration")
        if (not isinstance(duration, (int, float)) or isinstance(duration, bool)
                or not math.isfinite(duration) or duration <= 0
                or abs(round(duration * FPS) - duration * FPS) > 1e-6):
            raise ValueError("v2 基础有词区必须与已确认的 30fps 画面时间线一致。")
        start_frame = cursor
        end_frame = start_frame + round(duration * FPS)
        cursor = end_frame
        if cursor > 180 * FPS:
            raise ValueError("v2 计划超出短视频时长范围。")
        narration = scene.get("narration")
        if not isinstance(narration, str):
            raise ValueError("v2 原稿旁白必须是字符串。")
        trimmed = trim_v2(narration)
        if not is_wordy_v2(trimmed):
            legacy_silences.append({"id": f"silence-{position}", "startFrame": start_frame, "endFrame": end_frame})
            current = None
            continue
        if current is None:
            current = {"source_scene_positions": [], "canonical_text": "", "scene_text_ranges": [],
                       "frame_range": {"startFrame": start_frame, "endFrame": end_frame},
                       "start_code_point": 0, "end_code_point": 0}
            base_groups.append(current)
        else:
            # 拼接空格归左镜：延伸上一镜的文字区间到空格之后（例：左[0,3)、右[3,5)）。
            offset_after_space = len(current["canonical_text"]) + 1
            current["canonical_text"] += " "
            current["scene_text_ranges"][-1]["end"] = offset_after_space
            current["frame_range"]["endFrame"] = end_frame
        offset = len(current["canonical_text"])
        current["canonical_text"] += trimmed
        current["scene_text_ranges"].append({"position": position, "start": offset, "end": offset + len(trimmed)})
        current["source_scene_positions"].append(position)
    for group in base_groups:
        group["start_code_point"] = 0
        group["end_code_point"] = len(group["canonical_text"])
        group["base_group_id"] = "nb-" + _identity_sha(
            ["narration-text-v1", group["source_scene_positions"], group["canonical_text"]])
    return {"base_groups": base_groups, "legacy_silences": legacy_silences, "total_frames": cursor}


def derive_base_groups_v2(scenes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """从原稿派生基础连续有词区：规范正文（trim+单空格拼接）、码点范围、帧区间。"""
    return _derive_v2_facts(scenes)["base_groups"]


def canonical_source_sha256_v2(base_groups: list[dict[str, Any]], legacy_silences: list[dict[str, Any]]) -> str:
    """canonicalSourceSha256：按画面顺序的全部 baseGroup 记录与 legacy 静默的规范 JSON 摘要（两端同字节）。"""
    return _identity_sha({
        "rule": NARRATION_TEXT_RULE_NAME,
        "baseGroups": [
            {
                "id": group["base_group_id"],
                "text": group["canonical_text"],
                "sceneTextRanges": [
                    {"position": entry["position"], "start": entry["start"], "end": entry["end"]}
                    for entry in group["scene_text_ranges"]
                ],
                "frameRange": {"startFrame": group["frame_range"]["startFrame"], "endFrame": group["frame_range"]["endFrame"]},
            }
            for group in base_groups
        ],
        "legacySilences": [
            {"id": silence["id"], "startFrame": silence["startFrame"], "endFrame": silence["endFrame"]}
            for silence in legacy_silences
        ],
    })


def sentence_boundary_candidates_v2(canonical_text: str) -> list[int]:
    """句界候选（码点偏移）：句末标点后；连续标点、闭符号与规范空白归左，边界放其后。"""
    candidates: list[int] = []
    length = len(canonical_text)
    for index, character in enumerate(canonical_text):
        is_end = character in _SENTENCE_ENDS
        is_ascii_dot = character == "."
        if not (is_end or is_ascii_dot):
            continue
        if is_ascii_dot:
            # ASCII 句点仅在后接规范空白、闭符号或末尾才候选，不能切 3.14。
            nxt = canonical_text[index + 1] if index + 1 < length else None
            if nxt is not None and not (nxt in _CLOSERS or ord(nxt) in _TRIM_SET):
                continue
        boundary = index + 1
        while boundary < length:
            unit = canonical_text[boundary]
            if not (unit in _SENTENCE_ENDS or unit in _CLOSERS or ord(unit) in _TRIM_SET):
                break
            boundary += 1
        if 0 < boundary < length:
            candidates.append(boundary)
    return sorted(set(candidates))


def validate_slices_v2(
    base_group: dict[str, Any], slices: list[dict[str, int]],
) -> list[dict[str, Any]]:
    """校验用户切片：每个基础有词区按顺序无重叠、完整覆盖；同镜可多段；返回带场景归属的切片。"""
    if not isinstance(slices, list) or not slices:
        raise ValueError("v2 分段不能为空；不需要分段时请走原 v1 连续路径。")
    ranges = []
    for item in slices:
        start = item.get("start")
        end = item.get("end")
        if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool):
            raise ValueError("v2 分段端点必须是整数码点。")
        if not 0 <= start < end <= base_group["end_code_point"]:
            raise ValueError("v2 分段超出该基础有词区范围。")
        ranges.append((start, end))
    for previous, current in zip(ranges, ranges[1:]):
        if current[0] < previous[1]:
            raise ValueError("v2 分段按文字顺序且不得重叠。")
        # 前段 end 严格等于后段 start：缺口会静默丢掉中间文字。
        if current[0] > previous[1]:
            raise ValueError("v2 分段必须连续：相邻分段存在间隙，会遗漏中间文字。")
    coverage_start = ranges[0][0]
    coverage_end = ranges[-1][1]
    if coverage_start != 0 or coverage_end != base_group["end_code_point"]:
        raise ValueError("v2 分段必须完整覆盖基础有词区（无遗漏、无越界）。")
    # 内部切点必须来自宿主合法句界或镜头文字交界，不能任意字符切开。
    legal_boundaries = {boundary for entry in base_group["scene_text_ranges"]
                        for boundary in (entry["start"], entry["end"])}
    legal_boundaries.update(sentence_boundary_candidates_v2(base_group["canonical_text"]))
    for start, _end in ranges[1:]:
        if start not in legal_boundaries:
            raise ValueError("v2 分段切点必须来自合法句界或镜头边界。")
    result = []
    for start, end in ranges:
        positions = sorted({
            entry["position"] for entry in base_group["scene_text_ranges"]
            if entry["start"] < end and entry["end"] > start
        })
        if not positions:
            raise ValueError("v2 分段必须覆盖原稿文字。")
        text = base_group["canonical_text"][start:end]
        if not is_wordy_v2(trim_v2(text)):
            raise ValueError("v2 分段不得为纯空白段；拼接空格仅允许出现在段边界。")
        result.append({"start": start, "end": end, "sourceScenePositions": positions, "text": text})
    return result


def user_silences_v2(
    total_frames: int, legacy_silences: list[dict[str, int]],
    silences: list[dict[str, int]],
) -> list[dict[str, Any]]:
    """用户显式静默：整数帧、按帧排序、拒绝重复/重叠、不得与 legacy 静默重叠。"""
    normalized = []
    for item in silences:
        start, end = item.get("start"), item.get("end")
        if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool):
            raise ValueError("用户静默必须是整数帧。")
        if not 0 <= start < end <= total_frames:
            raise ValueError("用户静默超出画面范围。")
        normalized.append((start, end))
    normalized.sort()
    for previous, current in zip(normalized, normalized[1:]):
        if current[0] < previous[1]:
            raise ValueError("用户静默按帧排序且不得重叠。")
    legacy_ranges = [(int(item["startFrame"]), int(item["endFrame"])) for item in legacy_silences]
    for start, end in normalized:
        for legacy_start, legacy_end in legacy_ranges:
            if start < legacy_end and legacy_start < end:
                raise ValueError("用户静默不得与镜头静默（legacy）重叠。")
    return [{"id": f"ns-user-{start}-{end}", "startFrame": start, "endFrame": end, "source": "user"}
            for start, end in normalized]


def seconds_to_frames_v2(seconds: str) -> int:
    """非负十进制秒（最多6位小数）→ 整数帧，frame = floor(seconds*30 + 0.5)。

    HTTP 计划只送整数帧（独立安全整数校验），不经本函数透传。
    """
    if not isinstance(seconds, str):
        raise ValueError("时间输入必须是非负十进制秒字符串；HTTP 帧数走独立整数校验，不经本函数。")
    if not re.fullmatch(r"[0-9]+(\.[0-9]{1,6})?", seconds):
        raise ValueError("时间输入必须是非负十进制秒（至多6位小数）。")
    from decimal import Decimal
    value = (Decimal(seconds) * 30 + Decimal("0.5")).to_integral_value(rounding="ROUND_FLOOR")
    frames = int(value)
    if not -(2**53) < frames < 2**53:
        raise ValueError("转换结果超出安全整数范围。")
    return frames


# ══ v2 完整计划合同（SND-02） ══

NARRATION_PLAN_V2_VERSION = "video-factory/narration-plan-v2"
NARRATION_PLAN_V1_VERSION = "video-factory/narration-plan-v1"

_V2_PLAN_KEYS = sorted(["edgeTrim", "groups", "mode", "script", "silences", "source", "subtitleMode", "version", "visualPlan"])
_V2_GROUP_KEYS = sorted(["id", "placement", "sourceRange", "sourceScenePositions", "text", "window"])


def _require_safe_int_frame(value: Any, label: str) -> int:
    if type(value) is not int or not -(2**53) < value < 2**53:
        raise ValueError(f"{label}必须是安全整数帧。")
    return value


def build_narration_plan_v2(build_input: dict[str, Any]) -> dict[str, Any]:
    """从已确认原稿/画面与用户显式选择构建完整 v2 计划；未提及的基础有词区保持连续整段。"""
    if not isinstance(build_input, dict) or not isinstance(build_input.get("scenes"), list):
        raise ValueError("v2 计划输入必须是带 scenes 的对象。")
    script_sha = build_input.get("scriptSha256") or build_input.get("script_sha256")
    visual_sha = build_input.get("visualSha256") or build_input.get("visual_sha256")
    if not isinstance(script_sha, str) or not isinstance(visual_sha, str) \
            or not re.fullmatch(r"[a-f0-9]{64}", script_sha) or not re.fullmatch(r"[a-f0-9]{64}", visual_sha):
        raise ValueError("v2 计划缺少已确认的脚本与画面身份。")
    source_context_id = build_input.get("sourceContextId") or build_input.get("source_context_id")
    if not isinstance(source_context_id, str) or not source_context_id.strip() or len(source_context_id) > 200:
        raise ValueError("v2 计划的 sourceContextId 必须是宿主派生的非空标识。")
    facts = _derive_v2_facts(build_input["scenes"])
    base_groups = facts["base_groups"]

    raw_user = build_input.get("userSilences") or build_input.get("user_silences") or []
    if not isinstance(raw_user, list):
        raise ValueError("用户静默必须是列表。")
    user_silences = user_silences_v2(
        facts["total_frames"], facts["legacy_silences"],
        [{"start": item.get("startFrame"), "end": item.get("endFrame")} for item in raw_user])
    for silence in user_silences:
        if not any(group["frame_range"]["startFrame"] <= silence["startFrame"]
                   and silence["endFrame"] <= group["frame_range"]["endFrame"] for group in base_groups):
            raise ValueError("用户静默必须落在某一个基础有词区内。")
    all_silences = sorted(
        [{"id": s["id"], "startFrame": s["startFrame"], "endFrame": s["endFrame"], "source": "legacy_silent_scene"}
         for s in facts["legacy_silences"]]
        + [{"id": s["id"], "startFrame": s["startFrame"], "endFrame": s["endFrame"], "source": "user"}
           for s in user_silences],
        key=lambda s: (s["startFrame"], s["endFrame"]))

    segments = build_input.get("segments", [])
    if not isinstance(segments, list):
        raise ValueError("分段选择必须是列表。")
    segments_by_index: dict[int, list[dict[str, Any]]] = {}
    for segment in segments:
        if not isinstance(segment, dict):
            raise ValueError("分段选择必须是对象。")
        index = segment.get("baseGroupIndex")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(base_groups):
            raise ValueError("分段所属基础有词区索引无效。")
        if index in segments_by_index:
            raise ValueError("每个基础有词区只能有一组分段选择。")
        slices = segment.get("slices")
        if not isinstance(slices, list) or not slices:
            raise ValueError("显式分段不能为空。")
        segments_by_index[index] = slices

    groups: list[dict[str, Any]] = []
    previous_end: int | None = None
    for index, group in enumerate(base_groups):
        explicit = segments_by_index.get(index)
        prepared = explicit or [{
            "start": 0, "end": group["end_code_point"],
            "window": dict(group["frame_range"]),
            "placement": {"anchor": "start", "offsetFrames": 0},
        }]
        slices = validate_slices_v2(group, [{"start": item.get("start"), "end": item.get("end")} for item in prepared])
        for item, slice_ in zip(prepared, slices):
            window = item.get("window")
            placement = item.get("placement")
            if not isinstance(window, dict) or not isinstance(placement, dict):
                raise ValueError("分段必须有窗口与落点。")
            start = _require_safe_int_frame(window.get("startFrame"), "分段窗口起点")
            end = _require_safe_int_frame(window.get("endFrame"), "分段窗口终点")
            if not group["frame_range"]["startFrame"] <= start < end <= group["frame_range"]["endFrame"]:
                raise ValueError("分段窗口必须位于其基础有词区的画面区间内。")
            for silence in all_silences:
                if start < silence["endFrame"] and silence["startFrame"] < end:
                    raise ValueError("分段窗口不得与显式或镜头静默重叠。")
            if previous_end is not None and start < previous_end:
                raise ValueError("分段窗口按文字顺序排列且不得重叠。")
            anchor = placement.get("anchor")
            offset = placement.get("offsetFrames")
            if anchor not in ("start", "end") or type(offset) is not int or not 0 <= offset < end - start:
                raise ValueError("分段落点必须位于窗口内。")
            previous_end = end
            groups.append({
                "id": "ng-" + _identity_sha([group["base_group_id"], slice_["start"], slice_["end"]]),
                "sourceRange": {"baseGroupId": group["base_group_id"],
                                "startCodePoint": slice_["start"], "endCodePoint": slice_["end"]},
                "sourceScenePositions": slice_["sourceScenePositions"],
                "text": slice_["text"],
                "window": {"startFrame": start, "endFrame": end},
                "placement": {"anchor": anchor, "offsetFrames": offset},
            })

    return {
        "version": NARRATION_PLAN_V2_VERSION,
        "mode": "continuous_groups",
        "script": {"sha256": script_sha},
        "visualPlan": {"sha256": visual_sha, "fps": FPS, "totalFrames": facts["total_frames"]},
        "source": {"normalization": NARRATION_TEXT_RULE_NAME, "sourceContextId": source_context_id,
                   "canonicalSourceSha256": canonical_source_sha256_v2(base_groups, facts["legacy_silences"])},
        "edgeTrim": "none",
        "subtitleMode": "provider_sentence",
        "silences": all_silences,
        "groups": groups,
    }


def _validate_v2_candidate_structure(value: dict[str, Any]) -> None:
    """§4.2.1：候选 v2 的数值字段先按整数语义显式校验（排除 bool），再做逐字段对照。

    Python 的 ==/!= 会把 True==1、False==0 判等，bool 冒充整数不能只靠与期望比较发现；
    值域与来源一致性仍由重建期望的逐字段对照保证，这里只做结构/类型语义。
    """
    visual_plan = value.get("visualPlan")
    if not isinstance(visual_plan, dict):
        raise ValueError("v2 计划缺少画面身份。")
    if type(visual_plan.get("fps")) is not int or visual_plan["fps"] != FPS:
        raise ValueError("v2 计划画面帧率必须是整数 30。")
    _require_safe_int_frame(visual_plan.get("totalFrames"), "v2 计划总帧数")
    silences = value.get("silences")
    if not isinstance(silences, list):
        raise ValueError("v2 计划静默必须是列表。")
    for silence in silences:
        if not isinstance(silence, dict):
            raise ValueError("v2 计划静默必须是对象。")
        _require_safe_int_frame(silence.get("startFrame"), "静默起点")
        _require_safe_int_frame(silence.get("endFrame"), "静默终点")
    groups = value.get("groups")
    if not isinstance(groups, list):
        raise ValueError("v2 计划分组必须是列表。")
    for group in groups:
        if not isinstance(group, dict):
            raise ValueError("v2 计划分组必须是对象。")
        positions = group.get("sourceScenePositions")
        if not isinstance(positions, list) or any(type(position) is not int for position in positions):
            raise ValueError("v2 组镜头归属必须是整数位置列表。")
        source_range = group.get("sourceRange")
        if (not isinstance(source_range, dict) or not isinstance(source_range.get("baseGroupId"), str)
                or type(source_range.get("startCodePoint")) is not int
                or type(source_range.get("endCodePoint")) is not int):
            raise ValueError("v2 组来源范围必须是整数码点区间。")
        window = group.get("window")
        if not isinstance(window, dict):
            raise ValueError("v2 计划分组必须有窗口。")
        if _require_safe_int_frame(window.get("startFrame"), "组窗口起点") >= _require_safe_int_frame(window.get("endFrame"), "组窗口终点"):
            raise ValueError("组窗口起点必须严格小于终点。")
        placement = group.get("placement")
        if not isinstance(placement, dict):
            raise ValueError("v2 计划分组必须有落点。")
        _require_safe_int_frame(placement.get("offsetFrames"), "组落点偏移")


def validate_narration_plan_v2(value: Any, expected: dict[str, Any]) -> dict[str, Any]:
    """整体校验候选 v2 计划：未知版本拒绝降级；逐字段对照由已确认来源重建的期望。"""
    if not isinstance(value, dict):
        raise ValueError("v2 旁白计划必须是对象。")
    if value.get("version") != NARRATION_PLAN_V2_VERSION:
        raise ValueError("未知旁白计划版本，拒绝降级。")
    _validate_v2_candidate_structure(value)
    expected_plan = build_narration_plan_v2(expected)
    if sorted(value.keys()) != _V2_PLAN_KEYS:
        raise ValueError("v2 计划字段与合同不符。")
    for key in ("mode", "edgeTrim", "subtitleMode", "script", "visualPlan", "source", "silences"):
        if value[key] != expected_plan[key]:
            raise ValueError("v2 计划的已确认来源身份或静默与期望不一致。")
    groups = value["groups"]
    if not isinstance(groups, list) or len(groups) != len(expected_plan["groups"]):
        raise ValueError("v2 计划分组与已确认来源不一致。")
    for group, original in zip(groups, expected_plan["groups"]):
        if not isinstance(group, dict) or sorted(group.keys()) != _V2_GROUP_KEYS:
            raise ValueError("v2 计划分组字段与合同不符。")
        if group["id"] != original["id"]:
            raise ValueError("v2 组身份与来源范围不一致。")
        if group["sourceRange"] != original["sourceRange"]:
            raise ValueError("v2 组来源范围与已确认文字不一致。")
        if group["sourceScenePositions"] != original["sourceScenePositions"]:
            raise ValueError("v2 组镜头归属与已确认文字不一致。")
        if group["text"] != original["text"]:
            raise ValueError("v2 组文字必须等于其来源范围切片，改词请回脚本。")
        if group["window"] != original["window"]:
            raise ValueError("v2 组窗口必须与已确认选择一致。")
        if group["placement"] != original["placement"]:
            raise ValueError("v2 组落点必须与已确认选择一致。")
    return copy.deepcopy(value)


def narration_plan_version(value: Any) -> str:
    """消费者入口按版本显式分派；未知版本一律拒绝，不静默降级到 v1。"""
    version = value.get("version") if isinstance(value, dict) else None
    if version in (NARRATION_PLAN_V1_VERSION, NARRATION_PLAN_V2_VERSION):
        return version
    raise ValueError("未知旁白计划版本，拒绝降级。")


def validate_narration_plan_v2_standalone(
    value: Any, scenes: list[dict[str, Any]], *, script_sha256: str, visual_sha256: str,
    source_context_id: str,
) -> dict[str, Any]:
    """worker 消费入口：手头只有计划本体时，从计划反推用户选择再走整体校验。

    与 confirmNarrationPlanV2 的差别只在期望的来源——反推的 segments/userSilences
    与原候选产生同一 build 输入，因此校验语义一致。
    """
    if not isinstance(value, dict):
        raise ValueError("v2 旁白计划必须是对象。")
    if value.get("version") != NARRATION_PLAN_V2_VERSION:
        raise ValueError("未知旁白计划版本，拒绝降级。")
    groups = value.get("groups")
    if not isinstance(groups, list):
        raise ValueError("v2 计划分组必须是列表。")
    index_by_base_group: dict[str, int] = {}
    segments: list[dict[str, Any]] = []
    slices_by_index: dict[int, list[dict[str, Any]]] = {}
    for group in groups:
        if not isinstance(group, dict):
            raise ValueError("v2 计划分组必须是对象。")
        source_range = group.get("sourceRange")
        if not isinstance(source_range, dict):
            raise ValueError("v2 计划分组缺少来源范围。")
        base_group_id = source_range.get("baseGroupId")
        if not isinstance(base_group_id, str) or not base_group_id:
            raise ValueError("v2 计划分组来源范围无效。")
        if base_group_id not in slices_by_index:
            if base_group_id in index_by_base_group:
                raise ValueError("每个基础有词区只能有一组分段选择。")
            index_by_base_group[base_group_id] = len(segments)
            slices_by_index[base_group_id] = []
            segments.append({"baseGroupIndex": index_by_base_group[base_group_id], "slices": slices_by_index[base_group_id]})
        window = group.get("window")
        placement = group.get("placement")
        if not isinstance(window, dict) or not isinstance(placement, dict):
            raise ValueError("v2 计划分组必须有窗口与落点。")
        slices_by_index[base_group_id].append({
            "start": source_range.get("startCodePoint"), "end": source_range.get("endCodePoint"),
            "window": window, "placement": placement,
        })
    for base_group_id, slices in slices_by_index.items():
        slices.sort(key=lambda item: (item["start"], item["end"]))
    user_silences = [
        {"startFrame": silence.get("startFrame"), "endFrame": silence.get("endFrame")}
        for silence in (value.get("silences") or [])
        if isinstance(silence, dict) and silence.get("source") == "user"
    ]
    return validate_narration_plan_v2(value, {
        "scenes": scenes, "scriptSha256": script_sha256, "visualSha256": visual_sha256,
        "sourceContextId": source_context_id, "segments": segments, "userSilences": user_silences,
    })
