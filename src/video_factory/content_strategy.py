import json
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from .domain import Niche, TopicCandidate


def default_niches() -> List[Niche]:
    return [
        Niche(
            slug="emotion-stories",
            name="情绪/关系故事",
            audience="18-40 岁、对亲密关系和人际困境有代入感的泛人群",
            format="悬念开头 + 生活场景 + 情绪反转 + 评论问题",
            automation_fit=8,
            hook_patterns=["你有没有发现", "最伤人的不是", "很多关系变淡"],
            risks=["容易鸡汤化", "价值观表述需要克制", "避免编造真实人物隐私"],
        ),
        Niche(
            slug="history-curiosities",
            name="历史人物/奇闻",
            audience="喜欢故事、冷知识和历史反转的泛知识用户",
            format="人物困境 + 关键选择 + 反常识结论",
            automation_fit=7,
            hook_patterns=["历史上最反常识的是", "这个人真正厉害的不是", "很多人误会了"],
            risks=["事实核查成本高", "不能把野史当正史", "素材版权要记录"],
        ),
        Niche(
            slug="life-avoidance",
            name="生活避坑/清单",
            audience="希望少踩坑、爱收藏实用信息的普通用户",
            format="痛点 + 清单 + 立即可做的建议",
            automation_fit=9,
            hook_patterns=["这几个坑别再踩了", "普通人最容易忽略", "如果你也遇到"],
            risks=["建议不能越界成医疗/法律/金融结论", "清单容易同质化"],
        ),
        Niche(
            slug="light-science",
            name="冷知识/轻科普",
            audience="喜欢短平快知识、愿意收藏转发的用户",
            format="反直觉问题 + 简明解释 + 生活应用",
            automation_fit=8,
            hook_patterns=["为什么你会", "原来不是因为", "一个小知识"],
            risks=["需要事实来源", "复杂概念不能过度简化"],
        ),
        Niche(
            slug="healing-bedtime",
            name="治愈/睡前故事",
            audience="睡前刷视频、需要情绪安慰和放松的人群",
            format="温柔设定 + 小故事 + 情绪落点",
            automation_fit=8,
            hook_patterns=["睡前听一个", "今天如果很累", "把这句话留给你"],
            risks=["节奏慢导致完播不稳", "画面和声音质量影响大"],
        ),
    ]


TOPIC_PATTERNS: Dict[str, List[Dict[str, object]]] = {
    "emotion-stories": [
        {"title": "越长大越不想解释的真正原因", "angle": "成年人关系里的低成本沉默", "risk": "low", "difficulty": 3},
        {"title": "关系变淡前最容易被忽略的 3 个信号", "angle": "可评论、可收藏的情绪清单", "risk": "medium", "difficulty": 3},
        {"title": "为什么有些人突然就不联系你了", "angle": "从责怪转向边界感", "risk": "medium", "difficulty": 4},
        {"title": "真正让人失望的不是吵架", "angle": "情绪反转和强共鸣", "risk": "low", "difficulty": 3},
        {"title": "一句话判断一段关系还值不值得继续", "angle": "争议 hook + 评论互动", "risk": "medium", "difficulty": 4},
        {"title": "越善良的人越容易吃的一个亏", "angle": "大众代入 + 结尾自我保护", "risk": "low", "difficulty": 3},
    ],
    "history-curiosities": [
        {"title": "历史上最会翻盘的人，都做对了一件事", "angle": "人物故事归纳", "risk": "medium", "difficulty": 5},
        {"title": "一个小决定，改变了一个朝代的走向", "angle": "悬念故事", "risk": "high", "difficulty": 6},
        {"title": "被误解最多的历史人物之一", "angle": "反常识纠偏", "risk": "high", "difficulty": 6},
        {"title": "古人处理压力的方式，比现代人狠多了", "angle": "历史与现实连接", "risk": "medium", "difficulty": 5},
        {"title": "这场失败为什么反而成就了他", "angle": "失败叙事", "risk": "medium", "difficulty": 5},
        {"title": "一个冷门人物的逆袭，藏着普通人的机会", "angle": "小人物故事", "risk": "medium", "difficulty": 5},
    ],
    "life-avoidance": [
        {"title": "普通人做决定前最该避开的 3 个坑", "angle": "强收藏清单", "risk": "low", "difficulty": 2},
        {"title": "买东西前先问自己这 4 个问题", "angle": "消费避坑", "risk": "low", "difficulty": 2},
        {"title": "让生活变乱的不是懒，而是这个习惯", "angle": "反直觉生活观察", "risk": "low", "difficulty": 2},
        {"title": "周末最不该浪费时间的 3 件事", "angle": "时间管理但不说教", "risk": "low", "difficulty": 2},
        {"title": "普通人存不下钱，往往不是收入问题", "angle": "轻财商但避免具体投资建议", "risk": "medium", "difficulty": 3},
        {"title": "让你越来越累的 5 个隐形任务", "angle": "情绪 + 生活效率", "risk": "low", "difficulty": 2},
    ],
    "light-science": [
        {"title": "为什么越刷手机越觉得累", "angle": "生活化心理科普", "risk": "medium", "difficulty": 4},
        {"title": "你以为是拖延，其实是大脑在省电", "angle": "反直觉解释", "risk": "medium", "difficulty": 4},
        {"title": "为什么有些声音会让人瞬间放松", "angle": "治愈和科普结合", "risk": "low", "difficulty": 4},
        {"title": "一个让人更容易坚持的小技巧", "angle": "行为科学轻解释", "risk": "medium", "difficulty": 4},
        {"title": "为什么越想睡越睡不着", "angle": "睡眠常识但不医疗化", "risk": "medium", "difficulty": 5},
        {"title": "为什么短视频前 3 秒这么重要", "angle": "内容创作者可用的轻科普", "risk": "low", "difficulty": 3},
    ],
    "healing-bedtime": [
        {"title": "睡前听一个关于慢慢变好的小故事", "angle": "温柔陪伴", "risk": "low", "difficulty": 3},
        {"title": "如果今天很累，把这句话留给自己", "angle": "情绪安慰", "risk": "low", "difficulty": 2},
        {"title": "一个人低谷时最需要的不是鼓励", "angle": "反鸡汤治愈", "risk": "low", "difficulty": 3},
        {"title": "给总是想太多的人，一个睡前答案", "angle": "睡前场景", "risk": "low", "difficulty": 3},
        {"title": "你不用马上变好，也可以先休息一下", "angle": "高共鸣短文案", "risk": "low", "difficulty": 2},
        {"title": "一个关于小店、雨夜和重新开始的故事", "angle": "AI 图片适配强", "risk": "low", "difficulty": 3},
    ],
}

RISK_SCORE = {"low": 18, "medium": 10, "high": 2}


def generate_candidate_drafts(count: int) -> List[Dict[str, object]]:
    niches = {niche.slug: niche for niche in default_niches()}
    drafts: List[Dict[str, object]] = []
    while len(drafts) < count:
        for niche_slug, patterns in TOPIC_PATTERNS.items():
            niche = niches[niche_slug]
            for pattern in patterns:
                if len(drafts) >= count:
                    return drafts
                difficulty = int(pattern["difficulty"])
                risk = str(pattern["risk"])
                score = niche.automation_fit * 8 + RISK_SCORE[risk] - difficulty * 3
                drafts.append(
                    {
                        "niche_slug": niche.slug,
                        "title": str(pattern["title"]),
                        "angle": str(pattern["angle"]),
                        "audience": niche.audience,
                        "risk_level": risk,
                        "automation_difficulty": difficulty,
                        "score": score,
                        "rationale": build_rationale(niche, risk, difficulty, score),
                    }
                )
    return drafts


def build_rationale(niche: Niche, risk_level: str, difficulty: int, score: int) -> str:
    return (
        f"{niche.name} 受众较广，自动化适配度 {niche.automation_fit}/10；"
        f"风险 {risk_level}，制作难度 {difficulty}/10，综合分 {score}。"
    )


def select_week_plan(candidates: Iterable[TopicCandidate], count: int = 7) -> List[TopicCandidate]:
    ordered = sorted(candidates, key=lambda item: (-item.score, item.id))
    selected: List[TopicCandidate] = []
    used_niches = set()

    for candidate in ordered:
        if candidate.niche_slug in used_niches:
            continue
        selected.append(candidate)
        used_niches.add(candidate.niche_slug)
        if len(selected) >= count:
            return selected

    for candidate in ordered:
        if candidate in selected:
            continue
        selected.append(candidate)
        if len(selected) >= count:
            return selected

    return selected


def write_week_plan(path: Path, candidates: Iterable[TopicCandidate]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "plan_name": path.stem,
        "items": [
            {
                "day": index + 1,
                "candidate_id": candidate.id,
                "niche_slug": candidate.niche_slug,
                "title": candidate.title,
                "angle": candidate.angle,
                "audience": candidate.audience,
                "risk_level": candidate.risk_level,
                "automation_difficulty": candidate.automation_difficulty,
                "score": candidate.score,
                "rationale": candidate.rationale,
            }
            for index, candidate in enumerate(candidates)
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
