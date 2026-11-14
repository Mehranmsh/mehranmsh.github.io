"""Deterministic vocal-space planning for accompaniment events."""
from __future__ import annotations

from typing import Any

_DUCKABLE_PARTS = {"chords", "guitar", "strings", "electric_guitar"}


def plan_vocal_space(
    part: str,
    start_tick: int,
    duration_ticks: int,
    vocal_intervals: list[tuple[int, int]],
) -> dict[str, Any]:
    """Duck harmonic layers only while the lead vocal/melody is active."""
    if not isinstance(part, str) or not part:
        raise ValueError("part must be a non-empty string")
    for name, value in (("start_tick", start_tick), ("duration_ticks", duration_ticks)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{name} must be a non-negative integer")
    if duration_ticks <= 0:
        raise ValueError("duration_ticks must be positive")
    if not isinstance(vocal_intervals, list):
        raise ValueError("vocal_intervals must be a list")
    event_end = start_tick + duration_ticks
    overlap_ticks = 0
    for interval in vocal_intervals:
        if (not isinstance(interval, (tuple, list)) or len(interval) != 2
                or any(isinstance(v, bool) or not isinstance(v, int) for v in interval)
                or interval[0] < 0 or interval[1] <= interval[0]):
            raise ValueError("Each vocal interval must contain valid start and end ticks")
        overlap_ticks += max(0, min(event_end, interval[1]) - max(start_tick, interval[0]))
    overlap_ticks = min(duration_ticks, overlap_ticks)
    overlap_ratio = overlap_ticks / duration_ticks
    if part not in _DUCKABLE_PARTS:
        gain, mode = 1.0, "unaffected"
    elif overlap_ticks == 0:
        gain, mode = 1.0, "vocal_rest"
    else:
        # Scale ducking with the share of the event occupied by lead activity.
        gain = max(0.68, 1.0 - 0.24 * overlap_ratio)
        mode = "support_under_vocal"
    return {
        "gain": round(gain, 4),
        "mode": mode,
        "overlap_ratio": round(overlap_ratio, 4),
        "overlap_ticks": overlap_ticks,
        "planner": "deterministic_vocal_space_v1",
    }
