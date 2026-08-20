import re
from typing import Iterable, List


LOOP_PHASES = [
    "discover",
    "plan",
    "implement",
    "verify",
    "review",
    "ship",
    "learn",
]

LOOP_STATUSES = [
    "planned",
    "active",
    "completed",
    "blocked",
    "skipped",
]


def normalize_slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip().lower())
    slug = slug.strip("-._")
    if not slug:
        raise ValueError("Loop slug cannot be empty.")
    return slug


def validate_phase(phase: str) -> str:
    if phase not in LOOP_PHASES:
        raise ValueError(f"Invalid phase '{phase}'. Use one of: {', '.join(LOOP_PHASES)}")
    return phase


def validate_status(status: str) -> str:
    if status not in LOOP_STATUSES:
        raise ValueError(f"Invalid status '{status}'. Use one of: {', '.join(LOOP_STATUSES)}")
    return status


def default_success_criteria() -> List[str]:
    return [
        "目标、范围和非目标写入 loop 文档。",
        "至少一个可运行命令证明本轮能力可用。",
        "测试或验证输出能复现。",
        "变更可提交，且不会把 data/workspace 产物带入 git。",
    ]


def merge_criteria(values: Iterable[str]) -> List[str]:
    criteria = [item.strip() for item in values if item.strip()]
    return criteria or default_success_criteria()
