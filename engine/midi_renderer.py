"""Dependency-free Standard MIDI File renderer for MEHRAN composition plans."""
from __future__ import annotations

import struct
from itertools import combinations, permutations
from pathlib import Path
from typing import Any

PPQ = 480
MAX_NOTES = 4096


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
    payload = bytearray(b"\x00\xff\x03" + bytes([len(encoded_name)]) + encoded_name)
    previous = 0
    for tick, priority, message in sorted(events, key=lambda item: (item[0], item[1])):
        payload.extend(_vlq(tick - previous))
        payload.extend(message)
        previous = tick
    payload.extend(b"\x00\xff\x2f\x00")
    return b"MTrk" + struct.pack(">I", len(payload)) + payload


def _chord_notes(symbol: str) -> tuple[int, ...]:
    roots = {"C": 60, "D": 62, "E": 64, "F": 65, "G": 67, "A": 69, "B": 71}
    if not isinstance(symbol, str) or not symbol or symbol[0] not in roots:
        raise ValueError("Unsupported chord symbol in composition plan")
    root, suffix = roots[symbol[0]], symbol[1:]
    intervals = (0, 3, 7) if suffix.startswith("m") else (0, 4, 7)
    if "7" in suffix:
        intervals += (10,)
    return tuple(root + interval for interval in intervals)


def _voice_lead_chord(symbol: str, previous: tuple[int, ...] | None = None) -> tuple[int, ...]:
    """Choose a close-position triad minimizing movement from the previous chord."""
    pitch_classes = _chord_notes(symbol)
    classes = {note % 12 for note in pitch_classes[:3]}
    candidates = [note for note in range(48, 73) if note % 12 in classes]
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


def render_midi(plan: dict[str, Any], output_path: str | Path) -> dict[str, Any]:
    """Render lyric-aware phrase timing and chord bars to a Standard MIDI file."""
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
    note_count, phrase_start, chord_bar_index = 0, 0, 0
    previous_voicing = None
    chord_voicings = []
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
            melody_events.append((cursor, 2, bytes((0x90, note, 88))))
            melody_events.append((cursor + gate, 1, bytes((0x80, note, 0))))
            cursor += duration
            note_count += 1
        for bar in range(bars):
            bar_start = phrase_start + bar * PPQ * 4
            symbol = chords[chord_bar_index % len(chords)]
            chord = _voice_lead_chord(symbol, previous_voicing)
            chord_voicings.append({"symbol": symbol, "midi_notes": list(chord)})
            previous_voicing = chord
            for note in chord:
                chord_events.append((bar_start, 2, bytes((0x91, note, 58))))
                chord_events.append((bar_start + PPQ * 4 - 24, 1, bytes((0x81, note, 0))))
                note_count += 1
            chord_bar_index += 1
        phrase_start += phrase_ticks
    if note_count > MAX_NOTES:
        raise ValueError("Composition exceeds the 4096-note safety limit")
    conductor = _track([
        (0, 0, b"\xff\x51\x03" + tempo_us.to_bytes(3, "big")),
        (0, 1, b"\xff\x58\x04\x04\x02\x18\x08"),
    ], "MEHRAN Tempo")
    tracks = [conductor, _track(melody_events, "MEHRAN Melody"),
              _track(chord_events, "MEHRAN Chords")]
    midi = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ) + b"".join(tracks)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(midi)
    return {
        "path": str(target), "format": "Standard MIDI File", "tracks": len(tracks),
        "tempo_bpm": bpm, "note_events": note_count, "duration_ticks": phrase_start,
        "chord_voicings": chord_voicings,
        "duration_seconds": round(phrase_start / PPQ * 60 / bpm, 2),
        "bytes": len(midi),
    }
