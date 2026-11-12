"""Independent MEHRAN music composition core (stdlib-only prototype).

This module creates a structured, editable composition plan from Persian lyrics.
It is a deterministic composition assistant, not a trained generative model and
not yet an audio renderer. No external model, API, download, or paid service.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

PERSIAN_VOWELS = set("َُِاویآ")
MOOD_WORDS = {
    "sad": ("غم", "تنها", "اشک", "درد", "رفتی", "برگرد", "دلتنگ", "شکست"),
    "hopeful": ("امید", "فردا", "بهار", "روشن", "آزادی", "شروع", "می‌رس"),
    "romantic": ("عشق", "عاشق", "دلبر", "آغوش", "بوسه", "چشم", "قلب"),
    "angry": ("خشم", "فریاد", "نفرت", "آتش", "جنگ", "ویران"),
}
SCALES = {
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "major": [0, 2, 4, 5, 7, 9, 11],
}
PROGRESSIONS = {
    "sad": (("Am", "F", "C", "G"), "A", "minor", 82),
    "hopeful": (("C", "G", "Am", "F"), "C", "major", 104),
    "romantic": (("C", "Am", "F", "G"), "C", "major", 92),
    "angry": (("Dm", "Bb", "F", "C"), "D", "minor", 118),
    "neutral": (("Am", "F", "C", "G"), "A", "minor", 96),
}
ROOTS = {"C": 60, "D": 62, "E": 64, "F": 65, "G": 67, "A": 69, "B": 71}


@dataclass(frozen=True)
class LyricLine:
    text: str
    word_count: int
    syllable_estimate: int
    ending: str


def _normalize(text: str) -> str:
    text = text.replace("ي", "ی").replace("ك", "ک")
    return re.sub(r"\s+", " ", text).strip()


def _syllables(word: str) -> int:
    # Persian short vowels are often unwritten; this is an estimate, not phonetic
    # transcription. Keep a minimum of one syllable for each non-empty word.
    letters = [c for c in word if c.isalpha() or c in PERSIAN_VOWELS]
    nuclei = sum(1 for c in letters if c in PERSIAN_VOWELS)
    return max(1, nuclei)


def _ending(line: str) -> str:
    words = re.findall(r"[\wآ-ی]+", line, flags=re.UNICODE)
    return words[-1][-2:] if words else ""


def analyze_lyrics(lyrics: str) -> dict[str, Any]:
    if not isinstance(lyrics, str) or not lyrics.strip():
        raise ValueError("lyrics must be a non-empty string")
    cleaned = _normalize(lyrics)
    raw_lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if not raw_lines:
        raise ValueError("lyrics must contain at least one non-empty line")
    lines = []
    for line in raw_lines[:160]:
        words = re.findall(r"[\wآ-ی]+", line, flags=re.UNICODE)
        lines.append(LyricLine(line, len(words), sum(_syllables(w) for w in words), _ending(line)))
    counts = {mood: sum(1 for word in keywords if word in cleaned) for mood, keywords in MOOD_WORDS.items()}
    mood = max(counts, key=counts.get) if max(counts.values(), default=0) else "neutral"
    # Preserve input order and expose approximate line lengths for later prosody work.
    return {
        "language": "fa",
        "line_count": len(lines),
        "word_count": sum(line.word_count for line in lines),
        "mood": mood,
        "mood_scores": counts,
        "lines": [asdict(line) for line in lines],
        "rhyme_candidates": sorted({line.ending for line in lines if line.ending}),
        "syllable_method": "orthographic_estimate_v1",
        "notice": "Syllable counts are approximate; Persian pronunciation and poetic meter need a later phonetic layer.",
    }


def _melody_for_line(syllables: int, tonic: int, scale: list[int], line_index: int) -> list[int]:
    count = max(2, min(24, syllables))
    # A small contour that rises toward the end of a phrase, with bounded range.
    degrees = [0, 2, 4, 2, 1, 3, 4, 5]
    notes = []
    for i in range(count):
        degree = degrees[(i + line_index) % len(degrees)]
        notes.append(tonic + scale[degree % len(scale)] + (12 if i >= count - 2 and line_index % 4 == 3 else 0))
    return notes


def compose_plan(lyrics: str, title: str = "Untitled", genre: str = "pop",
                 target_bpm: int | None = None) -> dict[str, Any]:
    analysis = analyze_lyrics(lyrics)
    mood = analysis["mood"]
    chords, key, mode, suggested_bpm = PROGRESSIONS[mood]
    bpm = suggested_bpm if target_bpm is None else target_bpm
    if isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200:
        raise ValueError("target_bpm must be an integer between 50 and 200")
    tonic = ROOTS[key]
    scale = SCALES[mode]
    lines = analysis["lines"]
    # Use lyric length to form sections without rewriting or discarding lines.
    verse_end = max(1, round(len(lines) * 0.55))
    sections = [
        {"name": "verse", "start_line": 0, "end_line": verse_end},
        {"name": "chorus", "start_line": verse_end, "end_line": len(lines)},
    ]
    if len(lines) >= 8:
        sections = [
            {"name": "verse_1", "start_line": 0, "end_line": max(1, len(lines)//3)},
            {"name": "chorus", "start_line": max(1, len(lines)//3), "end_line": max(2, 2*len(lines)//3)},
            {"name": "verse_2_and_final_chorus", "start_line": max(2, 2*len(lines)//3), "end_line": len(lines)},
        ]
    melody = []
    for index, line in enumerate(lines):
        melody.append({
            "line_index": index,
            "syllable_estimate": line["syllable_estimate"],
            "midi_notes": _melody_for_line(line["syllable_estimate"], tonic, scale, index),
            "chord": chords[index % len(chords)],
        })
    arrangement = {
        "intro": ["soft piano", "acoustic guitar"],
        "verse": ["acoustic guitar", "warm bass", "light piano"],
        "chorus": ["live drums", "strings", "bass", "electric guitar accents"],
        "bridge": ["reduced percussion", "cello or strings"],
        "outro": ["piano", "acoustic guitar"],
    }
    return {
        "engine": "MEHRAN_INDEPENDENT_COMPOSITION_CORE",
        "engine_version": "0.1.0",
        "title": _normalize(title) or "Untitled",
        "genre": _normalize(genre) or "pop",
        "analysis": analysis,
        "composition": {
            "key": key,
            "mode": mode,
            "tempo_bpm": bpm,
            "time_signature": "4/4",
            "chord_progression": list(chords),
            "sections": sections,
            "melody": melody,
            "arrangement_blueprint": arrangement,
        },
        "audio_rendered": False,
        "status": "composition_plan_only",
        "next_layers": ["phonetic_prosody", "harmony_voice_leading", "instrument_sound_bank", "midi_renderer", "audio_mixer"],
    }
