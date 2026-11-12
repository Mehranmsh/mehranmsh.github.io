"""Deterministic melodic response fills for genuine vocal-rest windows."""
from __future__ import annotations

from typing import Any

from persian_modal_planner import resolve_persian_modal_profile


def plan_melody_fill(
    *, gap_start_tick: int, gap_duration_ticks: int,
    scale_pitch_classes: list[int], chord_pitch_classes: list[int],
    reference_note: int, instrument_range: tuple[int, int] = (48, 84),
    max_notes: int = 4, base_velocity: int = 62,
    fill_style: str = "guitar", modal_profile: str | None = None,
    modal_tonic_pc: int = 0, modal_degree_cents: dict[int, float] | None = None,
) -> dict[str, Any]:
    """Create a short chord-aware fill wholly contained in a vocal-rest gap.

    Instrument profiles shape register, contour, density and articulation.
    This returns planning metadata only, not sample availability or rendered audio.
    """
    profiles = {
        "guitar": {"range": (48, 84), "notes": 4, "spacing": 180, "articulation": "fingerstyle", "release_ms": 24, "contour": (9, 7, 4, 2)},
        "piano": {"range": (48, 88), "notes": 5, "spacing": 144, "articulation": "staccato", "release_ms": 18, "contour": (0, 4, 7, 12, 7)},
        "strings": {"range": (48, 84), "notes": 2, "spacing": 360, "articulations": ("sustain",), "release_ms": 65, "contour": (0, 5)},
        "tar": {"range": (48, 84), "notes": 4, "spacing": 180, "articulations": ("mezrab_down", "mezrab_up"), "release_ms": 18, "contour": (7, 5, 2, 5)},
        "setar": {"range": (55, 88), "notes": 4, "spacing": 210, "articulations": ("mezrab_down", "mezrab_up"), "release_ms": 22, "contour": (5, 2, 7, 4)},
        "santur": {"range": (55, 90), "notes": 5, "spacing": 144, "articulations": ("soft_mallet", "soft_mallet", "roll", "hard_mallet", "roll"), "release_ms": 16, "contour": (0, 4, 7, 12, 7)},
        "kamancheh": {"range": (48, 84), "notes": 2, "spacing": 360, "articulations": ("short_bow", "long_bow"), "release_ms": 65, "contour": (0, 5)},
    }
    if fill_style not in profiles:
        raise ValueError("unsupported fill_style")
    profile = profiles[fill_style]
    modal = (resolve_persian_modal_profile(modal_profile, modal_tonic_pc, modal_degree_cents)
             if modal_profile is not None else None)
    if modal is not None:
        scale_pitch_classes = list(modal["scale_pitch_classes"])
    if instrument_range == (48, 84):
        instrument_range = profile["range"]
    if isinstance(gap_start_tick, bool) or not isinstance(gap_start_tick, int) or gap_start_tick < 0:
        raise ValueError("gap_start_tick must be a non-negative integer")
    if isinstance(gap_duration_ticks, bool) or not isinstance(gap_duration_ticks, int) or gap_duration_ticks < 0:
        raise ValueError("gap_duration_ticks must be a non-negative integer")
    if not isinstance(scale_pitch_classes, list) or not scale_pitch_classes or any(
        isinstance(pc, bool) or not isinstance(pc, int) or not 0 <= pc <= 11
        for pc in scale_pitch_classes
    ):
        raise ValueError("scale_pitch_classes must contain pitch classes from 0 to 11")
    if not isinstance(chord_pitch_classes, list) or not chord_pitch_classes or any(
        isinstance(pc, bool) or not isinstance(pc, int) or not 0 <= pc <= 11
        for pc in chord_pitch_classes
    ):
        raise ValueError("chord_pitch_classes must contain pitch classes from 0 to 11")
    if isinstance(reference_note, bool) or not isinstance(reference_note, int) or not 0 <= reference_note <= 127:
        raise ValueError("reference_note must be a MIDI note from 0 to 127")
    if (not isinstance(instrument_range, tuple) or len(instrument_range) != 2
            or any(isinstance(n, bool) or not isinstance(n, int) for n in instrument_range)
            or not 0 <= instrument_range[0] < instrument_range[1] <= 127):
        raise ValueError("instrument_range must be an ascending MIDI-note tuple")
    if isinstance(max_notes, bool) or not isinstance(max_notes, int) or not 1 <= max_notes <= 8:
        raise ValueError("max_notes must be from 1 to 8")
    if isinstance(base_velocity, bool) or not isinstance(base_velocity, int) or not 1 <= base_velocity <= 127:
        raise ValueError("base_velocity must be an integer from 1 to 127")
    if gap_duration_ticks < 120:
        return {"events": [], "reason": "gap_too_short", "planner": "instrument_shaped_melodic_fill_v2",
                "audio_rendered": False}

    count = min(max_notes, profile["notes"], max(1, gap_duration_ticks // profile["spacing"]))
    base = min(max(instrument_range[0], reference_note), instrument_range[1])
    candidates = [note for note in range(max(instrument_range[0], base - 12),
                                         min(instrument_range[1], base + 13) + 1)
                  if note % 12 in scale_pitch_classes]
    if not candidates:
        return {"events": [], "reason": "no_scale_notes_in_range",
                "planner": "instrument_shaped_melodic_fill_v2", "audio_rendered": False}
    chord = [note for note in candidates if note % 12 in chord_pitch_classes]
    ordered = sorted(chord or candidates, key=lambda note: (abs(note - base), note))
    # A compact rising-then-returning response, biased toward chord tones.
    chosen = []
    for index in range(count):
        pool = ordered if index in (0, count - 1) and chord else candidates
        offsets = profile.get("contour", (5, 2, 7, 3))
        target = base + offsets[index % len(offsets)]
        if modal is not None and index == count - 1:
            landing = [value for value in candidates if value % 12 == modal["final_pitch_class"]]
            if landing:
                pool = landing
        elif modal is not None and index not in (0, count - 1):
            emphasized = set(modal["emphasized_pitch_classes"])
            modal_tones = [value for value in pool if value % 12 in emphasized]
            if modal_tones:
                pool = modal_tones + [value for value in pool if value % 12 not in emphasized]
        emphasized = set(modal["emphasized_pitch_classes"]) if modal is not None else set()
        note = min(pool, key=lambda value: (
            abs(value - target) - (1.5 if value % 12 in emphasized else 0),
            abs(value - base), value
        ))
        if chosen and note == chosen[-1] and len(pool) > 1:
            note = min((item for item in pool if item != note),
                       key=lambda value: (abs(value - target), abs(value - base), value))
        chosen.append(note)
    total = min(gap_duration_ticks, count * profile["spacing"])
    durations = [total // count] * count
    durations[-1] += total - sum(durations)
    cursor = gap_start_tick
    events = []
    velocity_contour = (0, -4, 2, -2)
    articulations = profile.get("articulations", (profile.get("articulation", "sustain"),))
    for index, (note, duration) in enumerate(zip(chosen, durations)):
        velocity = max(1, min(127, base_velocity + velocity_contour[index % len(velocity_contour)]))
        events.append({"midi_note": note, "start_tick": cursor,
                       "duration_ticks": duration, "velocity": velocity,
                       "role": "melodic_response_fill",
                       "articulation": articulations[index % len(articulations)],
                       "release_ms": profile["release_ms"], "fill_style": fill_style,
                       "modal_profile": modal["name"] if modal else None,
                       "modal_tuning": modal["tuning"] if modal else None,
                       "pitch_cents": modal["degree_cents_by_pitch_class"].get(note % 12, 0.0) if modal else 0.0,
                       "microtonal_audio_rendered": False if modal else None})
        cursor += duration
    return {"events": events, "reason": "planned_in_vocal_rest",
            "planner": "instrument_shaped_melodic_fill_v2", "audio_rendered": False,
            "modal_profile": modal["name"] if modal else None,
            "modal_tuning": modal["tuning"] if modal else None,
            "microtonal_audio_rendered": False if modal else None}
