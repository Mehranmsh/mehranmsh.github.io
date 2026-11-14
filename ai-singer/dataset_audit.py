"""Privacy-preserving local audit for the MEHRAN Persian singing dataset.

Only aggregate statistics are emitted. Recording IDs, speaker IDs, transcripts,
audio paths, and rights text are never included in the report.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from dataset_manifest import ALLOWED_SPLITS, ManifestError, validate_manifest
from speaker_reference import SpeakerReferenceError, build_speaker_reference_map
from annotation_quality import AnnotationQualityError, summarize_annotation_quality


class DatasetAuditError(ValueError):
    """Raised when the local dataset cannot be audited safely."""


def _read_jsonl(path: Path) -> list[dict]:
    records = []
    try:
        with path.open("r", encoding="utf-8") as source:
            for raw in source:
                if raw.strip():
                    value = json.loads(raw)
                    if not isinstance(value, dict):
                        raise DatasetAuditError("manifest contains a non-object record")
                    records.append(value)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DatasetAuditError("manifest could not be read as valid UTF-8 JSONL") from exc
    return records


def audit_dataset(
    manifest_path: str | Path,
    dataset_root: str | Path | None = None,
    *,
    expected_sample_rate: int = 48000,
    minimum_phoneme_coverage: float | None = None,
    minimum_vowel_note_coverage: float | None = None,
    maximum_internal_gap_seconds: float | None = None,
) -> dict:
    """Validate local data and return privacy-safe readiness aggregates."""
    if isinstance(expected_sample_rate, bool) or not isinstance(expected_sample_rate, int) or expected_sample_rate <= 0:
        raise DatasetAuditError("expected_sample_rate must be a positive integer")

    raw_manifest = Path(manifest_path).expanduser()
    raw_root = Path(dataset_root).expanduser() if dataset_root else raw_manifest.parent
    if raw_manifest.is_symlink() or raw_root.is_symlink():
        raise DatasetAuditError("manifest and dataset root symlinks are not allowed")
    manifest = raw_manifest.resolve()
    root = raw_root.resolve()
    try:
        validation = validate_manifest(manifest, root)
    except ManifestError as exc:
        # Do not echo paths, IDs, transcripts, or other local metadata to stdout.
        raise DatasetAuditError("manifest validation failed; details withheld to protect local dataset metadata") from exc

    records = _read_jsonl(manifest)
    by_split: dict[str, list[dict]] = {split: [] for split in sorted(ALLOWED_SPLITS)}
    speakers: dict[str, set[str]] = {split: set() for split in ALLOWED_SPLITS}
    durations = {split: 0.0 for split in ALLOWED_SPLITS}
    rates: dict[str, set[int]] = {split: set() for split in ALLOWED_SPLITS}
    targets = {split: [] for split in ALLOWED_SPLITS}
    reference_only = {split: 0 for split in ALLOWED_SPLITS}
    reviewed = {split: 0 for split in ALLOWED_SPLITS}
    phoneme_aligned = {split: 0 for split in ALLOWED_SPLITS}
    midi_annotated = {split: 0 for split in ALLOWED_SPLITS}

    for record in records:
        split = record["split"]
        by_split[split].append(record)
        speakers[split].add(record["speaker_id"])
        durations[split] += float(record["duration_seconds"])
        rates[split].add(int(record["sample_rate"]))
        if record.get("speaker_reference_only") is True:
            reference_only[split] += 1
            continue
        targets[split].append(record)
        if record.get("alignment_status") == "reviewed":
            reviewed[split] += 1
            if isinstance(record.get("phoneme_alignment"), list) and record["phoneme_alignment"]:
                phoneme_aligned[split] += 1
        if isinstance(record.get("notes"), list) and record["notes"]:
            midi_annotated[split] += 1

    reference_pairs = {}
    reference_warnings = []
    for split in ("train", "validation", "test"):
        split_targets = targets[split]
        has_any_reference = any("speaker_reference_recording_id" in item for item in split_targets)
        if not split_targets:
            reference_pairs[split] = 0
            continue
        if not has_any_reference:
            reference_pairs[split] = 0
            if split in {"train", "validation"}:
                reference_warnings.append(f"{split}: separate speaker references are not configured")
            continue
        try:
            mapping = build_speaker_reference_map(records, split)
        except SpeakerReferenceError as exc:
            raise DatasetAuditError(
                f"speaker reference validation failed for {split}; details withheld to protect local metadata"
            ) from exc
        reference_pairs[split] = len(mapping)

    split_report = {}
    annotation_warnings = []
    for split in ("train", "validation", "test"):
        eligible_annotations = [
            record for record in targets[split]
            if record.get("alignment_status") == "reviewed"
            and isinstance(record.get("phoneme_alignment"), list)
            and isinstance(record.get("notes"), list)
            and record.get("phoneme_alignment") and record.get("notes")
        ]
        try:
            annotation_summary = summarize_annotation_quality(
                eligible_annotations,
                minimum_phoneme_coverage=minimum_phoneme_coverage,
                minimum_vowel_note_coverage=minimum_vowel_note_coverage,
                maximum_internal_gap_seconds=maximum_internal_gap_seconds,
            )
        except AnnotationQualityError as exc:
            raise DatasetAuditError("annotation quality analysis failed; details withheld") from exc
        for item in annotation_summary["warnings"]:
            annotation_warnings.append({
                "split": split, "code": item["code"], "recordings": item["recordings"],
            })
        split_report[split] = {
            "recordings": len(by_split[split]),
            "training_targets": len(targets[split]),
            "speaker_reference_only": reference_only[split],
            "unique_speakers": len(speakers[split]),
            "total_audio_hours": round(durations[split] / 3600.0, 4),
            "sample_rates": sorted(rates[split]),
            "reviewed_alignments": reviewed[split],
            "phoneme_aligned_targets": phoneme_aligned[split],
            "midi_annotated_targets": midi_annotated[split],
            "speaker_reference_pairs": reference_pairs[split],
            "annotation_quality": annotation_summary,
        }

    warnings = list(reference_warnings)
    blockers = list(reference_warnings)
    for item in annotation_warnings:
        message = f'{item["split"]}: {item["recordings"]} recordings flagged by {item["code"]}'
        warnings.append(message)
        if item["split"] in {"train", "validation"}:
            blockers.append(message)

    if not targets["train"]:
        message = "train: no target recordings"
        warnings.append(message)
        blockers.append(message)
    if not targets["validation"]:
        message = "validation: no target recordings"
        warnings.append(message)
        blockers.append(message)
    for split in ("train", "validation"):
        count = len(targets[split])
        checks = (
            (count and reviewed[split] != count,
             f"{split}: some targets do not have reviewed phoneme alignment"),
            (count and midi_annotated[split] != count,
             f"{split}: some targets do not have reviewed MIDI note annotations"),
            (count and any(record["channels"] != 1 for record in targets[split]),
             f"{split}: stereo targets are incompatible with the current training loader"),
            (count and any(record["sample_rate"] != expected_sample_rate for record in targets[split]),
             f"{split}: target sample rate differs from the configured model rate"),
        )
        for failed, message in checks:
            if failed:
                warnings.append(message)
                blockers.append(message)
        if count and reference_pairs[split] != count:
            if not any(item.startswith(f"{split}: separate speaker references") for item in warnings):
                message = f"{split}: not every target has a valid separate speaker reference"
                warnings.append(message)
                blockers.append(message)

    ready = bool(targets["train"] and targets["validation"] and not blockers)
    next_steps = []
    if not targets["train"]:
        next_steps.append("Add consented Persian target recordings to the train split.")
    if not targets["validation"]:
        next_steps.append("Add a speaker-disjoint validation split with consented target recordings.")
    if any("speaker reference" in item or "references are not configured" in item for item in blockers):
        next_steps.append("Add a valid separate speaker-reference recording for every train and validation target.")
    if any("phoneme alignment" in item or "flagged by" in item for item in blockers):
        next_steps.append("Review Persian phoneme alignment and resolve any configured annotation-quality warnings.")
    if any("MIDI note annotations" in item for item in blockers):
        next_steps.append("Complete and review monophonic MIDI note annotations for every training target.")
    if any("stereo targets" in item for item in blockers):
        next_steps.append("Convert training targets to mono PCM WAV.")
    if any("sample rate" in item for item in blockers):
        next_steps.append(f"Convert training targets to the configured {expected_sample_rate} Hz sample rate.")
    if not targets["test"] or reference_pairs["test"] != len(targets["test"]):
        evaluation_next_step = "Create a separate held-out test split with valid speaker references before claiming evaluation readiness."
    else:
        evaluation_next_step = None
    return {
        "valid": True,
        "privacy": {
            "aggregate_only": True,
            "speaker_ids_emitted": False,
            "recording_ids_emitted": False,
            "transcripts_emitted": False,
            "audio_paths_emitted": False,
            "audio_uploaded": False,
        },
        "manifest": {
            "recordings": validation["recording_count"],
            "unique_speakers": validation["speaker_count"],
            "speaker_split_leakage": False,
            "expected_sample_rate": expected_sample_rate,
        },
        "splits": split_report,
        "training_readiness": {
            "ready_for_staged_training": ready,
            "blockers": blockers,
            "warnings": warnings,
            "recommended_next_steps": next_steps,
            "training_started": False,
            "model_weights_created": False,
        },
        "evaluation_readiness": {
            "test_target_recordings": len(targets["test"]),
            "held_out_test_split_available": bool(
                targets["test"] and reference_pairs["test"] == len(targets["test"])
            ),
            "recommended_next_step": evaluation_next_step,
            "evaluation_started": False,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit a local MEHRAN Persian singing dataset; emits aggregate statistics only."
    )
    parser.add_argument("manifest", help="Path to the local JSONL manifest")
    parser.add_argument("--audio-root", help="Root directory for relative audio_path entries")
    parser.add_argument("--sample-rate", type=int, default=48000, help="Expected model sample rate (default: 48000)")
    parser.add_argument("--minimum-phoneme-coverage", type=float, help="Optional warning threshold from 0 to 1; no default cutoff")
    parser.add_argument("--minimum-vowel-note-coverage", type=float, help="Optional warning threshold from 0 to 1; no default cutoff")
    parser.add_argument("--maximum-internal-gap-seconds", type=float, help="Optional warning threshold; rests are not errors unless this is set")
    args = parser.parse_args()
    try:
        result = audit_dataset(
            args.manifest, args.audio_root, expected_sample_rate=args.sample_rate,
            minimum_phoneme_coverage=args.minimum_phoneme_coverage,
            minimum_vowel_note_coverage=args.minimum_vowel_note_coverage,
            maximum_internal_gap_seconds=args.maximum_internal_gap_seconds,
        )
    except DatasetAuditError as exc:
        parser.exit(2, f"INVALID: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
