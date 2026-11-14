"""Deterministic, sample-bank-aware articulation planning for MEHRAN.

This module plans performance-technique metadata. It does not synthesize or
claim that a recording exists; exact sample availability is checked separately.
"""
from __future__ import annotations

from typing import Any

from sample_bank import SAMPLE_ARTICULATION_CATALOG

PPQ = 480

_LONG_PREFERENCES = {
    "piano": ("sustain",),
    "strings": ("long_bow", "sustain"),
    "violin": ("long_bow", "sustain"),
    "viola": ("long_bow", "sustain"),
    "cello": ("long_bow", "sustain"),
    "contrabass": ("long_bow", "sustain"),
    "ney": ("sustain", "breath_attack"),
    "flute": ("sustain", "breath_attack"),
    "clarinet": ("sustain", "breath_attack"),
    "oboe": ("sustain", "breath_attack"),
    "bassoon": ("sustain", "breath_attack"),
    "trumpet": ("sustain", "tongued"),
    "trombone": ("sustain", "tongued"),
    "french_horn": ("sustain",),
    "accordion": ("sustain", "bellows_attack"),
}
_SHORT_PREFERENCES = {
    "piano": ("staccato",),
    "strings": ("staccato", "short_bow"),
    "violin": ("staccato", "short_bow"),
    "viola": ("staccato", "short_bow"),
    "cello": ("staccato", "short_bow"),
    "contrabass": ("staccato", "short_bow"),
    "flute": ("staccato",),
    "clarinet": ("staccato", "tongued"),
    "oboe": ("staccato",),
    "bassoon": ("staccato",),
    "trumpet": ("staccato", "tongued"),
    "trombone": ("staccato", "tongued"),
    "french_horn": ("staccato",),
    "acoustic_guitar": ("palm_mute", "pick", "fingerstyle"),
    "classical_guitar": ("rasgueado", "rest_stroke", "fingerstyle"),
    "electric_guitar": ("palm_mute",),
    "electric_bass": ("pick", "slap", "fingerstyle"),
    "tar": ("mezrab_down", "mezrab_up"),
    "setar": ("mezrab_down", "mezrab_up"),
    "oud": ("risha_down", "risha_up"),
    "qanun": ("pluck",),
    "harp": ("pluck",),
    "santur": ("soft_mallet", "hard_mallet"),
    "mandolin": ("downstroke", "upstroke"),
    "banjo": ("pick", "finger_roll"),
}
_PLUCKED = {"acoustic_guitar", "classical_guitar", "electric_guitar",
            "electric_bass", "tar", "setar", "oud", "qanun", "harp",
            "mandolin", "banjo"}
_BOWED = {"strings", "violin", "viola", "cello", "contrabass",
          "kamancheh"}

# Renderer-neutral profiles. They shape note duration and release only.
_PERFORMANCE_PROFILES = {
    "staccato": (0.62, 12), "palm_mute": (0.70, 14),
    "short_bow": (0.74, 22), "mezrab_down": (0.82, 18),
    "mezrab_up": (0.82, 18), "pizzicato": (0.78, 24),
    "tremolo": (0.94, 28), "long_bow": (0.97, 65),
    "legato": (0.98, 48), "sustain": (0.88, 25),
}

def _performance_profile(articulation: str) -> dict[str, float | int]:
    gate_ratio, release_ms = _PERFORMANCE_PROFILES.get(articulation, (0.88, 25))
    return {"gate_ratio": gate_ratio, "release_ms": release_ms}


def _first_available(preferences: tuple[str, ...], available: set[str],
                     default: str = "sustain") -> str:
    for item in preferences:
        if item in available:
            return item
    if default in available:
        return default
    return sorted(available)[0]


def choose_articulation(
    event: dict[str, Any],
    instrument: str,
    tempo_bpm: int,
    style: str = "balanced",
    available_articulations: list[str] | None = None,
) -> dict[str, Any]:
    """Choose one catalog-supported technique for a single note event."""
    if not isinstance(event, dict):
        raise ValueError("event must be an object")
    if instrument not in SAMPLE_ARTICULATION_CATALOG:
        raise ValueError(f"Unsupported instrument: {instrument}")
    if isinstance(tempo_bpm, bool) or not isinstance(tempo_bpm, int) or not 30 <= tempo_bpm <= 300:
        raise ValueError("tempo_bpm must be an integer from 30 to 300")
    if style not in {"balanced", "legato", "staccato", "expressive"}:
        raise ValueError("style must be balanced, legato, staccato or expressive")
    duration = event.get("duration_ticks")
    if isinstance(duration, bool) or not isinstance(duration, int) or duration <= 0:
        raise ValueError("event duration_ticks must be a positive integer")

    catalog = set(SAMPLE_ARTICULATION_CATALOG[instrument])
    available = catalog if available_articulations is None else set(available_articulations)
    if not available or not available.issubset(catalog):
        raise ValueError("available_articulations must be a non-empty subset of the instrument catalog")

    explicit = event.get("explicit_articulation")
    if explicit is not None:
        if not isinstance(explicit, str) or explicit not in catalog:
            raise ValueError("explicit_articulation is not supported by this instrument")
        if explicit not in available:
            return {"articulation": explicit, "status": "blocked_missing_sample",
                    "reason": "explicit_request_not_in_available_articulations",
                    "confidence": "high", **_performance_profile(explicit)}
        return {"articulation": explicit, "status": "planned",
                "reason": "explicit_user_or_arranger_instruction", "confidence": "high",
                **_performance_profile(explicit)}

    beats = duration / PPQ
    previous_note = event.get("previous_note")
    note = event.get("midi_note")
    next_note = event.get("next_note")
    repeated = isinstance(note, int) and note == previous_note
    leap = isinstance(note, int) and isinstance(next_note, int) and abs(next_note - note) >= 7
    phrase_final = bool(event.get("phrase_final", False))

    if phrase_final or style == "legato" or beats >= 2.0:
        desired = _LONG_PREFERENCES.get(instrument, ("sustain",))
        reason = "phrase_resolution_or_long_note"
    elif style == "staccato" or beats <= 0.5 or repeated:
        desired = _SHORT_PREFERENCES.get(instrument, ("staccato", "short_bow"))
        reason = "short_note_or_repeated_pitch"
    elif style == "expressive" and leap and instrument in _BOWED:
        desired = ("tremolo", "long_bow", "sustain")
        reason = "expressive_bowed_leap"
    elif style == "expressive" and leap and instrument in _PLUCKED:
        desired = ("tremolo", "vibrato", "pick", "fingerstyle")
        reason = "expressive_plucked_leap"
    else:
        desired = _LONG_PREFERENCES.get(instrument, ("sustain",))
        reason = "neutral_phrase_motion"

    chosen = _first_available(tuple(desired), available)
    return {"articulation": chosen, "status": "planned",
            "reason": reason, "confidence": "medium" if chosen in desired else "low",
            **_performance_profile(chosen)}


def plan_articulations(
    events: list[dict[str, Any]],
    instrument: str,
    tempo_bpm: int,
    style: str = "balanced",
    available_articulations: list[str] | None = None,
) -> dict[str, Any]:
    """Plan techniques for an ordered note-event list without rendering audio."""
    if not isinstance(events, list) or not events:
        raise ValueError("events must contain at least one note event")
    planned = []
    for index, event in enumerate(events):
        enriched = dict(event)
        if index and "previous_note" not in enriched:
            enriched["previous_note"] = events[index - 1].get("midi_note")
        if index + 1 < len(events) and "next_note" not in enriched:
            enriched["next_note"] = events[index + 1].get("midi_note")
        result = choose_articulation(enriched, instrument, tempo_bpm, style,
                                     available_articulations)
        planned.append({"event_index": index, **result})
    counts: dict[str, int] = {}
    for item in planned:
        counts[item["articulation"]] = counts.get(item["articulation"], 0) + 1
    blocked = sum(item["status"] == "blocked_missing_sample" for item in planned)
    return {
        "instrument": instrument,
        "tempo_bpm": tempo_bpm,
        "style": style,
        "event_count": len(planned),
        "planned_count": len(planned) - blocked,
        "blocked_count": blocked,
        "articulation_counts": counts,
        "events": planned,
        "audio_rendered": False,
        "note": "Planning metadata only. Actual playback requires exact matching recordings in the sample bank.",
    }
