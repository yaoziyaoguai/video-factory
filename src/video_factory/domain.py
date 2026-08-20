from dataclasses import dataclass, field
from typing import List


@dataclass(frozen=True)
class Topic:
    id: int
    title: str
    angle: str
    source: str
    priority: int
    status: str


@dataclass(frozen=True)
class Scene:
    position: int
    narration: str
    duration: float
    visual_strategy: str
    visual_prompt: str
    search_terms: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class ScriptDraft:
    title: str
    hook: str
    duration_target: int
    scenes: List[Scene]
    hashtags: List[str]
    disclosure_required: bool = True
