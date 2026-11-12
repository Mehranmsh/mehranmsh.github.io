"""Offline command-line validator for a recorded MEHRAN sample bank.

The validator is read-only. It never creates, moves, edits, or deletes audio files.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sample_bank import (
    analyze_sample_bank_coverage,
    analyze_sample_bank_instrument_health,
    analyze_sample_bank_quality,
    load_sample_bank,
)


def inspect_sample_bank(bank_root: str | Path) -> dict[str, Any]:
    """Return a machine-readable report for a validated on-disk sample bank."""
    bank = load_sample_bank(bank_root)
    coverage = analyze_sample_bank_coverage(bank)
    quality = analyze_sample_bank_quality(bank)
    health = analyze_sample_bank_instrument_health(bank, coverage, quality)
    ready = bool(coverage["ready"] and quality["basic_signal_checks_pass"])
    return {
        "read_only": True,
        "bank_root": str(Path(bank_root).resolve()),
        "ready": ready,
        "recorded_samples": len(bank.samples),
        "coverage": coverage,
        "quality": quality,
        "instrument_health": health,
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only validation of a recorded MEHRAN PCM WAV sample bank."
    )
    parser.add_argument("bank_root", type=Path, help="Directory containing bank.json and recorded WAV files")
    args = parser.parse_args(argv)
    try:
        report = inspect_sample_bank(args.bank_root)
    except (OSError, ValueError) as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ready"] else 2


if __name__ == "__main__":
    sys.exit(main())
