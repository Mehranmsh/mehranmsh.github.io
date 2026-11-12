"""Dependency-free Standard MIDI File renderer for MEHRAN composition plans."""
from __future__ import annotations

import struct
from itertools import combinations, permutations
from pathlib import Path
from typing import Any

PPQ = 480
MAX_NOTES = 4096
ROOTS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _vlq(value: int) -> bytes:
    if value < 0:
        raise ValueError("MIDI delta time cannot be negative")
    buffer = value & 0x7F
    output = bytearray()
    while (value := value >> 7):
        buffer <<= 8
        buffer |= (value & 0x7F) | 0x80
    while True:
        output.append(buffer & 0xFF)
        if buffer & 0x80:
            buffer >>= 8
        else:
            break
    return bytes(output)


def _track(events: list[tuple[int, int, bytes]], name: str) -> bytes:
    encoded_name = name.encode("ascii")
    payload = bytearray(b"\\x00\\xff\\x03" + bytes([len(encoded_name)]) + encoded_name)
    previous = 0
    for tick, priority, message in sorted(events, key=lambda item: (item[0], item[1])):
        payload.extend(_vlq(tick - previous))
        payload.extend(message)
        previous = tick
    payload.extend(b"\\x00\\xff\\x2f\\x00")
    return b"MTrk" + struct.pack(">I", len(payload)) + payload


def _parse_chord(symbol: str) -> tuple[int, tuple[int, ...]]:
    if not isinstance(symbol, str) or not symbol or symbol[0] not in ROOTS:
        raise ValueError("Unsupported chord symbol in composition plan")
    root = ROOTS[symbol[0]]
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
    return root % 12, intervals


def _chord_notes(symbol: str) -> tuple[int, ...]:
    root, intervals = _parse_chord(symbol)
    return tuple(60 + ((root + interval) % 12) for interval in intervals)


def _voice_lead_chord(symbol: str, previous: tuple[int, ...] | None = None) -> tuple[int, ...]:
    """Choose a close-position triad minimizing movement from the previous chord."""
    pitch_classes = {note % 12 for note in _chord_notes(symbol)[:3]}
    candidates = [note for note in range(48, 73) if note % 12 in pitch_classes]
    voicings = [combo for combo in combinations(candidates, 3)
                if len({note % 12 for note in combo}) == 3]
    if not voicings:
        raise ValueError("Could not construct a chord voicing")
    if previous is None:
        return min(voicings, key=lambda combo: (sum(abs(note - 60) for note in combo),
                                                combo[-1] - combo[0]))
    return min(
        voicings,
        key=lambda combo: (
            min(sum(abs(a - b) for a, b in zip(order, combo))
                for order in permutations(previous)),
            sum(abs(note - 60) for note in combo),
        ),
    )


def _note_on(channel: int, note: int, velocity: int) -> bytes:
    return bytes((0x90 | channel, note, velocity))


def _note_off(channel: int, note: int) -> bytes:
    return bytes((0x80 | channel, note, 0))


def _bass_pattern(root_pc: int, bar_start: int, events: list[tuple[int, int, bytes]]) -> int:
    """Add a simple root-fifth-root bass pulse for one 4/4 bar."""
    root = 36 + root_pc
    fifth = root + 7
    pattern = [(0, root, PPQ * 2 - 36), (PPQ * 2, fifth, PPQ - 36),
               (PPQ * 3, root, PPQ - 36)]
    for offset, note, gate in pattern:
        start = bar_start + offset
        events.append((start, 2, _note_on(2, note, 82)))
        events.append((start + gate, 1, _note_off(2, note)))
    return len(pattern)


def _drum_bar(bar_start: int, events: list[tuple[int, int, bytes]], *,
              chorus: bool = False) -> int:
    """Add a deterministic GM drum groove on MIDI channel 10 (zero-based 9)."""
    hits = [(0, 36, 112), (PPQ * 2, 36, 104),
            (PPQ, 38, 94), (PPQ * 3, 38, 100)]
    # Eighth-note hats; chorus opens the hat on the final eighth of each bar.
    for eighth in range(8):
        note = 46 if chorus and eighth == 7 else 42
        hits.append((eighth * (PPQ // 2), note, 72 if note == 42 else 82))
    for offset, note, velocity in hits:
        start = bar_start + offset
        events.append((start, 2, _note_on(9, note, velocity)))
        events.append((start + 48, 1, _note_off(9, note)))
    return len(hits)


def render_midi(plan: dict[str, Any], output_path: str | Path) -> dict[str, Any]:
    """Render melody, chords, bass and percussion to a Standard MIDI file."""
    try:
        composition = plan["composition"]
        bpm, melody, chords = (composition["tempo_bpm"],
                               composition["melody"],
                               composition["chord_progression"])
    except (KeyError, TypeError) as exc:
        raise ValueError("Invalid MEHRAN composition plan") from exc
    if isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200:
        raise ValueError("Plan tempo must be an integer between 50 and 200 BPM")
    if not isinstance(melody, list) or not melody or len(melody) > 160:
        raise ValueError("Plan melody must contain 1 to 160 lyric lines")
    if not isinstance(chords, list) or not chords:
        raise ValueError("Plan must contain a chord progression")
    tempo_us = round(60_000_000 / bpm)
    melody_events: list[tuple[int, int, bytes]] = []
    chord_events: list[tuple[int, int, bytes]] = []
    bass_events: list[tuple[int, int, bytes]] = []
    drum_events: list[tuple[int, int, bytes]] = []
    note_count, phrase_start, chord_bar_index = 0, 0, 0
    previous_voicing = None
    chord_voicings = []
    bass_note_count = drum_hit_count = 0
    for phrase in melody:
        if not isinstance(phrase, dict):
            raise ValueError("Each melody phrase must be an object")
        notes = phrase.get("midi_notes")
        bars = phrase.get("bar_count", 1)
        durations = phrase.get("note_durations_ticks")
        if (not isinstance(notes, list) or not notes or
                any(isinstance(n, bool) or not isinstance(n, int) or not 48 <= n <= 96 for n in notes)):
            raise ValueError("Each phrase needs MIDI notes in the supported range (48-96)")
        if isinstance(bars, bool) or not isinstance(bars, int) or not 1 <= bars <= 3:
            raise ValueError("Phrase bar_count must be between 1 and 3")
        phrase_ticks = bars * PPQ * 4
        if durations is None:
            step = phrase_ticks // len(notes)
            durations = [step] * len(notes)
            durations[-1] += phrase_ticks - sum(durations)
        if (not isinstance(durations, list) or len(durations) != len(notes) or
                any(isinstance(d, bool) or not isinstance(d, int) or d <= 0 for d in durations) or
                sum(durations) != phrase_ticks):
            raise ValueError("Note durations must be positive and exactly fill the phrase")
        cursor = phrase_start
        for note, duration in zip(notes, durations):
            gate = max(1, int(duration * 0.88))
            melody_events.append((cursor, 2, _note_on(0, note, 88)))
            melody_events.append((cursor + gate, 1, _note_off(0, note)))
            cursor += duration
            note_count += 1
        for bar in range(bars):
            bar_start = phrase_start + bar * PPQ * 4
            symbol = chords[chord_bar_index % len(chords)]
            root_pc, _ = _parse_chord(symbol)
            chord = _voice_lead_chord(symbol, previous_voicing)
            chord_voicings.append({"symbol": symbol, "midi_notes": list(chord)})
            previous_voicing = chord
            for note in chord:
                chord_events.append((bar_start, 2, _note_on(1, note, 58)))
                chord_events.append((bar_start + PPQ * 4 - 24, 1, _note_off(1, note)))
                note_count += 1
            bass_note_count += _bass_pattern(root_pc, bar_start, bass_events)
            drum_hit_count += _drum_bar(bar_start, drum_events,
                                        chorus=(phrase.get("section") == "chorus"))
            chord_bar_index += 1
        phrase_start += phrase_ticks
    note_count += bass_note_count + drum_hit_count
    if note_count > MAX_NOTES:
        raise ValueError("Composition exceeds the 4096-note safety limit")
    conductor = _track([
        (0, 0, b"\\xff\\x51\\x03" + tempo_us.to_bytes(3, "big")),
        (0, 1, b"\\xff\\x58\\x04\\x04\\x02\\x18\\x08"),
    ], "MEHRAN Tempo")
    tracks = [conductor, _track(melody_events, "MEHRAN Melody"),
              _track(chord_events, "MEHRAN Chords"),
              _track(bass_events, "MEHRAN Bass"),
              _track(drum_events, "MEHRAN Drums")]
    midi = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ) + b"".join(tracks)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(midi)
    return {
        "path": str(target), "format": "Standard MIDI File", "tracks": len(tracks),
        "tempo_bpm": bpm, "note_events": note_count, "duration_ticks": phrase_start,
        "bass_note_events": bass_note_count, "drum_hits": drum_hit_count,
        "drum_channel": 10, "chord_voicings": chord_voicings,
        "duration_seconds": round(phrase_start / PPQ * 60 / bpm, 2),
        "bytes": len(midi),
    }
