"""Offline command-line validator for a recorded MEHRAN sample bank.

The validator is read-only. It never creates, moves, edits, or deletes audio files.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from pathlib import Path
from typing import Any

from sample_bank import (
    analyze_sample_bank_coverage,
    analyze_recording_provenance,
    analyze_sample_bank_instrument_health,
    analyze_sample_bank_quality,
    build_sample_recording_checklist,
    load_sample_bank,
)


def inspect_sample_bank(bank_root: str | Path) -> dict[str, Any]:
    """Return a machine-readable report for a validated on-disk sample bank."""
    bank = load_sample_bank(bank_root)
    coverage = analyze_sample_bank_coverage(bank)
    quality = analyze_sample_bank_quality(bank)
    health = analyze_sample_bank_instrument_health(bank, coverage, quality)
    provenance = analyze_recording_provenance(bank)
    ready = bool(coverage["ready"] and quality["basic_signal_checks_pass"])
    return {
        "read_only": True,
        "bank_root": str(Path(bank_root).resolve()),
        "ready": ready,
        "recorded_samples": len(bank.samples),
        "coverage": coverage,
        "quality": quality,
        "instrument_health": health,
        "recording_provenance": provenance,
        "summary": {
            "instrument_count": len(coverage["instruments"]),
            "required_targets": coverage["required_requirements"],
            "covered_targets": coverage["covered_requirements"],
            "missing_targets": coverage["required_requirements"] - coverage["covered_requirements"],
            "samples_with_warnings": quality["samples_with_warnings"],
        },
        "note": (
            "Ready means exact catalog note/velocity coverage and basic numerical WAV checks pass. "
            "It does not certify timbre, tuning, performance, loop audibility, or mix readiness."
        ),
    }



def export_sample_bank_progress_csv(bank_root: str | Path) -> str:
    """Export every catalog target as recorded or missing, using exact asset matching."""
    bank = load_sample_bank(bank_root)
    checklist = build_sample_recording_checklist()
    output = io.StringIO(newline="")
    columns = [
        "instrument", "instrument_label", "register_zone", "midi_note",
        "velocity_layer", "velocity_min", "velocity_max", "articulation",
        "status", "sample_path", "recording_session_id",
        "instrument_model", "instrument_serial", "performer", "tuning",
        "reference_frequency_hz", "microphone", "microphone_position",
        "room", "audio_interface", "preamp", "gain_db", "recorded_at", "notes",
    ]
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    for instrument, spec in checklist["instruments"].items():
        recorded = [sample for sample in bank.samples if sample.instrument == instrument]
        for target in spec["targets"]:
            matches = [
                sample for sample in recorded
                if sample.midi_note == target["midi_note"]
                and sample.articulation == target["articulation"]
                and sample.velocity_min <= target["velocity_min"]
                and sample.velocity_max >= target["velocity_max"]
            ]
            sample = matches[0] if matches else None
            writer.writerow({
                "instrument": instrument,
                "instrument_label": spec["label"],
                "register_zone": target["register_zone"],
                "midi_note": target["midi_note"],
                "velocity_layer": target["velocity_layer"],
                "velocity_min": target["velocity_min"],
                "velocity_max": target["velocity_max"],
                "articulation": target["articulation"],
                "status": "recorded" if sample else "missing",
                "sample_path": str(sample.path.relative_to(bank.root)) if sample else "",
                "recording_session_id": sample.recording_session_id or "" if sample else "",
                **(sample.recording_metadata if sample and sample.recording_metadata else {}),
            })
    return output.getvalue()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only validation of a recorded MEHRAN PCM WAV sample bank."
    )
    parser.add_argument("bank_root", type=Path, help="Directory containing bank.json and recorded WAV files")
    parser.add_argument("--format", choices=("json", "csv"), default="json", help="Report format")
    args = parser.parse_args(argv)
    try:
        if args.format == "csv":
            print(export_sample_bank_progress_csv(args.bank_root), end="")
            return 0
        report = inspect_sample_bank(args.bank_root)
    except (OSError, ValueError) as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ready"] else 2


if __name__ == "__main__":
    sys.exit(main())
