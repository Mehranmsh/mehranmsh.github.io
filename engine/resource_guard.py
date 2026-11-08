"""Fail-closed resource policy for future local generation jobs.

This module performs no I/O, downloads, retries, billing, or model startup.
It is deliberately not wired to the HTTP job route until runtime acceptance.
"""
from __future__ import annotations

import re
import secrets
import threading
from dataclasses import dataclass


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
    """In-process single-job reservation guard; fail closed on unknown data."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active: tuple[str, str] | None = None
        self._seen_keys: set[str] = set()

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

        with self._lock:
            if idempotency_key in self._seen_keys:
                return GuardDecision(False, "duplicate_request", "This request key has already been used.")
            if self._active is not None:
                return GuardDecision(False, "concurrency_limit", "A generation job is already reserved.")
            reservation_id = secrets.token_urlsafe(18)
            self._active = (reservation_id, idempotency_key)
            self._seen_keys.add(idempotency_key)
            return GuardDecision(True, "reserved", "Resources reserved; no model was started.", reservation_id)

    def release(self, reservation_id: str) -> bool:
        """Release only the matching active reservation; never clears key history."""
        if not isinstance(reservation_id, str) or not reservation_id:
            return False
        with self._lock:
            if self._active is None or self._active[0] != reservation_id:
                return False
            self._active = None
            return True

    def status(self) -> dict:
        with self._lock:
            return {
                "active_jobs": 1 if self._active is not None else 0,
                "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
                "max_batch_size": MAX_BATCH_SIZE,
                "max_duration_seconds": MAX_DURATION_SECONDS,
                "seen_idempotency_keys": len(self._seen_keys),
            }
