"""Validated, offline sample-bank manifest for MEHRAN's future sampler.

Only recorded PCM WAV assets are accepted. This module does not synthesize
placeholder tones and does not claim to render audio.
"""
from __future__ import annotations

import json
import re
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Sample:
    instrument: str
    midi_note: int
    path: Path
    velocity_min: int
    velocity_max: int
    sample_rate: int
    channels: int
    frames: int
    loop_start_frame: int | None = None
    loop_end_frame: int | None = None


@dataclass(frozen=True)
class SampleBank:
    root: Path
    samples: tuple[Sample, ...]


def _integer(value: Any, low: int, high: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{field} must be an integer from {low} to {high}")
    return value


def load_sample_bank(bank_root: str | Path) -> SampleBank:
    """Load bank.json and validate every referenced, recorded PCM WAV sample."""
    root = Path(bank_root).resolve()
    manifest_path = root / "bank.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Could not read a valid sample-bank bank.json") from exc
    if not isinstance(manifest, dict) or manifest.get("format_version") != 1:
        raise ValueError("Unsupported sample-bank manifest version")
    entries = manifest.get("samples")
    if not isinstance(entries, list) or not entries or len(entries) > 4096:
        raise ValueError("Sample bank must contain 1 to 4096 sample entries")

    samples = []
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Each sample entry must be an object")
        instrument = entry.get("instrument")
        if not isinstance(instrument, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{1,39}", instrument):
            raise ValueError("Instrument names must be lowercase slugs")
        midi_note = _integer(entry.get("midi_note"), 0, 127, "midi_note")
        velocity_min = _integer(entry.get("velocity_min", 1), 1, 127, "velocity_min")
        velocity_max = _integer(entry.get("velocity_max", 127), 1, 127, "velocity_max")
        if velocity_min > velocity_max:
            raise ValueError("velocity_min cannot exceed velocity_max")
        relative = entry.get("path")
        if not isinstance(relative, str) or not relative or "\x00" in relative:
            raise ValueError("Sample path must be a non-empty relative path")
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or candidate == root:
            raise ValueError("Sample path must remain inside the sample-bank directory")
        identity = (instrument, midi_note, velocity_min, velocity_max)
        if identity in seen:
            raise ValueError("Duplicate instrument, note, and velocity layer")
        seen.add(identity)
        if not candidate.is_file():
            raise ValueError(f"Recorded sample file is missing: {relative}")
        try:
            with wave.open(str(candidate), "rb") as wav:
                if wav.getcomptype() != "NONE" or wav.getsampwidth() != 2:
                    raise ValueError("Samples must be uncompressed 16-bit PCM WAV files")
                channels = wav.getnchannels()
                sample_rate = wav.getframerate()
                frames = wav.getnframes()
                if channels not in (1, 2) or not 8000 <= sample_rate <= 192000 or frames <= 0:
                    raise ValueError("Sample WAV has unsupported channels, rate, or empty audio")
                loop_start = entry.get("loop_start_frame")
                loop_end = entry.get("loop_end_frame")
                if (loop_start is None) != (loop_end is None):
                    raise ValueError("Both loop_start_frame and loop_end_frame must be provided together")
                if loop_start is not None:
                    loop_start = _integer(loop_start, 0, frames - 1, "loop_start_frame")
                    loop_end = _integer(loop_end, 1, frames, "loop_end_frame")
                    if loop_end - loop_start < 16:
                        raise ValueError("Sample loop must contain at least 16 frames")
        except (wave.Error, EOFError, OSError) as exc:
            raise ValueError(f"Invalid recorded WAV sample: {relative}") from exc
        samples.append(Sample(instrument, midi_note, candidate, velocity_min,
                              velocity_max, sample_rate, channels, frames,
                              loop_start, loop_end))
    return SampleBank(root, tuple(samples))


def select_sample(bank: SampleBank, instrument: str, midi_note: int,
                  velocity: int = 80) -> Sample:
    """Choose the closest recorded pitch within the requested velocity layer."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if not isinstance(instrument, str) or not instrument:
        raise ValueError("instrument must be a non-empty name")
    midi_note = _integer(midi_note, 0, 127, "midi_note")
    velocity = _integer(velocity, 1, 127, "velocity")
    candidates = [sample for sample in bank.samples
                  if sample.instrument == instrument
                  and sample.velocity_min <= velocity <= sample.velocity_max]
    if not candidates:
        raise ValueError(f"No recorded sample layer for instrument: {instrument}")
    return min(candidates, key=lambda sample: (abs(sample.midi_note - midi_note),
                                               sample.midi_note))
