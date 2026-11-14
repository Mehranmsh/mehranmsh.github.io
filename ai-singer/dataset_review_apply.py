"""Apply human-reviewed Persian phoneme/MIDI annotations to a local JSONL manifest.

The CSV queue and manifest contain private metadata. This tool is local-only,
validates the complete candidate manifest, and atomically replaces the manifest.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import tempfile
from pathlib import Path

from dataset_manifest import ManifestError, validate_manifest
from studio_dataset_export import StudioDatasetExportError, _manifest_write_lock


class ReviewApplyError(ValueError):
    """Raised when a review queue cannot safely update a manifest."""


IMMUTABLE_FIELDS = ("recording_id", "speaker_id", "split", "audio_path", "transcript")
MAX_REVIEW_CSV_BYTES = 20 * 1024 * 1024
MAX_REVIEW_ROWS = 50000


def apply_review_queue(
    manifest_path: str | Path,
    queue_path: str | Path,
    *,
    audio_root: str | Path | None = None,
) -> dict:
    manifest = Path(manifest_path).expanduser()
    queue = Path(queue_path).expanduser()
    root = Path(audio_root).expanduser() if audio_root else manifest.parent
    if manifest.is_symlink() or queue.is_symlink() or root.is_symlink():
        raise ReviewApplyError("manifest, review queue, and audio root symlinks are not allowed")
    if not manifest.is_file() or not queue.is_file():
        raise ReviewApplyError("manifest and review queue must be existing regular files")
    if queue.stat().st_size > MAX_REVIEW_CSV_BYTES:
        raise ReviewApplyError("review queue exceeds the 20 MiB limit")
    if manifest.resolve() == queue.resolve():
        raise ReviewApplyError("review queue must be separate from the manifest")

    try:
        with queue.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.DictReader(source)
            required = set(IMMUTABLE_FIELDS) | {
                "review_decision", "phoneme_alignment_json", "notes_json"
            }
            if not reader.fieldnames or not required.issubset(reader.fieldnames):
                raise ReviewApplyError("review queue columns are incomplete")
            reviews = {}
            for row in reader:
                if len(reviews) >= MAX_REVIEW_ROWS:
                    raise ReviewApplyError("review queue has too many rows")
                recording_id = row.get("recording_id", "")
                if not recording_id or recording_id in reviews:
                    raise ReviewApplyError("review queue contains an empty or duplicate recording ID")
                decision = row.get("review_decision", "").strip().lower()
                if decision not in {"pending", "approved", "rejected"}:
                    raise ReviewApplyError("review decision must be pending, approved, or rejected")
                reviews[recording_id] = row
    except (OSError, UnicodeError, csv.Error) as exc:
        raise ReviewApplyError("review queue could not be read safely") from exc

    if not reviews:
        return {"valid": True, "approved_updates": 0, "pending_or_rejected": 0,
                "manifest_updated": False, "local_only": True, "uploaded": False}

    manifest_path_resolved = manifest.resolve(strict=True)
    if manifest_path_resolved.is_symlink():
        raise ReviewApplyError("manifest symlinks are not allowed")

    approved = 0
    pending = 0
    output_temp = None
    with _manifest_write_lock(manifest_path_resolved):
        try:
            records = []
            with manifest_path_resolved.open("r", encoding="utf-8") as source:
                for line in source:
                    if line.strip():
                        record = json.loads(line)
                        records.append(record)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ReviewApplyError("manifest could not be read consistently") from exc

        known = {record.get("recording_id"): record for record in records}
        if len(known) != len(records):
            raise ReviewApplyError("manifest contains duplicate or missing recording IDs")
        if set(reviews) - set(known):
            raise ReviewApplyError("review queue contains records not present in the manifest")

        for recording_id, row in reviews.items():
            record = known[recording_id]
            if any(row.get(field, "") != str(record.get(field, "")) for field in IMMUTABLE_FIELDS):
                raise ReviewApplyError("review queue metadata does not match the current manifest")
            if row["review_decision"].strip().lower() != "approved":
                pending += 1
                continue
            if record.get("alignment_status") == "reviewed":
                raise ReviewApplyError("review queue cannot overwrite an already reviewed recording")
            try:
                spans = json.loads(row["phoneme_alignment_json"])
                notes = json.loads(row["notes_json"])
            except (TypeError, json.JSONDecodeError) as exc:
                raise ReviewApplyError("approved annotation JSON is malformed") from exc
            if not isinstance(spans, list) or not spans or not isinstance(notes, list) or not notes:
                raise ReviewApplyError("approved reviews require non-empty phoneme and MIDI arrays")
            record["phoneme_alignment"] = spans
            record["notes"] = notes
            record["alignment_status"] = "reviewed"
            approved += 1

        if approved == 0:
            return {"valid": True, "approved_updates": 0, "pending_or_rejected": pending,
                    "manifest_updated": False, "local_only": True, "uploaded": False}

        try:
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", newline="\n", dir=manifest_path_resolved.parent,
                prefix=manifest_path_resolved.name + ".", suffix=".tmp", delete=False,
            ) as target:
                output_temp = Path(target.name)
                for record in records:
                    target.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\\n")
                target.flush()
                os.fsync(target.fileno())
            try:
                validate_manifest(output_temp, root)
            except ManifestError as exc:
                raise ReviewApplyError("reviewed annotations failed manifest validation") from exc
            os.replace(output_temp, manifest_path_resolved)
            output_temp = None
        except OSError as exc:
            raise ReviewApplyError("validated manifest could not be replaced atomically") from exc
        finally:
            if output_temp is not None:
                try:
                    output_temp.unlink(missing_ok=True)
                except OSError:
                    pass

    return {
        "valid": True,
        "approved_updates": approved,
        "pending_or_rejected": pending,
        "manifest_updated": True,
        "local_only": True,
        "uploaded": False,
        "training_started": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply approved local Persian annotation reviews to a MEHRAN dataset manifest."
    )
    parser.add_argument("manifest", help="Local JSONL manifest")
    parser.add_argument("review_queue", help="CSV produced by dataset_review_queue.py")
    parser.add_argument("--audio-root", help="Dataset root for referenced WAV files")
    args = parser.parse_args()
    try:
        result = apply_review_queue(args.manifest, args.review_queue, audio_root=args.audio_root)
    except (ReviewApplyError, StudioDatasetExportError) as exc:
        parser.exit(2, f"INVALID: {exc}\\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
