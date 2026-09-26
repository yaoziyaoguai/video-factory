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
