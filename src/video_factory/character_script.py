"""角色稿的显式版本边界；不将台词伪装成旧旁白。"""
import math
import re
from typing import Any

from .narration_plan import trim_v2

CHARACTER_SCRIPT_VERSION = "video-factory/character-script-v1"


def script_scene_text(script: dict[str, Any], scene: dict[str, Any]) -> str:
    """仅用于素材检索/阅读的投影，不回写剧本或用作 TTS 输入。"""
    if script.get("version") == CHARACTER_SCRIPT_VERSION:
        return " ".join(turn["text"] for turn in scene["dialogue"]) or scene.get("visible_action") or scene.get("purpose") or scene["visual_prompt"]
    return str(scene["narration"])

_CLAIMS = [
    r"(?:已(?:经)?|得到|完成|成功)(?:被)?(?:验证|证实|证明)",
    r"(?:验证|证实|证明)(?:了|通过|成立|有效|因果|效果|结果)",
    r"(?:真实|现实|实拍|现场)(?:验证|实验|测试|结果|证据|效果)",
    r"(?:因果|产品效果|方法效果).{0,8}(?:成立|已验证|得到验证|被证明)",
]
_NEGATED = r"(?:不|非|不能|不得|并非|不是|不可|未)(?:能|得|是|可)?[^，。；！？!?]{0,12}$"

def validate_character_script(value: Any, *, duration_seconds: int | None = None,
                              duration_range: dict[str, int] | None = None,
                              require_canon_facts: bool = False) -> dict[str, Any]:
    src = _object(value, "角色剧本")
    if src.get("version") != CHARACTER_SCRIPT_VERSION:
        raise ValueError("不支持的角色剧本版本。")
    if duration_seconds is not None and (not _integer(duration_seconds) or not 20 <= duration_seconds <= 180):
        raise ValueError("Script draft target durationSeconds must be an integer between 20 and 180.")
    low, high = (duration_seconds * 0.6, duration_seconds * 1.4) if duration_seconds is not None else (0, math.inf)
    if duration_range is not None:
        low, high = duration_range.get("minSeconds"), duration_range.get("maxSeconds")
        if (duration_seconds is None or not _integer(low) or not _integer(high) or not 20 <= low <= duration_seconds <= high <= 180):
            raise ValueError("Script draft target durationRange is invalid.")
    characters = []
    character_map = {}
    for raw in _list(src.get("characters"), "characters"):
        c = _object(raw, "角色")
        kind = c.get("kind")
        if kind not in ("character", "narrator"):
            raise ValueError("角色 kind 无效。")
        char = {"id": _id(c.get("id")), "name": _text(c.get("name")), "kind": kind,
                "appearance": _text(c.get("appearance"), kind == "narrator"),
                "personality": _text(c.get("personality"), True), "voice_intent": _text(c.get("voice_intent"), True),
                "voice_profile_id": None if c.get("voice_profile_id") is None and "voice_profile_id" in c
                else _text(c.get("voice_profile_id"))}
        if char["id"] in character_map:
            raise ValueError("角色 id 不得重复。")
        characters.append(char)
        character_map[char["id"]] = char
    scenes, turn_ids = [], set()
    for raw in _list(src.get("scenes"), "scenes"):
        s = _object(raw, "镜头")
        if "narration" in s:
            raise ValueError("角色剧本不接受 narration。")
        if not _integer(s.get("position")) or s["position"] < 1:
            raise ValueError("镜头 position 必须是正整数。")
        duration = s.get("duration")
        if (isinstance(duration, bool) or not isinstance(duration, (float, int))
                or not math.isfinite(duration) or duration <= 0):
            raise ValueError("镜头时长无效。")
        if s.get("visual_strategy") not in ("stock", "image", "generated", "local"):
            raise ValueError("镜头 visual_strategy 无效。")
        cast = [_id(item) for item in _list(s.get("character_ids"), "出场角色")]
        if len(set(cast)) != len(cast) or any(character_map.get(item, {}).get("kind") != "character" for item in cast):
            raise ValueError("出场角色必须引用不重复的 character。")
        dialogue = []
        for raw_turn in _list(s.get("dialogue"), "dialogue"):
            t = _object(raw_turn, "台词")
            turn_id, speaker = _id(t.get("id")), _id(t.get("speaker_id"))
            if turn_id in turn_ids or speaker not in character_map:
                raise ValueError("台词 id 重复或说话角色不存在。")
            turn_ids.add(turn_id)
            pause = t.get("after_pause_frames")
            if not _integer(pause) or pause < 0:
                raise ValueError("台词停顿必须是非负安全整数帧。")
            dialogue.append({"id": turn_id, "speaker_id": speaker, "text": _text(t.get("text")),
                             "delivery": _text(t.get("delivery"), True), "after_pause_frames": int(pause)})
        if sum(t["after_pause_frames"] + 1 for t in dialogue) > math.floor(duration * 30 + 0.5):
            raise ValueError("镜头放不下台词与停顿。")
        terms = _strings(s.get("search_terms"), 1)
        if len(set(terms)) != len(terms):
            raise ValueError("search_terms 不得重复。")
        scene = {"position": int(s["position"]), "duration": duration, "visual_strategy": s["visual_strategy"],
                 "visual_prompt": _text(s.get("visual_prompt")), "search_terms": terms,
                 "character_ids": cast, "dialogue": dialogue}
        for key in ("purpose", "visible_action", "on_screen_text", "sound_cue"):
            if key in s:
                scene[key] = _text(s[key], key == "on_screen_text")
        for key in ("success_criteria", "failure_conditions"):
            if key in s:
                scene[key] = _strings(s[key], 1)
        if scene["visual_strategy"] == "generated":
            values = [scene.get(k, "") for k in ("purpose", "visual_prompt", "visible_action", "on_screen_text")]
            values += [t["text"] for t in dialogue] + scene.get("success_criteria", []) + scene.get("failure_conditions", [])
            for text in values:
                for pattern in _CLAIMS:
                    for match in re.finditer(pattern, text):
                        if not re.search(_NEGATED, text[max(0, match.start() - 18):match.start()]):
                            raise ValueError("Generated visual cannot claim real-world evidence.")
        scenes.append(scene)
    scenes.sort(key=lambda scene: scene["position"])
    if not 3 <= len(scenes) <= 24 or any(s["position"] != i + 1 for i, s in enumerate(scenes)):
        raise ValueError("剧本须有3–24个连续编号的镜头。")
    if not low <= sum(s["duration"] for s in scenes) <= high:
        raise ValueError("剧本总时长超出目标范围。")
    if require_canon_facts and "canonFacts" not in src:
        raise ValueError("Series script drafts must contain a canonFacts array with at most 8 entries.")
    result = {"version": CHARACTER_SCRIPT_VERSION, "characters": characters, "scenes": scenes}
    for key in ("viewerPromise", "narrativeArc"):
        if key in src:
            result[key] = _text(src[key])
    if "canonFacts" in src:
        result["canonFacts"] = _strings(src["canonFacts"], 0)
    return result


def _integer(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            and value == math.floor(value) and abs(value) <= 2**53 - 1)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(label + " 必须是对象。")
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(label + " 必须是数组。")
    return value


def _text(value: Any, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not trim_v2(value)):
        raise ValueError("字段必须是" + ("" if allow_empty else "非空") + "字符串。")
    return trim_v2(value)


def _id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise ValueError("ID 格式无效。")
    return value


def _strings(value: Any, minimum: int) -> list[str]:
    values = _list(value, "字符串列表")
    if not minimum <= len(values) <= 8:
        raise ValueError("字符串列表数量无效。")
    return [_text(item) for item in values]
