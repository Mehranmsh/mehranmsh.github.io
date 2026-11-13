"""Deterministic section-aware arrangement density and part entry planning."""
from __future__ import annotations

import math
from typing import Any

_PARTS = {
    "melody": "lead",
    "chords": "harmony",
    "bass": "low_end",
    "kick": "rhythm_anchor",
    "snare": "backbeat",
    "closed_hat": "timekeeping",
    "open_hat": "transition_accent",
    "cajon": "rhythm_color",
    "kalimba": "melodic_color",
    "guitar": "rhythmic_harmony",
    "strings": "sustained_harmony",
    "electric_guitar": "hook_accent",
}
_SECTIONS = ("verse", "pre_chorus", "chorus", "bridge", "final_chorus")
# Multipliers are conservative arrangement balances, not loudness targets.
_GAINS = {
    "verse":       {"melody": 1.00, "chords": 0.82, "bass": 0.84, "kick": 0.82, "snare": 0.78, "closed_hat": 0.72, "open_hat": 0.0, "cajon": 0.42, "kalimba": 0.0, "guitar": 0.68, "strings": 0.0, "electric_guitar": 0.0},
    "pre_chorus":  {"melody": 1.02, "chords": 0.90, "bass": 0.92, "kick": 0.90, "snare": 0.90, "closed_hat": 0.86, "open_hat": 0.0, "cajon": 0.60, "kalimba": 0.30, "guitar": 0.88, "strings": 0.0, "electric_guitar": 0.0},
    "chorus":      {"melody": 1.04, "chords": 0.96, "bass": 0.98, "kick": 1.00, "snare": 1.00, "closed_hat": 0.98, "open_hat": 0.92, "cajon": 0.74, "kalimba": 0.48, "guitar": 0.96, "strings": 0.90, "electric_guitar": 0.92},
    "bridge":      {"melody": 1.00, "chords": 0.68, "bass": 0.72, "kick": 0.62, "snare": 0.58, "closed_hat": 0.55, "open_hat": 0.0, "cajon": 0.28, "guitar": 0.45, "strings": 0.0, "electric_guitar": 0.0},
    "final_chorus":{"melody": 1.08, "chords": 1.00, "bass": 1.04, "kick": 1.05, "snare": 1.08, "closed_hat": 1.05, "open_hat": 1.00, "cajon": 0.82, "guitar": 1.02, "strings": 1.00, "electric_guitar": 1.00},
}


def plan_part_arrangement(part: str, section: str, event_index: int = 0) -> dict[str, Any]:
    """Return deterministic activity, role and gain for one arrangement event."""
    if part not in _PARTS:
        raise ValueError(f"Unknown arrangement part: {part}")
    if section not in _SECTIONS:
        raise ValueError(f"Unknown arrangement section: {section}")
    if isinstance(event_index, bool) or not isinstance(event_index, int) or event_index < 0:
        raise ValueError("event_index must be a non-negative integer")
    gain = _GAINS[section][part]
    return {
        "active": gain > 0.0,
        "gain": gain,
        "role": _PARTS[part],
        "density": "sparse" if section == "bridge" else (
            "full" if section == "final_chorus" else
            "building" if section == "pre_chorus" else
            "full" if section == "chorus" else "supportive"
        ),
        "section": section,
        "event_index": event_index,
        "planner": "deterministic_section_arrangement_v1",
    }
