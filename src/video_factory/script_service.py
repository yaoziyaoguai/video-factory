import re
from typing import Dict

from .domain import Scene, ScriptDraft, Topic, TopicCandidate


SCRIPT_BLUEPRINTS = {
    "emotion-stories": {
        "structure": "情绪悬念 -> 生活场景 -> 情绪反转 -> 关系边界 -> 评论提问",
        "hook": "很多人不是突然变冷，而是在某个瞬间决定不再解释。",
        "beats": [
            ("hook", "stock", "emotional close-up, quiet conflict, vertical"),
            ("scene", "stock", "daily relationship moment, text message silence, vertical"),
            ("turn", "image", "conceptual split between expectation and boundary, vertical"),
            ("takeaway", "stock", "person walking alone with calm expression, vertical"),
            ("comment", "local", "minimal ending card with reflective question"),
        ],
        "quality_checks": ["避免指责某一类人", "结尾给边界感，不做情绪煽动", "保留评论问题"],
    },
    "history-curiosities": {
        "structure": "人物悬念 -> 时代困境 -> 关键选择 -> 反常识结论 -> 现实映射",
        "hook": "这个故事真正有意思的地方，不是他赢了，而是他差点输在最小的选择上。",
        "beats": [
            ("hook", "image", "ancient portrait inspired scene, dramatic light, vertical"),
            ("context", "stock", "old books, historical documents, vertical"),
            ("choice", "image", "crossroads, ancient decision moment, cinematic vertical"),
            ("insight", "stock", "museum detail, timeline, vertical"),
            ("comment", "local", "ending card with fact-check reminder"),
        ],
        "quality_checks": ["事实发布前必须人工核查", "区分正史/野史/演绎", "避免绝对化历史结论"],
    },
    "life-avoidance": {
        "structure": "痛点 -> 3 条清单 -> 反直觉解释 -> 今日行动 -> 收藏提示",
        "hook": "这个坑很多人不是不知道，而是每次都在最忙的时候忘了避开。",
        "beats": [
            ("hook", "stock", "asian office worker overwhelmed at desk, practical decision stress, vertical"),
            ("list", "local", "editorial checklist card, three short rules, clean Chinese typography, vertical"),
            ("explain", "local", "editorial insight card, low-cost reminder, clean Chinese typography, vertical"),
            ("action", "local", "bold action card, one tiny habit, high contrast Chinese typography, vertical"),
            ("save", "local", "save checklist ending card, comment prompt, clean Chinese typography, vertical"),
        ],
        "quality_checks": ["建议必须低风险可执行", "避免医疗/法律/投资建议", "标题和正文都要适合收藏"],
    },
    "light-science": {
        "structure": "反直觉问题 -> 简明机制 -> 生活例子 -> 一个小技巧 -> 复盘问题",
        "hook": "你以为这是意志力问题，其实大脑可能只是在用最省力的方式保护你。",
        "beats": [
            ("hook", "stock", "curious person thinking, question mark mood, vertical"),
            ("mechanism", "image", "simple science illustration, brain and habit, vertical"),
            ("example", "stock", "phone scrolling fatigue, everyday life, vertical"),
            ("tip", "local", "one practical tip card, clean typography"),
            ("comment", "local", "ending question card"),
        ],
        "quality_checks": ["复杂概念只做轻解释", "避免医疗化诊断", "保留事实核查位"],
    },
    "healing-bedtime": {
        "structure": "温柔开场 -> 小故事设定 -> 低谷瞬间 -> 情绪落点 -> 睡前收束",
        "hook": "如果今天已经很累了，先别急着变好，听一个很小的故事。",
        "beats": [
            ("hook", "image", "warm bedtime room, soft light, vertical"),
            ("setting", "image", "rainy night small shop, quiet street, vertical"),
            ("low", "image", "lonely but peaceful character, cinematic vertical"),
            ("comfort", "stock", "warm tea, window light, calm mood, vertical"),
            ("close", "local", "soft ending card, good night message"),
        ],
        "quality_checks": ["语气要慢，不要喊口号", "避免过度鸡汤", "画面提示要柔和一致"],
    },
}


def draft_script(topic: Topic, duration_target: int = 45) -> ScriptDraft:
    return draft_script_from_values(
        title=topic.title,
        angle=topic.angle or "反常识、强共鸣、适合转发",
        niche_slug="general",
        audience="泛短视频用户",
        duration_target=duration_target,
    )


def draft_candidate_script(candidate: TopicCandidate, duration_target: int = 45) -> ScriptDraft:
    return draft_script_from_values(
        title=candidate.title,
        angle=candidate.angle,
        niche_slug=candidate.niche_slug,
        audience=candidate.audience,
        duration_target=duration_target,
    )


def draft_script_from_values(
    title: str,
    angle: str,
    niche_slug: str,
    audience: str,
    duration_target: int = 45,
) -> ScriptDraft:
    clean_title = title.strip()
    blueprint = SCRIPT_BLUEPRINTS.get(niche_slug)
    if blueprint is None:
        return draft_general_script(clean_title, angle, duration_target)

    per_scene = max(4.0, round(duration_target / 5, 1))
    hook = f"{blueprint['hook']}这期讲「{clean_title}」。"
    beats = blueprint["beats"]
    narrations = build_niche_narrations(clean_title, angle, audience, niche_slug)

    scenes = [
        Scene(
            position=index + 1,
            narration=narrations[index],
            duration=per_scene,
            visual_strategy=str(beats[index][1]),
            visual_prompt=f"{beats[index][2]}, topic: {clean_title}",
            search_terms=build_search_terms(clean_title, str(beats[index][0])),
        )
        for index in range(5)
    ]

    return ScriptDraft(
        title=clean_title,
        hook=hook,
        duration_target=duration_target,
        scenes=scenes,
        hashtags=build_hashtags(clean_title, niche_slug),
        niche_slug=niche_slug,
        structure=str(blueprint["structure"]),
        quality_checks=list(blueprint["quality_checks"]),
        platform_notes={
            "douyin": "发布前人工检查 AIGC 标识、素材来源和标题是否过度承诺。",
            "review_focus": "先看前 3 秒 hook、字幕密度、事实/建议风险。",
            "art_direction": director_note_for_niche(niche_slug),
        },
    )


def draft_general_script(title: str, angle: str, duration_target: int) -> ScriptDraft:
    per_scene = max(4.0, round(duration_target / 5, 1))
    hook = f"你以为「{title}」只是普通话题？真正影响完播的，是前 3 秒有没有戳中人。"
    scenes = [
        Scene(1, hook, per_scene, "stock", f"vertical short video hook, emotional close-up, {title}", build_search_terms(title, "reaction emotion")),
        Scene(2, f"这条视频先抓住一个角度：{angle}。不要讲大道理，先讲一个观众马上能代入的场景。", per_scene, "stock", f"daily life scene, relatable problem, {title}", build_search_terms(title, "daily life problem")),
        Scene(3, "接着给出一个反转：观众以为问题在表面，其实真正的原因藏在选择、习惯或信息差里。", per_scene, "image", f"conceptual illustration of hidden reason behind {title}, cinematic, vertical", build_search_terms(title, "surprise insight")),
        Scene(4, "然后用一句能记住的话收束，让观众觉得这条内容不是刷过就忘，而是值得收藏。", per_scene, "stock", f"person taking notes, practical takeaway, {title}", build_search_terms(title, "takeaway notes")),
        Scene(5, "最后留一个开放问题，引导评论。你遇到过类似情况吗？评论区说一个，我继续做下一条。", per_scene, "local", "brand ending card with question prompt", ["comments", "question", "short video ending"]),
    ]
    return ScriptDraft(
        title=title,
        hook=hook,
        duration_target=duration_target,
        scenes=scenes,
        hashtags=build_hashtags(title, "general"),
        quality_checks=["检查 hook 是否具体", "检查结尾是否有互动问题", "检查素材来源"],
    )


def draft_to_dict(draft: ScriptDraft) -> Dict[str, object]:
    return {
        "title": draft.title,
        "hook": draft.hook,
        "duration_target": draft.duration_target,
        "disclosure_required": draft.disclosure_required,
        "niche_slug": draft.niche_slug,
        "structure": draft.structure,
        "quality_checks": draft.quality_checks,
        "platform_notes": draft.platform_notes,
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
    if re.search(r"[\u4e00-\u9fff]", title):
        return [title, suffix]
    ascii_words = re.findall(r"[A-Za-z0-9]+", title)
    if ascii_words:
        return [" ".join(ascii_words), suffix]
    return [title, suffix]


def build_hashtags(title: str, niche_slug: str = "general") -> list:
    compact = re.sub(r"\s+", "", title)
    niche_tag = {
        "emotion-stories": "情绪故事",
        "history-curiosities": "历史冷知识",
        "life-avoidance": "生活避坑",
        "light-science": "冷知识",
        "healing-bedtime": "睡前故事",
    }.get(niche_slug, "短视频")
    return ["AI视频", niche_tag, "涨粉实验", compact[:12]]


def build_niche_narrations(title: str, angle: str, audience: str, niche_slug: str) -> list:
    templates = {
        "emotion-stories": [
            f"很多关系不是突然变淡的。今天这条讲「{title}」，先别急着对号入座。",
            f"最容易被忽略的是这个场景：你还在解释，对方其实已经不想理解了。角度是：{angle}。",
            "真正的反转是，沉默有时不是冷漠，而是一个人终于决定把力气留给自己。",
            f"给 {audience} 的一句话：能好好沟通就沟通，不能沟通就别用自责换连接。",
            "你有没有遇到过那种突然不想解释的瞬间？评论区说一句，我做下一条。",
        ],
        "history-curiosities": [
            f"如果只看结果，「{title}」像一句爽文标题；但历史里真正重要的是中间那次选择。",
            f"这期的角度是：{angle}。先看困境，再看他为什么没有按常规出牌。",
            "很多历史故事的转折，不在大场面，而在一个当时没人重视的小动作。",
            "发布前这里要人工核查事实：人物、年代、事件来源，不能把演绎当结论。",
            "你想看哪个历史人物的反常识故事？评论区留名字，我去查资料。",
        ],
        "life-avoidance": [
            "做决定前，先避开这 3 个坑。每天都会用到。",
            "别拖到最忙才处理。别用感觉替代规则。别做完不复盘。",
            "真正有用的不是道理多，而是提前放一个低成本提醒。",
            "今天只做一件事：写下最像你的那个坑，下次先停三秒。",
            "收藏这张清单。你最想避开什么坑？评论区告诉我。",
        ],
        "light-science": [
            f"「{title}」听起来像生活问题，其实背后有一个很简单的机制。",
            f"这期不讲复杂术语，只讲一个能用的解释：{angle}。",
            "你可以把它理解成，大脑在压力下会优先选择最省力、最熟悉的路径。",
            "所以建议也要小：别试图一次改变全部，只改一个触发点。",
            "你还想听哪个生活现象背后的原因？评论区给我一个问题。",
        ],
        "healing-bedtime": [
            f"如果今天很累，先听一个关于「{title}」的小故事。",
            f"故事里的那个人也没有马上变好，他只是先允许自己慢下来。角度：{angle}。",
            "后来他发现，很多变化不是突然发生的，而是在没人看见的时候一点点回来。",
            "所以今晚不用逼自己立刻振作。能睡一觉、喝口水、少责怪自己，就已经很好。",
            "把这条留给今晚的你。晚安，明天再慢慢来。",
        ],
    }
    return templates.get(niche_slug, [])


def director_note_for_niche(niche_slug: str) -> str:
    notes = {
        "life-avoidance": "真实镜头只表现日常压力和记录动作；清单、行动、结尾必须使用自有设计卡，避免图库素材把信息讲散。",
        "emotion-stories": "镜头要安静、克制，避免夸张哭泣或争吵；画面留白服务情绪，不做戏剧化狗血。",
        "history-curiosities": "历史类画面优先文献、器物、环境氛围，避免用不准确的具象人物替代事实。",
        "light-science": "视觉语言要像轻科普板书，少用医学化大脑图和夸张特效。",
        "healing-bedtime": "低对比、慢节奏、暖光，禁止高饱和鸡汤感。",
    }
    return notes.get(niche_slug, "先定义一个视觉母题，再选素材；每个镜头必须服务同一种情绪。")
