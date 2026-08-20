import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional

from .domain import EngineeringLoop, LoopEvent, Niche, Scene, Topic, TopicCandidate


SCHEMA = """
CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    angle TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    priority INTEGER NOT NULL DEFAULT 50,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    scheduled_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    target_duration INTEGER NOT NULL DEFAULT 45,
    script_path TEXT,
    export_dir TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (topic_id) REFERENCES topics(id)
);

CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    narration TEXT NOT NULL,
    duration REAL NOT NULL,
    visual_strategy TEXT NOT NULL,
    visual_prompt TEXT NOT NULL,
    search_terms_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    scene_id INTEGER,
    provider TEXT NOT NULL,
    source_url TEXT,
    local_path TEXT,
    license_note TEXT,
    prompt TEXT,
    model TEXT,
    sha256 TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id),
    FOREIGN KEY (scene_id) REFERENCES scenes(id)
);

CREATE TABLE IF NOT EXISTS provider_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    operation TEXT NOT NULL,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS engineering_loops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    branch TEXT NOT NULL DEFAULT '',
    success_criteria_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS loop_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id INTEGER NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (loop_id) REFERENCES engineering_loops(id)
);

CREATE TABLE IF NOT EXISTS niches (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    audience TEXT NOT NULL,
    format TEXT NOT NULL,
    automation_fit INTEGER NOT NULL,
    hook_patterns_json TEXT NOT NULL,
    risks_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id INTEGER,
    niche_slug TEXT NOT NULL,
    title TEXT NOT NULL,
    angle TEXT NOT NULL,
    audience TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    automation_difficulty INTEGER NOT NULL,
    score INTEGER NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at TEXT NOT NULL,
    FOREIGN KEY (loop_id) REFERENCES engineering_loops(id),
    FOREIGN KEY (niche_slug) REFERENCES niches(slug)
);

CREATE TABLE IF NOT EXISTS content_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id INTEGER,
    name TEXT NOT NULL,
    candidate_ids_json TEXT NOT NULL,
    output_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (loop_id) REFERENCES engineering_loops(id)
);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path

    def connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    def add_topic(
        self,
        title: str,
        angle: str = "",
        source: str = "manual",
        priority: int = 50,
    ) -> int:
        created_at = utc_now()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO topics (title, angle, source, priority, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (title, angle, source, priority, created_at),
            )
            return int(cursor.lastrowid)

    def list_topics(self, status: Optional[str] = None) -> List[Topic]:
        query = "SELECT * FROM topics"
        params = []
        if status:
            query += " WHERE status = ?"
            params.append(status)
        query += " ORDER BY priority DESC, id ASC"
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [topic_from_row(row) for row in rows]

    def get_topic(self, topic_id: int) -> Topic:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if row is None:
            raise ValueError(f"Topic not found: {topic_id}")
        return topic_from_row(row)

    def create_job(self, topic_id: int, target_duration: int) -> int:
        now = utc_now()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO jobs (topic_id, status, target_duration, created_at, updated_at)
                VALUES (?, 'draft', ?, ?, ?)
                """,
                (topic_id, target_duration, now, now),
            )
            return int(cursor.lastrowid)

    def update_job(
        self,
        job_id: int,
        status: Optional[str] = None,
        script_path: Optional[Path] = None,
        export_dir: Optional[Path] = None,
    ) -> None:
        assignments = ["updated_at = ?"]
        params: List[object] = [utc_now()]
        if status is not None:
            assignments.append("status = ?")
            params.append(status)
        if script_path is not None:
            assignments.append("script_path = ?")
            params.append(str(script_path))
        if export_dir is not None:
            assignments.append("export_dir = ?")
            params.append(str(export_dir))
        params.append(job_id)
        with self.connect() as conn:
            conn.execute(
                f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ?",
                params,
            )

    def get_job(self, job_id: int) -> sqlite3.Row:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise ValueError(f"Job not found: {job_id}")
        return row

    def replace_scenes(self, job_id: int, scenes: Iterable[Scene]) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM scenes WHERE job_id = ?", (job_id,))
            conn.executemany(
                """
                INSERT INTO scenes (
                    job_id,
                    position,
                    narration,
                    duration,
                    visual_strategy,
                    visual_prompt,
                    search_terms_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        job_id,
                        scene.position,
                        scene.narration,
                        scene.duration,
                        scene.visual_strategy,
                        scene.visual_prompt,
                        json.dumps(scene.search_terms, ensure_ascii=False),
                    )
                    for scene in scenes
                ],
            )

    def get_scenes(self, job_id: int) -> List[Scene]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scenes WHERE job_id = ? ORDER BY position ASC",
                (job_id,),
            ).fetchall()
        return [
            Scene(
                position=int(row["position"]),
                narration=str(row["narration"]),
                duration=float(row["duration"]),
                visual_strategy=str(row["visual_strategy"]),
                visual_prompt=str(row["visual_prompt"]),
                search_terms=json.loads(str(row["search_terms_json"])),
            )
            for row in rows
        ]

    def create_loop(
        self,
        slug: str,
        title: str,
        objective: str,
        success_criteria: Iterable[str],
        branch: str = "",
    ) -> int:
        now = utc_now()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO engineering_loops (
                    slug,
                    title,
                    objective,
                    branch,
                    success_criteria_json,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    slug,
                    title,
                    objective,
                    branch,
                    json.dumps(list(success_criteria), ensure_ascii=False),
                    now,
                    now,
                ),
            )
            return int(cursor.lastrowid)

    def list_loops(self, status: Optional[str] = None) -> List[EngineeringLoop]:
        query = "SELECT * FROM engineering_loops"
        params = []
        if status:
            query += " WHERE status = ?"
            params.append(status)
        query += " ORDER BY id ASC"
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [loop_from_row(row) for row in rows]

    def get_loop(self, loop_ref: str) -> EngineeringLoop:
        where = "id = ?" if loop_ref.isdigit() else "slug = ?"
        value: object = int(loop_ref) if loop_ref.isdigit() else loop_ref
        with self.connect() as conn:
            row = conn.execute(
                f"SELECT * FROM engineering_loops WHERE {where}",
                (value,),
            ).fetchone()
        if row is None:
            raise ValueError(f"Loop not found: {loop_ref}")
        return loop_from_row(row)

    def add_loop_event(
        self,
        loop_id: int,
        phase: str,
        status: str,
        summary: str,
        evidence: Iterable[str],
    ) -> int:
        created_at = utc_now()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO loop_events (
                    loop_id,
                    phase,
                    status,
                    summary,
                    evidence_json,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    loop_id,
                    phase,
                    status,
                    summary,
                    json.dumps(list(evidence), ensure_ascii=False),
                    created_at,
                ),
            )
            conn.execute(
                "UPDATE engineering_loops SET updated_at = ? WHERE id = ?",
                (created_at, loop_id),
            )
            return int(cursor.lastrowid)

    def get_loop_events(self, loop_id: int) -> List[LoopEvent]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM loop_events WHERE loop_id = ? ORDER BY id ASC",
                (loop_id,),
            ).fetchall()
        return [loop_event_from_row(row) for row in rows]

    def complete_loop(self, loop_id: int, verification: Iterable[str]) -> None:
        now = utc_now()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE engineering_loops
                SET status = 'completed', updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (now, now, loop_id),
            )
            conn.execute(
                """
                INSERT INTO loop_events (
                    loop_id,
                    phase,
                    status,
                    summary,
                    evidence_json,
                    created_at
                )
                VALUES (?, 'ship', 'completed', 'Loop completed.', ?, ?)
                """,
                (
                    loop_id,
                    json.dumps(list(verification), ensure_ascii=False),
                    now,
                ),
            )

    def upsert_niches(self, niches: Iterable[Niche]) -> None:
        now = utc_now()
        with self.connect() as conn:
            conn.executemany(
                """
                INSERT INTO niches (
                    slug,
                    name,
                    audience,
                    format,
                    automation_fit,
                    hook_patterns_json,
                    risks_json,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET
                    name = excluded.name,
                    audience = excluded.audience,
                    format = excluded.format,
                    automation_fit = excluded.automation_fit,
                    hook_patterns_json = excluded.hook_patterns_json,
                    risks_json = excluded.risks_json,
                    updated_at = excluded.updated_at
                """,
                [
                    (
                        niche.slug,
                        niche.name,
                        niche.audience,
                        niche.format,
                        niche.automation_fit,
                        json.dumps(niche.hook_patterns, ensure_ascii=False),
                        json.dumps(niche.risks, ensure_ascii=False),
                        now,
                        now,
                    )
                    for niche in niches
                ],
            )

    def list_niches(self) -> List[Niche]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM niches ORDER BY slug ASC").fetchall()
        return [niche_from_row(row) for row in rows]

    def clear_topic_candidates(self, loop_id: Optional[int]) -> None:
        with self.connect() as conn:
            if loop_id is None:
                conn.execute("DELETE FROM topic_candidates WHERE loop_id IS NULL")
            else:
                conn.execute("DELETE FROM topic_candidates WHERE loop_id = ?", (loop_id,))

    def add_topic_candidate(
        self,
        loop_id: Optional[int],
        niche_slug: str,
        title: str,
        angle: str,
        audience: str,
        risk_level: str,
        automation_difficulty: int,
        score: int,
        rationale: str,
    ) -> int:
        created_at = utc_now()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO topic_candidates (
                    loop_id,
                    niche_slug,
                    title,
                    angle,
                    audience,
                    risk_level,
                    automation_difficulty,
                    score,
                    rationale,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    loop_id,
                    niche_slug,
                    title,
                    angle,
                    audience,
                    risk_level,
                    automation_difficulty,
                    score,
                    rationale,
                    created_at,
                ),
            )
            return int(cursor.lastrowid)

    def list_topic_candidates(
        self,
        loop_id: Optional[int] = None,
        niche_slug: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[TopicCandidate]:
        clauses = []
        params: List[object] = []
        if loop_id is not None:
            clauses.append("loop_id = ?")
            params.append(loop_id)
        if niche_slug is not None:
            clauses.append("niche_slug = ?")
            params.append(niche_slug)
        query = "SELECT * FROM topic_candidates"
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY score DESC, id ASC"
        if limit is not None:
            query += " LIMIT ?"
            params.append(limit)
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [topic_candidate_from_row(row) for row in rows]

    def create_content_plan(
        self,
        loop_id: Optional[int],
        name: str,
        candidate_ids: Iterable[int],
        output_path: Path,
    ) -> int:
        created_at = utc_now()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO content_plans (
                    loop_id,
                    name,
                    candidate_ids_json,
                    output_path,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    loop_id,
                    name,
                    json.dumps(list(candidate_ids), ensure_ascii=False),
                    str(output_path),
                    created_at,
                ),
            )
            return int(cursor.lastrowid)


def topic_from_row(row: sqlite3.Row) -> Topic:
    return Topic(
        id=int(row["id"]),
        title=str(row["title"]),
        angle=str(row["angle"]),
        source=str(row["source"]),
        priority=int(row["priority"]),
        status=str(row["status"]),
    )


def loop_from_row(row: sqlite3.Row) -> EngineeringLoop:
    return EngineeringLoop(
        id=int(row["id"]),
        slug=str(row["slug"]),
        title=str(row["title"]),
        objective=str(row["objective"]),
        status=str(row["status"]),
        branch=str(row["branch"]),
        success_criteria=json.loads(str(row["success_criteria_json"])),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
        completed_at=row["completed_at"],
    )


def loop_event_from_row(row: sqlite3.Row) -> LoopEvent:
    return LoopEvent(
        id=int(row["id"]),
        loop_id=int(row["loop_id"]),
        phase=str(row["phase"]),
        status=str(row["status"]),
        summary=str(row["summary"]),
        evidence=json.loads(str(row["evidence_json"])),
        created_at=str(row["created_at"]),
    )


def niche_from_row(row: sqlite3.Row) -> Niche:
    return Niche(
        slug=str(row["slug"]),
        name=str(row["name"]),
        audience=str(row["audience"]),
        format=str(row["format"]),
        automation_fit=int(row["automation_fit"]),
        hook_patterns=json.loads(str(row["hook_patterns_json"])),
        risks=json.loads(str(row["risks_json"])),
    )


def topic_candidate_from_row(row: sqlite3.Row) -> TopicCandidate:
    return TopicCandidate(
        id=int(row["id"]),
        loop_id=row["loop_id"],
        niche_slug=str(row["niche_slug"]),
        title=str(row["title"]),
        angle=str(row["angle"]),
        audience=str(row["audience"]),
        risk_level=str(row["risk_level"]),
        automation_difficulty=int(row["automation_difficulty"]),
        score=int(row["score"]),
        rationale=str(row["rationale"]),
        status=str(row["status"]),
        created_at=str(row["created_at"]),
    )
