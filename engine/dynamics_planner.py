"""Deterministic per-note musical dynamics planning."""
from __future__ import annotations

from typing import Any

DYNAMIC_CURVES = {"natural", "crescendo", "decrescendo", "arch", "steady"}
_DYNAMIC_MARKS = ((48, "pp"), (60, "p"), (72, "mp"), (86, "mf"), (102, "f"), (116, "ff"))

def _curve_velocity(index: int, count: int, curve: str) -> int:
    position = index / max(1, count - 1)
    if curve == "crescendo": return round(62 + 42 * position)
    if curve == "decrescendo": return round(104 - 42 * position)
    if curve == "arch": return round(64 + 42 * (1 - abs(2 * position - 1)))
    if curve == "steady": return 82
    return round(70 + 22 * (1 - abs(2 * position - 1)))

def _mark(velocity: int) -> str:
    result = "pp"
    for threshold, label in _DYNAMIC_MARKS:
        if velocity >= threshold: result = label
    return result

def plan_dynamics(events: list[dict[str, Any]], curve: str = "natural") -> dict[str, Any]:
    """Assign MIDI velocity and conventional dynamic marks to phrase notes."""
    if not isinstance(events, list) or not events:
        raise ValueError("events must be a non-empty list")
    if not isinstance(curve, str) or curve not in DYNAMIC_CURVES:
        raise ValueError(f"curve must be one of: {', '.join(sorted(DYNAMIC_CURVES))}")
    planned = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValueError("each dynamics event must be an object")
        explicit = event.get("dynamics_velocity")
        if explicit is not None:
            if isinstance(explicit, bool) or not isinstance(explicit, int) or not 1 <= explicit <= 127:
                raise ValueError("dynamics_velocity must be an integer from 1 to 127")
            velocity, reason = explicit, "explicit_velocity_preserved"
        else:
            velocity = _curve_velocity(index, len(events), curve)
            stressed = event.get("is_lexically_stressed") is True and event.get("stress_confidence") == "curated"
            if stressed:
                velocity = min(127, velocity + 6)
            reason = curve + "_phrase_curve" + ("_plus_curated_lexical_stress" if stressed else "")
            if event.get("is_phrase_final_syllable") is True:
                velocity = max(1, velocity - 3)
                reason += "_cadence_release"
        planned.append({"note_index": index, "dynamics_velocity": velocity,
                        "dynamic_mark": _mark(velocity), "dynamics_curve": curve,
                        "dynamics_reason": reason, "confidence": "deterministic"})
    velocities = [item["dynamics_velocity"] for item in planned]
    return {"curve": curve, "event_count": len(planned), "events": planned,
            "velocity_range": [min(velocities), max(velocities)],
            "planner": "deterministic_phrase_dynamics_v1"}
