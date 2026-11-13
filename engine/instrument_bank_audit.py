"""Read-only audit of the actual recorded sample-bank inventory.

Reports recorded roots, declared playable zones, velocity intervals, articulations,
and round-robin depth. It does not infer missing recordings or certify sound quality.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from sample_bank import SampleBank, load_sample_bank


def build_instrument_bank_audit(bank: SampleBank) -> dict[str, Any]:
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")

    groups: dict[str, list[Any]] = defaultdict(list)
    for sample in bank.samples:
        groups[sample.instrument].append(sample)

    instruments: dict[str, Any] = {}
    for instrument, samples in sorted(groups.items()):
        roots = sorted({sample.midi_note for sample in samples})
        articulations = sorted({sample.articulation for sample in samples})
        velocity_intervals = sorted({
            (sample.velocity_min, sample.velocity_max) for sample in samples
        })
        playable_zones = sorted({
            (sample.playable_key_min, sample.playable_key_max)
            for sample in samples
        }, key=lambda zone: (
            -1 if zone[0] is None else zone[0],
            -1 if zone[1] is None else zone[1],
        ))

        rr_groups: dict[tuple[Any, ...], list[int]] = defaultdict(list)
        for sample in samples:
            key = (
                sample.midi_note, sample.articulation,
                sample.velocity_min, sample.velocity_max,
                sample.string_name, sample.playable_key_min,
                sample.playable_key_max, sample.one_shot,
            )
            rr_groups[key].append(sample.round_robin_index)

        rr_depths = [len(indices) for indices in rr_groups.values()]
        rr_distribution: dict[str, int] = defaultdict(int)
        rr_gaps = []
        for key, indices in rr_groups.items():
            depth = len(indices)
            rr_distribution[str(depth)] += 1
            ordered = sorted(indices)
            expected = list(range(ordered[0], ordered[0] + len(ordered)))
            if ordered != expected:
                rr_gaps.append({
                    "midi_note": key[0],
                    "articulation": key[1],
                    "velocity_range": [key[2], key[3]],
                    "string": key[4],
                    "playable_key_range": [key[5], key[6]],
                    "indices": ordered,
                })

        instruments[instrument] = {
            "sample_entries": len(samples),
            "recorded_pitch_centers": len(roots),
            "recorded_midi_notes": roots,
            "recorded_note_min_max": [roots[0], roots[-1]],
            "articulations": articulations,
            "velocity_intervals": [
                {"min": low, "max": high} for low, high in velocity_intervals
            ],
            "declared_playable_key_zones": [
                {"min": low, "max": high}
                for low, high in playable_zones
            ],
            "one_shot_entries": sum(sample.one_shot for sample in samples),
            "pitched_entries": sum(not sample.one_shot for sample in samples),
            "round_robin": {
                "group_count": len(rr_groups),
                "minimum_takes_per_group": min(rr_depths),
                "maximum_takes_per_group": max(rr_depths),
                "depth_distribution": dict(sorted(
                    rr_distribution.items(), key=lambda item: int(item[0])
                )),
                "groups_with_non_contiguous_indices": rr_gaps,
            },
            "sample_rates_hz": sorted({sample.sample_rate for sample in samples}),
            "channel_counts": sorted({sample.channels for sample in samples}),
        }

    return {
        "schema_version": 1,
        "bank_sample_entries": len(bank.samples),
        "instrument_count": len(instruments),
        "instruments": instruments,
        "interpretation": {
            "recorded_pitch_centers": "Exact MIDI roots present in the manifest; not a claim of continuous chromatic coverage.",
            "playable_zones": "Only the declared key zones in the source manifest; null means no explicit zone was declared.",
            "round_robin": "Grouped by note, articulation, velocity interval, string, playable zone and one-shot status.",
            "quality": "Inventory only. This report does not grade timbre, tuning, performance or mix readiness.",
        },
        "read_only": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit actual recorded instrument-bank coverage metadata."
    )
    parser.add_argument("bank", type=Path, help="Installed sample-bank directory")
    parser.add_argument("--output", type=Path, help="Optional JSON output path")
    args = parser.parse_args()
    report = build_instrument_bank_audit(load_sample_bank(args.bank))
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
