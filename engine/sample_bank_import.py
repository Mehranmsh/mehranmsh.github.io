"""Build a validated MEHRAN sample-bank manifest from a completed recording CSV.

The importer never moves, edits, normalizes, or synthesizes audio files. It only
writes bank.json after every selected recording has passed WAV validation.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

from sample_bank import load_sample_bank


def _safe_relative_audio_path(root: Path, value: str) -> tuple[Path, str]:
    if not value or "\\x00" in value:
        raise ValueError("Recorded file path must be non-empty")
    candidate = (root / value).resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        raise ValueError("Recorded file path must remain inside the audio folder")
    if not candidate.is_file() or candidate.suffix.lower() != ".wav":
        raise ValueError(f"Recorded WAV file is missing or not a .wav: {value}")
    return candidate, candidate.relative_to(root).as_posix()


def build_sample_bank_manifest(
    recording_csv: str | Path,
    audio_root: str | Path,
    output_path: str | Path | None = None,
) -> dict[str, Any]:
    """Create bank.json from rows explicitly marked recorded in a capture sheet."""
    csv_path = Path(recording_csv).resolve()
    root = Path(audio_root).resolve()
    if not root.is_dir():
        raise ValueError("Audio folder does not exist")
    destination = Path(output_path).resolve() if output_path else root / "bank.json"
    if not destination.is_relative_to(root):
        raise ValueError("Manifest output must be inside the audio folder")
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise ValueError("Recording CSV must include a header row")
            fields = set(reader.fieldnames)
            status_field = "recording_status" if "recording_status" in fields else "status"
            path_field = "recorded_file_path" if "recorded_file_path" in fields else "sample_path"
            required = {"instrument", "midi_note", "velocity_min", "velocity_max", "articulation"}
            if not required.issubset(fields) or status_field not in fields or path_field not in fields:
                raise ValueError("CSV must contain instrument, midi_note, velocity_min, velocity_max, articulation, status and recorded file path columns")
            entries = []
            seen = set()
            skipped = 0
            for row_number, row in enumerate(reader, start=2):
                status = (row.get(status_field) or "").strip().lower()
                if status not in {"recorded", "complete", "done"}:
                    skipped += 1
                    continue
                instrument = (row.get("instrument") or "").strip()
                articulation = (row.get("articulation") or "sustain").strip()
                if not re.fullmatch(r"[a-z][a-z0-9_-]{1,39}", instrument):
                    raise ValueError(f"Row {row_number}: invalid instrument slug")
                if not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", articulation):
                    raise ValueError(f"Row {row_number}: invalid articulation slug")
                try:
                    note = int(row["midi_note"])
                    velocity_min = int(row["velocity_min"])
                    velocity_max = int(row["velocity_max"])
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"Row {row_number}: note and velocity fields must be integers") from exc
                if not 0 <= note <= 127 or not 1 <= velocity_min <= velocity_max <= 127:
                    raise ValueError(f"Row {row_number}: note or velocity range is outside MIDI limits")
                identity = (instrument, note, velocity_min, velocity_max, articulation)
                if identity in seen:
                    raise ValueError(f"Row {row_number}: duplicate instrument/note/velocity/articulation target")
                seen.add(identity)
                _, relative = _safe_relative_audio_path(root, (row.get(path_field) or "").strip())
                entries.append({
                    "instrument": instrument,
                    "midi_note": note,
                    "velocity_min": velocity_min,
                    "velocity_max": velocity_max,
                    "articulation": articulation,
                    "path": relative,
                })
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise ValueError("Could not read a valid UTF-8 recording CSV") from exc

    if not entries:
        raise ValueError("No completed recording rows were found in the CSV")
    manifest = {"format_version": 1, "samples": entries}
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=".bank-", suffix=".json.tmp", dir=destination.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
            handle.write("\\n")
        # Validate every WAV and manifest reference before publishing bank.json.
        load_sample_bank_from_manifest(root, Path(temporary_name))
        os.replace(temporary_name, destination)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise
    return {
        "manifest_path": str(destination),
        "imported_samples": len(entries),
        "skipped_rows": skipped,
        "audio_files_modified": False,
        "validated": True,
    }


def load_sample_bank_from_manifest(root: Path, manifest_path: Path):
    """Validate staged metadata against the original audio files without replacing bank.json."""
    return load_sample_bank(root, manifest_path=manifest_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import completed WAV recordings from a MEHRAN capture CSV.")
    parser.add_argument("recording_csv", type=Path)
    parser.add_argument("audio_root", type=Path)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)
    try:
        report = build_sample_bank_manifest(args.recording_csv, args.audio_root, args.output)
    except (OSError, ValueError) as exc:
        print(json.dumps({"validated": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
