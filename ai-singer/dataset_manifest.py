"""Strict, privacy-conscious manifest validation for MEHRAN SVS training audio.

This module validates metadata and local WAV files only. It does not train a model,
upload recordings, or infer consent/rights from the presence of an audio file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import wave
from collections import defaultdict
from pathlib import Path, PurePosixPath

from phoneme_inventory import validate_phoneme_sequence


class ManifestError(ValueError):
    """Raised when a dataset manifest is unsafe or internally inconsistent."""


ALLOWED_SPLITS = {"train", "validation", "test"}
ALLOWED_ALIGNMENTS = {"reviewed", "unreviewed", "needs_review"}
ALLOWED_SAMPLE_WIDTHS = {2, 3, 4}
MAX_AUDIO_FILE_BYTES = 500 * 1024 * 1024
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
    if root.is_symlink():
        raise ManifestError("dataset root symlink is not allowed")
    resolved_root = root.resolve(strict=True)
    current = resolved_root
    for part in candidate.parts:
        current = current / part
        if current.is_symlink():
            raise ManifestError("audio_path must not traverse symlinks")
    try:
        resolved = current.resolve(strict=True)
        resolved.relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ManifestError("audio_path is missing or resolves outside the dataset root") from exc
    if not resolved.is_file():
        raise ManifestError(f"audio file does not exist: {value}")
    if resolved.stat().st_size <= 0 or resolved.stat().st_size > MAX_AUDIO_FILE_BYTES:
        raise ManifestError("audio file size is outside the permitted limit")
    return resolved


def _validate_alignment(record: dict, duration: float, line_number: int) -> None:
    status = record["alignment_status"]
    if not isinstance(status, str) or status not in ALLOWED_ALIGNMENTS:
        raise ManifestError(f"line {line_number}: unsupported alignment_status")
    spans = record.get("phoneme_alignment")
    if status == "reviewed" and (not isinstance(spans, list) or not spans):
        raise ManifestError(f"line {line_number}: reviewed alignment requires phoneme_alignment")
    if spans is None:
        _validate_syllable_alignment(record, duration, line_number)
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
    _validate_syllable_alignment(record, duration, line_number)
    try:
        validate_phoneme_sequence([span["phoneme"] for span in spans])
    except (TypeError, ValueError) as exc:
        raise ManifestError(f"line {line_number}: invalid Persian phoneme sequence: {exc}") from exc



def _validate_syllable_alignment(record: dict, duration: float, line_number: int) -> None:
    """Validate explicitly reviewed syllable-to-phoneme grouping; never infer syllables."""
    syllables = record.get("syllable_alignment")
    if syllables is None:
        return
    if record.get("alignment_status") != "reviewed":
        raise ManifestError(f"line {line_number}: syllable_alignment requires alignment_status='reviewed'")
    phonemes = record.get("phoneme_alignment")
    if not isinstance(phonemes, list) or not phonemes:
        raise ManifestError(f"line {line_number}: syllable_alignment requires phoneme_alignment")
    if not isinstance(syllables, list) or not syllables or len(syllables) > 20000:
        raise ManifestError(f"line {line_number}: syllable_alignment must be a non-empty bounded list")

    expected_phoneme_start = 0
    previous_syllable_end = 0.0
    for index, syllable in enumerate(syllables):
        if not isinstance(syllable, dict):
            raise ManifestError(f"line {line_number}: invalid syllable span {index}")
        label = syllable.get("text")
        start, end = syllable.get("start_seconds"), syllable.get("end_seconds")
        first = syllable.get("phoneme_start_index")
        stop = syllable.get("phoneme_end_index")
        if not isinstance(label, str) or not label.strip() or len(label) > 200:
            raise ManifestError(f"line {line_number}: syllable text must be a non-empty reviewed label")
        if (isinstance(start, bool) or isinstance(end, bool)
                or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                or not math.isfinite(start) or not math.isfinite(end)
                or start < previous_syllable_end or end <= start or end > duration + 0.02):
            raise ManifestError(f"line {line_number}: syllable spans must be ordered and within audio")
        if (isinstance(first, bool) or not isinstance(first, int)
                or isinstance(stop, bool) or not isinstance(stop, int)
                or first != expected_phoneme_start or stop <= first or stop > len(phonemes)):
            raise ManifestError(f"line {line_number}: syllables must partition phoneme indices in order")
        first_phoneme = phonemes[first]
        last_phoneme = phonemes[stop - 1]
        if (start > float(first_phoneme["start_seconds"]) + 0.02
                or end < float(last_phoneme["end_seconds"]) - 0.02):
            raise ManifestError(f"line {line_number}: syllable timing must cover its assigned phonemes")
        expected_phoneme_start = stop
        previous_syllable_end = float(end)

    if expected_phoneme_start != len(phonemes):
        raise ManifestError(f"line {line_number}: syllable alignment must assign every phoneme")



def _validate_notes(record: dict, duration: float, line_number: int) -> None:
    notes = record.get("notes")
    if record["alignment_status"] == "reviewed" and (not isinstance(notes, list) or not notes):
        raise ManifestError(f"line {line_number}: reviewed monophonic notes are required")
    if notes is None:
        return
    if not isinstance(notes, list) or len(notes) > 20000:
        raise ManifestError(f"line {line_number}: notes must be a bounded list")
    previous_start = -1.0
    previous_end = 0.0
    for index, note in enumerate(notes):
        if not isinstance(note, dict):
            raise ManifestError(f"line {line_number}: invalid MIDI note event {index}")
        midi = note.get("midi_note")
        velocity = note.get("velocity", 80)
        start = note.get("start_seconds")
        length = note.get("duration_seconds")
        if (isinstance(midi, bool) or not isinstance(midi, int) or not 0 <= midi <= 127
                or isinstance(velocity, bool) or not isinstance(velocity, int) or not 1 <= velocity <= 127
                or isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start)
                or isinstance(length, bool) or not isinstance(length, (int, float)) or not math.isfinite(length)
                or start < 0 or length <= 0 or length > 30
                or start < previous_start or start < previous_end - 1e-9
                or start + length > duration + 0.02):
            raise ManifestError(
                f"line {line_number}: MIDI notes must have valid pitch/velocity, ordered non-overlapping timing, and fit the audio"
            )
        previous_start = start
        previous_end = start + length

def validate_manifest(manifest_path: str | Path, dataset_root: str | Path | None = None) -> dict:
    """Validate JSONL metadata, rights declarations, speaker splits, and WAV headers."""
    raw_path = Path(manifest_path).expanduser()
    raw_root = Path(dataset_root).expanduser() if dataset_root else raw_path.parent
    if raw_path.is_symlink() or raw_root.is_symlink():
        raise ManifestError("manifest and dataset root symlinks are not allowed")
    path = raw_path.resolve()
    root = raw_root.resolve()
    if not path.is_file():
        raise ManifestError("manifest file does not exist")
    if path.stat().st_size > 20 * 1024 * 1024:
        raise ManifestError("manifest exceeds the 20 MiB limit")

    seen_ids: set[str] = set()
    seen_audio_paths: set[Path] = set()
    seen_audio_hashes: set[str] = set()
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
            if audio_path in seen_audio_paths:
                raise ManifestError(f"line {line_number}: audio file must not be reused by multiple records")
            seen_audio_paths.add(audio_path)
            digest = hashlib.sha256()
            try:
                with audio_path.open("rb") as audio_source:
                    for chunk in iter(lambda: audio_source.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError as exc:
                raise ManifestError(f"line {line_number}: audio file could not be fingerprinted") from exc
            audio_fingerprint = digest.hexdigest()
            if audio_fingerprint in seen_audio_hashes:
                raise ManifestError(f"line {line_number}: duplicate audio content detected")
            seen_audio_hashes.add(audio_fingerprint)
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
            _validate_notes(record, duration, line_number)
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
