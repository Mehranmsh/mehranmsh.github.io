"""Deterministic stereo expression planning for arrangement parts."""
from __future__ import annotations

from typing import Any

_PART_BASE = {
    "melody": 0.00, "chords": 0.00, "bass": 0.00, "contrabass": -0.08,
    "kick": 0.00, "snare": 0.00, "closed_hat": -0.14,
    "open_hat": 0.20, "cajon": 0.00, "kalimba": 0.16, "guitar": -0.24, "strings": 0.00,
    "electric_guitar": 0.34, "harp": 0.18, "cello": -0.16,
}
_SECTION_WIDTH = {
    "verse": 0.82, "pre_chorus": 1.0, "chorus": 1.28,
    "final_chorus": 1.42, "bridge": 0.62,
}


def plan_part_expression(
    part: str,
    section: str,
    base_pan: float = 0.0,
    event_index: int = 0,
) -> dict[str, Any]:
    """Return a bounded, deterministic stereo position and expression label.

    Existing chord-voice panning is preserved and gently widened/narrowed by
    section. Rhythm anchors stay centered; hats and optional layers get stable
    positions. No audio or instrument recording is synthesized here.
    """
    if part not in _PART_BASE:
        raise ValueError(f"Unsupported arrangement part: {part}")
    if section not in _SECTION_WIDTH:
        raise ValueError(f"Unsupported section: {section}")
    if isinstance(base_pan, bool) or not isinstance(base_pan, (int, float)) or not -1.0 <= base_pan <= 1.0:
        raise ValueError("base_pan must be between -1.0 and 1.0")
    if isinstance(event_index, bool) or not isinstance(event_index, int) or event_index < 0:
        raise ValueError("event_index must be a non-negative integer")
    width = _SECTION_WIDTH[section]
    if part in ("melody", "bass", "contrabass", "kick", "snare", "cajon"):
        pan = -0.08 if part == "contrabass" else 0.0
    elif part == "closed_hat":
        pan = -0.14 if event_index % 2 == 0 else 0.14
    elif part == "open_hat":
        pan = 0.24
    elif part == "chords":
        pan = float(base_pan)
    elif part in ("guitar", "electric_guitar"):
        pan = max(-0.85, min(0.85, float(base_pan) * width))
    elif part == "strings":
        pan = max(-0.75, min(0.75, float(base_pan) * width))
    else:
        pan = max(-0.75, min(0.75, float(base_pan) * width))
    return {
        "part": part,
        "section": section,
        "pan": round(pan, 3),
        "stereo_width": width,
        "profile": f"{section}_{part}_stereo_v1",
        "planner": "deterministic_part_expression_v1",
    }
