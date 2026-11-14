"""Turn consented, reviewed manifest records into deterministic SVS examples.

This loader reads local audio only. It does not upload, train, infer, or synthesize.
"""
from __future__ import annotations

import json
from pathlib import Path

from acoustic_contract import validate_acoustic_conditioning
from batch_collator import TrainingExample
from dataset_manifest import ManifestError, _safe_audio_path, validate_manifest
from model_config import AcousticModelConfig
from pitch_targets import build_pitch_targets
from signal_features import extract_acoustic_features
from token_encoder import build_frame_token_sequence


class DatasetLoadError(ValueError):
    """Raised when a manifest record cannot become a reviewed training example."""


def _language_code(value: object) -> str:
    if not isinstance(value, str):
        raise DatasetLoadError("language must be a string")
    normalized = value.strip().lower()
    if normalized in {"fa", "persian", "farsi"}:
        return "fa"
    raise DatasetLoadError("the first training loader supports Persian records only")


def _read_records(manifest_path: Path) -> list[dict]:
    records = []
    try:
        with manifest_path.open("r", encoding="utf-8") as source:
            for line_number, raw in enumerate(source, start=1):
                if not raw.strip():
                    continue
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise DatasetLoadError(f"line {line_number}: invalid JSON") from exc
                if not isinstance(record, dict):
                    raise DatasetLoadError(f"line {line_number}: record must be an object")
                records.append(record)
    except OSError as exc:
        raise DatasetLoadError("cannot read dataset manifest") from exc
    return records


def load_training_examples(
    manifest_path: str | Path,
    config: AcousticModelConfig,
    *,
    dataset_root: str | Path | None = None,
    split: str = "train",
) -> list[TrainingExample]:
    """Load one manifest split into aligned acoustic, phoneme, and MIDI examples.

    Every selected record must have explicit performer consent and rights
    metadata (checked by validate_manifest), reviewed phoneme spans, and
    monophonic MIDI note events. The loader rejects stereo recordings because
    the current feature frontend is mono-only.
    """
    if split not in {"train", "validation", "test"}:
        raise DatasetLoadError("split must be train, validation, or test")

    manifest = Path(manifest_path).resolve()
    root = Path(dataset_root).resolve() if dataset_root else manifest.parent.resolve()
    try:
        validate_manifest(manifest, root)
    except ManifestError as exc:
        raise DatasetLoadError(str(exc)) from exc

    records = _read_records(manifest)
    selected = [record for record in records if record.get("split") == split]
    if not selected:
        raise DatasetLoadError(f"manifest contains no records for split: {split}")

    examples = []
    for record in selected:
        recording_id = record["recording_id"]
        if record.get("alignment_status") != "reviewed":
            raise DatasetLoadError(f"{recording_id}: reviewed phoneme alignment is required")
        spans = record.get("phoneme_alignment")
        notes = record.get("notes")
        if not isinstance(spans, list) or not spans:
            raise DatasetLoadError(f"{recording_id}: phoneme_alignment is required")
        if not isinstance(notes, list) or not notes:
            raise DatasetLoadError(f"{recording_id}: reviewed monophonic notes are required")

        sample_rate = record["sample_rate"]
        if sample_rate != config.sample_rate:
            raise DatasetLoadError(f"{recording_id}: WAV sample rate does not match model config")
        if record["channels"] != 1:
            raise DatasetLoadError(f"{recording_id}: current feature frontend requires mono WAV")

        audio_path = _safe_audio_path(root, record["audio_path"])
        audio_bytes = audio_path.read_bytes()
        duration = float(record["duration_seconds"])
        conditioning_payload = {
            "schema_version": "mehran.svs.conditioning.v1",
            "project_id": recording_id,
            "language": _language_code(record["language"]),
            "sample_rate": sample_rate,
            "duration_seconds": duration,
            "phonemes": spans,
            "notes": notes,
            "style": record.get("style", {}),
        }
        try:
            conditioning = validate_acoustic_conditioning(conditioning_payload)
            acoustic = extract_acoustic_features(audio_bytes, config)
            tokens = build_frame_token_sequence(conditioning, config)
            pitch = build_pitch_targets(conditioning, config)
        except (ValueError, TypeError, KeyError) as exc:
            raise DatasetLoadError(f"{recording_id}: {exc}") from exc

        if len(acoustic.f0_hz) != len(tokens.frame_times_seconds):
            raise DatasetLoadError(f"{recording_id}: WAV feature frames do not match reviewed alignment grid")
        examples.append(TrainingExample(recording_id, acoustic, tokens, pitch))

    return examples
