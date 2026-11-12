"""Safely combine validated MEHRAN recorded instrument banks for local runtime use.

The installer copies only manifest-referenced WAV files into a fresh staging
directory, preserves source license/provenance, validates the combined bank,
and publishes it atomically. Existing destinations are never overwritten.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from sample_bank import load_sample_bank


EXPECTED_BANKS = {
    "nylon_guitar": ("Meta Nylon Guitar", "meta-nylon-guitar", "meta-nylon-guitar"),
    "acoustic_guitar": ("Meta Steel Guitar", "meta-steel-guitar", "meta-steel-guitar"),
    "piano": ("Meta Piano", "meta-piano", "meta_piano"),
}


def _source_license(root: Path) -> str:
    candidates = (
        root / "source" / "SOURCE_LICENSE.txt",
        root / "SOURCE_LICENSE.txt",
        root / "SOURCE_LICENSE_CC0.txt",
    )
    for candidate in candidates:
        if candidate.is_file():
            text = candidate.read_text(encoding="utf-8")
            if "CC0" not in text and "Creative Commons Zero" not in text:
                raise ValueError(f"Source license does not identify CC0: {candidate}")
            return text
    raise ValueError(f"Missing source license file in {root}")


def install_recorded_banks(
    bank_roots: list[str | Path],
    destination: str | Path,
) -> dict[str, Any]:
    """Install one or more validated CC0 Meta banks as a combined sample bank."""
    if not bank_roots:
        raise ValueError("At least one source bank is required")
    target = Path(destination).expanduser()
    if target.exists() or target.is_symlink():
        raise ValueError("Destination already exists; refusing to overwrite an installed bank")
    target.parent.mkdir(parents=True, exist_ok=True)
    parent = target.parent.resolve()
    target = parent / target.name
    if target.name in ("", ".", ".."):
        raise ValueError("Invalid installation destination")

    staged = Path(tempfile.mkdtemp(prefix=".mehran-bank-install-", dir=parent))
    combined_samples = []
    combined_sessions: dict[str, dict[str, str]] = {}
    source_records = []
    seen_instruments = set()
    try:
        for raw_root in bank_roots:
            source_root = Path(raw_root).expanduser().resolve(strict=True)
            if not source_root.is_dir():
                raise ValueError(f"Source bank is not a directory: {source_root}")
            bank = load_sample_bank(source_root)
            instruments = sorted({sample.instrument for sample in bank.samples})
            if len(instruments) != 1 or instruments[0] not in EXPECTED_BANKS:
                raise ValueError(f"Only validated Meta nylon/steel guitar banks are accepted: {source_root}")
            instrument = instruments[0]
            if instrument in seen_instruments:
                raise ValueError(f"Duplicate instrument bank supplied: {instrument}")
            seen_instruments.add(instrument)
            label, source_id, session_prefix = EXPECTED_BANKS[instrument]
            license_text = _source_license(source_root)
            session_ids = {sample.recording_session_id for sample in bank.samples}
            if None in session_ids or len(session_ids) != 1:
                raise ValueError(f"{instrument} samples must share one declared recording session")
            session_id = next(iter(session_ids))
            if not session_id.startswith(session_prefix):
                raise ValueError(f"Unexpected recording session provenance for {instrument}")
            license_dir = staged / "provenance" / instrument
            license_dir.mkdir(parents=True, exist_ok=True)
            (license_dir / "SOURCE_LICENSE.txt").write_text(license_text, encoding="utf-8")
            copied = 0
            for sample in bank.samples:
                relative = sample.path.relative_to(source_root)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unsafe sample path in validated source bank")
                destination_relative = Path(instrument) / relative
                output_path = staged / destination_relative
                output_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(sample.path, output_path)
                entry = {
                    "instrument": sample.instrument,
                    "midi_note": sample.midi_note,
                    "velocity_min": sample.velocity_min,
                    "velocity_max": sample.velocity_max,
                    "articulation": sample.articulation,
                    "string": sample.string_name,
                    "path": destination_relative.as_posix(),
                    "recording_session_id": session_id,
                }
                combined_samples.append(entry)
                copied += 1
            metadata = next(
                sample.recording_metadata for sample in bank.samples
                if sample.recording_metadata is not None
            )
            combined_sessions[session_id] = dict(metadata)
            source_records.append({
                "instrument": instrument,
                "label": label,
                "source_id": source_id,
                "license": "CC0 1.0 Universal",
                "source_sample_count": len(bank.samples),
                "copied_sample_count": copied,
                "source_root_name": source_root.name,
            })

        manifest = {
            "format_version": 1,
            "recording_sessions": combined_sessions,
            "sources": source_records,
            "samples": combined_samples,
        }
        manifest_path = staged / "bank.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        validated = load_sample_bank(staged)
        if len(validated.samples) != len(combined_samples):
            raise ValueError("Combined bank validation count mismatch")
        for sample in validated.samples:
            if sample.sample_rate != 48000 or sample.channels != 1:
                raise ValueError("Installed guitar samples must be mono PCM16 at 48 kHz")
        # A same-filesystem rename publishes the complete bank in one operation.
        os.replace(staged, target)
        return {
            "installed": True,
            "destination": str(target),
            "instrument_count": len(seen_instruments),
            "sample_count": len(validated.samples),
            "sources": source_records,
            "manifest_validated": True,
            "audio_files_modified": False,
        }
    except Exception:
        shutil.rmtree(staged, ignore_errors=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install validated recorded MEHRAN instrument banks.")
    parser.add_argument("destination", type=Path)
    parser.add_argument("bank_roots", nargs="+", type=Path)
    args = parser.parse_args(argv)
    try:
        report = install_recorded_banks(args.bank_roots, args.destination)
    except (OSError, ValueError) as exc:
        print(json.dumps({"installed": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
