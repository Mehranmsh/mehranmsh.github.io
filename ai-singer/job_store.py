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
    connection.execute("PRAGMA foreign_keys = ON")
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

        # Forward-only schema migration for the future native worker queue.
        columns = {row["name"] for row in db.execute("PRAGMA table_info(singing_jobs)").fetchall()}
        migrations = {
            "priority": "INTEGER NOT NULL DEFAULT 0",
            "attempt_count": "INTEGER NOT NULL DEFAULT 0",
            "max_attempts": "INTEGER NOT NULL DEFAULT 3",
            "worker_id": "TEXT",
            "lease_until": "REAL",
        }
        for column, declaration in migrations.items():
            if column not in columns:
                db.execute(f"ALTER TABLE singing_jobs ADD COLUMN {column} {declaration}")
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_singing_jobs_queue
            ON singing_jobs(status, priority DESC, created_at ASC)
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_singing_jobs_lease
            ON singing_jobs(status, lease_until)
        """)


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
        db.execute(
            "INSERT INTO singing_job_events (job_id, event_type, status, detail_code, created_at) VALUES (?, ?, ?, ?, ?)",
            (job_id, "created", "blocked_model_unavailable", "native_model_not_ready", now),
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
            db.execute(
                "INSERT INTO singing_job_events (job_id, event_type, status, detail_code, created_at) VALUES (?, ?, ?, ?, ?)",
                (job_id, "cancelled", "cancelled", "user_requested", now),
            )
        updated = db.execute("SELECT * FROM singing_jobs WHERE job_id = ?", (job_id,)).fetchone()
        return _public_record(updated)


def _insert_event(db: sqlite3.Connection, job_id: str, event_type: str, status: str, detail_code: str, now: float) -> None:
    db.execute(
        "INSERT INTO singing_job_events (job_id, event_type, status, detail_code, created_at) VALUES (?, ?, ?, ?, ?)",
        (job_id, event_type, status, detail_code, now),
    )


def claim_next_job(worker_id: str, *, model_ready: bool, lease_seconds: int = 90) -> dict | None:
    """Atomically lease one queued job. A worker cannot claim anything unless readiness is verified."""
    if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
        raise ValueError("worker_id must contain 1 to 128 characters")
    if type(model_ready) is not bool or not model_ready:
        return None
    if type(lease_seconds) is not int or not 15 <= lease_seconds <= 900:
        raise ValueError("lease_seconds must be an integer between 15 and 900")

    now = time.time()
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        # Expired leases are retried or terminally failed before selecting new work.
        expired = db.execute(
            """SELECT job_id, attempt_count, max_attempts FROM singing_jobs
               WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?""",
            (now,),
        ).fetchall()
        for item in expired:
            if item["attempt_count"] < item["max_attempts"]:
                db.execute(
                    """UPDATE singing_jobs SET status = 'queued', worker_id = NULL,
                       lease_until = NULL, updated_at = ? WHERE job_id = ?""",
                    (now, item["job_id"]),
                )
                _insert_event(db, item["job_id"], "lease_expired", "queued", "retry_scheduled", now)
            else:
                db.execute(
                    """UPDATE singing_jobs SET status = 'failed', worker_id = NULL,
                       lease_until = NULL, updated_at = ? WHERE job_id = ?""",
                    (now, item["job_id"]),
                )
                _insert_event(db, item["job_id"], "lease_expired", "failed", "max_attempts_reached", now)

        row = db.execute(
            """SELECT * FROM singing_jobs WHERE status = 'queued'
               ORDER BY priority DESC, created_at ASC LIMIT 1"""
        ).fetchone()
        if row is None:
            return None
        lease_until = now + lease_seconds
        updated = db.execute(
            """UPDATE singing_jobs SET status = 'processing', worker_id = ?,
               lease_until = ?, attempt_count = attempt_count + 1, updated_at = ?
               WHERE job_id = ? AND status = 'queued'""",
            (worker_id, lease_until, now, row["job_id"]),
        )
        if updated.rowcount != 1:
            return None
        _insert_event(db, row["job_id"], "claimed", "processing", "worker_lease_granted", now)
        claimed = db.execute("SELECT * FROM singing_jobs WHERE job_id = ?", (row["job_id"],)).fetchone()
        return {**_public_record(claimed), "attempt_count": claimed["attempt_count"],
                "worker_id": claimed["worker_id"], "lease_until": claimed["lease_until"]}


def renew_job_lease(job_id: str, worker_id: str, *, lease_seconds: int = 90) -> bool:
    """Extend an unexpired lease held by the same worker; stale workers cannot revive it."""
    if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
        raise ValueError("worker_id must contain 1 to 128 characters")
    if type(lease_seconds) is not int or not 15 <= lease_seconds <= 900:
        raise ValueError("lease_seconds must be an integer between 15 and 900")
    now = time.time()
    with _connect() as db:
        updated = db.execute(
            """UPDATE singing_jobs SET lease_until = ?, updated_at = ?
               WHERE job_id = ? AND status = 'processing' AND worker_id = ?
               AND lease_until > ? AND cancellation_requested = 0""",
            (now + lease_seconds, now, job_id, worker_id, now),
        )
        return updated.rowcount == 1


def finish_job(job_id: str, worker_id: str, *, success: bool, error_code: str | None = None) -> bool:
    """Close a worker lease. Success is only a lifecycle result, not proof of WAV quality."""
    if not isinstance(worker_id, str) or not worker_id.strip() or len(worker_id) > 128:
        raise ValueError("worker_id must contain 1 to 128 characters")
    if type(success) is not bool:
        raise ValueError("success must be a boolean")
    if error_code is not None and (
        not isinstance(error_code, str) or not error_code or len(error_code) > 80
        or not error_code.replace("_", "").isalnum()
    ):
        raise ValueError("error_code must be a short internal code")
    now = time.time()
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            """SELECT attempt_count, max_attempts FROM singing_jobs
               WHERE job_id = ? AND status = 'processing' AND worker_id = ?
               AND lease_until > ?""",
            (job_id, worker_id, now),
        ).fetchone()
        if row is None:
            return False
        if success:
            status, event, detail = "completed", "completed", "worker_completed"
        elif row["attempt_count"] < row["max_attempts"]:
            status, event, detail = "queued", "retry_scheduled", error_code or "worker_retryable_error"
        else:
            status, event, detail = "failed", "failed", error_code or "max_attempts_reached"
        db.execute(
            """UPDATE singing_jobs SET status = ?, worker_id = NULL, lease_until = NULL,
               updated_at = ? WHERE job_id = ?""",
            (status, now, job_id),
        )
        _insert_event(db, job_id, event, status, detail, now)
        return True



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
