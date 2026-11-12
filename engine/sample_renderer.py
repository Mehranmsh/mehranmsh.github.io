"""Offline PCM sample playback and WAV mixing for MEHRAN.

This renderer plays only recorded samples from a validated sample bank. It
does not synthesize oscillator tones or claim to provide instrument recordings.
"""
from __future__ import annotations

import array
import math
import struct
import wave
from pathlib import Path
from typing import Any

from sample_bank import SampleBank, select_sample

MAX_EVENTS = 20000
MAX_DURATION_SECONDS = 120.0
MAX_OUTPUT_RATE = 48000
MAX_PEAK = 0.92


def _read_sample(path: Path) -> tuple[array.array, int, int]:
    with wave.open(str(path), "rb") as wav:
        if wav.getcomptype() != "NONE" or wav.getsampwidth() != 2:
            raise ValueError("Only uncompressed 16-bit PCM samples are supported")
        channels = wav.getnchannels()
        rate = wav.getframerate()
        frames = wav.getnframes()
        raw = wav.readframes(frames)
    pcm = array.array("h")
    pcm.frombytes(raw)
    if struct.pack("=H", 1) != struct.pack("<H", 1):
        pcm.byteswap()
    if channels not in (1, 2) or not pcm:
        raise ValueError("Sample must contain mono or stereo PCM frames")
    return pcm, channels, rate


def render_sample_events(
    events: list[dict[str, Any]],
    bank: SampleBank,
    output_path: str | Path,
    *,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Render recorded sample events into a stereo 16-bit PCM WAV file.

    Each event contains instrument, midi_note, start_seconds, duration_seconds,
    and optional velocity. Pitch shifting is simple sample-rate transposition;
    no time-stretching or artificial instrument synthesis is performed.
    """
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if not isinstance(events, list) or not events or len(events) > MAX_EVENTS:
        raise ValueError(f"events must contain 1 to {MAX_EVENTS} entries")
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or not 8000 <= sample_rate <= MAX_OUTPUT_RATE:
        raise ValueError("sample_rate must be an integer from 8000 to 48000")

    checked = []
    end_time = 0.0
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Each sample event must be an object")
        instrument = event.get("instrument")
        note = event.get("midi_note")
        start = event.get("start_seconds")
        duration = event.get("duration_seconds")
        velocity = event.get("velocity", 90)
        if not isinstance(instrument, str) or not instrument:
            raise ValueError("event instrument must be a non-empty string")
        if isinstance(note, bool) or not isinstance(note, int) or not 0 <= note <= 127:
            raise ValueError("event midi_note must be an integer from 0 to 127")
        if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
            raise ValueError("event start_seconds must be finite and non-negative")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
            raise ValueError("event duration_seconds must be finite and positive")
        if isinstance(velocity, bool) or not isinstance(velocity, int) or not 1 <= velocity <= 127:
            raise ValueError("event velocity must be an integer from 1 to 127")
        sample = select_sample(bank, instrument, note, velocity)
        end_time = max(end_time, float(start) + float(duration))
        checked.append((sample, note, float(start), float(duration), velocity))
    if end_time > MAX_DURATION_SECONDS:
        raise ValueError("Rendered audio may not exceed 120 seconds")

    frame_count = max(1, math.ceil(end_time * sample_rate))
    mix = array.array("f", [0.0]) * (frame_count * 2)
    rendered_events = 0
    for sample, target_note, start, duration, velocity in checked:
        pcm, source_channels, source_rate = _read_sample(sample.path)
        source_frames = len(pcm) // source_channels
        semitone_ratio = 2.0 ** ((target_note - sample.midi_note) / 12.0)
        source_step = source_rate / sample_rate * semitone_ratio
        start_frame = round(start * sample_rate)
        requested_frames = min(round(duration * sample_rate),
                               math.ceil(source_frames / source_step))
        if requested_frames <= 0:
            continue
        gain = (velocity / 127.0) ** 1.6 * 0.72
        attack_frames = max(1, round(sample_rate * 0.004))
        release_frames = max(1, round(sample_rate * 0.025))
        for out_index in range(requested_frames):
            source_position = out_index * source_step
            source_index = int(source_position)
            if source_index >= source_frames:
                break
            fraction = source_position - source_index
            next_index = min(source_index + 1, source_frames - 1)
            if out_index < attack_frames:
                envelope = out_index / attack_frames
            elif requested_frames - out_index <= release_frames:
                envelope = max(0.0, (requested_frames - out_index) / release_frames)
            else:
                envelope = 1.0
            frame_gain = gain * envelope
            for channel in range(2):
                source_channel = 0 if source_channels == 1 else channel
                a = pcm[source_index * source_channels + source_channel]
                b = pcm[next_index * source_channels + source_channel]
                value = (a + (b - a) * fraction) * frame_gain
                destination = (start_frame + out_index) * 2 + channel
                mix[destination] += value
        rendered_events += 1

    peak = max((abs(value) for value in mix), default=0.0)
    normalization = min(1.0, (32767.0 * MAX_PEAK / peak)) if peak > 0 else 1.0
    output = array.array("h")
    for value in mix:
        clipped = max(-32768, min(32767, round(value * normalization)))
        output.append(clipped)
    if struct.pack("=H", 1) != struct.pack("<H", 1):
        output.byteswap()

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(output.tobytes())

    return {
        "path": str(target),
        "format": "WAV PCM 16-bit",
        "sample_rate": sample_rate,
        "channels": 2,
        "duration_seconds": round(frame_count / sample_rate, 3),
        "events_requested": len(checked),
        "events_rendered": rendered_events,
        "peak_before_normalization": round(peak / 32768.0, 5),
        "normalization_applied": round(normalization, 5),
        "source": "recorded_sample_bank",
    }
