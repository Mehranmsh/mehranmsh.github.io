"""Validated, offline sample-bank manifest for MEHRAN's future sampler.

Only recorded PCM WAV assets are accepted. This module does not synthesize
placeholder tones and does not claim to render audio.
"""
from __future__ import annotations

import csv
import io
import json
import re
import struct
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any


LOOP_BOUNDARY_JUMP_WARNING_THRESHOLD = 0.10


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
    articulation: str = "sustain"
    recording_session_id: str | None = None
    recording_metadata: dict[str, str] | None = None


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
    sessions = manifest.get("recording_sessions", {})
    if not isinstance(sessions, dict):
        raise ValueError("recording_sessions must be an object keyed by session ID")
    allowed_metadata = {
        "instrument_model", "instrument_serial", "performer", "tuning",
        "reference_frequency_hz", "microphone", "microphone_position",
        "room", "audio_interface", "preamp", "gain_db", "recorded_at", "notes",
    }
    validated_sessions: dict[str, dict[str, str]] = {}
    for session_id, metadata in sessions.items():
        if (not isinstance(session_id, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{1,63}", session_id)):
            raise ValueError("Recording session IDs must be 2-64 safe characters")
        if not isinstance(metadata, dict):
            raise ValueError(f"Recording session {session_id} must contain an object")
        unknown = set(metadata) - allowed_metadata
        if unknown:
            raise ValueError(f"Unknown recording metadata fields: {', '.join(sorted(unknown))}")
        clean = {}
        for field, value in metadata.items():
            if not isinstance(value, str) or not value.strip() or len(value) > 500:
                raise ValueError(f"Recording metadata {field} must be a non-empty string up to 500 characters")
            clean[field] = value.strip()
        validated_sessions[session_id] = clean

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
        articulation = entry.get("articulation", "sustain")
        session_id = entry.get("recording_session_id")
        if session_id is not None and (
            not isinstance(session_id, str) or session_id not in validated_sessions
        ):
            raise ValueError("recording_session_id must reference a declared recording session")
        recording_metadata = validated_sessions.get(session_id) if session_id else None
        if not isinstance(articulation, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", articulation):
            raise ValueError("articulation must be a lowercase slug")
        identity = (instrument, midi_note, velocity_min, velocity_max, articulation)
        if identity in seen:
            raise ValueError("Duplicate instrument, note, velocity layer, and articulation")
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
                              loop_start, loop_end, articulation, session_id, recording_metadata))
    return SampleBank(root, tuple(samples))




def analyze_recording_provenance(bank: SampleBank) -> dict[str, Any]:
    """Summarize sample recording-session metadata without guessing missing values."""
    fields = (
        "instrument_model", "instrument_serial", "performer", "tuning",
        "reference_frequency_hz", "microphone", "microphone_position",
        "room", "audio_interface", "preamp", "gain_db", "recorded_at", "notes",
    )
    by_field = {
        field: sum(
            1 for sample in bank.samples
            if sample.recording_metadata and field in sample.recording_metadata
        )
        for field in fields
    }
    linked = sum(1 for sample in bank.samples if sample.recording_session_id)
    return {
        "sample_count": len(bank.samples),
        "linked_samples": linked,
        "unlinked_samples": len(bank.samples) - linked,
        "session_count": len({
            sample.recording_session_id for sample in bank.samples
            if sample.recording_session_id
        }),
        "metadata_field_coverage": {
            field: {
                "recorded_samples": count,
                "missing_samples": len(bank.samples) - count,
                "coverage_percent": round(count * 100 / len(bank.samples), 2)
                if bank.samples else 0.0,
            }
            for field, count in by_field.items()
        },
        "complete_provenance": bool(bank.samples) and all(
            sample.recording_session_id and sample.recording_metadata
            and all(field in sample.recording_metadata for field in fields)
            for sample in bank.samples
        ),
        "read_only": True,
    }


def _register_zones(low: int, high: int) -> list[dict[str, Any]]:
    """Partition a catalog capture range into transparent, non-overlapping zones."""
    if (isinstance(low, bool) or not isinstance(low, int)
            or isinstance(high, bool) or not isinstance(high, int)
            or not 0 <= low <= high <= 127):
        raise ValueError("register bounds must be ordered MIDI notes from 0 to 127")
    if low == high:
        return [{"name": "single", "note_min": low, "note_max": high}]
    span = high - low + 1
    first_end = low + (span + 2) // 3 - 1
    second_end = low + (2 * span + 2) // 3 - 1
    return [
        {"name": "low", "note_min": low, "note_max": first_end},
        {"name": "middle", "note_min": first_end + 1, "note_max": second_end},
        {"name": "high", "note_min": second_end + 1, "note_max": high},
    ]


def build_sample_recording_checklist(
    catalog: dict[str, dict[str, Any]] | None = None,
    articulation_catalog: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Create note, velocity and performance-technique capture targets."""
    requirements = SAMPLE_INSTRUMENT_CATALOG if catalog is None else catalog
    articulation_requirements = (
        SAMPLE_ARTICULATION_CATALOG if articulation_catalog is None
        else articulation_catalog
    )
    instruments = {}
    total_targets = 0
    for instrument, spec in requirements.items():
        low, high = spec["note_range"]
        layers = spec["velocity_layers"]
        articulations = _articulations_for(instrument, articulation_requirements)
        register_zones = _register_zones(low, high)
        def zone_for_note(note: int) -> str:
            for zone in register_zones:
                if zone["note_min"] <= note <= zone["note_max"]:
                    return zone["name"]
            raise ValueError("Recording target falls outside its register zones")
        targets = [
            {"midi_note": note, "register_zone": zone_for_note(note),
             "velocity_layer": layer["name"],
             "velocity_min": layer["min"], "velocity_max": layer["max"],
             "articulation": articulation}
            for articulation in articulations
            for note in range(low, high + 1)
            for layer in layers
        ]
        total_targets += len(targets)
        instruments[instrument] = {
            "label": spec["label"],
            "note_range": [low, high],
            "register_zones": register_zones,
            "articulations": articulations,
            "target_count": len(targets),
            "targets": targets,
            "capture_guidance": [
                "Record every listed articulation as a distinct performance, not as an effect applied afterward",
                "Keep microphone position and gain consistent within an instrument",
                "Avoid clipping, background noise and unintended effects",
                "Preserve the natural attack, decay, sustain and release of each technique",
                "Document tuning, instrument, room, performer and recording chain",
                "Use loop points only for genuinely sustained sounds and audition loop boundaries",
            ],
        }
    return {
        "catalog_version": 3,
        "instrument_count": len(instruments),
        "total_recording_targets": total_targets,
        "articulation_count": sum(
            len(item["articulations"]) for item in instruments.values()
        ),
        "instruments": instruments,
        "format_requirements": {
            "container": "WAV",
            "encoding": "uncompressed PCM",
            "bit_depth": 16,
            "sample_rate_hz": "8000-192000",
            "channels": [1, 2],
            "manifest": "bank.json",
            "manifest_articulation_field": "articulation",
        },
        "note": "Checklist targets describe planned instrument, note, velocity and articulation coverage, not recordings already present.",
    }



def build_sample_recording_sheet_csv(
    catalog: dict[str, dict[str, Any]] | None = None,
    articulation_catalog: dict[str, list[str]] | None = None,
) -> str:
    """Export planned note, velocity and articulation targets as an Excel-friendly CSV."""
    checklist = build_sample_recording_checklist(catalog, articulation_catalog)
    output = io.StringIO(newline="")
    columns = [
        "instrument", "instrument_label", "articulation", "midi_note",
        "velocity_layer", "velocity_min", "velocity_max",
        "suggested_filename", "recording_status", "recorded_file_path",
        "recording_notes",
    ]
    writer = csv.DictWriter(output, fieldnames=columns, lineterminator="\r\n")
    writer.writeheader()
    for instrument, spec in checklist["instruments"].items():
        for target in spec["targets"]:
            note = target["midi_note"]
            layer = target["velocity_layer"]
            articulation = target["articulation"]
            writer.writerow({
                "instrument": instrument,
                "instrument_label": spec["label"],
                "articulation": articulation,
                "midi_note": note,
                "velocity_layer": layer,
                "velocity_min": target["velocity_min"],
                "velocity_max": target["velocity_max"],
                "suggested_filename": f"{instrument}/{articulation}/{note}_{layer}.wav",
                "recording_status": "planned",
                "recorded_file_path": "",
                "recording_notes": "",
            })
    return "\ufeff" + output.getvalue()



def analyze_sample_bank_instrument_health(
    bank: SampleBank,
    coverage: dict[str, Any] | None = None,
    quality: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Aggregate read-only sample, coverage and signal diagnostics by instrument."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    coverage_report = coverage if coverage is not None else analyze_sample_bank_coverage(bank)
    quality_report = quality if quality is not None else analyze_sample_bank_quality(bank)
    quality_by_instrument: dict[str, list[dict[str, Any]]] = {}
    for measurement in quality_report["measurements"]:
        quality_by_instrument.setdefault(measurement["instrument"], []).append(measurement)

    instruments = {}
    for instrument, coverage_item in coverage_report["instruments"].items():
        samples = [sample for sample in bank.samples if sample.instrument == instrument]
        measurements = quality_by_instrument.get(instrument, [])
        warning_counts: dict[str, int] = {}
        for measurement in measurements:
            for warning in measurement["warnings"]:
                warning_counts[warning] = warning_counts.get(warning, 0) + 1
        sample_count = len(samples)
        warning_sample_count = sum(bool(item["warnings"]) for item in measurements)
        if sample_count == 0:
            status = "missing"
        elif warning_sample_count:
            status = "needs_attention"
        elif not coverage_item["ready"]:
            status = "incomplete_coverage"
        else:
            status = "basic_signal_checks_passed"
        rms_values = [item["rms"] for item in measurements]
        peak_values = [item["peak"] for item in measurements]
        loop_jumps = [item["loop_boundary_jump"] for item in measurements
                      if item["loop_boundary_jump"] is not None]
        loop_warning_count = sum(
            "loop_boundary_discontinuity" in item["warnings"]
            for item in measurements
        )
        instruments[instrument] = {
            "label": coverage_item["label"],
            "status": status,
            "recorded_samples": sample_count,
            "coverage_percent": coverage_item["coverage_percent"],
            "covered_requirements": coverage_item["covered_requirements"],
            "required_requirements": coverage_item["required_requirements"],
            "missing_notes": coverage_item["missing_notes"],
            "missing_velocity_layers": coverage_item["missing_velocity_layers"],
            "samples_with_warnings": warning_sample_count,
            "warning_counts": warning_counts,
            "average_rms": round(sum(rms_values) / len(rms_values), 5) if rms_values else None,
            "max_peak": max(peak_values) if peak_values else None,
            "sample_rates": sorted({sample.sample_rate for sample in samples}),
            "channel_counts": sorted({sample.channels for sample in samples}),
            "bit_depths": [16] if samples else [],
            "looped_samples": sum(sample.loop_start_frame is not None for sample in samples),
            "unlooped_samples": sum(sample.loop_start_frame is None for sample in samples),
            "loop_boundary_warning_count": loop_warning_count,
            "max_loop_boundary_jump": round(max(loop_jumps), 6) if loop_jumps else None,
            "total_duration_seconds": round(sum(sample.frames / sample.sample_rate for sample in samples), 4),
            "coverage_ready": coverage_item["ready"],
            "basic_signal_checks_pass": warning_sample_count == 0 and sample_count > 0,
        }
    return {
        "read_only": True,
        "instrument_count": len(instruments),
        "instruments": instruments,
        "note": "Per-instrument status summarizes file presence, catalog coverage, basic WAV signal checks and numerical loop-boundary jump indicators only; it does not certify perceptual loop quality, timbre, tuning, performance or mix readiness.",
    }


def select_sample(bank: SampleBank, instrument: str, midi_note: int,
                  velocity: int = 80, articulation: str = "sustain") -> Sample:
    """Choose the closest recorded pitch for an exact articulation and velocity layer."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if not isinstance(instrument, str) or not instrument:
        raise ValueError("instrument must be a non-empty name")
    midi_note = _integer(midi_note, 0, 127, "midi_note")
    velocity = _integer(velocity, 1, 127, "velocity")
    if not isinstance(articulation, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", articulation):
        raise ValueError("articulation must be a lowercase slug")
    candidates = [sample for sample in bank.samples
                  if sample.instrument == instrument
                  and sample.articulation == articulation
                  and sample.velocity_min <= velocity <= sample.velocity_max]
    if not candidates:
        raise ValueError(f"No recorded {articulation} sample layer for instrument: {instrument}")
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
        loop_boundary_jump = None
        if sample.loop_start_frame is not None:
            with wave.open(str(sample.path), "rb") as wav:
                wav.setpos(sample.loop_start_frame)
                first_frame = struct.unpack("<" + "h" * sample.channels, wav.readframes(1))
                wav.setpos(sample.loop_end_frame - 1)
                last_frame = struct.unpack("<" + "h" * sample.channels, wav.readframes(1))
            loop_boundary_jump = max(
                abs(first - last) / 32768.0
                for first, last in zip(first_frame, last_frame)
            )
        warnings = []
        if peak == 0:
            warnings.append("silent_sample")
        elif rms / 32768.0 < 0.005:
            warnings.append("very_low_level")
        if clipped:
            warnings.append("digital_clipping")
        if abs(dc_offset) > 0.02:
            warnings.append("dc_offset")
        if (loop_boundary_jump is not None
                and loop_boundary_jump > LOOP_BOUNDARY_JUMP_WARNING_THRESHOLD):
            warnings.append("loop_boundary_discontinuity")
        reports.append({
            "instrument": sample.instrument,
            "midi_note": sample.midi_note,
            "velocity_range": [sample.velocity_min, sample.velocity_max],
            "duration_seconds": round(sample.frames / sample.sample_rate, 4),
            "sample_rate": sample.sample_rate,
            "channels": sample.channels,
            "bit_depth": 16,
            "loop_present": sample.loop_start_frame is not None,
            "loop_start_frame": sample.loop_start_frame,
            "loop_end_frame": sample.loop_end_frame,
            "loop_duration_seconds": round((sample.loop_end_frame - sample.loop_start_frame) / sample.sample_rate, 4) if sample.loop_start_frame is not None else None,
            "loop_boundary_jump": round(loop_boundary_jump, 6) if loop_boundary_jump is not None else None,
            "loop_boundary_jump_warning_threshold": LOOP_BOUNDARY_JUMP_WARNING_THRESHOLD,
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
        "note": "Checks cover silence, level, clipping, DC offset and a numerical loop-boundary jump indicator only; they do not certify perceptual loop quality, instrument tone, recording quality, tuning or mix readiness.",
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
    # Iranian instruments: capture requirements only, not renderer support claims.
    "tar": {
        "label": "Persian tar",
        "note_range": [40, 88],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "setar": {
        "label": "Persian setar",
        "note_range": [48, 88],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "santur": {
        "label": "Persian santur",
        "note_range": [48, 96],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "ney": {
        "label": "Persian ney",
        "note_range": [48, 84],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "kamancheh": {
        "label": "Persian kamancheh",
        "note_range": [48, 84],
        "velocity_layers": [{"name": "sustain", "min": 1, "max": 127}],
    },
    "oud": {
        "label": "Oud",
        "note_range": [40, 84],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "qanun": {
        "label": "Qanun",
        "note_range": [48, 90],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "daf": {
        "label": "Persian daf",
        "note_range": [35, 60],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "tombak": {
        "label": "Persian tombak",
        "note_range": [35, 60],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    # Orchestral instruments.
    "violin": {
        "label": "Violin",
        "note_range": [55, 96],
        "velocity_layers": [{"name": "sustain", "min": 1, "max": 127}],
    },
    "viola": {
        "label": "Viola",
        "note_range": [48, 84],
        "velocity_layers": [{"name": "sustain", "min": 1, "max": 127}],
    },
    "cello": {
        "label": "Cello",
        "note_range": [36, 76],
        "velocity_layers": [{"name": "sustain", "min": 1, "max": 127}],
    },
    "contrabass": {
        "label": "Double bass",
        "note_range": [28, 60],
        "velocity_layers": [{"name": "sustain", "min": 1, "max": 127}],
    },
    "flute": {
        "label": "Concert flute",
        "note_range": [60, 96],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "clarinet": {
        "label": "B-flat clarinet",
        "note_range": [50, 91],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "oboe": {
        "label": "Oboe",
        "note_range": [58, 88],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "bassoon": {
        "label": "Bassoon",
        "note_range": [34, 75],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "trumpet": {
        "label": "Trumpet",
        "note_range": [55, 84],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "trombone": {
        "label": "Trombone",
        "note_range": [40, 72],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "french_horn": {
        "label": "French horn",
        "note_range": [41, 77],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "harp": {
        "label": "Concert harp",
        "note_range": [24, 96],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    # Additional plucked and free-reed instruments.
    "classical_guitar": {
        "label": "Nylon-string classical guitar",
        "note_range": [40, 84],
        "velocity_layers": [
            {"name": "soft", "min": 1, "max": 64},
            {"name": "hard", "min": 65, "max": 127},
        ],
    },
    "mandolin": {
        "label": "Mandolin",
        "note_range": [55, 88],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "banjo": {
        "label": "Five-string banjo",
        "note_range": [48, 88],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "accordion": {
        "label": "Piano accordion",
        "note_range": [48, 84],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
    "harmonica": {
        "label": "Diatonic harmonica",
        "note_range": [48, 84],
        "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
    },
}



SAMPLE_ARTICULATION_CATALOG = {
    "piano": ["sustain", "staccato"],
    "acoustic_guitar": ["fingerstyle", "pick", "palm_mute"],
    "electric_bass": ["fingerstyle", "pick", "slap"],
    "strings": ["sustain", "staccato", "tremolo", "pizzicato"],
    "electric_guitar": ["sustain", "palm_mute", "harmonic", "slide"],
    "kick": ["main"],
    "snare": ["center_hit", "rimshot", "ghost_note"],
    "closed_hat": ["closed_hit", "foot_closed"],
    "open_hat": ["open_hit", "choke"],
    "tar": ["mezrab_down", "mezrab_up", "tremolo", "vibrato"],
    "setar": ["mezrab_down", "mezrab_up", "tremolo", "vibrato"],
    "santur": ["soft_mallet", "hard_mallet", "roll"],
    "ney": ["breath_attack", "sustain", "vibrato"],
    "kamancheh": ["long_bow", "short_bow", "tremolo", "pizzicato"],
    "oud": ["risha_down", "risha_up", "tremolo"],
    "qanun": ["pluck", "tremolo"],
    "daf": ["open_hit", "closed_hit", "roll"],
    "tombak": ["tom", "bak", "roll", "riz"],
    "violin": ["long_bow", "short_bow", "staccato", "pizzicato", "tremolo"],
    "viola": ["long_bow", "short_bow", "staccato", "pizzicato", "tremolo"],
    "cello": ["long_bow", "short_bow", "staccato", "pizzicato", "tremolo"],
    "contrabass": ["long_bow", "short_bow", "pizzicato"],
    "flute": ["breath_attack", "sustain", "staccato", "flutter_tongue"],
    "clarinet": ["breath_attack", "sustain", "staccato", "tongued"],
    "oboe": ["breath_attack", "sustain", "staccato"],
    "bassoon": ["breath_attack", "sustain", "staccato"],
    "trumpet": ["tongued", "sustain", "staccato", "mute"],
    "trombone": ["tongued", "sustain", "staccato", "mute"],
    "french_horn": ["sustain", "staccato", "muted"],
    "harp": ["pluck", "harmonic", "bisbigliando"],
    "classical_guitar": ["fingerstyle", "rest_stroke", "harmonic", "rasgueado"],
    "mandolin": ["downstroke", "upstroke", "tremolo"],
    "banjo": ["finger_roll", "pick", "strum"],
    "accordion": ["bellows_attack", "sustain", "bellows_change"],
    "harmonica": ["single_note", "chord", "bend", "vibrato"],
}


def _articulations_for(
    instrument: str,
    articulation_catalog: dict[str, list[str]],
) -> list[str]:
    values = articulation_catalog.get(instrument, ["sustain"])
    if (not isinstance(values, list) or not values
            or any(not isinstance(value, str)
                   or not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", value)
                   for value in values)
            or len(values) != len(set(values))):
        raise ValueError(f"Invalid articulation requirements for instrument: {instrument}")
    return values


def analyze_sample_bank_coverage(
    bank: SampleBank,
    catalog: dict[str, dict[str, Any]] | None = None,
    articulation_catalog: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Report exact coverage by note, register zone, velocity layer and articulation."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    requirements = SAMPLE_INSTRUMENT_CATALOG if catalog is None else catalog
    articulation_requirements = (
        SAMPLE_ARTICULATION_CATALOG if articulation_catalog is None
        else articulation_catalog
    )
    instruments: dict[str, Any] = {}
    total_required = 0
    total_covered = 0
    for instrument, spec in requirements.items():
        low, high = spec["note_range"]
        layers = spec["velocity_layers"]
        articulations = _articulations_for(instrument, articulation_requirements)
        zones = _register_zones(low, high)
        def zone_for_note(note: int) -> str:
            for zone in zones:
                if zone["note_min"] <= note <= zone["note_max"]:
                    return zone["name"]
            raise ValueError("Coverage target falls outside its register zones")
        zone_counts = {
            zone["name"]: {"note_min": zone["note_min"], "note_max": zone["note_max"],
                           "required": 0, "covered": 0}
            for zone in zones
        }
        articulation_counts = {
            articulation: {"required": 0, "covered": 0}
            for articulation in articulations
        }
        velocity_counts = {
            layer["name"]: {"velocity_min": layer["min"], "velocity_max": layer["max"],
                            "required": 0, "covered": 0}
            for layer in layers
        }
        required_pairs = [
            (note, layer["name"], layer["min"], layer["max"], articulation)
            for articulation in articulations
            for note in range(low, high + 1)
            for layer in layers
        ]
        recorded = [sample for sample in bank.samples if sample.instrument == instrument]
        missing_notes = []
        missing_layers = []
        missing_articulations = []
        covered = 0
        for note, layer_name, velocity_min, velocity_max, articulation in required_pairs:
            zone_name = zone_for_note(note)
            zone_counts[zone_name]["required"] += 1
            articulation_counts[articulation]["required"] += 1
            velocity_counts[layer_name]["required"] += 1
            matching = [
                sample for sample in recorded
                if sample.midi_note == note
                and sample.articulation == articulation
                and sample.velocity_min <= velocity_min
                and sample.velocity_max >= velocity_max
            ]
            if matching:
                covered += 1
                zone_counts[zone_name]["covered"] += 1
                articulation_counts[articulation]["covered"] += 1
                velocity_counts[layer_name]["covered"] += 1
            else:
                if note not in missing_notes:
                    missing_notes.append(note)
                missing_layers.append({
                    "note": note, "layer": layer_name,
                    "articulation": articulation,
                })
                if articulation not in missing_articulations:
                    missing_articulations.append(articulation)
        def progress_items(counts: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
            return {
                name: {
                    **item,
                    "missing": item["required"] - item["covered"],
                    "coverage_percent": round(item["covered"] * 100 / item["required"], 2)
                    if item["required"] else 100.0,
                }
                for name, item in counts.items()
            }
        required = len(required_pairs)
        total_required += required
        total_covered += covered
        instruments[instrument] = {
            "label": spec["label"],
            "note_range": [low, high],
            "articulations": articulations,
            "recorded_samples": len(recorded),
            "required_requirements": required,
            "covered_requirements": covered,
            "missing_requirements": required - covered,
            "coverage_percent": round(covered * 100 / required, 2) if required else 100.0,
            "register_zone_progress": progress_items(zone_counts),
            "articulation_progress": progress_items(articulation_counts),
            "velocity_layer_progress": progress_items(velocity_counts),
            "missing_notes": missing_notes,
            "missing_velocity_layers": missing_layers,
            "missing_articulations": missing_articulations,
            "ready": covered == required,
        }
    return {
        "catalog_version": 3,
        "ready": total_covered == total_required and total_required > 0,
        "recorded_samples": len(bank.samples),
        "required_requirements": total_required,
        "covered_requirements": total_covered,
        "missing_requirements": total_required - total_covered,
        "coverage_percent": round(total_covered * 100 / total_required, 2)
        if total_required else 0.0,
        "instruments": instruments,
        "read_only": True,
        "note": "Coverage requires exact recorded note, velocity-zone and articulation assets; progress is grouped by catalog register zones and does not certify recording quality or mixing.",
    }
