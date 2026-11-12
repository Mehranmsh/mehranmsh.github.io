"""Render a recorded instrument note across velocity layers for audition."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sample_bank import load_sample_bank
from sample_renderer import render_sample_events
from velocity_layer_planner import plan_velocity_layers


def build_velocity_sweep_events(
    bank_root: str | Path,
    instrument: str,
    midi_note: int,
    velocities: list[int],
    articulation: str = "sustain",
    *,
    note_duration: float = 0.8,
    gap_seconds: float = 0.2,
) -> tuple[Any, list[dict[str, Any]]]:
    """Build sequential events only for exact recorded note/articulation layers."""
    if not isinstance(instrument, str) or not instrument.strip():
        raise ValueError("instrument must be a non-empty name")
    if isinstance(midi_note, bool) or not isinstance(midi_note, int) or not 0 <= midi_note <= 127:
        raise ValueError("midi_note must be an integer from 0 to 127")
    if not isinstance(velocities, list) or not velocities:
        raise ValueError("velocities must be a non-empty list")
    if any(isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 127 for v in velocities):
        raise ValueError("each velocity must be an integer from 1 to 127")
    if len(set(velocities)) != len(velocities):
        raise ValueError("velocities must not contain duplicates")
    if isinstance(note_duration, bool) or not isinstance(note_duration, (int, float)) or not 0.05 <= note_duration <= 10:
        raise ValueError("note_duration must be between 0.05 and 10 seconds")
    if isinstance(gap_seconds, bool) or not isinstance(gap_seconds, (int, float)) or not 0 <= gap_seconds <= 5:
        raise ValueError("gap_seconds must be between 0 and 5 seconds")

    bank = load_sample_bank(bank_root)
    events = []
    for index, velocity in enumerate(velocities):
        plan = plan_velocity_layers(bank, instrument, midi_note, velocity, articulation)
        if not plan["layers"]:
            raise ValueError(
                f"Exact recorded velocity layer unavailable: instrument={instrument}, "
                f"note={midi_note}, velocity={velocity}, articulation={articulation}"
            )
        events.append({
            "instrument": instrument,
            "midi_note": midi_note,
            "start_seconds": index * (float(note_duration) + float(gap_seconds)),
            "duration_seconds": float(note_duration),
            "velocity": velocity,
            "articulation": articulation,
            "release_seconds": min(0.12, float(note_duration) / 4),
            "audition_velocity": velocity,
            "velocity_selection_mode": plan["selection_mode"],
        })
    return bank, events


def render_velocity_sweep(
    bank_root: str | Path,
    instrument: str,
    midi_note: int,
    velocities: list[int],
    output_path: str | Path,
    articulation: str = "sustain",
    *,
    note_duration: float = 0.8,
    gap_seconds: float = 0.2,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    bank, events = build_velocity_sweep_events(
        bank_root, instrument, midi_note, velocities, articulation,
        note_duration=note_duration, gap_seconds=gap_seconds,
    )
    result = render_sample_events(events, bank, output_path, sample_rate=sample_rate)
    return {
        "rendered": result.get("events_rendered") == len(events),
        "source": "recorded_sample_bank",
        "instrument": instrument,
        "midi_note": midi_note,
        "articulation": articulation,
        "velocities": velocities,
        "output_path": str(Path(output_path).resolve()),
        "render_metadata": result,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Render an exact recorded note at several velocities into one audition WAV."
    )
    parser.add_argument("bank_root", type=Path)
    parser.add_argument("instrument")
    parser.add_argument("midi_note", type=int)
    parser.add_argument("output_wav", type=Path)
    parser.add_argument("--velocities", default="16,31,48,64,80,96,112,127")
    parser.add_argument("--articulation", default="sustain")
    parser.add_argument("--duration", type=float, default=0.8)
    parser.add_argument("--gap", type=float, default=0.2)
    parser.add_argument("--sample-rate", type=int, default=44100)
    args = parser.parse_args(argv)
    try:
        velocities = [int(value.strip()) for value in args.velocities.split(",")]
        report = render_velocity_sweep(
            args.bank_root, args.instrument, args.midi_note, velocities,
            args.output_wav, args.articulation, note_duration=args.duration,
            gap_seconds=args.gap, sample_rate=args.sample_rate,
        )
    except (OSError, ValueError) as exc:
        print(json.dumps({"rendered": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["rendered"] else 1


if __name__ == "__main__":
    sys.exit(main())
