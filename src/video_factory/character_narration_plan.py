"""逐台词声音 v3；时间候选不可修改正文、说话人或音色。"""
import copy
import hashlib
import math
import re
from typing import Any

from .character_script import validate_character_script
from .narration_plan import canonical_json_v2

VERSION = "video-factory/narration-plan-v3"


def allocate_character_turn_frames(frames: int, turns: list[dict[str, Any]]) -> list[int]:
    _integer(frames, 1)
    for turn in turns:
        _integer(turn["after_pause_frames"], 0)
        if not isinstance(turn["text"], str) or not turn["text"].strip():
            raise ValueError("台词正文不能为空。")
        canonical_json_v2(turn["text"])
    if not turns:
        return []
    available = frames - sum(turn["after_pause_frames"] for turn in turns)
    if available < len(turns):
        raise ValueError("镜头放不下台词与停顿，请修改时长。")
    weights = [len(turn["text"]) for turn in turns]
    total = sum(weights)
    extra = available - len(turns)
    result = [1 + extra * weight // total for weight in weights]
    order = sorted(range(len(turns)), key=lambda i: (-(extra * weights[i] % total), i))
    for index in order[:available - sum(result)]:
        result[index] += 1
    return result


def parse_character_narration_candidate(value: Any) -> dict[str, Any]:
    candidate = _record(value, {"version", "groups", "userSilences"})
    if candidate.get("version") != VERSION or not isinstance(candidate.get("groups"), list) or not isinstance(candidate.get("userSilences"), list):
        raise ValueError("角色声音候选版本或台词、留白列表无效。")
    groups = []
    for raw in candidate["groups"]:
        group = _record(raw, {"turnId", "window", "placement"})
        if not isinstance(group.get("turnId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", group["turnId"]):
            raise ValueError("台词身份无效。")
        placement = _record(group.get("placement"), {"anchor", "offsetFrames"})
        if placement.get("anchor") not in ("start", "end"):
            raise ValueError("台词落点无效。")
        _integer(placement.get("offsetFrames"), 0)
        groups.append({"turnId": group["turnId"], "window": _window(group.get("window")), "placement": dict(placement)})
    return {"version": VERSION, "groups": groups, "userSilences": [_window(s) for s in candidate["userSilences"]]}


def build_character_narration_plan(source: dict[str, Any], raw_candidate: Any = None) -> dict[str, Any]:
    script = validate_character_script(source["script"])
    if (not all(isinstance(source.get(k), str) and re.fullmatch(r"[a-f0-9]{64}", source[k]) for k in ("scriptSha256", "visualSha256"))
            or not isinstance(source.get("sourceContextId"), str) or not source["sourceContextId"].strip()):
        raise ValueError("角色声音缺少有效稿件与画面身份。")
    counts, elapsed, previous = [], 0.0, 0
    for scene in script["scenes"]:
        elapsed += scene["duration"]
        boundary = math.floor(elapsed * 30 + 0.5)
        counts.append(boundary - previous)
        previous = boundary
    total_frames = sum(counts)
    _integer(total_frames, 1)
    if total_frames > 5400:
        raise ValueError("角色声音超出时长范围。")
    candidate = parse_character_narration_candidate(raw_candidate) if raw_candidate is not None else None
    turn_ids = [t["id"] for s in script["scenes"] for t in s["dialogue"]]
    if candidate is not None and [g["turnId"] for g in candidate["groups"]] != turn_ids:
        raise ValueError("台词列表必须按当前剧本顺序完整保留。")
    facts = {"rule": "character-turns-v1", "characters": [
        {"id": c["id"], "kind": c["kind"], "voiceProfileId": c["voice_profile_id"] or ""} for c in script["characters"]],
        "scenes": [{"position": s["position"], "frames": counts[i], "characterIds": s["character_ids"], "dialogue": [
            {"id": t["id"], "speakerId": t["speaker_id"], "text": t["text"], "afterPauseFrames": t["after_pause_frames"]}
            for t in s["dialogue"]]} for i, s in enumerate(script["scenes"])]}
    plan = {"version": VERSION, "mode": "character_turns", "audioStrategy": "external_tts",
            "script": {"sha256": source["scriptSha256"]}, "visualPlan": {"sha256": source["visualSha256"], "fps": 30, "totalFrames": total_frames},
            "source": {"sourceContextId": source["sourceContextId"], "canonicalSourceSha256": _digest(facts)},
            "edgeTrim": "none", "subtitleMode": "provider_sentence", "groups": [], "silences": []}
    start, group_index = 0, 0
    characters = {c["id"]: c for c in script["characters"]}
    for i, scene in enumerate(script["scenes"]):
        end = start + counts[i]
        allocations = allocate_character_turn_frames(counts[i], scene["dialogue"])
        if not scene["dialogue"]:
            plan["silences"].append({"id": f"silent-scene-{scene['position']}", "startFrame": start, "endFrame": end, "source": "silent_scene"})
        cursor = start
        for j, turn in enumerate(scene["dialogue"]):
            character = characters[turn["speaker_id"]]
            if not character["voice_profile_id"]:
                raise ValueError(f"请先为角色“{character['name']}”选择可用音色。")
            selected = candidate["groups"][group_index] if candidate is not None else None
            group_index += 1
            window = selected["window"] if selected is not None else {"startFrame": cursor, "endFrame": cursor + allocations[j]}
            placement = selected["placement"] if selected is not None else {"anchor": "start", "offsetFrames": 0}
            if (window["startFrame"] < cursor or window["endFrame"] + turn["after_pause_frames"] > end
                    or placement["offsetFrames"] >= window["endFrame"] - window["startFrame"]):
                raise ValueError("台词时间越界或重叠，请调整窗口与留白。")
            plan["groups"].append({"id": turn["id"], "turnId": turn["id"], "speakerId": turn["speaker_id"], "voiceProfileId": character["voice_profile_id"],
                "sourceScenePositions": [scene["position"]], "text": turn["text"], "window": dict(window), "placement": dict(placement)})
            cursor = window["endFrame"]
            if turn["after_pause_frames"]:
                plan["silences"].append({"id": f"pause-{turn['id']}", "startFrame": cursor,
                    "endFrame": cursor + turn["after_pause_frames"], "source": "script_pause"})
                cursor += turn["after_pause_frames"]
        start = end
    for window in sorted(candidate["userSilences"] if candidate is not None else [], key=lambda s: (s["startFrame"], s["endFrame"])):
        if (window["endFrame"] > total_frames or any(_overlaps(window, s) for s in plan["silences"])
                or any(_overlaps(window, g["window"]) for g in plan["groups"])):
            raise ValueError("用户留白越界或与台词、脚本留白重叠。")
        plan["silences"].append({**window, "id": f"silence-user-{window['startFrame']}-{window['endFrame']}", "source": "user"})
    plan["silences"].sort(key=lambda s: (s["startFrame"], s["endFrame"]))
    return plan


def character_candidate_from_plan(plan: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(plan.get("groups"), list) or not isinstance(plan.get("silences"), list):
        raise ValueError("角色声音计划缺少台词与留白。")
    return parse_character_narration_candidate({"version": plan.get("version"), "groups": [
        {"turnId": g.get("turnId"), "window": g.get("window"), "placement": g.get("placement")} for g in plan["groups"]],
        "userSilences": [{"startFrame": s.get("startFrame"), "endFrame": s.get("endFrame")}
                         for s in plan["silences"] if s.get("source") == "user"]})


def validate_character_narration_plan(value: Any, source: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("角色声音计划格式无效。")
    rebuilt = build_character_narration_plan(source, character_candidate_from_plan(value))
    # 规范字节比较避免 Python 将 True 与 1 当作同一份有效身份。
    if canonical_json_v2(value) != canonical_json_v2(rebuilt):
        raise ValueError("角色声音计划与当前剧本、音色、来源身份或留白不一致。")
    return copy.deepcopy(rebuilt)


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical_json_v2(value).encode("utf-8")).hexdigest()


def _integer(value: Any, minimum: int) -> None:
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise ValueError("时间参数必须是安全整数。")


def _record(value: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - keys:
        raise ValueError("候选字段无效，不能替换正文、角色或音色。")
    return value


def _window(value: Any) -> dict[str, int]:
    window = _record(value, {"startFrame", "endFrame"})
    _integer(window.get("startFrame"), 0)
    _integer(window.get("endFrame"), window["startFrame"] + 1)
    return dict(window)


def _overlaps(a: dict[str, int], b: dict[str, int]) -> bool:
    return a["startFrame"] < b["endFrame"] and b["startFrame"] < a["endFrame"]
