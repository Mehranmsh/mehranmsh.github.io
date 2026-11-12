"""Validated, offline sample-bank manifest for MEHRAN's future sampler.

Only recorded PCM WAV assets are accepted. This module does not synthesize
placeholder tones and does not claim to render audio.
"""
from __future__ import annotations

import json
import re
import struct
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


def analyze_sample_bank_quality(bank: SampleBank) -> dict[str, Any]:
    """Measure recorded WAV health without pretending to judge timbre or musicianship."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    reports = []
    total_samples = 0
    total_clipped = 0
    for sample in bank.samples:
        count = 0
        peak = 0
        clipped = 0
        sample_sum = 0
        square_sum = 0
        with wave.open(str(sample.path), "rb") as wav:
            while True:
                chunk = wav.readframes(32768)
                if not chunk:
                    break
                values = struct.unpack("<" + "h" * (len(chunk) // 2), chunk)
                count += len(values)
                if values:
                    peak = max(peak, max(abs(value) for value in values))
                    clipped += sum(value in (-32768, 32767) for value in values)
                    sample_sum += sum(values)
                    square_sum += sum(value * value for value in values)
        rms = (square_sum / count) ** 0.5 if count else 0.0
        dc_offset = sample_sum / count / 32768.0 if count else 0.0
        peak_normalized = peak / 32768.0
        clipped_ratio = clipped / count if count else 0.0
        warnings = []
        if peak == 0:
            warnings.append("silent_sample")
        elif rms / 32768.0 < 0.005:
            warnings.append("very_low_level")
        if clipped:
            warnings.append("digital_clipping")
        if abs(dc_offset) > 0.02:
            warnings.append("dc_offset")
        reports.append({
            "instrument": sample.instrument,
            "midi_note": sample.midi_note,
            "velocity_range": [sample.velocity_min, sample.velocity_max],
            "duration_seconds": round(sample.frames / sample.sample_rate, 4),
            "peak": round(peak_normalized, 5),
            "rms": round(rms / 32768.0, 5),
            "dc_offset": round(dc_offset, 5),
            "clipped_samples": clipped,
            "clipped_ratio": round(clipped_ratio, 6),
            "warnings": warnings,
            "basic_signal_checks_pass": not warnings,
        })
        total_samples += count
        total_clipped += clipped
    warning_count = sum(bool(item["warnings"]) for item in reports)
    return {
        "sample_count": len(reports),
        "samples_with_warnings": warning_count,
        "clipped_samples": total_clipped,
        "basic_signal_checks_pass": warning_count == 0,
        "measurements": reports,
        "note": "Checks cover silence, level, clipping and DC offset only; they do not certify instrument tone, recording quality, tuning or mix readiness.",
    }


# Recording targets for the first practical MEHRAN instrument bank.
# Notes are MIDI note numbers; velocity zones are inclusive.
SAMPLE_INSTRUMENT_CATALOG = {
    "piano": {
        "label": "Acoustic grand piano",
        "note_range": [36, 96],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 48},
            {"name": "medium", "min": 49, "max": 88},
            {"name": "hard", "min": 89, "max": 127},
        ],
    },
    "acoustic_guitar": {
        "label": "Steel-string acoustic guitar",
        "note_range": [40, 88],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "electric_bass": {
        "label": "Fingered electric bass",
        "note_range": [28, 60],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "strings": {
        "label": "String ensemble",
        "note_range": [48, 84],
        "velocity_layers": [
            {"name": "sustain", "min": 1, "max": 127},
        ],
    },
    "electric_guitar": {
        "label": "Clean electric guitar",
        "note_range": [40, 88],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "kick": {
        "label": "Acoustic kick drum",
        "note_range": [36, 36],
        "velocity_layers": [
            {"name": "main", "min": 1, "max": 127},
        ],
    },
    "snare": {
        "label": "Acoustic snare drum",
        "note_range": [38, 38],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "closed_hat": {
        "label": "Closed hi-hat",
        "note_range": [42, 42],
        "velocity_layers": [
            {"name": "main", "min": 1, "max": 127},
        ],
    },
    "open_hat": {
        "label": "Open hi-hat",
        "note_range": [46, 46],
        "velocity_layers": [
            {"name": "main", "min": 1, "max": 127},
        ],
    },
}


def analyze_sample_bank_coverage(
    bank: SampleBank,
    catalog: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Report exact recorded-note and velocity-zone coverage; never infer readiness."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    requirements = SAMPLE_INSTRUMENT_CATALOG if catalog is None else catalog
    instruments: dict[str, Any] = {}
    total_required = 0
    total_covered = 0

    for instrument, spec in requirements.items():
        low, high = spec["note_range"]
        layers = spec["velocity_layers"]
        required_pairs = [
            (note, layer["name"], layer["min"], layer["max"])
            for note in range(low, high + 1)
            for layer in layers
        ]
        recorded = [sample for sample in bank.samples if sample.instrument == instrument]
        missing_notes = []
        missing_layers = []
        covered = 0
        for note, layer_name, velocity_min, velocity_max in required_pairs:
            matching = [
                sample for sample in recorded
                if sample.midi_note == note
                and sample.velocity_min <= velocity_min
                and sample.velocity_max >= velocity_max
            ]
            if matching:
                covered += 1
            else:
                if note not in missing_notes:
                    missing_notes.append(note)
                missing_layers.append({"note": note, "layer": layer_name})
        required = len(required_pairs)
        total_required += required
        total_covered += covered
        instruments[instrument] = {
            "label": spec["label"],
            "note_range": [low, high],
            "required_samples": required,
            "covered_samples": covered,
            "coverage_percent": round(covered * 100 / required, 2) if required else 100.0,
            "missing_notes": missing_notes,
            "missing_velocity_layers": missing_layers,
            "ready": covered == required,
        }

    return {
        "catalog_version": 1,
        "ready": total_covered == total_required and total_required > 0,
        "required_samples": total_required,
        "covered_samples": total_covered,
        "coverage_percent": round(total_covered * 100 / total_required, 2) if total_required else 0.0,
        "instruments": instruments,
        "note": "Coverage means recorded note/velocity assets exist; it does not certify recording quality or mixing.",
    }
