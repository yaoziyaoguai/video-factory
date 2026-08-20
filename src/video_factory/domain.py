from dataclasses import dataclass, field
from typing import List, Optional


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


@dataclass(frozen=True)
class EngineeringLoop:
    id: int
    slug: str
    title: str
    objective: str
    status: str
    branch: str
    success_criteria: List[str]
    created_at: str
    updated_at: str
    completed_at: Optional[str] = None


@dataclass(frozen=True)
class LoopEvent:
    id: int
    loop_id: int
    phase: str
    status: str
    summary: str
    evidence: List[str]
    created_at: str


@dataclass(frozen=True)
class Niche:
    slug: str
    name: str
    audience: str
    format: str
    automation_fit: int
    hook_patterns: List[str]
    risks: List[str]


@dataclass(frozen=True)
class TopicCandidate:
    id: int
    loop_id: Optional[int]
    niche_slug: str
    title: str
    angle: str
    audience: str
    risk_level: str
    automation_difficulty: int
    score: int
    rationale: str
    status: str
    created_at: str
