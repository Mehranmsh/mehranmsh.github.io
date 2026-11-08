"""Durable fail-closed resource policy for future local generation jobs.

Reservations are persisted in SQLite and serialized with BEGIN IMMEDIATE.
A process restart never silently clears an active reservation: recovery must
explicitly release the exact reservation ID after an operator verifies that
no inference process is still running. This module never starts a model.
"""
from __future__ import annotations

import re
import secrets
import sqlite3
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DISK_RESERVE_BYTES = 2 * 1024**3
MAX_DURATION_SECONDS = 600
MAX_BATCH_SIZE = 1
MAX_CONCURRENT_JOBS = 1
_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:-]{16,128}$")


@dataclass(frozen=True)
class ResourceSnapshot:
    free_bytes: int | None
    disk_reserve_bytes: int = DEFAULT_DISK_RESERVE_BYTES
    active_jobs: int = 0


@dataclass(frozen=True)
class GuardDecision:
    allowed: bool
    code: str
    message: str
    reservation_id: str | None = None


class ResourceGuard:
    """SQLite-backed single-job reservation guard; fail closed on unknown data."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        if not self.db_path.parent.exists() or not self.db_path.parent.is_dir():
            raise ValueError("Reservation database parent directory must already exist.")
        with self._connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS job_reservations (
                    reservation_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL CHECK(status IN ('active','released')),
                    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                    released_at INTEGER
                )
            """)
            db.execute("""
                CREATE INDEX IF NOT EXISTS idx_job_reservations_status
                ON job_reservations(status)
            """)

    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=10000")
        return db

    @staticmethod
    def _valid_int(value: object) -> bool:
        return isinstance(value, int) and not isinstance(value, bool)

    def reserve(
        self,
        *,
        snapshot: ResourceSnapshot,
        engine_ready: bool,
        idempotency_key: str,
        duration_seconds: int,
        batch_size: int = 1,
    ) -> GuardDecision:
        if engine_ready is not True:
            return GuardDecision(False, "engine_not_ready", "Local engine is not verified and ready.")
        if not isinstance(snapshot, ResourceSnapshot):
            return GuardDecision(False, "resource_snapshot_unknown", "Resource information is unavailable.")
        if not self._valid_int(snapshot.free_bytes) or snapshot.free_bytes < 0:
            return GuardDecision(False, "disk_space_unknown", "Free disk space is unknown; job was not accepted.")
        if not self._valid_int(snapshot.disk_reserve_bytes) or snapshot.disk_reserve_bytes < 0:
            return GuardDecision(False, "disk_policy_invalid", "Disk reserve configuration is invalid.")
        if snapshot.free_bytes < snapshot.disk_reserve_bytes:
            return GuardDecision(False, "disk_reserve_reached", "Free disk space is below the protected reserve.")
        if not self._valid_int(snapshot.active_jobs) or snapshot.active_jobs < 0:
            return GuardDecision(False, "active_job_state_unknown", "Active job state is invalid.")
        if snapshot.active_jobs >= MAX_CONCURRENT_JOBS:
            return GuardDecision(False, "concurrency_limit", "A generation job is already active.")
        if not self._valid_int(duration_seconds) or not 10 <= duration_seconds <= MAX_DURATION_SECONDS:
            return GuardDecision(False, "duration_limit", "Duration must be an integer from 10 to 600 seconds.")
        if not self._valid_int(batch_size) or batch_size != MAX_BATCH_SIZE:
            return GuardDecision(False, "batch_limit", "Only one output per request is permitted.")
        if not isinstance(idempotency_key, str) or not _IDEMPOTENCY_RE.fullmatch(idempotency_key):
            return GuardDecision(False, "invalid_idempotency_key", "A 16-128 character idempotency key is required.")

        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT status FROM job_reservations WHERE idempotency_key=?",
                (idempotency_key,),
            ).fetchone()
            if existing is not None:
                db.rollback()
                return GuardDecision(False, "duplicate_request", "This request key has already been used.")
            active = db.execute(
                "SELECT COUNT(*) AS total FROM job_reservations WHERE status='active'"
            ).fetchone()["total"]
            if active >= MAX_CONCURRENT_JOBS:
                db.rollback()
                return GuardDecision(False, "concurrency_limit", "A generation job is already reserved.")
            reservation_id = secrets.token_urlsafe(24)
            db.execute(
                "INSERT INTO job_reservations(reservation_id,idempotency_key,status) VALUES(?,?,'active')",
                (reservation_id, idempotency_key),
            )
            db.commit()
            return GuardDecision(True, "reserved", "Resources reserved durably; no model was started.", reservation_id)
        except sqlite3.IntegrityError:
            db.rollback()
            return GuardDecision(False, "duplicate_request", "This request key has already been used.")
        except sqlite3.Error:
            db.rollback()
            return GuardDecision(False, "reservation_store_error", "Durable reservation failed; job was not accepted.")
        finally:
            db.close()

    def release(self, reservation_id: str) -> bool:
        """Release only the matching active reservation; idempotency history remains."""
        if not isinstance(reservation_id, str) or not reservation_id:
            return False
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            result = db.execute(
                "UPDATE job_reservations SET status='released', released_at=unixepoch() "
                "WHERE reservation_id=? AND status='active'",
                (reservation_id,),
            )
            db.commit()
            return result.rowcount == 1
        except sqlite3.Error:
            db.rollback()
            return False
        finally:
            db.close()

    def status(self) -> dict:
        db = self._connect()
        try:
            rows = db.execute("""
                SELECT
                    SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_jobs,
                    COUNT(*) AS seen_idempotency_keys
                FROM job_reservations
            """).fetchone()
            active = int(rows["active_jobs"] or 0)
            return {
                "active_jobs": active,
                "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
                "max_batch_size": MAX_BATCH_SIZE,
                "max_duration_seconds": MAX_DURATION_SECONDS,
                "seen_idempotency_keys": int(rows["seen_idempotency_keys"] or 0),
                "recovery_required": active > 0,
            }
        finally:
            db.close()

    def active_reservations(self) -> list[dict]:
        """Expose reservation IDs for explicit operator reconciliation only."""
        db = self._connect()
        try:
            rows = db.execute("""
                SELECT reservation_id, created_at
                FROM job_reservations WHERE status='active'
                ORDER BY created_at
            """).fetchall()
            return [dict(row) for row in rows]
        finally:
            db.close()
