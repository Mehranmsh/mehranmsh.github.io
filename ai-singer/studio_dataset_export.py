"""Build a local JSONL training-manifest record from a reviewed MEHRAN studio export.

Only metadata is written. Audio remains in the user's local dataset directory.
No upload, training, inference, or synthesis is performed.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
import wave
from pathlib import Path, PurePosixPath

from dataset_manifest import MAX_AUDIO_FILE_BYTES, ManifestError, validate_manifest


EXPORT_SCHEMA = "mehran.svs.conditioning-export.v1"
CONDITIONING_SCHEMA = "mehran.svs.conditioning.v1"


class StudioDatasetExportError(ValueError):
    """Raised when a studio export cannot safely become a dataset record."""


def _safe_relative_audio(root: Path, audio_path: str) -> tuple[str, Path]:
    if not isinstance(audio_path, str) or not audio_path.strip():
        raise StudioDatasetExportError("audio_path must be a relative path inside the dataset root")
    relative = PurePosixPath(audio_path)
    if relative.is_absolute() or ".." in relative.parts or "\\" in audio_path:
        raise StudioDatasetExportError("audio_path must be a relative path without traversal")
    if root.is_symlink():
        raise StudioDatasetExportError("dataset root symlink is not allowed")
    resolved_root = root.expanduser().resolve(strict=True)
    current = resolved_root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise StudioDatasetExportError("audio_path must not traverse symlinks")
    try:
        resolved = current.resolve(strict=True)
        resolved.relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise StudioDatasetExportError("audio file is missing or outside dataset root") from exc
    if not resolved.is_file():
        raise StudioDatasetExportError("audio_path must identify a regular WAV file")
    return relative.as_posix(), resolved


def build_manifest_record(
    export: dict,
    *,
    dataset_root: str | Path,
    audio_path: str,
    recording_id: str,
    speaker_id: str,
    split: str,
    transcript: str,
    consent_confirmed: bool,
    rights_basis: str,
) -> dict:
    """Convert one reviewed conditioning export to the strict dataset manifest shape."""
    if not isinstance(export, dict) or export.get("schema") != EXPORT_SCHEMA:
        raise StudioDatasetExportError("unsupported studio conditioning export schema")
    if export.get("review_required") is not True:
        raise StudioDatasetExportError("studio export must retain review_required=true")
    if export.get("accepted_for_inference") is not False or export.get("audio_generated") is not False:
        raise StudioDatasetExportError("only non-inference conditioning exports are accepted")
    conditioning = export.get("conditioning")
    if not isinstance(conditioning, dict) or conditioning.get("schema_version") != CONDITIONING_SCHEMA:
        raise StudioDatasetExportError("missing or unsupported acoustic conditioning payload")
    if conditioning.get("language") != "fa":
        raise StudioDatasetExportError("the first training dataset builder accepts Persian (fa) only")
    if split not in {"train", "validation", "test"}:
        raise StudioDatasetExportError("split must be train, validation, or test")
    for label, value, limit in (
        ("recording_id", recording_id, 160),
        ("speaker_id", speaker_id, 160),
        ("transcript", transcript, 20000),
        ("rights_basis", rights_basis, 500),
    ):
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise StudioDatasetExportError(f"{label} must contain 1 to {limit} characters")
    if consent_confirmed is not True:
        raise StudioDatasetExportError("explicit performer consent is required")
    if not isinstance(conditioning.get("phonemes"), list) or not conditioning["phonemes"]:
        raise StudioDatasetExportError("reviewed phoneme timing is required")
    if not isinstance(conditioning.get("notes"), list) or not conditioning["notes"]:
        raise StudioDatasetExportError("reviewed monophonic MIDI notes are required")

    relative_audio, resolved_audio = _safe_relative_audio(Path(dataset_root), audio_path)
    if resolved_audio.stat().st_size <= 0 or resolved_audio.stat().st_size > MAX_AUDIO_FILE_BYTES:
        raise StudioDatasetExportError("WAV file size exceeds the 500 MiB dataset limit")
    try:
        with wave.open(str(resolved_audio), "rb") as wav:
            channels = wav.getnchannels()
            sample_rate = wav.getframerate()
            frames = wav.getnframes()
            width = wav.getsampwidth()
            compression = wav.getcomptype()
    except (wave.Error, EOFError) as exc:
        raise StudioDatasetExportError("audio must be a readable PCM WAV file") from exc
    if compression != "NONE" or width not in {2, 3, 4} or channels != 1:
        raise StudioDatasetExportError("WAV must be uncompressed 16/24/32-bit mono PCM; stereo is not supported by the current training frontend")
    if sample_rate not in {22050, 24000, 44100, 48000} or frames <= 0:
        raise StudioDatasetExportError("unsupported WAV sample rate or empty audio")
    declared_sample_rate = conditioning.get("sample_rate")
    if isinstance(declared_sample_rate, bool) or declared_sample_rate != sample_rate:
        raise StudioDatasetExportError("conditioning sample_rate does not match the selected WAV")
    actual_duration = frames / sample_rate
    declared_duration = conditioning.get("duration_seconds")
    if (isinstance(declared_duration, bool) or not isinstance(declared_duration, (int, float))
            or not math.isfinite(declared_duration) or abs(declared_duration - actual_duration) > 0.05):
        raise StudioDatasetExportError("conditioning duration does not match the selected WAV")

    return {
        "recording_id": recording_id,
        "audio_path": relative_audio,
        "language": "Persian",
        "speaker_id": speaker_id,
        "split": split,
        "transcript": transcript,
        "sample_rate": sample_rate,
        "channels": channels,
        "duration_seconds": actual_duration,
        "consent_confirmed": True,
        "rights_basis": rights_basis.strip(),
        "alignment_status": "reviewed",
        "phoneme_alignment": conditioning["phonemes"],
        "notes": conditioning["notes"],
        "style": conditioning.get("style", {}),
    }


def append_manifest_record(
    output_path: str | Path,
    record: dict,
    *,
    dataset_root: str | Path,
) -> dict:
    """Atomically append a record, validating the complete candidate manifest first."""
    output = Path(output_path).expanduser()
    if output.is_symlink():
        raise StudioDatasetExportError("manifest output symlink is not allowed")
    output.parent.mkdir(parents=True, exist_ok=True)
    existing = output.read_text(encoding="utf-8") if output.exists() else ""
    candidate = existing.rstrip("\n") + ("\n" if existing.strip() else "")
    candidate += json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline="\n", dir=output.parent,
            prefix=output.name + ".", suffix=".tmp", delete=False,
        ) as temp:
            temp.write(candidate)
            temp.flush()
            os.fsync(temp.fileno())
            temp_path = Path(temp.name)
        try:
            validate_manifest(temp_path, dataset_root)
        except ManifestError as exc:
            raise StudioDatasetExportError(str(exc)) from exc
        os.replace(temp_path, output)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    return {"manifest_path": str(output), "recording_count": len([line for line in candidate.splitlines() if line.strip()]), "audio_copied": False, "audio_uploaded": False, "training_started": False}


def main() -> int:
    parser = argparse.ArgumentParser(description="Add a reviewed MEHRAN studio export to a local Persian SVS dataset.")
    parser.add_argument("--export", required=True, help="Path to mehran-acoustic-conditioning.json")
    parser.add_argument("--dataset-root", required=True, help="Local dataset root containing the WAV")
    parser.add_argument("--audio-path", required=True, help="WAV path relative to --dataset-root")
    parser.add_argument("--output", required=True, help="JSONL manifest path")
    parser.add_argument("--recording-id", required=True)
    parser.add_argument("--speaker-id", required=True, help="Pseudonymous speaker ID, not a real name")
    parser.add_argument("--split", required=True, choices=("train", "validation", "test"))
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--rights-basis", required=True, help="Ownership/license and permission basis")
    parser.add_argument("--consent-confirmed", action="store_true", help="Explicitly confirm performer consent")
    args = parser.parse_args()
    try:
        export = json.loads(Path(args.export).read_text(encoding="utf-8"))
        record = build_manifest_record(
            export, dataset_root=args.dataset_root, audio_path=args.audio_path,
            recording_id=args.recording_id, speaker_id=args.speaker_id,
            split=args.split, transcript=args.transcript,
            consent_confirmed=args.consent_confirmed, rights_basis=args.rights_basis,
        )
        result = append_manifest_record(args.output, record, dataset_root=args.dataset_root)
    except (OSError, json.JSONDecodeError, StudioDatasetExportError) as exc:
        parser.exit(2, f"INVALID: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
