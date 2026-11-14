"""Standard MIDI File parser for MEHRAN SVS conditioning. No synthesis is performed."""
from __future__ import annotations

from collections import defaultdict, deque


class MidiParseError(ValueError):
    pass


NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#")


def _u16(data: bytes, offset: int) -> int:
    return (data[offset] << 8) | data[offset + 1]


def _u32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 4], "big")


def _vlq(data: bytes, pos: int, end: int) -> tuple[int, int]:
    value = 0
    for _ in range(4):
        if pos >= end:
            raise MidiParseError("Unexpected end of track inside variable-length quantity")
        byte = data[pos]
        pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos
    raise MidiParseError("Variable-length quantity exceeds four bytes")


def midi_note_name(number: int) -> str:
    return f"{NOTE_NAMES[number % 12]}{number // 12 - 1}"


def parse_standard_midi(data: bytes, max_notes: int = 4096) -> dict:
    """Parse note events and tempo map from an SMF byte string."""
    if len(data) < 14 or data[:4] != b"MThd":
        raise MidiParseError("Missing Standard MIDI header")
    header_length = _u32(data, 4)
    if header_length < 6 or 8 + header_length > len(data):
        raise MidiParseError("Invalid MIDI header length")
    fmt = _u16(data, 8)
    track_count = _u16(data, 10)
    division = _u16(data, 12)
    if fmt not in (0, 1):
        raise MidiParseError("Only MIDI format 0 and 1 are supported")
    if not track_count or track_count > 32 or (fmt == 0 and track_count != 1):
        raise MidiParseError("Unsupported MIDI track count")
    if not division or division & 0x8000:
        raise MidiParseError("SMPTE timing is not supported; use PPQ MIDI")

    offset = 8 + header_length
    raw_notes: list[dict] = []
    tempo_events: list[tuple[int, int]] = [(0, 500000)]
    max_tick = 0

    for track_index in range(track_count):
        if offset + 8 > len(data) or data[offset:offset + 4] != b"MTrk":
            raise MidiParseError("Missing or damaged MIDI track chunk")
        chunk_length = _u32(data, offset + 4)
        pos = offset + 8
        end = pos + chunk_length
        if end > len(data):
            raise MidiParseError("MIDI track extends beyond file boundary")
        tick = 0
        running_status = None
        active: dict[tuple[int, int], deque] = defaultdict(deque)

        while pos < end:
            delta, pos = _vlq(data, pos, end)
            tick += delta
            max_tick = max(max_tick, tick)
            if pos >= end:
                raise MidiParseError("Missing MIDI event after delta time")

            first = data[pos]
            if first & 0x80:
                status = first
                pos += 1
                if status < 0xF0:
                    running_status = status
            else:
                if running_status is None:
                    raise MidiParseError("Running status used before a channel status")
                status = running_status

            if status == 0xFF:
                if pos >= end:
                    raise MidiParseError("Truncated MIDI meta event")
                meta_type = data[pos]
                pos += 1
                size, pos = _vlq(data, pos, end)
                if pos + size > end:
                    raise MidiParseError("MIDI meta event exceeds track boundary")
                payload = data[pos:pos + size]
                pos += size
                if meta_type == 0x51 and size == 3:
                    micros = int.from_bytes(payload, "big")
                    if micros:
                        tempo_events.append((tick, micros))
                if meta_type == 0x2F:
                    break
                continue

            if status in (0xF0, 0xF7):
                size, pos = _vlq(data, pos, end)
                if pos + size > end:
                    raise MidiParseError("MIDI SysEx event exceeds track boundary")
                pos += size
                running_status = None
                continue

            if status >= 0xF0:
                raise MidiParseError("Unsupported system-common MIDI event")

            kind = status & 0xF0
            channel = status & 0x0F
            needed = 1 if kind in (0xC0, 0xD0) else 2
            if pos + needed > end:
                raise MidiParseError("Truncated MIDI channel event")
            first_data = data[pos]
            pos += 1
            second_data = data[pos] if needed == 2 else 0
            if needed == 2:
                pos += 1
            if first_data > 127 or second_data > 127:
                raise MidiParseError("Invalid MIDI data byte")

            if kind not in (0x80, 0x90):
                continue
            key = (channel, first_data)
            is_on = kind == 0x90 and second_data > 0
            if is_on:
                active[key].append((tick, second_data, track_index))
            else:
                if active[key]:
                    start_tick, velocity, source_track = active[key].popleft()
                    if len(raw_notes) < max_notes:
                        raw_notes.append({
                            "start_tick": start_tick,
                            "end_tick": max(start_tick, tick),
                            "pitch": first_data,
                            "velocity": velocity,
                            "channel": channel,
                            "track": source_track,
                        })
        offset = end

    if offset != len(data):
        trailing = data[offset:]
        if any(trailing):
            raise MidiParseError("Unexpected data after final MIDI track")

    tempo_events.sort(key=lambda item: item[0])
    compact_tempos: list[tuple[int, int]] = []
    for event in tempo_events:
        if compact_tempos and compact_tempos[-1][0] == event[0]:
            compact_tempos[-1] = event
        else:
            compact_tempos.append(event)

    def seconds_at(target_tick: int) -> float:
        seconds = 0.0
        previous_tick = 0
        micros_per_quarter = 500000
        for event_tick, event_tempo in compact_tempos:
            if event_tick >= target_tick:
                break
            seconds += (event_tick - previous_tick) * micros_per_quarter / 1_000_000 / division
            previous_tick = event_tick
            micros_per_quarter = event_tempo
        seconds += (target_tick - previous_tick) * micros_per_quarter / 1_000_000 / division
        return seconds

    notes = []
    for event in sorted(raw_notes, key=lambda item: (item["start_tick"], item["pitch"])):
        start = event["start_tick"]
        finish = event["end_tick"]
        start_seconds = seconds_at(start)
        end_seconds = seconds_at(finish)
        notes.append({
            "note": midi_note_name(event["pitch"]),
            "midiNote": event["pitch"],
            "startTick": start,
            "endTick": finish,
            "startBeat": round(start / division, 6),
            "durationBeats": round((finish - start) / division, 6),
            "startSeconds": round(start_seconds, 6),
            "durationSeconds": round(max(0.0, end_seconds - start_seconds), 6),
            "velocity": event["velocity"],
            "channel": event["channel"],
            "track": event["track"],
        })

    return {
        "format": fmt,
        "trackCount": track_count,
        "ticksPerQuarter": division,
        "durationTicks": max_tick,
        "durationSeconds": round(seconds_at(max_tick), 6),
        "tempoMap": [{"tick": tick, "microsecondsPerQuarter": tempo} for tick, tempo in compact_tempos],
        "noteCount": len(notes),
        "notes": notes,
        "truncated": len(raw_notes) >= max_notes,
    }
