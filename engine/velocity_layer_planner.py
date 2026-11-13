"""Velocity-layer blending for recorded multisample instruments.

This planner uses equal-power interpolation only where two recorded velocity
ranges overlap. It does not claim to reproduce a source sampler's proprietary
or undocumented crossfade curve.
"""
from __future__ import annotations

import math
from typing import Any

from sample_bank import Sample, SampleBank, _integer


def plan_velocity_layers(
    bank: SampleBank,
    instrument: str,
    midi_note: int,
    velocity: int,
    articulation: str = "sustain",
) -> dict[str, Any]:
    """Return exact-note sample layers and equal-power gains for one velocity."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if not isinstance(instrument, str) or not instrument:
        raise ValueError("instrument must be a non-empty name")
    midi_note = _integer(midi_note, 0, 127, "midi_note")
    velocity = _integer(velocity, 1, 127, "velocity")
    if not isinstance(articulation, str) or not articulation:
        raise ValueError("articulation must be a non-empty name")

    matching_samples = [
        sample for sample in bank.samples
        if sample.instrument == instrument
        and (sample.midi_note == midi_note or (
            sample.playable_key_min is not None
            and sample.playable_key_min <= midi_note <= sample.playable_key_max
        ))
        and sample.articulation == articulation
        and sample.velocity_min <= velocity <= sample.velocity_max
    ]
    # Multiple recorded round-robin takes share one velocity zone. Collapse
    # each zone to a representative here; the renderer rotates the takes
    # after velocity-layer planning so they are never mistaken for extra
    # dynamic layers.
    zones = sorted({
        (sample.velocity_min, sample.velocity_max,
         sample.velocity_fade_in, sample.velocity_fade_out)
        for sample in matching_samples
    }, key=lambda zone: (zone[0], zone[1], 0 if zone[3] is not None else 1, repr(zone[2]), repr(zone[3])))
    candidates = [
        min(
            (sample for sample in matching_samples
             if (sample.velocity_min, sample.velocity_max,
                 sample.velocity_fade_in, sample.velocity_fade_out) == zone),
            key=lambda sample: (sample.round_robin_index, sample.path.as_posix()),
        )
        for zone in zones
    ]
    if not candidates:
        return {
            "instrument": instrument,
            "midi_note": midi_note,
            "velocity": velocity,
            "articulation": articulation,
            "layers": [],
            "selection_mode": "no_exact_velocity_layer",
        }
    if len(candidates) > 2:
        raise ValueError("More than two velocity layers overlap; explicit blend mapping is required")
    if any(sample.velocity_fade_in is not None or sample.velocity_fade_out is not None
           for sample in candidates):
        layers = []
        for sample in candidates:
            gain = 1.0
            if sample.velocity_fade_in is not None:
                low, high = sample.velocity_fade_in
                position = min(1.0, max(0.0, (velocity - low) / (high - low)))
                gain = math.sin(position * math.pi / 2.0)
            elif sample.velocity_fade_out is not None:
                low, high = sample.velocity_fade_out
                position = min(1.0, max(0.0, (velocity - low) / (high - low)))
                gain = math.cos(position * math.pi / 2.0)
            layers.append({"sample": sample, "gain": gain})
        return {
            "instrument": instrument,
            "midi_note": midi_note,
            "velocity": velocity,
            "articulation": articulation,
            "layers": layers,
            "selection_mode": "sfz_velocity_crossfade",
        }

    if len(candidates) == 1:
        return {
            "instrument": instrument,
            "midi_note": midi_note,
            "velocity": velocity,
            "articulation": articulation,
            "layers": [{"sample": candidates[0], "gain": 1.0}],
            "selection_mode": "single_recorded_layer",
        }

    lower, upper = candidates
    overlap_start = max(lower.velocity_min, upper.velocity_min)
    overlap_end = min(lower.velocity_max, upper.velocity_max)
    if overlap_start >= overlap_end:
        raise ValueError("Overlapping velocity candidates have an invalid blend interval")
    position = (velocity - overlap_start) / (overlap_end - overlap_start)
    angle = position * math.pi / 2.0
    return {
        "instrument": instrument,
        "midi_note": midi_note,
        "velocity": velocity,
        "articulation": articulation,
        "layers": [
            {"sample": lower, "gain": math.cos(angle)},
            {"sample": upper, "gain": math.sin(angle)},
        ],
        "selection_mode": "equal_power_velocity_crossfade",
        "overlap": [overlap_start, overlap_end],
        "blend_position": position,
    }
