"""SQLite-backed job registry. Jobs are intake records only; no worker synthesizes audio."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

DB_PATH = Path(os.getenv("MEHRAN_SVS_JOB_DB", "./data/jobs.sqlite3"))
RETENTION_SECONDS = 7 * 24 * 60 * 60
MAX_ACTIVE_JOBS = 1000


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(DB_PATH), timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def initialize_job_store() -> None:
    with _connect() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("""
            CREATE TABLE IF NOT EXISTS singing_jobs (
                job_id TEXT PRIMARY KEY,
                token_hash TEXT NOT NULL,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                cancellation_requested INTEGER NOT NULL DEFAULT 0
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_singing_jobs_expiry ON singing_jobs(expires_at)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_singing_jobs_created ON singing_jobs(created_at)")
        db.execute("""
            CREATE TABLE IF NOT EXISTS singing_job_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                status TEXT NOT NULL,
                detail_code TEXT NOT NULL,
                created_at REAL NOT NULL,
                FOREIGN KEY(job_id) REFERENCES singing_jobs(job_id) ON DELETE CASCADE
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_job_events_job ON singing_job_events(job_id, event_id)")


def _public_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "job_id": row["job_id"],
        "project_id": row["project_id"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "expires_at": row["expires_at"],
        "cancellation_requested": bool(row["cancellation_requested"]),
        "generation_ready": False,
        "audio_generated": False,
    }


def create_job(project_id: str, payload: dict) -> tuple[dict, str]:
    now = time.time()
    job_id = str(uuid.uuid4())
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    with _connect() as db:
        db.execute("DELETE FROM singing_jobs WHERE expires_at <= ?", (now,))
        active = db.execute(
            "SELECT COUNT(*) FROM singing_jobs WHERE status NOT IN ('cancelled', 'expired')"
        ).fetchone()[0]
        if active >= MAX_ACTIVE_JOBS:
            raise RuntimeError("The job registry is full. Try again later.")
        db.execute(
            """INSERT INTO singing_jobs
            (job_id, token_hash, project_id, status, payload_json, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, 'blocked_model_unavailable', ?, ?, ?, ?)""",
            (job_id, token_hash, project_id, serialized, now, now, now + RETENTION_SECONDS),
        )
        row = db.execute("SELECT * FROM singing_jobs WHERE job_id = ?", (job_id,)).fetchone()
    return _public_record(row), token


def get_job(job_id: str, token: str) -> dict | None:
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.time()
    with _connect() as db:
        row = db.execute("SELECT * FROM singing_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None or row["expires_at"] <= now:
            return None
        if not secrets.compare_digest(row["token_hash"], token_hash):
            return None
        return _public_record(row)


def cancel_job(job_id: str, token: str) -> dict | None:
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.time()
    with _connect() as db:
        row = db.execute("SELECT * FROM singing_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None or row["expires_at"] <= now:
            return None
        if not secrets.compare_digest(row["token_hash"], token_hash):
            return None
        if row["status"] == "blocked_model_unavailable":
            db.execute(
                "UPDATE singing_jobs SET status = 'cancelled', cancellation_requested = 1, updated_at = ? WHERE job_id = ?",
                (now, job_id),
            )
        updated = db.execute("SELECT * FROM singing_jobs WHERE job_id = ?", (job_id,)).fetchone()
        return _public_record(updated)



def get_job_events(job_id: str, token: str) -> list[dict] | None:
    """Return event history only after verifying the per-job bearer token."""
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.time()
    with _connect() as db:
        row = db.execute("SELECT token_hash, expires_at FROM singing_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None or row["expires_at"] <= now:
            return None
        if not secrets.compare_digest(row["token_hash"], token_hash):
            return None
        events = db.execute(
            "SELECT event_type, status, detail_code, created_at FROM singing_job_events WHERE job_id = ? ORDER BY event_id",
            (job_id,),
        ).fetchall()
        return [dict(event) for event in events]
