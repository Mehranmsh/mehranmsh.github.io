"""Dependency-free Standard MIDI File renderer for MEHRAN composition plans."""
from __future__ import annotations

import struct
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
    payload = bytearray(b"\x00\xff\x03" + bytes([len(name)]) + name.encode("ascii"))
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
    root = roots[symbol[0]]
    suffix = symbol[1:]
    intervals = (0, 3, 7) if suffix.startswith("m") else (0, 4, 7)
    if "7" in suffix:
        intervals = intervals + (10,)
    return tuple(root + interval for interval in intervals)


def render_midi(plan: dict[str, Any], output_path: str | Path) -> dict[str, Any]:
    """Render the plan's note/chord blueprint to a two-track MIDI file."""
    try:
        composition = plan["composition"]
        bpm = composition["tempo_bpm"]
        melody = composition["melody"]
        chords = composition["chord_progression"]
    except (KeyError, TypeError) as exc:
        raise ValueError("Invalid MEHRAN composition plan") from exc
    if isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200:
        raise ValueError("Plan tempo must be an integer between 50 and 200 BPM")
    if not isinstance(melody, list) or not melody or len(melody) > 160:
        raise ValueError("Plan melody must contain 1 to 160 lyric lines")
    if not isinstance(chords, list) or not chords:
        raise ValueError("Plan must contain a chord progression")
    tempo_us = round(60_000_000 / bpm)
    tempo_event = (0, 0, b"\xff\x51\x03" + tempo_us.to_bytes(3, "big"))
    melody_events: list[tuple[int, int, bytes]] = []
    chord_events: list[tuple[int, int, bytes]] = []
    note_count = 0
    for line_index, phrase in enumerate(melody):
        notes = phrase.get("midi_notes")
        if not isinstance(notes, list) or not notes:
            raise ValueError("Each melody phrase must contain MIDI note numbers")
        if any(isinstance(note, bool) or not isinstance(note, int) or not 48 <= note <= 96 for note in notes):
            raise ValueError("Melody note is outside the supported MIDI range (48-96)")
        bar_start = line_index * PPQ * 4
        step = max(1, (PPQ * 4) // len(notes))
        for index, note in enumerate(notes):
            start = bar_start + index * step
            end = start + max(1, min(step, PPQ))
            melody_events.append((start, 2, bytes((0x90, note, 88))))
            melody_events.append((end, 1, bytes((0x80, note, 0))))
            note_count += 1
        chord = chords[line_index % len(chords)]
        for note in _chord_notes(chord):
            chord_events.append((bar_start, 2, bytes((0x91, note, 58))))
            chord_events.append((bar_start + PPQ * 4 - 12, 1, bytes((0x81, note, 0))))
            note_count += 1
    if note_count > MAX_NOTES:
        raise ValueError("Composition exceeds the 4096-note safety limit")
    conductor = _track([(0, 0, b"\xff\x51\x03" + tempo_us.to_bytes(3, "big")),
                        (0, 1, b"\xff\x58\x04\x04\x02\x18\x08")], "MEHRAN Tempo")
    tracks = [conductor, _track(melody_events, "MEHRAN Melody"),
              _track(chord_events, "MEHRAN Chords")]
    midi = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ) + b"".join(tracks)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(midi)
    return {"path": str(target), "format": "Standard MIDI File", "tracks": len(tracks),
            "tempo_bpm": bpm, "note_events": note_count, "bytes": len(midi)}
