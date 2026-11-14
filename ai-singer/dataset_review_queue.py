"""Create a private, local CSV queue for human review of dataset annotations.

The queue intentionally contains identifying metadata and transcript text. It is
written only to a user-selected local path with owner-only permissions where
supported. It is never uploaded or printed to stdout.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import tempfile
from pathlib import Path

from dataset_manifest import ManifestError, validate_manifest


class ReviewQueueError(ValueError):
    """Raised when a local review queue cannot be created safely."""


FIELDS = (
    "recording_id", "speaker_id", "split", "audio_path", "transcript",
    "duration_seconds", "sample_rate", "channels", "alignment_status",
    "has_phoneme_alignment", "has_midi_notes", "phoneme_alignment_json",
    "notes_json", "review_decision",
)


def _safe_output(path: str | Path, audio_root: str | Path) -> Path:
    raw = Path(path).expanduser()
    absolute = raw if raw.is_absolute() else Path.cwd() / raw
    if absolute.name in {"", ".", ".."}:
        raise ReviewQueueError("output must name a CSV file")
    for parent in (absolute.parent, *absolute.parent.parents):
        if parent.exists() and parent.is_symlink():
            raise ReviewQueueError("output parent symlinks are not allowed")
    try:
        parent = absolute.parent.resolve(strict=True)
        root = Path(audio_root).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ReviewQueueError("output directory or audio root is unavailable") from exc
    output = parent / absolute.name
    if output.is_symlink() or (output.exists() and not output.is_file()):
        raise ReviewQueueError("output must be a regular non-symlink file")
    try:
        output.resolve(strict=False).relative_to(root)
    except ValueError:
        pass
    else:
        raise ReviewQueueError("review queue must be stored outside the audio dataset root")
    return output


def build_review_queue(
    manifest_path: str | Path,
    output_path: str | Path,
    *,
    audio_root: str | Path | None = None,
) -> dict:
    """Validate a manifest and atomically write a local annotation review CSV."""
    manifest = Path(manifest_path).expanduser()
    root = Path(audio_root).expanduser() if audio_root else manifest.parent
    if manifest.is_symlink() or root.is_symlink():
        raise ReviewQueueError("manifest and audio root symlinks are not allowed")
    try:
        validation = validate_manifest(manifest, root)
    except ManifestError as exc:
        raise ReviewQueueError(
            "manifest validation failed; private dataset details are withheld"
        ) from exc
    output = _safe_output(output_path, root)

    rows = []
    try:
        with manifest.open("r", encoding="utf-8") as source:
            for raw in source:
                if not raw.strip():
                    continue
                record = json.loads(raw)
                if record.get("alignment_status") not in {"unreviewed", "needs_review"}:
                    continue
                rows.append({
                    "recording_id": record["recording_id"],
                    "speaker_id": record["speaker_id"],
                    "split": record["split"],
                    "audio_path": record["audio_path"],
                    "transcript": record["transcript"],
                    "duration_seconds": record["duration_seconds"],
                    "sample_rate": record["sample_rate"],
                    "channels": record["channels"],
                    "alignment_status": record["alignment_status"],
                    "has_phoneme_alignment": bool(record.get("phoneme_alignment")),
                    "has_midi_notes": bool(record.get("notes")),
                    "phoneme_alignment_json": json.dumps(record.get("phoneme_alignment", []), ensure_ascii=False),
                    "notes_json": json.dumps(record.get("notes", []), ensure_ascii=False),
                    "review_decision": "pending",
                })
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ReviewQueueError(
            "manifest could not be read consistently; private details are withheld"
        ) from exc

    rows.sort(key=lambda item: (item["split"], item["recording_id"]))
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline="", dir=output.parent,
            prefix=output.name + ".", suffix=".tmp", delete=False,
        ) as target:
            temp_path = Path(target.name)
            writer = csv.DictWriter(target, fieldnames=FIELDS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
            target.flush()
            os.fsync(target.fileno())
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        os.replace(temp_path, output)
        temp_path = None
        try:
            os.chmod(output, 0o600)
        except OSError:
            pass
    except OSError as exc:
        raise ReviewQueueError("local review queue could not be written") from exc
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    return {
        "valid": True,
        "manifest_recordings": validation["recording_count"],
        "review_queue_recordings": len(rows),
        "output_written": True,
        "local_only": True,
        "uploaded": False,
        "file_permissions": "owner-only where supported",
        "contains_private_metadata": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a private local CSV queue for unreviewed MEHRAN dataset annotations."
    )
    parser.add_argument("manifest", help="Path to the local JSONL manifest")
    parser.add_argument("--audio-root", help="Root directory for relative audio_path entries")
    parser.add_argument("--output", required=True, help="CSV destination outside the audio dataset root")
    args = parser.parse_args()
    try:
        report = build_review_queue(args.manifest, args.output, audio_root=args.audio_root)
    except ReviewQueueError as exc:
        parser.exit(2, f"INVALID: {exc}\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
