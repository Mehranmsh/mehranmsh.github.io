"""Independent MEHRAN music composition core (stdlib-only prototype).

Creates a structured, editable composition plan from Persian lyrics. This is
not a trained generative model and is not an audio renderer.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

PERSIAN_VOWELS = set("َُِاویآ")
WORD_PATTERN = re.compile(r"[\wآ-ی\u064b-\u065f\u0670]+(?:\u200c[\wآ-ی\u064b-\u065f\u0670]+)*", flags=re.UNICODE)
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
    "sad": (("Am", "F", "C", "G7"), "A", "minor", 82),
    "hopeful": (("C", "G", "Am", "F"), "C", "major", 104),
    "romantic": (("C", "Am", "F", "G7"), "C", "major", 92),
    "angry": (("Dm", "Bb", "F", "C7"), "D", "minor", 118),
    "neutral": (("Am", "F", "C", "G7"), "A", "minor", 96),
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
    "فردا": ("far", "da"), "بهار": ("ba", "har"), "بهانه": ("ba", "ha", "ne"), "آزادی": ("a", "za", "di"),
    "دلتنگ": ("del", "tang"), "اشک": ("ashk",), "تنهایی": ("tan", "ha", "yi"),
    "رفتی": ("raf", "ti"), "عاشق": ("a", "shegh"), "دلبر": ("del", "bar"),
    "آغوش": ("a", "ghush"), "بوسه": ("bu", "se"), "چشم": ("cheshm",),
    "قلب": ("ghalb",), "خموش": ("kha", "mush"), "سرد": ("sard",),
}


# Stress positions are deliberately curated only for words whose spoken form
# is explicitly represented above. Unknown words remain unmarked.
LEXICAL_STRESS_INDEX = {
    "برگرد": 1, "دلم": 1, "گرفته": 2, "عشق": 0, "خانه": 1,
    "شب": 0, "روز": 0, "یار": 0, "ای": 0, "تنها": 1,
    "امید": 1, "فردا": 1, "بهار": 1, "آزادی": 2,
    "دلتنگ": 1, "اشک": 0, "تنهایی": 2, "رفتی": 1,
    "عاشق": 1, "دلبر": 1, "آغوش": 1, "بوسه": 1,
    "چشم": 0, "قلب": 0, "خموش": 1, "سرد": 0,
}



def _canonical_word(word: str) -> str:
    normalized = word.replace("ي", "ی").replace("ك", "ک")
    return "".join(char for char in normalized if char not in PERSIAN_DIACRITICS)


def _rhythmic_syllables(word: str) -> int:
    normalized = word.replace("ي", "ی").replace("ك", "ک")
    known = PRONUNCIATION_LEXICON.get(_canonical_word(normalized))
    return len(known) if known else _syllables(normalized)

def _word_phonetics(word: str) -> dict[str, Any]:
    """Conservative written-vowel scan; never invents unwritten short vowels."""
    normalized = word.replace("ي", "ی").replace("ك", "ک")
    explicit_marks = sum(1 for char in normalized if char in SHORT_VOWEL_MARKS)
    canonical = _canonical_word(normalized)
    known_pronunciation = PRONUNCIATION_LEXICON.get(canonical)
    if known_pronunciation:
        return {
            "word": normalized,
            "syllable_estimate": len(known_pronunciation),
            "syllables": list(known_pronunciation),
            "explicit_short_vowel_marks": explicit_marks,
            "confidence": "high",
            "method": "curated_lyric_pronunciation_lexicon_v1",
            "lexical_stress": {
                "syllable_index": LEXICAL_STRESS_INDEX.get(canonical),
                "confidence": "curated" if canonical in LEXICAL_STRESS_INDEX else "unknown",
            },
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


def _phonetic_rhyme_tail(final_syllable: str) -> str:
    """Return the vowel-and-coda portion of a curated Latin syllable."""
    vowel_positions = [index for index, char in enumerate(final_syllable.lower())
                       if char in "aeiou"]
    return final_syllable[vowel_positions[-1]:] if vowel_positions else final_syllable


def _rhyme_signature(word: str) -> dict[str, str]:
    """Prefer curated phonetic evidence; unknown words keep a low-confidence spelling key."""
    canonical = _canonical_word(word)
    pronunciation = PRONUNCIATION_LEXICON.get(canonical)
    if pronunciation:
        final_syllable = pronunciation[-1]
        return {
            "signature": final_syllable,
            "rhyme_tail": _phonetic_rhyme_tail(final_syllable),
            "confidence": "curated",
            "method": "curated_vowel_and_coda_v1",
        }
    fallback = canonical[-2:]
    return {
        "signature": fallback,
        "rhyme_tail": fallback,
        "confidence": "low",
        "method": "orthographic_suffix_fallback_v1",
    }


def _ending(line: str) -> str:
    words = WORD_PATTERN.findall(line)
    return _rhyme_signature(words[-1])["signature"] if words else ""


def analyze_lyrics(lyrics: str) -> dict[str, Any]:
    if not isinstance(lyrics, str) or not lyrics.strip():
        raise ValueError("lyrics must be a non-empty string")
    cleaned = _normalize(lyrics)
    raw_lines = []
    line_stanza_indices = []
    stanza_index = 0
    stanza_has_content = False
    for raw_line in cleaned.splitlines():
        if not raw_line.strip():
            if stanza_has_content:
                stanza_index += 1
                stanza_has_content = False
            continue
        raw_lines.append(raw_line.strip())
        line_stanza_indices.append(stanza_index)
        stanza_has_content = True
    if not raw_lines:
        raise ValueError("lyrics must contain at least one non-empty line")
    raw_lines = raw_lines[:160]
    line_stanza_indices = line_stanza_indices[:160]
    lines = []
    for line in raw_lines:
        words = WORD_PATTERN.findall(line)
        lines.append(LyricLine(line, len(words), sum(_rhythmic_syllables(w) for w in words), _ending(line)))
    counts = {mood: sum(1 for word in keywords if word in cleaned)
              for mood, keywords in MOOD_WORDS.items()}
    mood = max(counts, key=counts.get) if max(counts.values(), default=0) else "neutral"
    rhyme_analysis = []
    rhyme_groups_by_key: dict[tuple[int, str, str], dict[str, Any]] = {}
    rhyme_labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for index, line in enumerate(lines):
        ending_words = WORD_PATTERN.findall(line.text)
        signature = (_rhyme_signature(ending_words[-1]) if ending_words else {
            "signature": "", "confidence": "unknown", "method": "no_ending_word",
        })
        group_label = None
        if signature["signature"]:
            key = (line_stanza_indices[index], signature["rhyme_tail"], signature["confidence"])
            if key not in rhyme_groups_by_key:
                label_index = len(rhyme_groups_by_key)
                label = (rhyme_labels[label_index] if label_index < len(rhyme_labels)
                         else f"R{label_index + 1}")
                rhyme_groups_by_key[key] = {
                    "label": label,
                    "stanza_index": line_stanza_indices[index],
                    "signature": signature["signature"],
                    "rhyme_tail": signature["rhyme_tail"],
                    "confidence": signature["confidence"],
                    "method": signature["method"],
                    "line_indices": [],
                }
            group = rhyme_groups_by_key[key]
            group["line_indices"].append(index)
            group_label = group["label"]
        rhyme_analysis.append({
            "line_index": index,
            "stanza_index": line_stanza_indices[index],
            "ending_word": ending_words[-1] if ending_words else "",
            **signature,
            "group": group_label,
        })
    rhyme_groups = [
        group for group in rhyme_groups_by_key.values()
        if len(group["line_indices"]) >= 2
    ]
    repeated_group_labels = {group["label"] for group in rhyme_groups}
    for item in rhyme_analysis:
        if item["group"] not in repeated_group_labels:
            item["group"] = None
    stanza_rhyme_schemes = []
    for stanza in sorted(set(line_stanza_indices)):
        stanza_items = [item for item in rhyme_analysis
                        if item["stanza_index"] == stanza]
        labels = {}
        pattern = []
        for item in stanza_items:
            if item["group"] is None:
                pattern.append(None)
                continue
            key = (item["rhyme_tail"], item["confidence"])
            if key not in labels:
                labels[key] = rhyme_labels[len(labels)] if len(labels) < len(rhyme_labels) else f"R{len(labels) + 1}"
            pattern.append(labels[key])
        stanza_rhyme_schemes.append({
            "stanza_index": stanza,
            "line_indices": [item["line_index"] for item in stanza_items],
            "pattern": pattern,
        })
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
                          WORD_PATTERN.findall(line.text)],
                "lexical_stress": "unknown",
                "notice": "Unwritten short vowels and colloquial pronunciation cannot be recovered reliably from plain Persian text.",
            }
            for index, line in enumerate(lines)
        ],
        "rhyme_candidates": sorted({line.ending for line in lines if line.ending}),
        "rhyme_analysis": rhyme_analysis,
        "rhyme_groups": rhyme_groups,
        "stanza_rhyme_schemes": stanza_rhyme_schemes,
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


def _harmonic_function(symbol: str, key: str, mode: str) -> str:
    """Describe a chord's scale-degree role in the composition's tonal center."""
    roots = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    if not isinstance(symbol, str) or not symbol or symbol[0] not in roots:
        return "unknown"
    pitch = roots[symbol[0]]
    if len(symbol) > 1 and symbol[1] == "b":
        pitch -= 1
    elif len(symbol) > 1 and symbol[1] == "#":
        pitch += 1
    degree = (pitch - roots[key]) % 12
    major_roles = {0: "tonic", 2: "supertonic", 4: "mediant",
                   5: "subdominant", 7: "dominant", 9: "submediant",
                   11: "leading_tone"}
    minor_roles = {0: "tonic", 2: "supertonic", 3: "mediant",
                   5: "subdominant", 7: "dominant", 8: "submediant",
                   10: "subtonic"}
    return (minor_roles if mode == "minor" else major_roles).get(degree, "chromatic")


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


def _align_stressed_onsets_to_beats(
    durations: list[int], note_map: list[dict[str, Any]], tolerance: int = 180
) -> tuple[list[int], list[dict[str, Any]]]:
    """Nudge curated stressed-syllable onsets toward beats 1 or 3.

    Timing is redistributed from the immediately preceding note, preserving
    the phrase's total duration. Unknown stress and large adjustments are skipped.
    """
    adjusted = list(durations)
    metadata = [dict(item) for item in note_map]
    for index, item in enumerate(metadata):
        if (index == 0 or item.get("is_lexically_stressed") is not True
                or item.get("stress_confidence") != "curated"):
            continue
        onset = sum(adjusted[:index])
        target = min(
            (round(onset / 960) * 960, max(0, round(onset / 1920) * 1920 + 960)),
            key=lambda beat: abs(beat - onset),
        )
        shift = target - onset
        if abs(shift) > tolerance:
            continue
        previous_minimum = 120
        # Transfer time from/to the phrase-final note so total phrase length
        # remains exact while the stressed onset moves toward its beat.
        if (adjusted[index - 1] + shift < previous_minimum
                or adjusted[-1] - shift < previous_minimum):
            continue
        adjusted[index - 1] += shift
        adjusted[-1] -= shift
        item["stress_beat_alignment"] = "aligned"
        item["stress_onset_shift_ticks"] = shift
    return adjusted, metadata


def _align_strong_beats_to_chord_tones(notes: list[int], note_map: list[dict[str, Any]],
                                               chord: str) -> list[int]:
    """Prefer chord tones when a melody note begins on the primary downbeat."""
    chord_classes = set(_chord_pitch_classes(chord))
    adjusted = list(notes)
    for index, item in enumerate(note_map):
        if item.get("beat_strength") != "strong":
            continue
        candidates = [note for note in range(55, 85)
                      if note % 12 in chord_classes]
        if candidates:
            adjusted[index] = min(
                candidates,
                key=lambda candidate: (abs(candidate - adjusted[index]), candidate),
            )
    return adjusted


def _smooth_melodic_leaps(notes: list[int], note_map: list[dict[str, Any]],
                         tonic: int, scale: list[int], peak_index: int) -> list[int]:
    """Reduce avoidable interior leaps while preserving phrase anchors and beat accents."""
    adjusted = list(notes)
    scale_classes = {(tonic + interval) % 12 for interval in scale}
    for index in range(1, len(adjusted) - 1):
        if index == peak_index or note_map[index].get("beat_strength") == "strong":
            continue
        previous = adjusted[index - 1]
        current = adjusted[index]
        if abs(current - previous) <= 7:
            continue
        candidates = [
            candidate for candidate in range(max(55, previous - 7), min(84, previous + 7) + 1)
            if candidate % 12 in scale_classes
        ]
        if candidates:
            adjusted[index] = min(
                candidates,
                key=lambda candidate: (abs(candidate - current), abs(candidate - previous), candidate),
            )
    return adjusted


def _align_words_to_notes(lyric_line: str, note_count: int) -> dict[str, Any]:
    """Map estimated lyric syllables onto melody notes without inventing phonemes."""
    matches = list(WORD_PATTERN.finditer(lyric_line))
    words = []
    for index, match in enumerate(matches):
        word = match.group(0).replace("ي", "ی").replace("ك", "ک")
        canonical = _canonical_word(word)
        pronunciation = PRONUNCIATION_LEXICON.get(canonical)
        count = len(pronunciation) if pronunciation else _syllables(word)
        words.append({
            "word_index": index,
            "word": word,
            "syllable_estimate": count,
            "syllables": list(pronunciation) if pronunciation else None,
            "confidence": "high" if pronunciation else "low",
            "lexical_stress_index": LEXICAL_STRESS_INDEX.get(canonical),
            "stress_confidence": "curated" if canonical in LEXICAL_STRESS_INDEX else "unknown",
        })
    total_syllables = sum(item["syllable_estimate"] for item in words)
    if not words or note_count <= 0 or total_syllables <= 0:
        return {"word_note_alignment": [], "note_lyric_map": []}

    alignment = []
    note_map = []
    syllable_cursor = 0
    note_cursor = 0
    for word_index, item in enumerate(words):
        start_syllable = syllable_cursor
        end_syllable = start_syllable + item["syllable_estimate"]
        if note_count >= len(words):
            # Reserve at least one complete note slot per word, then distribute
            # the remaining slots proportionally to each word's syllable count.
            remaining_words = len(words) - word_index - 1
            proportional_end = round(end_syllable * note_count / total_syllables)
            note_end = min(note_count - remaining_words,
                           max(note_cursor + 1, proportional_end))
            note_start = note_cursor
        else:
            note_start = min(note_count - 1, round(
                start_syllable * note_count / total_syllables))
            note_end = min(note_count, max(note_start + 1, round(
                end_syllable * note_count / total_syllables)))
        alignment.append({
            **item,
            "syllable_start": start_syllable,
            "syllable_end": end_syllable,
            "note_start": note_start,
            "note_end": note_end,
        })
        syllable_cursor = end_syllable
        if note_count >= len(words):
            note_cursor = note_end

    for note_index in range(note_count):
        word = next(
            (item for item in alignment
             if item["note_start"] <= note_index < item["note_end"]),
            None,
        )
        if word is None:
            syllable_index = min(
                total_syllables - 1,
                int((note_index + 0.5) * total_syllables / note_count),
            )
            word = next(item for item in alignment
                        if item["syllable_start"] <= syllable_index < item["syllable_end"])
            local_syllable = syllable_index - word["syllable_start"]
        else:
            local_note = note_index - word["note_start"]
            local_syllable = min(
                word["syllable_estimate"] - 1,
                int((local_note + 0.5) * word["syllable_estimate"]
                    / (word["note_end"] - word["note_start"])),
            )
            syllable_index = word["syllable_start"] + local_syllable
        syllable_token = (
            word["syllables"][local_syllable]
            if word["syllables"] and local_syllable < len(word["syllables"])
            else None
        )
        note_map.append({
            "note_index": note_index,
            "word_index": word["word_index"],
            "word": word["word"],
            "syllable_index": syllable_index,
            "syllable_token": syllable_token,
            "confidence": word["confidence"],
            "is_lexically_stressed": (
                word["lexical_stress_index"] == local_syllable
                if word["lexical_stress_index"] is not None else None
            ),
            "stress_confidence": word["stress_confidence"],
        })
    syllable_note_map = []
    for word in alignment:
        word_note_count = word["note_end"] - word["note_start"]
        for local_index in range(word["syllable_estimate"]):
            syllable_index = word["syllable_start"] + local_index
            if word_note_count:
                note_index = word["note_start"] + min(
                    word_note_count - 1,
                    int((local_index + 0.5) * word_note_count
                        / word["syllable_estimate"]),
                )
            else:
                note_index = min(
                    note_count - 1,
                    int((syllable_index + 0.5) * note_count / total_syllables),
                )
            syllable_note_map.append({
                "syllable_index": syllable_index,
                "word_index": word["word_index"],
                "word": word["word"],
                "syllable_token": (
                    word["syllables"][local_index]
                    if word["syllables"] and local_index < len(word["syllables"])
                    else None
                ),
                "note_index": note_index,
                "mapping": "word_preserving_syllable_to_note_v2",
                "is_lexically_stressed": (
                    word["lexical_stress_index"] == local_index
                    if word["lexical_stress_index"] is not None else None
                ),
                "stress_confidence": word["stress_confidence"],
                "confidence": word["confidence"],
            })
    return {
        "word_note_alignment": alignment,
        "note_lyric_map": note_map,
        "syllable_note_map": syllable_note_map,
    }


def _cadence_sustain_profile(lyric_line: str) -> dict[str, Any]:
    """Estimate phrase-final syllable openness from curated pronunciation only."""
    words = WORD_PATTERN.findall(lyric_line)
    if not words:
        return {"factor": 1.7, "type": "unknown", "confidence": "unknown"}
    canonical = _canonical_word(words[-1])
    pronunciation = PRONUNCIATION_LEXICON.get(canonical)
    if not pronunciation:
        return {"factor": 1.7, "type": "unknown", "confidence": "low"}
    final_syllable = pronunciation[-1].lower()
    if final_syllable and final_syllable[-1] in "aeiou":
        return {"factor": 1.9, "type": "open", "confidence": "curated"}
    return {"factor": 1.55, "type": "closed", "confidence": "curated"}


def _phrase_durations(syllables: int, note_count: int,
                      lyric_line: str = "") -> tuple[int, list[int]]:
    """Allocate phrase timing with approximate word-boundary and punctuation cues.

    Persian short vowels are often unwritten, so these positions are rhythmic
    hints based on orthographic estimates, not verified phonetic stress.
    """
    bars = max(1, min(3, (max(1, syllables) + 7) // 8))
    total_ticks = bars * 4 * 480
    weights = [1.0] * note_count

    word_matches = list(WORD_PATTERN.finditer(lyric_line))
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

    # Apply a restrained rhythmic lift only where lexical stress is
    # explicitly curated. Unknown Persian stress is never inferred here.
    if note_count >= len(words) and words and estimated_total:
        note_cursor = 0
        for word_index, word in enumerate(words):
            syllable_count = estimated_counts[word_index]
            stress_index = LEXICAL_STRESS_INDEX.get(
                _canonical_word(word)
            )
            remaining_words = len(words) - word_index - 1
            proportional_end = round(
                sum(estimated_counts[:word_index + 1]) * note_count / estimated_total
            )
            note_end = min(
                note_count - remaining_words,
                max(note_cursor + 1, proportional_end),
            )
            if stress_index is not None and syllable_count > 0:
                word_note_count = note_end - note_cursor
                stressed_note = note_cursor + min(
                    word_note_count - 1,
                    int((stress_index + 0.5) * word_note_count / syllable_count),
                )
                weights[stressed_note] *= 1.2
            note_cursor = note_end

    cadence_profile = _cadence_sustain_profile(lyric_line)
    if note_count >= 2:
        weights[-1] *= cadence_profile["factor"]
        stripped = lyric_line.rstrip()
        if stripped.endswith((",", "،", ";", "؛", ":", "؟", "!", ".")):
            weights[-1] *= 1.15

    weight_total = sum(weights)
    durations = [int(total_ticks * weight / weight_total) for weight in weights]
    durations[-1] += total_ticks - sum(durations)
    return bars, durations

def _rhythmic_value(duration_ticks: int) -> str:
    """Label note length against the engine's 480-PPQ quarter-note grid."""
    if duration_ticks >= 1680:
        return "whole"
    if duration_ticks >= 840:
        return "half"
    if duration_ticks >= 420:
        return "quarter"
    if duration_ticks >= 210:
        return "eighth"
    if duration_ticks >= 105:
        return "sixteenth"
    return "short_subdivision"


def _breath_demand_profile(syllables: int, pause_ticks: int) -> dict[str, Any]:
    """Estimate phrase breath demand without claiming vocal physiology."""
    count = max(0, int(syllables))
    if count <= 5:
        level, support = "low", "light"
    elif count <= 9:
        level, support = "moderate", "steady"
    elif count <= 13:
        level, support = "high", "strong"
    else:
        level, support = "very_high", "very_strong"
    return {
        "syllable_count": count,
        "level": level,
        "support_hint": support,
        "recovery_window": "written_pause" if pause_ticks > 0 else "next_available_gap",
        "pause_ticks": max(0, int(pause_ticks)),
        "confidence": "syllable_estimate",
        "method": "conservative_phrase_length_bands_v1",
    }

def _phrase_pause(lyric_line: str) -> tuple[int, str]:
    """Return a conservative post-line breath in MIDI ticks from punctuation."""
    ending = lyric_line.rstrip()[-1:] if lyric_line.strip() else ""
    if ending in ("؟", "!", "！", "?"):
        return 360, "full"
    if ending in (".", "۔"):
        return 360, "full"
    if ending in ("؛", ";", ":"):
        return 240, "medium"
    if ending in (",", "،"):
        return 120, "short"
    return 0, "none"


def _harmonic_cadence(chords: tuple[str, ...], lyric_line: str) -> tuple[str | None, str]:
    """Choose a conservative phrase-ending chord from written punctuation."""
    ending = lyric_line.rstrip()[-1:] if lyric_line.strip() else ""
    if ending in ("؟", "?", "!", "！", ".", "۔"):
        return chords[0], "tonic_resolution"
    if ending in (",", "،"):
        return chords[-1], "dominant_suspension"
    if ending in ("؛", ";", ":"):
        return chords[min(2, len(chords) - 1)], "mid_phrase_lift"
    return None, "continuing"


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
        first = max(1, len(lines) // 3)
        second = max(first + 1, 2 * len(lines) // 3)
        remaining = len(lines) - second
        final_chorus_start = second + max(1, remaining // 2)
        sections = [
            {"name": "verse_1", "start_line": 0, "end_line": first},
            {"name": "chorus", "start_line": first, "end_line": second},
            {"name": "verse_2", "start_line": second, "end_line": final_chorus_start},
            {"name": "final_chorus", "start_line": final_chorus_start, "end_line": len(lines)},
        ]
    rhyme_by_line = {
        item["line_index"]: item
        for item in analysis.get("rhyme_analysis", [])
    }
    shared_rhyme_cadences: dict[tuple[int, str], int] = {}
    melody = []
    for index, line in enumerate(lines):
        line_section = next(
            (section["name"] for section in sections
             if section["start_line"] <= index < section["end_line"]),
            "verse",
        )
        section_start = next(
            (section["start_line"] for section in sections
             if section["name"] == line_section), 0,
        )
        section_line_index = index - section_start
        progression_slot = section_line_index % len(chords)
        chord = chords[progression_slot]
        cadence_chord, cadence_type = _harmonic_cadence(chords, line["text"])
        structural_cadence = "none"
        section_end = next(
            (section["end_line"] for section in sections
             if section["name"] == line_section), len(lines),
        )
        if cadence_chord is not None:
            chord = cadence_chord
        elif index + 1 == section_end and len(lines) >= 8:
            if line_section == "final_chorus":
                chord = chords[0]
                structural_cadence = "final_tonic"
            else:
                chord = chords[-1]
                structural_cadence = "section_dominant"
        # Restart the contour motif inside each section so verse and chorus
        # develop their own coherent melodic identity.
        notes = _melody_for_line(
            line["syllable_estimate"], tonic, scale, section_line_index, chord, line_section
        )
        bars, durations = _phrase_durations(line["syllable_estimate"], len(notes), line["text"])
        lyric_alignment = _align_words_to_notes(line["text"], len(notes))
        durations, lyric_alignment["note_lyric_map"] = _align_stressed_onsets_to_beats(
            durations, lyric_alignment["note_lyric_map"]
        )
        pause_ticks, breath_after = _phrase_pause(line["text"])
        breath_demand = _breath_demand_profile(line["syllable_estimate"], pause_ticks)
        is_section_final_phrase = index + 1 == section_end
        is_final_song_phrase = index == len(lines) - 1
        breath_boundary = (
            "final_song_end" if is_final_song_phrase else
            "section_end" if is_section_final_phrase else "internal_phrase"
        )
        breath_recovery_priority = (
            "highest" if is_final_song_phrase else
            "elevated" if is_section_final_phrase else "normal"
        )
        breath_demand.update({
            "section_boundary": is_section_final_phrase,
            "song_boundary": is_final_song_phrase,
            "recovery_priority": breath_recovery_priority,
            "boundary_basis": "composition_structure",
        })
        cadence_profile = _cadence_sustain_profile(line["text"])
        if lyric_alignment["note_lyric_map"]:
            lyric_alignment["note_lyric_map"][-1]["is_phrase_final_syllable"] = True
            lyric_alignment["note_lyric_map"][-1]["cadence_syllable_type"] = cadence_profile["type"]
            lyric_alignment["note_lyric_map"][-1]["cadence_syllable_confidence"] = cadence_profile["confidence"]
        tick_cursor = 0
        for note_index, note_duration in enumerate(durations):
            note_start_tick = tick_cursor
            note_end_tick = note_start_tick + note_duration
            note_map = lyric_alignment["note_lyric_map"][note_index]
            note_map["tick_start"] = note_start_tick
            note_map["tick_end"] = note_end_tick
            note_map["duration_ticks"] = note_duration
            note_map["rhythmic_value"] = _rhythmic_value(note_duration)
            note_map["articulation_hint"] = (
                "sustain" if note_duration >= 840 else
                "light" if note_duration <= 210 else "normal"
            )
            beat_index = note_start_tick // 480
            beat_in_bar = (note_start_tick % 1920) / 480 + 1
            beat_number = int(beat_in_bar)
            note_map["bar_index"] = note_start_tick // 1920
            note_map["beat_in_bar"] = beat_in_bar
            note_map["beat_number"] = beat_number
            note_map["beat_strength"] = (
                "strong" if beat_number == 1 else
                "medium" if beat_number == 3 else "weak"
            )
            note_map["beat_index"] = beat_index
            note_map["onset_accent"] = (
                "primary" if beat_number == 1 else
                "secondary" if beat_number == 3 else "none"
            )
            tick_cursor = note_end_tick
        notes = _align_strong_beats_to_chord_tones(
            notes, lyric_alignment["note_lyric_map"], chord
        )
        peak_index = max(0, min(len(notes) - 1, round(
            (len(notes) - 1) * (0.62 if "chorus" in line_section else 0.48)
        )))
        notes = _smooth_melodic_leaps(
            notes, lyric_alignment["note_lyric_map"], tonic, scale, peak_index
        )
        rhyme_item = rhyme_by_line.get(index, {})
        rhyme_group = rhyme_item.get("group")
        rhyme_confidence = rhyme_item.get("confidence", "unknown")
        rhyme_stanza = rhyme_item.get("stanza_index")
        # Only curated pronunciation evidence can drive melodic linkage.
        # Orthographic fallback remains useful for analysis, not composition.
        rhyme_key = (
            (rhyme_stanza, rhyme_group)
            if rhyme_group is not None and rhyme_confidence == "curated"
            else None
        )
        rhyme_cadence_linked = False
        if rhyme_key is not None:
            shared_pitch_class = shared_rhyme_cadences.get(rhyme_key)
            if shared_pitch_class is None:
                shared_rhyme_cadences[rhyme_key] = notes[-1] % 12
            elif shared_pitch_class in _chord_pitch_classes(chord):
                compatible_notes = [note for note in notes
                                    if note % 12 == shared_pitch_class]
                if compatible_notes:
                    notes[-1] = min(compatible_notes,
                                    key=lambda note: (abs(note - notes[-1]), note))
                    rhyme_cadence_linked = True
        melody.append({
            "line_index": index,
            **lyric_alignment,
            "section": line_section,
            "syllable_estimate": line["syllable_estimate"],
            "midi_notes": notes,
            "note_durations_ticks": durations,
            "bar_count": bars,
            "duration_ticks": bars * 4 * 480,
            "phrase_pause_ticks": pause_ticks,
            "breath_after_phrase": breath_after,
            "breath_demand": breath_demand,
            "breath_window": {
                "start_tick": bars * 4 * 480,
                "end_tick": bars * 4 * 480 + pause_ticks,
                "duration_ticks": pause_ticks,
                "kind": breath_after,
                "timing_basis": "written_punctuation",
                "boundary": breath_boundary,
                "recovery_priority": breath_recovery_priority,
            },
            "is_section_final_phrase": is_section_final_phrase,
            "is_final_song_phrase": is_final_song_phrase,
            "chord": chord,
            "harmonic_cadence": cadence_type,
            "structural_cadence": structural_cadence,
            "harmonic_function": _harmonic_function(chord, key, mode),
            "harmonic_position": {
                "global_phrase_index": index,
                "section_phrase_index": section_line_index,
                "section_phrase_count": next(
                    (section["end_line"] - section["start_line"]
                     for section in sections if section["name"] == line_section),
                    len(lines),
                ),
                "progression_slot": progression_slot,
                "cadence_override": cadence_chord is not None,
            },
            "phrase_start_is_chord_tone": notes[0] % 12 in _chord_pitch_classes(chord),
            "phrase_end_is_chord_tone": notes[-1] % 12 in _chord_pitch_classes(chord),
            "contour_type": "rising_peak_then_fall" if "chorus" in line_section else "restrained_wave",
            "melodic_motif_scope": line_section,
            "melodic_motif_slot": section_line_index % 3,
            "section_register": "lifted" if "chorus" in line_section else "midrange",
            "peak_note_index": max(0, min(len(notes) - 1, round((len(notes) - 1) * (0.62 if "chorus" in line_section else 0.48)))),
            "cadence_note": notes[-1],
            "cadence_syllable_type": cadence_profile["type"],
            "cadence_syllable_confidence": cadence_profile["confidence"],
            "cadence_sustain_factor": cadence_profile["factor"],
            "rhyme_cadence_group": rhyme_group,
            "rhyme_cadence_confidence": rhyme_confidence,
            "rhyme_cadence_linked": rhyme_cadence_linked,
            "rhyme_cadence_method": (
                "shared_stanza_rhyme_pitch_class_v1"
                if rhyme_key is not None else
                "curated_pronunciation_required"
                if rhyme_group is not None else "no_repeated_rhyme_group"
            ),
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
        "engine_version": "0.6.0",
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
