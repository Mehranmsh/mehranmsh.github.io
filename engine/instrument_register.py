"""Catalog-backed playable-register guidance for MIDI note events.

Ranges are recording-planning ranges from sample_bank's capture catalog. They
are practical target ranges, not a guarantee about every physical instrument.
"""
from __future__ import annotations

from typing import Any

from sample_bank import SAMPLE_INSTRUMENT_CATALOG

ALIASES = {
    "guitar": "acoustic_guitar",
    "bass": "electric_bass",
    "strings": "strings",
    "piano": "piano",
}


def resolve_register(instrument: str) -> dict[str, Any]:
    """Return a catalog register, or an explicit unknown status without guessing."""
    if not isinstance(instrument, str) or not instrument.strip():
        raise ValueError("instrument must be a non-empty slug")
    slug = instrument.strip().lower()
    catalog_slug = ALIASES.get(slug, slug)
    spec = SAMPLE_INSTRUMENT_CATALOG.get(catalog_slug)
    if spec is None:
        return {
            "instrument": slug,
            "catalog_instrument": None,
            "status": "register_not_catalogued",
            "note_range": None,
        }
    low, high = spec["note_range"]
    return {
        "instrument": slug,
        "catalog_instrument": catalog_slug,
        "status": "catalog_capture_range",
        "note_range": [low, high],
    }


def fit_note_to_register(note: int, note_range: list[int] | tuple[int, int]) -> int:
    """Move by octaves only, preserving pitch class, to the nearest in-range note."""
    if isinstance(note, bool) or not isinstance(note, int) or not 0 <= note <= 127:
        raise ValueError("MIDI note must be an integer from 0 to 127")
    if (not isinstance(note_range, (list, tuple)) or len(note_range) != 2
            or any(isinstance(v, bool) or not isinstance(v, int) for v in note_range)):
        raise ValueError("note_range must contain two integer MIDI notes")
    low, high = note_range
    if not 0 <= low <= high <= 127:
        raise ValueError("note_range must be an ordered MIDI range from 0 to 127")
    candidates = [candidate for candidate in range(low, high + 1)
                  if candidate % 12 == note % 12]
    if not candidates:
        raise ValueError("Instrument register contains no octave equivalent for this pitch class")
    return min(candidates, key=lambda candidate: (abs(candidate - note), candidate))
