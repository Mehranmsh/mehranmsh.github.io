"""Audition one exact recorded sample through the MEHRAN PCM renderer."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sample_bank import load_sample_bank, select_sample
from sample_renderer import render_sample_events


def render_one_note(
    bank_root: str | Path,
    instrument: str,
    midi_note: int,
    velocity: int,
    articulation: str,
    output_path: str | Path,
    *,
    duration_seconds: float = 1.0,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Render a single note only when its exact recorded note exists in the bank."""
    bank = load_sample_bank(bank_root)
    sample = select_sample(bank, instrument, midi_note, velocity, articulation)
    if sample.midi_note != midi_note:
        raise ValueError(
            f"Exact recorded note unavailable: {instrument} note={midi_note} articulation={articulation}"
        )
    result = render_sample_events(
        [{
            "instrument": instrument,
            "midi_note": midi_note,
            "start_seconds": 0.0,
            "duration_seconds": duration_seconds,
            "velocity": velocity,
            "articulation": articulation,
            "release_seconds": 0.08,
        }],
        bank,
        output_path,
        sample_rate=sample_rate,
    )
    return {
        "rendered": result.get("events_rendered", 0) > 0,
        "source": "recorded_sample_bank",
        "instrument": instrument,
        "midi_note": midi_note,
        "velocity": velocity,
        "articulation": articulation,
        "selected_sample": sample.path.relative_to(bank.root).as_posix(),
        "output_path": str(Path(output_path).resolve()),
        "sample_rate": sample_rate,
        "duration_seconds": duration_seconds,
        "render_metadata": result,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render one exact recorded MEHRAN instrument sample to WAV.")
    parser.add_argument("bank_root", type=Path)
    parser.add_argument("instrument")
    parser.add_argument("midi_note", type=int)
    parser.add_argument("output_wav", type=Path)
    parser.add_argument("--velocity", type=int, default=90)
    parser.add_argument("--articulation", default="sustain")
    parser.add_argument("--duration", type=float, default=1.0)
    parser.add_argument("--sample-rate", type=int, default=44100)
    args = parser.parse_args(argv)
    try:
        report = render_one_note(
            args.bank_root, args.instrument, args.midi_note, args.velocity,
            args.articulation, args.output_wav,
            duration_seconds=args.duration, sample_rate=args.sample_rate,
        )
    except (OSError, ValueError) as exc:
        print(json.dumps({"rendered": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["rendered"] else 1


if __name__ == "__main__":
    sys.exit(main())
