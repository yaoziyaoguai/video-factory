import re
from typing import Dict

from .domain import Scene, ScriptDraft, Topic


def draft_script(topic: Topic, duration_target: int = 45) -> ScriptDraft:
    per_scene = max(4.0, round(duration_target / 5, 1))
    angle = topic.angle or "反常识、强共鸣、适合转发"
    clean_title = topic.title.strip()
    hook = f"你以为「{clean_title}」只是普通话题？真正影响完播的，是前 3 秒有没有戳中人。"

    scenes = [
        Scene(
            position=1,
            narration=hook,
            duration=per_scene,
            visual_strategy="stock",
            visual_prompt=f"vertical short video hook, emotional close-up, {clean_title}",
            search_terms=build_search_terms(clean_title, "reaction emotion"),
        ),
        Scene(
            position=2,
            narration=f"这条视频先抓住一个角度：{angle}。不要讲大道理，先讲一个观众马上能代入的场景。",
            duration=per_scene,
            visual_strategy="stock",
            visual_prompt=f"daily life scene, relatable problem, {clean_title}",
            search_terms=build_search_terms(clean_title, "daily life problem"),
        ),
        Scene(
            position=3,
            narration="接着给出一个反转：观众以为问题在表面，其实真正的原因藏在选择、习惯或信息差里。",
            duration=per_scene,
            visual_strategy="image",
            visual_prompt=f"conceptual illustration of hidden reason behind {clean_title}, cinematic, vertical",
            search_terms=build_search_terms(clean_title, "surprise insight"),
        ),
        Scene(
            position=4,
            narration="然后用一句能记住的话收束，让观众觉得这条内容不是刷过就忘，而是值得收藏。",
            duration=per_scene,
            visual_strategy="stock",
            visual_prompt=f"person taking notes, practical takeaway, {clean_title}",
            search_terms=build_search_terms(clean_title, "takeaway notes"),
        ),
        Scene(
            position=5,
            narration="最后留一个开放问题，引导评论。你遇到过类似情况吗？评论区说一个，我继续做下一条。",
            duration=per_scene,
            visual_strategy="local",
            visual_prompt="brand ending card with question prompt",
            search_terms=["comments", "question", "short video ending"],
        ),
    ]

    return ScriptDraft(
        title=clean_title,
        hook=hook,
        duration_target=duration_target,
        scenes=scenes,
        hashtags=build_hashtags(clean_title),
    )


def draft_to_dict(draft: ScriptDraft) -> Dict[str, object]:
    return {
        "title": draft.title,
        "hook": draft.hook,
        "duration_target": draft.duration_target,
        "disclosure_required": draft.disclosure_required,
        "hashtags": draft.hashtags,
        "scenes": [
            {
                "position": scene.position,
                "narration": scene.narration,
                "duration": scene.duration,
                "visual_strategy": scene.visual_strategy,
                "visual_prompt": scene.visual_prompt,
                "search_terms": scene.search_terms,
            }
            for scene in draft.scenes
        ],
    }


def build_search_terms(title: str, suffix: str) -> list:
    ascii_words = re.findall(r"[A-Za-z0-9]+", title)
    if ascii_words:
        return [" ".join(ascii_words), suffix]
    return [title, suffix]


def build_hashtags(title: str) -> list:
    compact = re.sub(r"\s+", "", title)
    return ["AI视频", "短视频", "涨粉实验", compact[:12]]
