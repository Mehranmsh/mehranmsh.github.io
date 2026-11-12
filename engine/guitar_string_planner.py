"""String-aware sample selection for recorded six-string guitar banks.

String identity is read from the recorded source filename. The planner never
transposes a sample or invents an unavailable string/note combination.
"""
from __future__ import annotations

import re
from typing import Any

from sample_bank import Sample, SampleBank, _integer
from velocity_layer_planner import plan_velocity_layers

STRING_ORDER = ("LowE", "A", "D", "G", "B", "HighE")
OPEN_MIDI = {"LowE": 40, "A": 45, "D": 50, "G": 55, "B": 59, "HighE": 64}
STRING_PATTERN = re.compile(r"(?:^|_)String(LowE|HighE|A|D|G|B)(?:_|$)", re.IGNORECASE)
STRING_CANONICAL = {name.lower(): name for name in STRING_ORDER}


def string_for_sample(sample: Sample) -> str | None:
    """Extract a six-string identity from the source filename, if present."""
    match = STRING_PATTERN.search(sample.path.stem)
    if not match:
        return None
    return STRING_CANONICAL.get(match.group(1).lower())


def plan_guitar_string(
    bank: SampleBank,
    instrument: str,
    midi_note: int,
    velocity: int,
    articulation: str = "sustain",
    *,
    preferred_string: str = "auto",
    max_fret: int = 4,
) -> dict[str, Any]:
    """Choose an exact recorded string/note, preferring first-position fingering.

    Automatic selection follows Low E, A, D, G, B, High E and picks the first
    sampled string whose fret is within max_fret. If none qualifies, it reports
    no_first_position_match rather than silently moving to a distant fret.
    """
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if not isinstance(instrument, str) or not instrument.strip():
        raise ValueError("instrument must be a non-empty name")
    midi_note = _integer(midi_note, 0, 127, "midi_note")
    velocity = _integer(velocity, 1, 127, "velocity")
    if not isinstance(articulation, str) or not articulation:
        raise ValueError("articulation must be a non-empty name")
    if isinstance(max_fret, bool) or not isinstance(max_fret, int) or not 0 <= max_fret <= 24:
        raise ValueError("max_fret must be an integer from 0 to 24")

    requested = preferred_string.strip()
    if requested.lower() != "auto":
        selected_name = STRING_CANONICAL.get(requested.lower())
        if selected_name is None:
            raise ValueError("preferred_string must be auto, LowE, A, D, G, B, or HighE")
        allowed = (selected_name,)
    else:
        allowed = STRING_ORDER

    available: dict[str, list[Sample]] = {name: [] for name in STRING_ORDER}
    for sample in bank.samples:
        if (sample.instrument != instrument or sample.midi_note != midi_note
                or sample.articulation != articulation
                or not sample.velocity_min <= velocity <= sample.velocity_max):
            continue
        name = string_for_sample(sample)
        if name in available:
            available[name].append(sample)

    candidates = []
    for order, name in enumerate(allowed):
        fret = midi_note - OPEN_MIDI[name]
        if fret < 0 or fret > max_fret or not available[name]:
            continue
        candidates.append((order, fret, name))
    if not candidates:
        return {
            "instrument": instrument,
            "midi_note": midi_note,
            "velocity": velocity,
            "articulation": articulation,
            "preferred_string": preferred_string,
            "max_fret": max_fret,
            "selected_string": None,
            "fret": None,
            "status": "no_first_position_match",
            "available_strings": [
                name for name in allowed if available[name]
            ],
            "layers": [],
        }

    _, fret, selected = min(candidates, key=lambda item: (item[0], item[1]))
    string_only = SampleBank(bank.root, tuple(
        sample for sample in bank.samples
        if sample.instrument == instrument
        and sample.midi_note == midi_note
        and sample.articulation == articulation
        and sample.velocity_min <= velocity <= sample.velocity_max
        and string_for_sample(sample) == selected
    ))
    layers = plan_velocity_layers(string_only, instrument, midi_note, velocity, articulation)
    selected_samples = layers["layers"]

    return {
        "instrument": instrument,
        "midi_note": midi_note,
        "velocity": velocity,
        "articulation": articulation,
        "preferred_string": preferred_string,
        "selected_string": selected,
        "fret": fret,
        "open_string_midi": OPEN_MIDI[selected],
        "status": "exact_recorded_string",
        "available_strings": [name for name in allowed if available[name]],
        "selection_mode": layers["selection_mode"],
        "layers": selected_samples,
    }
