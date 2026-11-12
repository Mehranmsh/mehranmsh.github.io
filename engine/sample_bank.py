"""Validated, offline sample-bank manifest for MEHRAN's future sampler.

Only recorded PCM WAV assets are accepted. This module does not synthesize
placeholder tones and does not claim to render audio.
"""
from __future__ import annotations

import csv
import io
import json
import math
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



def rank_sample_candidates(
    bank: SampleBank,
    instrument: str,
    midi_note: int,
    velocity: int = 80,
    articulation: str = "sustain",
) -> dict[str, Any]:
    """Rank only exact-note, exact-articulation, velocity-compatible recordings.

    The score is a transparent technical screening aid, not a timbre or
    musicianship rating. It never substitutes another note or articulation.
    """
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if not isinstance(instrument, str) or not instrument:
        raise ValueError("instrument must be a non-empty name")
    midi_note = _integer(midi_note, 0, 127, "midi_note")
    velocity = _integer(velocity, 1, 127, "velocity")
    if not isinstance(articulation, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", articulation):
        raise ValueError("articulation must be a lowercase slug")

    exact = [
        sample for sample in bank.samples
        if sample.instrument == instrument
        and sample.midi_note == midi_note
        and sample.articulation == articulation
        and sample.velocity_min <= velocity <= sample.velocity_max
    ]
    if not exact:
        return {
            "instrument": instrument,
            "midi_note": midi_note,
            "velocity": velocity,
            "articulation": articulation,
            "selected_sample": None,
            "candidate_count": 0,
            "candidates": [],
            "selection_status": "no_exact_candidate",
            "score_kind": "technical_screening_only",
        }

    measurements = analyze_sample_bank_quality(bank)["measurements"]
    by_path = {
        item["path"]: item for item in measurements if "path" in item
    }
    ranked = []
    penalties = {
        "silent_sample": 100,
        "digital_clipping": 40,
        "dc_offset": 15,
        "very_low_level": 10,
        "loop_boundary_discontinuity": 15,
    }
    for sample in exact:
        relative_path = sample.path.relative_to(bank.root).as_posix()
        measurement = by_path[relative_path]
        warnings = list(measurement["warnings"])
        deductions = {
            warning: points for warning, points in penalties.items()
            if warning in warnings
        }
        if measurement.get("possible_truncated_tail"):
            deductions["possible_truncated_tail"] = 20
        score = max(0, 100 - sum(deductions.values()))
        reference_frequency = 440.0
        recording_metadata = sample.recording_metadata or {}
        if "reference_frequency_hz" in recording_metadata:
            try:
                declared_reference = float(recording_metadata["reference_frequency_hz"])
                if 400.0 <= declared_reference <= 480.0:
                    reference_frequency = declared_reference
            except (TypeError, ValueError):
                pass
        unpitched_instruments = {"kick", "snare", "closed_hat", "open_hat", "daf", "tombak"}
        if sample.instrument in unpitched_instruments:
            pitch_diagnostic = {"status": "not_applicable_percussion"}
        else:
            pitch_diagnostic = _estimate_sample_fundamental(sample, reference_frequency)
        acoustic_diagnostics = {
            "pitch": pitch_diagnostic,
            "pitch_stability_cents": pitch_diagnostic.get("pitch_stability_cents"),
            "envelope_family": measurement["envelope_family"],
            "attack_to_10_percent_seconds": measurement["attack_to_10_percent_seconds"],
            "attack_10_to_90_seconds": measurement["attack_10_to_90_seconds"],
            "release_90_to_10_seconds": measurement["release_90_to_10_seconds"],
            "ending_level_ratio": measurement["ending_level_ratio"],
            "boundary_analysis_status": measurement["boundary_analysis_status"],
        }
        ranked.append({
            "path": sample.path.relative_to(bank.root).as_posix(),
            "instrument": sample.instrument,
            "midi_note": sample.midi_note,
            "velocity_range": [sample.velocity_min, sample.velocity_max],
            "articulation": sample.articulation,
            "score": score,
            "warnings": warnings,
            "score_deductions": deductions,
            "rms": measurement["rms"],
            "peak": measurement["peak"],
            "dc_offset": measurement["dc_offset"],
            "acoustic_diagnostics": acoustic_diagnostics,
            "possible_truncated_tail": measurement.get("possible_truncated_tail", False),
            "technical_checks_pass": not warnings and not measurement.get("possible_truncated_tail", False),
        })
    ranked.sort(key=lambda item: (-item["score"], item["path"]))
    return {
        "instrument": instrument,
        "midi_note": midi_note,
        "velocity": velocity,
        "articulation": articulation,
        "selected_sample": ranked[0]["path"],
        "candidate_count": len(ranked),
        "candidates": ranked,
        "selection_status": "ranked_exact_candidates",
        "score_kind": "technical_screening_only",
        "note": (
            "Ranking uses numerical WAV warnings and a possible-tail heuristic. "
            "It does not judge timbre, musicality, tuning authenticity or performer quality; "
            "the top-ranked file should be auditioned before production use."
        ),
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


def _estimate_sample_fundamental(
    sample: Sample, reference_frequency_hz: float = 440.0
) -> dict[str, Any]:
    """Estimate a recorded note's fundamental near its declared MIDI pitch."""
    expected_hz = reference_frequency_hz * (2 ** ((sample.midi_note - 69) / 12))
    if expected_hz >= sample.sample_rate / 2:
        return {"status": "outside_analysis_band", "expected_hz": round(expected_hz, 3)}
    with wave.open(str(sample.path), "rb") as wav:
        wav.setpos(min(int(sample.sample_rate * 0.025), max(0, sample.frames - 1)))
        raw = wav.readframes(min(sample.frames, int(sample.sample_rate * 0.35)))
    values = struct.unpack("<" + "h" * (len(raw) // 2), raw)
    if sample.channels == 2:
        mono = [(values[i] + values[i + 1]) / 2.0 for i in range(0, len(values) - 1, 2)]
    else:
        mono = [float(value) for value in values]
    if not mono:
        return {"status": "insufficient_audio", "expected_hz": round(expected_hz, 3)}
    # Decimate for a bounded, deterministic analysis cost while preserving the note band.
    stride = max(1, sample.sample_rate // 6000)
    signal = mono[::stride][:1536]
    if len(signal) < 96:
        return {"status": "insufficient_audio", "expected_hz": round(expected_hz, 3)}
    mean = sum(signal) / len(signal)
    signal = [value - mean for value in signal]
    energy = sum(value * value for value in signal)
    zero_crossings = sum(
        1 for left, right in zip(signal, signal[1:])
        if (left < 0 <= right) or (right < 0 <= left)
    )
    zero_crossing_rate = zero_crossings / max(1, len(signal) - 1)
    expected_crossing_rate = min(1.0, 2.0 * expected_hz / (sample.sample_rate / stride))
    max_pitched_crossing_rate = min(0.98, max(0.45, expected_crossing_rate * 2.5 + 0.12))
    if zero_crossing_rate > max_pitched_crossing_rate:
        return {
            "status": "insufficient_periodicity",
            "expected_hz": round(expected_hz, 3),
            "zero_crossing_rate": round(zero_crossing_rate, 4),
        }
    if energy < 1.0:
        return {"status": "insufficient_periodicity", "expected_hz": round(expected_hz, 3)}
    analysis_rate = sample.sample_rate / stride
    expected_period = analysis_rate / expected_hz
    # Search a narrow +/- 100 cent window around the declared note, avoiding octave guesses.
    min_lag = max(2, int(expected_period / (2 ** (100 / 1200))) - 1)
    max_lag = min(len(signal) // 2, int(expected_period * (2 ** (100 / 1200))) + 1)
    if min_lag > max_lag:
        return {"status": "outside_analysis_band", "expected_hz": round(expected_hz, 3)}
    best_lag, best_score = None, -1.0
    for lag in range(min_lag, max_lag + 1):
        left = signal[:-lag]
        right = signal[lag:]
        left_energy = sum(value * value for value in left)
        right_energy = sum(value * value for value in right)
        denominator = (left_energy * right_energy) ** 0.5
        if denominator <= 0:
            continue
        score = sum(x * y for x, y in zip(left, right)) / denominator
        if score > best_score:
            best_lag, best_score = lag, score
    # Require the same periodic pitch to persist across three windows. A short
    # transient or quasi-periodic noise can score highly in one whole-file window.
    segment_scores = []
    segment_lags = []
    segment_size = len(signal) // 3
    for segment_index in range(3):
        segment = signal[segment_index * segment_size:(segment_index + 1) * segment_size]
        local_best_score, local_best_lag = -1.0, None
        for lag in range(min_lag, min(max_lag, len(segment) // 2) + 1):
            left, right = segment[:-lag], segment[lag:]
            denominator = (sum(value * value for value in left) *
                           sum(value * value for value in right)) ** 0.5
            if denominator <= 0:
                continue
            score = sum(x * y for x, y in zip(left, right)) / denominator
            if score > local_best_score:
                local_best_score, local_best_lag = score, lag
        segment_scores.append(local_best_score)
        if local_best_lag is not None:
            segment_lags.append(local_best_lag)
    stable_segments = (
        len(segment_lags) == 3
        and min(segment_scores) >= 0.65
        and max(segment_lags) - min(segment_lags) <= 1
    )
    if best_lag is None or best_score < 0.65 or not stable_segments:
        return {
            "status": "insufficient_periodicity",
            "expected_hz": round(expected_hz, 3),
            "periodicity_score": round(max(0.0, best_score), 4),
            "stable_segment_count": sum(score >= 0.65 for score in segment_scores),
        }
    # Parabolic interpolation reduces integer-lag quantization for stable tones.
    refined_lag = float(best_lag)
    if min_lag < best_lag < max_lag:
        def correlation(lag: int) -> float:
            left, right = signal[:-lag], signal[lag:]
            denominator = (sum(x*x for x in left) * sum(y*y for y in right)) ** 0.5
            return sum(x*y for x, y in zip(left, right)) / denominator if denominator else 0.0
        before, center, after = (
            correlation(best_lag - 1), best_score, correlation(best_lag + 1)
        )
        curvature = before - 2 * center + after
        if abs(curvature) > 1e-12:
            refined_lag += max(-0.5, min(0.5, 0.5 * (before - after) / curvature))
    measured_hz = analysis_rate / refined_lag
    segment_pitch_hz = [analysis_rate / lag for lag in segment_lags]
    segment_cents = [
        1200.0 * math.log2(frequency / measured_hz)
        for frequency in segment_pitch_hz
    ]
    pitch_stability_cents = (
        max(segment_cents) - min(segment_cents)
        if len(segment_cents) == 3 else None
    )
    # Autocorrelation alone can mistake a repeating ramp or transient for a note.
    # Check that energy is concentrated at the estimated fundamental/harmonics.
    harmonic_energy = 0.0
    for harmonic in range(1, 9):
        frequency = measured_hz * harmonic
        if frequency >= analysis_rate / 2:
            break
        cosine = sum(
            value * math.cos(2 * math.pi * frequency * index / analysis_rate)
            for index, value in enumerate(signal)
        )
        sine = sum(
            value * math.sin(2 * math.pi * frequency * index / analysis_rate)
            for index, value in enumerate(signal)
        )
        harmonic_energy += 2.0 * (cosine * cosine + sine * sine) / len(signal)
    spectral_concentration = min(1.0, harmonic_energy / energy)
    if spectral_concentration < 0.08:
        return {
            "status": "insufficient_periodicity",
            "expected_hz": round(expected_hz, 3),
            "periodicity_score": round(best_score, 4),
            "spectral_concentration": round(spectral_concentration, 4),
        }
    cents = 1200 * math.log2(measured_hz / expected_hz)
    return {
        "status": "estimated",
        "expected_hz": round(expected_hz, 3),
        "measured_hz": round(measured_hz, 3),
        "deviation_cents": round(cents, 2),
        "periodicity_score": round(best_score, 4),
        "spectral_concentration": round(spectral_concentration, 4),
        "zero_crossing_rate": round(zero_crossing_rate, 4),
        "segment_pitch_estimates_hz": [round(value, 3) for value in segment_pitch_hz],
        "pitch_stability_cents": round(pitch_stability_cents, 2)
        if pitch_stability_cents is not None else None,
    }


def analyze_sample_bank_tuning(
    bank: SampleBank, *, tolerance_cents: float = 15.0
) -> dict[str, Any]:
    """Estimate pitch offsets for pitched samples; percussion is explicitly skipped."""
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if (isinstance(tolerance_cents, bool) or not isinstance(tolerance_cents, (int, float))
            or not 1 <= tolerance_cents <= 100):
        raise ValueError("tolerance_cents must be a number from 1 to 100")
    unpitched = {"kick", "snare", "closed_hat", "open_hat", "daf", "tombak"}
    measurements = []
    grouped: dict[str, list[float]] = {}
    for sample in bank.samples:
        if sample.instrument in unpitched:
            measurements.append({
                "instrument": sample.instrument, "midi_note": sample.midi_note,
                "status": "not_applicable_percussion",
            })
            continue
        reference = 440.0
        metadata = sample.recording_metadata or {}
        if "reference_frequency_hz" in metadata:
            try:
                candidate = float(metadata["reference_frequency_hz"])
                if 400.0 <= candidate <= 480.0:
                    reference = candidate
            except (TypeError, ValueError):
                pass
        estimate = _estimate_sample_fundamental(sample, reference)
        item = {"instrument": sample.instrument, "midi_note": sample.midi_note, **estimate}
        if estimate.get("status") == "estimated":
            deviation = estimate["deviation_cents"]
            item["within_tolerance"] = abs(deviation) <= tolerance_cents
            grouped.setdefault(sample.instrument, []).append(deviation)
        measurements.append(item)
    profiles = {}
    for instrument, offsets in sorted(grouped.items()):
        profiles[instrument] = {
            "estimated_samples": len(offsets),
            "mean_deviation_cents": round(sum(offsets) / len(offsets), 2),
            "maximum_absolute_deviation_cents": round(max(abs(x) for x in offsets), 2),
            "within_tolerance_samples": sum(abs(x) <= tolerance_cents for x in offsets),
            "outside_tolerance_samples": sum(abs(x) > tolerance_cents for x in offsets),
        }
    estimated = sum(item.get("status") == "estimated" for item in measurements)
    return {
        "sample_count": len(measurements),
        "estimated_samples": estimated,
        "not_estimated_samples": len(measurements) - estimated,
        "tolerance_cents": float(tolerance_cents),
        "instrument_profiles": profiles,
        "measurements": measurements,
        "note": "Pitch is estimated by autocorrelation near each declared MIDI note. Percussion is skipped. This is a diagnostic estimate, not a tuner-grade certification; noisy, inharmonic, transient or multi-pitch recordings may be inconclusive.",
    }


def _envelope_family(instrument: str) -> str:
    """Return a broad acoustic envelope family for diagnostic context."""
    families = {
        "percussive": {
            "kick", "snare", "closed_hat", "open_hat", "daf", "tombak",
            "santur", "piano",
        },
        "plucked": {
            "acoustic_guitar", "electric_guitar", "electric_bass", "tar",
            "setar", "oud", "qanun", "harp", "classical_guitar", "mandolin",
            "banjo",
        },
        "bowed": {"strings", "violin", "viola", "cello", "contrabass", "kamancheh"},
        "wind_or_bellows": {
            "ney", "flute", "clarinet", "oboe", "bassoon", "trumpet",
            "trombone", "french_horn", "accordion", "harmonica",
        },
    }
    return next(
        (family for family, members in families.items() if instrument in members),
        "unknown",
    )


def _post_peak_decay_profile(
    buckets: list[tuple[float, float]],
    peak_index: int,
    bucket_frames: int,
    sample_rate: int,
    peak: float,
) -> dict[str, Any]:
    """Describe short-window RMS decay after the strongest recorded frame."""
    windows = ((0, 100), (100, 300), (300, 700))
    bucket_ms = bucket_frames * 1000.0 / sample_rate
    results = {}
    for start_ms, end_ms in windows:
        selected = []
        for index in range(peak_index, len(buckets)):
            offset_ms = (index - peak_index) * bucket_ms
            if start_ms <= offset_ms < end_ms:
                selected.append(buckets[index][1])
        key = f"{start_ms}_{end_ms}ms"
        results[key] = {
            "mean_rms_ratio": round(
                (sum(selected) / len(selected)) / peak, 5
            ) if selected and peak else None,
            "end_rms_ratio": round(selected[-1] / peak, 5)
            if selected and peak else None,
            "bucket_count": len(selected),
        }
    measured = any(item["bucket_count"] for item in results.values())
    return {
        "windows": results,
        "profile_status": "measured" if measured else "insufficient_duration",
        "normalization": "RMS relative to maximum bucket peak",
    }


def _analyze_sample_boundaries(sample: Sample) -> dict[str, Any]:
    """Measure low-level head/tail regions and the recorded attack envelope."""
    bucket_frames = max(1, int(sample.sample_rate * 0.01))
    buckets: list[tuple[float, float]] = []
    bucket_peak = 0
    bucket_square_sum = 0
    bucket_value_count = 0
    with wave.open(str(sample.path), "rb") as wav:
        while True:
            chunk = wav.readframes(8192)
            if not chunk:
                break
            values = struct.unpack("<" + "h" * (len(chunk) // 2), chunk)
            for offset in range(0, len(values), sample.channels):
                frame = values[offset:offset + sample.channels]
                if len(frame) != sample.channels:
                    continue
                frame_peak = max(abs(value) for value in frame)
                bucket_peak = max(bucket_peak, frame_peak)
                bucket_square_sum += sum(value * value for value in frame) / sample.channels
                bucket_value_count += 1
                if bucket_value_count >= bucket_frames:
                    rms = (bucket_square_sum / bucket_value_count) ** 0.5
                    buckets.append((float(bucket_peak), rms))
                    bucket_peak = 0
                    bucket_square_sum = 0.0
                    bucket_value_count = 0
    if bucket_value_count:
        rms = (bucket_square_sum / bucket_value_count) ** 0.5
        buckets.append((float(bucket_peak), rms))
    if not buckets:
        return {
            "leading_low_level_seconds": 0.0,
            "trailing_low_level_seconds": 0.0,
            "attack_to_10_percent_seconds": None,
            "attack_10_to_90_seconds": None,
            "release_90_to_10_seconds": None,
            "post_peak_decay_profile": {"windows": {}, "profile_status": "insufficient_audio"},
            "envelope_family": _envelope_family(sample.instrument),
            "quiet_region_rms": None,
            "ending_level_ratio": None,
            "possible_truncated_tail": False,
            "boundary_analysis_status": "insufficient_audio",
        }
    peak = max(item[0] for item in buckets)
    if peak <= 0:
        return {
            "leading_low_level_seconds": round(sample.frames / sample.sample_rate, 4),
            "trailing_low_level_seconds": round(sample.frames / sample.sample_rate, 4),
            "attack_to_10_percent_seconds": None,
            "attack_10_to_90_seconds": None,
            "release_90_to_10_seconds": None,
            "post_peak_decay_profile": {"windows": {}, "profile_status": "silent"},
            "envelope_family": _envelope_family(sample.instrument),
            "quiet_region_rms": 0.0,
            "ending_level_ratio": 0.0,
            "possible_truncated_tail": False,
            "boundary_analysis_status": "silent",
        }
    active_threshold = max(64.0, peak * 0.01)
    leading = 0
    while leading < len(buckets) and buckets[leading][0] <= active_threshold:
        leading += 1
    trailing = 0
    while trailing < len(buckets) and buckets[len(buckets) - 1 - trailing][0] <= active_threshold:
        trailing += 1
    attack = None
    attack_10_to_90 = None
    release_90_to_10 = None
    peak_index = max(range(len(buckets)), key=lambda index: buckets[index][0])
    ten_percent = max(64.0, peak * 0.1)
    ninety_percent = peak * 0.9
    attack_index = next(
        (index for index in range(leading, len(buckets))
         if buckets[index][0] >= ten_percent),
        None,
    )
    if attack_index is not None:
        attack = round((attack_index - leading) * bucket_frames / sample.sample_rate, 4)
        ninety_index = next(
            (index for index in range(attack_index, peak_index + 1)
             if buckets[index][0] >= ninety_percent),
            None,
        )
        if ninety_index is not None:
            attack_10_to_90 = round(
                (ninety_index - attack_index) * bucket_frames / sample.sample_rate, 4
            )
    release_start = next(
        (index for index in range(peak_index, len(buckets))
         if buckets[index][0] <= ninety_percent),
        None,
    )
    release_end = next(
        (index for index in range(peak_index, len(buckets))
         if buckets[index][0] <= ten_percent),
        None,
    )
    if release_start is not None and release_end is not None:
        release_90_to_10 = round(
            (release_end - release_start) * bucket_frames / sample.sample_rate, 4
        )
    ending_level_ratio = buckets[-1][0] / peak
    possible_truncated_tail = trailing == 0 and ending_level_ratio >= 0.05
    decay_profile = _post_peak_decay_profile(
        buckets, peak_index, bucket_frames, sample.sample_rate, peak
    )
    quiet = [rms for frame_peak, rms in buckets if frame_peak <= active_threshold]
    return {
        "leading_low_level_seconds": round(leading * bucket_frames / sample.sample_rate, 4),
        "trailing_low_level_seconds": round(min(trailing * bucket_frames, sample.frames) / sample.sample_rate, 4),
        "attack_to_10_percent_seconds": attack,
        "attack_10_to_90_seconds": attack_10_to_90,
        "release_90_to_10_seconds": release_90_to_10,
        "post_peak_decay_profile": decay_profile,
        "envelope_family": _envelope_family(sample.instrument),
        "quiet_region_rms": round((sum(value * value for value in quiet) / len(quiet)) ** 0.5 / 32768.0, 6)
        if quiet else None,
        "ending_level_ratio": round(ending_level_ratio, 4),
        "possible_truncated_tail": possible_truncated_tail,
        "boundary_analysis_status": "measured",
    }


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
        boundary = _analyze_sample_boundaries(sample)
        reports.append({
            "path": sample.path.relative_to(bank.root).as_posix(),
            "instrument": sample.instrument,
            "midi_note": sample.midi_note,
            "articulation": sample.articulation,
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
            **boundary,
            "warnings": warnings,
            "basic_signal_checks_pass": not warnings,
        })
        total_samples += count
        total_clipped += clipped
    instrument_groups: dict[str, list[dict[str, Any]]] = {}
    for report in reports:
        instrument_groups.setdefault(report["instrument"], []).append(report)
    instrument_profiles = {}
    for instrument, items in sorted(instrument_groups.items()):
        rates = sorted({item["sample_rate"] for item in items})
        channel_counts = sorted({item["channels"] for item in items})
        durations = [item["duration_seconds"] for item in items]
        rms_values = [item["rms"] for item in items]
        peak_values = [item["peak"] for item in items]
        instrument_profiles[instrument] = {
            "sample_count": len(items),
            "sample_rates_hz": rates,
            "channels_present": channel_counts,
            "sample_rate_consistent": len(rates) == 1,
            "channel_layout_consistent": len(channel_counts) == 1,
            "duration_seconds": {
                "minimum": min(durations),
                "maximum": max(durations),
            },
            "rms": {
                "minimum": min(rms_values),
                "maximum": max(rms_values),
                "spread": round(max(rms_values) - min(rms_values), 5),
            },
            "peak": {
                "minimum": min(peak_values),
                "maximum": max(peak_values),
                "spread": round(max(peak_values) - min(peak_values), 5),
            },
            "samples_with_warnings": sum(bool(item["warnings"]) for item in items),
            "clipped_samples": sum(item["clipped_samples"] for item in items),
            "basic_signal_checks_pass": all(item["basic_signal_checks_pass"] for item in items),
        }
    warning_count = sum(bool(item["warnings"]) for item in reports)
    return {
        "sample_count": len(reports),
        "samples_with_warnings": warning_count,
        "clipped_samples": total_clipped,
        "basic_signal_checks_pass": warning_count == 0,
        "measurements": reports,
        "instrument_profiles": instrument_profiles,
        "note": "Per-instrument profiles summarize sample-rate and channel consistency plus duration and level spread. Boundary metrics estimate low-level head/tail regions, quiet-region RMS, attack rise and a possible abrupt tail. They are diagnostic only: quiet regions may contain room noise, and measurements do not certify perceptual trimming, instrument tone, tuning or mix readiness.",
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
