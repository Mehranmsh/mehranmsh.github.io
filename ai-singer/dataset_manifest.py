"""Strict, privacy-conscious manifest validation for MEHRAN SVS training audio.

This module validates metadata and local WAV files only. It does not train a model,
upload recordings, or infer consent/rights from the presence of an audio file.
"""
from __future__ import annotations

import argparse
import json
import math
import wave
from collections import defaultdict
from pathlib import Path, PurePosixPath


class ManifestError(ValueError):
    """Raised when a dataset manifest is unsafe or internally inconsistent."""


ALLOWED_SPLITS = {"train", "validation", "test"}
ALLOWED_ALIGNMENTS = {"reviewed", "unreviewed", "needs_review"}
ALLOWED_SAMPLE_WIDTHS = {2, 3, 4}
REQUIRED_FIELDS = {
    "recording_id", "audio_path", "language", "speaker_id", "split",
    "transcript", "sample_rate", "channels", "duration_seconds",
    "consent_confirmed", "rights_basis", "alignment_status",
}


def _safe_audio_path(root: Path, value: object) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError("audio_path must be a non-empty relative path")
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or ".." in candidate.parts or "\\" in value:
        raise ManifestError("audio_path must not be absolute or contain traversal")
    resolved_root = root.resolve()
    resolved = (resolved_root / Path(*candidate.parts)).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ManifestError("audio_path resolves outside the dataset root")
    if not resolved.is_file():
        raise ManifestError(f"audio file does not exist: {value}")
    return resolved


def _validate_alignment(record: dict, duration: float, line_number: int) -> None:
    status = record["alignment_status"]
    if not isinstance(status, str) or status not in ALLOWED_ALIGNMENTS:
        raise ManifestError(f"line {line_number}: unsupported alignment_status")
    spans = record.get("phoneme_alignment")
    if status == "reviewed" and (not isinstance(spans, list) or not spans):
        raise ManifestError(f"line {line_number}: reviewed alignment requires phoneme_alignment")
    if spans is None:
        return
    if not isinstance(spans, list) or len(spans) > 20000:
        raise ManifestError(f"line {line_number}: phoneme_alignment must be a bounded list")
    previous_end = 0.0
    for index, span in enumerate(spans):
        if not isinstance(span, dict) or not isinstance(span.get("phoneme"), str) or not span["phoneme"].strip():
            raise ManifestError(f"line {line_number}: invalid phoneme span {index}")
        start, end = span.get("start_seconds"), span.get("end_seconds")
        if (isinstance(start, bool) or isinstance(end, bool)
                or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                or not math.isfinite(start) or not math.isfinite(end)
                or start < previous_end or end <= start or end > duration + 0.02):
            raise ManifestError(f"line {line_number}: phoneme spans must be ordered, non-overlapping, and within audio")
        previous_end = end


def validate_manifest(manifest_path: str | Path, dataset_root: str | Path | None = None) -> dict:
    """Validate JSONL metadata, rights declarations, speaker splits, and WAV headers."""
    path = Path(manifest_path).resolve()
    root = Path(dataset_root).resolve() if dataset_root else path.parent.resolve()
    if not path.is_file():
        raise ManifestError("manifest file does not exist")
    if path.stat().st_size > 20 * 1024 * 1024:
        raise ManifestError("manifest exceeds the 20 MiB limit")

    seen_ids: set[str] = set()
    speaker_splits: dict[str, set[str]] = defaultdict(set)
    totals = defaultdict(int)
    sample_rates = set()

    with path.open("r", encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise ManifestError(f"line {line_number}: invalid JSON") from exc
            if not isinstance(record, dict):
                raise ManifestError(f"line {line_number}: each record must be a JSON object")
            missing = REQUIRED_FIELDS - record.keys()
            if missing:
                raise ManifestError(f"line {line_number}: missing fields: {', '.join(sorted(missing))}")

            recording_id = record["recording_id"]
            speaker_id = record["speaker_id"]
            if not isinstance(recording_id, str) or not recording_id.strip() or len(recording_id) > 160:
                raise ManifestError(f"line {line_number}: invalid recording_id")
            if recording_id in seen_ids:
                raise ManifestError(f"line {line_number}: duplicate recording_id")
            seen_ids.add(recording_id)
            if not isinstance(speaker_id, str) or not speaker_id.strip() or len(speaker_id) > 160:
                raise ManifestError(f"line {line_number}: invalid speaker_id")
            if not isinstance(record["split"], str) or record["split"] not in ALLOWED_SPLITS:
                raise ManifestError(f"line {line_number}: split must be train, validation, or test")
            if not isinstance(record["language"], str) or not record["language"].strip():
                raise ManifestError(f"line {line_number}: language is required")
            if not isinstance(record["transcript"], str) or not record["transcript"].strip() or len(record["transcript"]) > 20000:
                raise ManifestError(f"line {line_number}: transcript must contain 1 to 20,000 characters")
            if record["consent_confirmed"] is not True:
                raise ManifestError(f"line {line_number}: explicit performer consent is required")
            if not isinstance(record["rights_basis"], str) or not record["rights_basis"].strip() or len(record["rights_basis"]) > 500:
                raise ManifestError(f"line {line_number}: rights_basis must identify the license or ownership basis")

            audio_path = _safe_audio_path(root, record["audio_path"])
            try:
                with wave.open(str(audio_path), "rb") as audio:
                    channels = audio.getnchannels()
                    rate = audio.getframerate()
                    frames = audio.getnframes()
                    width = audio.getsampwidth()
                    compression = audio.getcomptype()
            except (wave.Error, EOFError) as exc:
                raise ManifestError(f"line {line_number}: audio must be a readable PCM WAV") from exc
            duration = frames / rate if rate else 0
            if compression != "NONE" or width not in ALLOWED_SAMPLE_WIDTHS or channels not in (1, 2):
                raise ManifestError(f"line {line_number}: WAV must be uncompressed 16/24/32-bit mono or stereo PCM")
            if rate < 16000 or rate > 96000 or frames <= 0:
                raise ManifestError(f"line {line_number}: unsupported sample rate or empty audio")
            if record["sample_rate"] != rate or record["channels"] != channels:
                raise ManifestError(f"line {line_number}: declared audio format does not match WAV header")
            declared_duration = record["duration_seconds"]
            if (isinstance(declared_duration, bool) or not isinstance(declared_duration, (int, float))
                    or not math.isfinite(declared_duration) or abs(declared_duration - duration) > 0.05):
                raise ManifestError(f"line {line_number}: declared duration does not match WAV header")

            _validate_alignment(record, duration, line_number)
            speaker_splits[speaker_id].add(record["split"])
            totals[record["split"]] += 1
            sample_rates.add(rate)

    if not seen_ids:
        raise ManifestError("manifest contains no recording records")
    leakage = sorted(speaker for speaker, splits in speaker_splits.items() if len(splits) > 1)
    if leakage:
        raise ManifestError("speaker leakage across dataset splits: " + ", ".join(leakage[:10]))

    return {
        "valid": True,
        "recording_count": len(seen_ids),
        "speaker_count": len(speaker_splits),
        "split_counts": {split: totals[split] for split in sorted(ALLOWED_SPLITS)},
        "sample_rates": sorted(sample_rates),
        "speaker_split_leakage": False,
        "audio_uploaded": False,
        "training_started": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a MEHRAN SVS JSONL training manifest.")
    parser.add_argument("manifest", help="Path to the JSONL manifest")
    parser.add_argument("--audio-root", help="Root directory for relative audio_path entries")
    args = parser.parse_args()
    try:
        result = validate_manifest(args.manifest, args.audio_root)
    except ManifestError as exc:
        parser.exit(2, f"INVALID: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
