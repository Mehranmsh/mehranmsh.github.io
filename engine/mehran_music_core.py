"""Independent MEHRAN music composition core (stdlib-only prototype).

Creates a structured, editable composition plan from Persian lyrics. This is
not a trained generative model and is not an audio renderer.
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
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip()
                      for line in text.split("\n")).strip()


SHORT_VOWEL_MARKS = set("\u064e\u0650\u064f\u064b\u064c\u064d")
PERSIAN_DIACRITICS = SHORT_VOWEL_MARKS | {"\u0651", "\u0652", "\u0670"}

# Curated pronunciations for frequent lyric words; unknown words remain estimates.
PRONUNCIATION_LEXICON = {
    "برگرد": ("bar", "gard"), "دلم": ("de", "lam"), "گرفته": ("ge", "ref", "te"),
    "عشق": ("eshgh",), "خانه": ("kha", "ne"), "شب": ("shab",), "روز": ("ruz",),
    "یار": ("yar",), "ای": ("ey",), "تنها": ("tan", "ha"), "امید": ("o", "mid"),
    "فردا": ("far", "da"), "بهار": ("ba", "har"), "آزادی": ("a", "za", "di"),
    "دلتنگ": ("del", "tang"), "اشک": ("ashk",), "تنهایی": ("tan", "ha", "yi"),
    "رفتی": ("raf", "ti"), "عاشق": ("a", "shegh"), "دلبر": ("del", "bar"),
    "آغوش": ("a", "ghush"), "بوسه": ("bu", "se"), "چشم": ("cheshm",),
    "قلب": ("ghalb",), "خموش": ("kha", "mush"), "سرد": ("sard",),
}


def _rhythmic_syllables(word: str) -> int:
    normalized = word.replace("ي", "ی").replace("ك", "ک")
    known = PRONUNCIATION_LEXICON.get(normalized)
    return len(known) if known else _syllables(normalized)

def _word_phonetics(word: str) -> dict[str, Any]:
    """Conservative written-vowel scan; never invents unwritten short vowels."""
    normalized = word.replace("ي", "ی").replace("ك", "ک")
    explicit_marks = sum(1 for char in normalized if char in SHORT_VOWEL_MARKS)
    known_pronunciation = PRONUNCIATION_LEXICON.get(normalized)
    if known_pronunciation:
        return {
            "word": normalized,
            "syllable_estimate": len(known_pronunciation),
            "syllables": list(known_pronunciation),
            "explicit_short_vowel_marks": explicit_marks,
            "confidence": "high",
            "method": "curated_lyric_pronunciation_lexicon_v1",
            "lexical_stress": "unknown",
        }
    nuclei = 0
    previous_base_had_vowel_mark = False
    for index, char in enumerate(normalized):
        if char in PERSIAN_DIACRITICS:
            if char in SHORT_VOWEL_MARKS:
                nuclei += 1
                previous_base_had_vowel_mark = True
            continue
        if char in "اآ":
            if not previous_base_had_vowel_mark:
                nuclei += 1
        elif char in "وی":
            later_vowel = any(ch in "اآوی" for ch in normalized[index + 1:]
                              if ch not in PERSIAN_DIACRITICS)
            has_short_mark = (index + 1 < len(normalized)
                              and normalized[index + 1] in SHORT_VOWEL_MARKS)
            if not (index == 0 and (later_vowel or has_short_mark)) and not previous_base_had_vowel_mark:
                nuclei += 1
        previous_base_had_vowel_mark = False
    return {
        "word": normalized,
        "syllable_estimate": max(1, nuclei),
        "syllables": None,
        "explicit_short_vowel_marks": explicit_marks,
        "confidence": ("medium_high" if explicit_marks >= 2 else "medium")
                      if explicit_marks else "low",
        "method": "written_diacritics_and_long_vowels_v1" if explicit_marks
                  else "written_long_vowels_only_v1",
        "lexical_stress": "unknown",
    }


def _syllables(word: str) -> int:
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
        lines.append(LyricLine(line, len(words), sum(_rhythmic_syllables(w) for w in words), _ending(line)))
    counts = {mood: sum(1 for word in keywords if word in cleaned)
              for mood, keywords in MOOD_WORDS.items()}
    mood = max(counts, key=counts.get) if max(counts.values(), default=0) else "neutral"
    return {
        "language": "fa",
        "line_count": len(lines),
        "word_count": sum(line.word_count for line in lines),
        "mood": mood,
        "mood_scores": counts,
        "lines": [asdict(line) for line in lines],
        "phonetic_analysis": [
            {
                "line_index": index,
                "words": [_word_phonetics(word) for word in
                          re.findall(r"[\wآ-ی]+", line.text, flags=re.UNICODE)],
                "lexical_stress": "unknown",
                "notice": "Unwritten short vowels and colloquial pronunciation cannot be recovered reliably from plain Persian text.",
            }
            for index, line in enumerate(lines)
        ],
        "rhyme_candidates": sorted({line.ending for line in lines if line.ending}),
        "syllable_method": "orthographic_estimate_v1",
        "phonetic_method": "conservative_written_vowel_scan_v1",
        "notice": "The phonetic layer reports written vowel evidence only; it does not claim full pronunciation, lexical stress, or prosodic meter.",
    }


def _chord_pitch_classes(symbol: str) -> tuple[int, ...]:
    roots = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    if not isinstance(symbol, str) or not symbol or symbol[0] not in roots:
        raise ValueError("Unsupported chord symbol")
    root = roots[symbol[0]]
    suffix = symbol[1:]
    if suffix.startswith("b"):
        root -= 1
        suffix = suffix[1:]
    elif suffix.startswith("#"):
        root += 1
        suffix = suffix[1:]
    intervals = (0, 3, 7) if suffix.startswith("m") else (0, 4, 7)
    if "7" in suffix:
        intervals += (10,)
    return tuple((root + interval) % 12 for interval in intervals)


def _melody_for_line(syllables: int, tonic: int, scale: list[int],
                     line_index: int, chord: str, section: str = "verse") -> list[int]:
    """Build a section-shaped phrase with an audible, bounded peak and cadence."""
    count = max(2, min(24, syllables))
    is_chorus = "chorus" in section
    verse_contour = [0, 2, 3, 2, 4, 3, 2, 1]
    chorus_contour = [2, 3, 4, 5, 6, 5, 4, 3]
    contour = chorus_contour if is_chorus else verse_contour
    chord_classes = set(_chord_pitch_classes(chord))
    scale_notes = [tonic + interval + octave
                   for octave in (0, 12, 24)
                   for interval in scale
                   if 55 <= tonic + interval + octave <= 84]
    chord_notes = [note for note in scale_notes if note % 12 in chord_classes]
    if not chord_notes:
        chord_notes = scale_notes

    peak_index = max(0, min(count - 1, round((count - 1) * (0.62 if is_chorus else 0.48))))
    # Set a deliberate section-specific register target. The chorus peak is
    # higher, while every phrase remains inside the engine's safe MIDI range.
    peak_degree = scale[5] if is_chorus else scale[4]
    peak_target = tonic + (12 if is_chorus else 0) + peak_degree
    peak_target = min(84, max(55, peak_target))
    peak_pool = chord_notes if peak_index == 0 else scale_notes
    peak_note = min(peak_pool, key=lambda note: (abs(note - peak_target), note))

    notes = []
    for i in range(count):
        degree = contour[(i + line_index % 3) % len(contour)]
        target = tonic + scale[degree % len(scale)]
        if i < peak_index:
            target += 12 if is_chorus else 0
        elif i > peak_index:
            # A controlled descent after the phrase high point.
            target -= min(12, (i - peak_index) * 2)
        pool = chord_notes if i in (0, count - 1) else scale_notes
        notes.append(min(pool, key=lambda note: (abs(note - target), note)))

    notes[peak_index] = peak_note
    # Keep the peak unambiguous rather than allowing an earlier note to tie it.
    for i, note in enumerate(notes):
        if i != peak_index and note >= peak_note:
            # Phrase boundaries must remain chord tones even when a short
            # phrase needs its peak lowered into the same octave.
            source_pool = chord_notes if i in (0, count - 1) else scale_notes
            lower = [candidate for candidate in source_pool if candidate < peak_note]
            if lower:
                notes[i] = min(lower, key=lambda candidate: (abs(candidate - note), candidate))

    # The last note resolves to the current chord, below the peak whenever possible.
    if count >= 2:
        lower_cadences = [note for note in chord_notes if note < peak_note]
        if lower_cadences:
            notes[-1] = min(lower_cadences, key=lambda note: (abs(note - tonic - 12), note))
    return notes

def _phrase_durations(syllables: int, note_count: int,
                      lyric_line: str = "") -> tuple[int, list[int]]:
    """Allocate phrase timing with approximate word-boundary and punctuation cues.

    Persian short vowels are often unwritten, so these positions are rhythmic
    hints based on orthographic estimates, not verified phonetic stress.
    """
    bars = max(1, min(3, (max(1, syllables) + 7) // 8))
    total_ticks = bars * 4 * 480
    weights = [1.0] * note_count

    word_matches = list(re.finditer(r"[\wآ-ی]+", lyric_line, flags=re.UNICODE))
    words = [match.group(0) for match in word_matches]
    estimated_counts = [_rhythmic_syllables(word) for word in words]
    estimated_total = sum(estimated_counts)
    if note_count and estimated_total:
        cursor = 0
        for word_index, word_count in enumerate(estimated_counts):
            cursor += max(1, round(note_count * word_count / estimated_total))
            boundary = min(note_count - 1, cursor - 1)
            if boundary >= 0:
                weights[boundary] *= 1.15
                # Internal punctuation is a musical breath cue. Apply it to
                # the note ending immediately before the next word.
                if word_index + 1 < len(word_matches):
                    gap = lyric_line[word_matches[word_index].end():
                                       word_matches[word_index + 1].start()]
                    if any(mark in gap for mark in ("؛", ";", ":")):
                        weights[boundary] *= 1.4
                    elif any(mark in gap for mark in ("؟", "!", "—", "–", "-")):
                        weights[boundary] *= 1.5
                    elif any(mark in gap for mark in (",", "،")):
                        weights[boundary] *= 1.25

    if note_count >= 2:
        weights[-1] *= 1.7
        stripped = lyric_line.rstrip()
        if stripped.endswith((",", "،", ";", "؛", ":", "؟", "!", ".")):
            weights[-1] *= 1.15

    weight_total = sum(weights)
    durations = [int(total_ticks * weight / weight_total) for weight in weights]
    durations[-1] += total_ticks - sum(durations)
    return bars, durations

def compose_plan(lyrics: str, title: str = "Untitled", genre: str = "pop",
                 target_bpm: int | None = None) -> dict[str, Any]:
    analysis = analyze_lyrics(lyrics)
    mood = analysis["mood"]
    chords, key, mode, suggested_bpm = PROGRESSIONS[mood]
    bpm = suggested_bpm if target_bpm is None else target_bpm
    if isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200:
        raise ValueError("target_bpm must be an integer between 50 and 200")
    tonic, scale, lines = ROOTS[key], SCALES[mode], analysis["lines"]
    verse_end = max(1, round(len(lines) * 0.55))
    sections = [
        {"name": "verse", "start_line": 0, "end_line": verse_end},
        {"name": "chorus", "start_line": verse_end, "end_line": len(lines)},
    ]
    if len(lines) >= 8:
        first, second = max(1, len(lines)//3), max(2, 2*len(lines)//3)
        sections = [
            {"name": "verse_1", "start_line": 0, "end_line": first},
            {"name": "chorus", "start_line": first, "end_line": second},
            {"name": "verse_2_and_final_chorus", "start_line": second, "end_line": len(lines)},
        ]
    melody = []
    for index, line in enumerate(lines):
        chord = chords[index % len(chords)]
        line_section = next(
            (section["name"] for section in sections
             if section["start_line"] <= index < section["end_line"]),
            "verse",
        )
        notes = _melody_for_line(line["syllable_estimate"], tonic, scale, index, chord, line_section)
        bars, durations = _phrase_durations(line["syllable_estimate"], len(notes), line["text"])
        melody.append({
            "line_index": index,
            "section": line_section,
            "syllable_estimate": line["syllable_estimate"],
            "midi_notes": notes,
            "note_durations_ticks": durations,
            "bar_count": bars,
            "duration_ticks": bars * 4 * 480,
            "chord": chord,
            "phrase_start_is_chord_tone": notes[0] % 12 in _chord_pitch_classes(chord),
            "phrase_end_is_chord_tone": notes[-1] % 12 in _chord_pitch_classes(chord),
            "contour_type": "rising_peak_then_fall" if "chorus" in line_section else "restrained_wave",
            "peak_note_index": max(0, min(len(notes) - 1, round((len(notes) - 1) * (0.62 if "chorus" in line_section else 0.48)))),
            "cadence_note": notes[-1],
            "prosody_timing_method": "word_boundary_internal_punctuation_and_cadence_v2",
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
        "engine_version": "0.4.0",
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
        "next_layers": ["phonetic_prosody", "instrument_sound_bank", "audio_renderer", "audio_mixer"],
    }
