"""12-TET working profiles for Persian modal-aware phrase planning.

These interval sets are computational approximations, not authoritative radif
transcriptions or a substitute for regional performance practice.
"""
from __future__ import annotations
from typing import Any

PERSIAN_MODAL_PROFILES: dict[str, dict[str, Any]] = {
    "shur": {"intervals": (0, 2, 3, 5, 7, 8, 10), "emphasized_degrees": (2, 4), "final_degree": 0, "approach_degrees": (6, 5), "description": "Shur family working approximation"},
    "homayun": {"intervals": (0, 2, 3, 6, 7, 8, 11), "emphasized_degrees": (2, 5), "final_degree": 0, "approach_degrees": (6, 5), "description": "Homayun working approximation"},
    "mahour": {"intervals": (0, 2, 4, 5, 7, 9, 11), "emphasized_degrees": (2, 4), "final_degree": 0, "approach_degrees": (6, 5), "description": "Mahour working approximation"},
}

def resolve_persian_modal_profile(name: str, tonic_pc: int = 0) -> dict[str, Any]:
    """Return a validated transposed modal profile in 12-tone equal temperament."""
    if not isinstance(name, str) or name not in PERSIAN_MODAL_PROFILES:
        raise ValueError("unsupported persian_dastgah; supported: shur, homayun, mahour")
    if isinstance(tonic_pc, bool) or not isinstance(tonic_pc, int) or not 0 <= tonic_pc <= 11:
        raise ValueError("tonic_pc must be a pitch class from 0 to 11")
    profile = PERSIAN_MODAL_PROFILES[name]
    steps = profile["intervals"]
    return {
        "name": name, "description": profile["description"], "intervals": steps,
        "scale_pitch_classes": tuple((tonic_pc + step) % 12 for step in steps),
        "emphasized_pitch_classes": tuple((tonic_pc + steps[i]) % 12 for i in profile["emphasized_degrees"]),
        "final_pitch_class": (tonic_pc + steps[profile["final_degree"]]) % 12,
        "approach_pitch_classes": tuple((tonic_pc + steps[i]) % 12 for i in profile["approach_degrees"]),
        "tuning": "12tet_approximation", "microtonal_audio_rendered": False,
    }
