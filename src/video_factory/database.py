import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional

from .domain import Scene, Topic


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


def topic_from_row(row: sqlite3.Row) -> Topic:
    return Topic(
        id=int(row["id"]),
        title=str(row["title"]),
        angle=str(row["angle"]),
        source=str(row["source"]),
        priority=int(row["priority"]),
        status=str(row["status"]),
    )
