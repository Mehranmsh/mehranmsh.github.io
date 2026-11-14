"""Conservative lyric-syllable to MIDI-note alignment for MEHRAN SVS."""
from __future__ import annotations

from phoneme_inventory import validate_phoneme_sequence


class AlignmentError(ValueError):
    """Raised when manual note-to-syllable groups are invalid."""


def align_lyrics_to_midi(lyrics_analysis: dict, melody: dict, manual_note_groups: list[list[int]] | None = None, manual_timing_windows: list[dict] | None = None, reviewed_syllable_phonemes: list[list[str]] | None = None, reviewed_syllables: list[str] | None = None) -> dict:
    words = lyrics_analysis.get("words", [])
    unresolved = [word["text"] for word in words if word.get("needs_review") or not word.get("syllables")]
    syllables = []
    for word in words:
        for syllable_index, syllable in enumerate(word.get("syllables", [])):
            syllables.append({
                "text": syllable,
                "word": word["text"],
                "word_index": word["index"],
                "syllable_index": syllable_index,
            })

    if reviewed_syllables is not None:
        if not isinstance(reviewed_syllables, list) or not reviewed_syllables or len(reviewed_syllables) > 512:
            raise AlignmentError("reviewed_syllables must be a non-empty list of at most 512 syllable strings.")
        if any(not isinstance(item, str) or not item.strip() or len(item) > 80 for item in reviewed_syllables):
            raise AlignmentError("Every reviewed syllable must be a non-empty string of at most 80 characters.")
        syllables = [{
            "text": item.strip(), "word": "", "word_index": -1,
            "syllable_index": index, "phoneme_symbols": [],
            "phoneme_ambiguity": True, "phoneme_source": "not_reviewed",
        } for index, item in enumerate(reviewed_syllables)]

    if reviewed_syllable_phonemes is not None:
        if not isinstance(reviewed_syllable_phonemes, list) or len(reviewed_syllable_phonemes) != len(syllables):
            raise AlignmentError("reviewed_syllable_phonemes must contain one phoneme array per syllable.")
        for index, (syllable, phones) in enumerate(zip(syllables, reviewed_syllable_phonemes)):
            try:
                syllable["phoneme_symbols"] = validate_phoneme_sequence(phones)
            except (TypeError, ValueError) as exc:
                raise AlignmentError(f"Syllable {index} has an invalid reviewed phoneme sequence: {exc}") from exc
            syllable["phoneme_ambiguity"] = False
            syllable["phoneme_source"] = "human_syllable_override"

    # Keep phonemes attached only when the analyzer produced an unambiguous
    # one-to-one syllable annotation for this word. Word-level phone overrides
    # are not silently redistributed across syllables.
    for syllable in syllables:
        if reviewed_syllable_phonemes is not None:
            continue
        word = next((item for item in words if item.get("index") == syllable["word_index"]), None)
        phone_rows = word.get("phonemes", []) if word else []
        phone_index = syllable["syllable_index"]
        if len(phone_rows) == len(word.get("syllables", [])) if word else False:
            row = phone_rows[phone_index]
            syllable["phoneme_symbols"] = list(row.get("symbols", []))
            syllable["phoneme_ambiguity"] = bool(row.get("ambiguous_graphemes"))
        else:
            syllable["phoneme_symbols"] = []
            syllable["phoneme_ambiguity"] = True

    notes = melody.get("notes", [])
    base = {
        "alignment_version": "mehran.lyric-note-alignment.v1",
        "syllable_count": len(syllables),
        "note_count": len(notes),
        "alignment": [],
        "unassigned_syllables": list(range(len(syllables))),
        "unassigned_notes": list(range(len(notes))),
        "alignment_ready": False,
        "proposal_ready": False,
        "requires_review": True,
        "unresolved_words": unresolved,
        "timing_scope": "syllable_to_note_group",
        "limitations": [
            "This maps syllables to musical notes, not phonemes to acoustic frames.",
            "A final singing render still requires a trained and deployed vocal synthesis model.",
        ],
    }
    if unresolved:
        base["message"] = "Resolve every word pronunciation with human-confirmed syllable overrides before alignment."
        return base
    if not syllables or not notes:
        base["message"] = "Both reviewed syllables and parsed MIDI notes are required."
        return base

    method = "structural_one_to_one_proposal"
    if manual_note_groups is None:
        if len(syllables) != len(notes):
            base["message"] = "Syllable and note counts differ. No automatic mapping was guessed; provide manual_note_groups."
            return base
        groups = [[index] for index in range(len(syllables))]
    else:
        if not isinstance(manual_note_groups, list) or len(manual_note_groups) != len(syllables):
            raise AlignmentError("manual_note_groups must contain exactly one note-index group per syllable.")
        groups = []
        previous_index = -1
        used = set()
        for syllable_index, group in enumerate(manual_note_groups):
            if not isinstance(group, list) or not group:
                raise AlignmentError(f"Note group {syllable_index} must be a non-empty array.")
            if any(type(index) is not int for index in group):
                raise AlignmentError("Note indices must be integers.")
            if group != sorted(group) or len(set(group)) != len(group):
                raise AlignmentError("Each note group must contain unique, ascending note indices.")
            for index in group:
                if index < 0 or index >= len(notes):
                    raise AlignmentError(f"Note index {index} is outside the MIDI note range.")
                if index in used or index <= previous_index:
                    raise AlignmentError("Note groups must be non-overlapping and strictly chronological.")
                used.add(index)
                previous_index = index
            groups.append(group)
        method = "human_note_groups"

    mapped = []
    assigned_notes = set()
    for syllable, group in zip(syllables, groups):
        selected = [notes[index] for index in group]
        assigned_notes.update(group)
        start = min(note["startSeconds"] for note in selected)
        finish = max(note["startSeconds"] + note["durationSeconds"] for note in selected)
        mapped.append({
            **syllable,
            "note_indices": group,
            "notes": [note["note"] for note in selected],
            "start_seconds": round(start, 6),
            "end_seconds": round(finish, 6),
            "duration_seconds": round(max(0.0, finish - start), 6),
            "melisma": len(group) > 1,
        })

    if manual_timing_windows is not None:
        if not isinstance(manual_timing_windows, list) or len(manual_timing_windows) != len(mapped):
            raise AlignmentError("manual_timing_windows must contain exactly one timing window per syllable.")
        duration = max(
            (float(note["startSeconds"]) + float(note["durationSeconds"]) for note in notes),
            default=0.0,
        )
        import math
        for index, window in enumerate(manual_timing_windows):
            if not isinstance(window, dict):
                raise AlignmentError(f"Timing window {index} must be an object.")
            start = window.get("start_seconds")
            end = window.get("end_seconds")
            if isinstance(start, bool) or isinstance(end, bool):
                raise AlignmentError(f"Timing window {index} must use numeric seconds.")
            try:
                start = float(start)
                end = float(end)
            except (TypeError, ValueError) as exc:
                raise AlignmentError(f"Timing window {index} must use numeric seconds.") from exc
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                raise AlignmentError(f"Timing window {index} must be finite, non-negative and have positive duration.")
            if end > duration + 1e-6:
                raise AlignmentError(f"Timing window {index} extends beyond the melody duration.")
            mapped[index]["start_seconds"] = round(start, 6)
            mapped[index]["end_seconds"] = round(end, 6)
            mapped[index]["duration_seconds"] = round(end - start, 6)
        base["timing_source"] = "human_edited_syllable_windows"
    else:
        base["timing_source"] = "midi_note_group_bounds"

    base.update({
        "alignment": mapped,
        "unassigned_syllables": [],
        "unassigned_notes": [index for index in range(len(notes)) if index not in assigned_notes],
        "method": method,
        "proposal_ready": True,
        "alignment_ready": method == "human_note_groups",
        "requires_review": method != "human_note_groups",
        "message": (
            "Human note groups accepted. Review musical phrasing and timing before any future render."
            if method == "human_note_groups"
            else "A one-to-one structural proposal was created. Human review is required before it can be used."
        ),
    })
    return base
