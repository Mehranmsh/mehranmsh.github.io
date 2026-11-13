"""Build a narrowly scoped CC0 contrabass velocity-gap supplement.

Only exact-root MIDI 27 Meatbass recordings in the 97-127 source layer are
added. They are selected only for requested velocities 121-127, preserving
the incumbent Rubner source for its existing 75-120 range. No MIDI 33 key-zone
samples are copied, so this supplement cannot disguise the exact-root MIDI 34
gap with pitch-shifted playback.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from sample_bank import load_sample_bank


def build_supplement(baseline_root: Path, candidate_root: Path, output_root: Path) -> dict:
    baseline_root = baseline_root.resolve(strict=True)
    candidate_root = candidate_root.resolve(strict=True)
    output_root = output_root.resolve()
    if output_root.exists():
        raise ValueError(f"Output directory already exists: {output_root}")

    baseline_manifest = json.loads((baseline_root / "bank.json").read_text(encoding="utf-8"))
    candidate_manifest = json.loads((candidate_root / "bank.json").read_text(encoding="utf-8"))
    if len(baseline_manifest.get("samples", [])) != 123:
        raise ValueError("Expected the pinned 123-entry Rubner contrabass baseline")
    if len(candidate_manifest.get("samples", [])) != 224:
        raise ValueError("Expected the fully validated 224-entry Meatbass candidate")

    supplement = [
        dict(entry) for entry in candidate_manifest["samples"]
        if entry.get("instrument") == "contrabass"
        and entry.get("midi_note") == 27
        and entry.get("articulation") == "pizzicato"
        and entry.get("velocity_min") == 97
        and entry.get("velocity_max") == 127
    ]
    if len(supplement) != 4 or sorted(x.get("round_robin_index") for x in supplement) != [0, 1, 2, 3]:
        raise ValueError("Expected four exact-root MIDI 27 high-layer Meatbass round robins")
    if any(
        x.get("playable_key_min") != 26 or x.get("playable_key_max") != 28
        for x in supplement
    ):
        raise ValueError("Unexpected Meatbass MIDI 27 playable key zone")

    output_root.mkdir(parents=True)
    (output_root / "rubner").mkdir()
    (output_root / "meatbass-supplement").mkdir()
    for entry in baseline_manifest["samples"]:
        source = (baseline_root / entry["path"]).resolve()
        if not source.is_relative_to(baseline_root):
            raise ValueError("Unsafe baseline sample path")
        target = output_root / "rubner" / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        entry["path"] = target.relative_to(output_root).as_posix()

    for entry in supplement:
        source = (candidate_root / entry["path"]).resolve()
        if not source.is_relative_to(candidate_root):
            raise ValueError("Unsafe candidate sample path")
        relative = Path("meatbass-supplement") / Path(entry["path"]).name
        shutil.copyfile(source, output_root / relative)
        entry["path"] = relative.as_posix()
        entry["selection_priority"] = 10
        entry["selection_priority_min_velocity"] = 121

    sessions = dict(baseline_manifest.get("recording_sessions", {}))
    for session_id, metadata in candidate_manifest.get("recording_sessions", {}).items():
        if session_id in sessions and sessions[session_id] != metadata:
            raise ValueError(f"Recording session collision: {session_id}")
        sessions[session_id] = metadata

    manifest = {
        "format_version": 1,
        "recording_sessions": sessions,
        "sources": [
            *baseline_manifest.get("sources", []),
            {
                "instrument": "contrabass",
                "label": "Karoryfer Meatbass exact-root MIDI 27 high-velocity supplement",
                "source_id": "karoryfer-meatbass-midi27-high-velocity",
                "license": "CC0 1.0 Universal",
                "source_sample_count": 4,
                "copied_sample_count": 4,
            },
        ],
        "samples": [*baseline_manifest["samples"], *supplement],
    }
    (output_root / "bank.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    shutil.copyfile(baseline_root / "LICENSE-CC0.txt", output_root / "LICENSE-RUBNER-CC0.txt")
    shutil.copyfile(candidate_root / "LICENSE-CC0.txt", output_root / "LICENSE-MEATBASS-CC0.txt")
    shutil.copyfile(candidate_root / "provenance.json", output_root / "provenance-meatbass.json")
    if (baseline_root / "provenance.json").is_file():
        shutil.copyfile(baseline_root / "provenance.json", output_root / "provenance-rubner.json")

    bank = load_sample_bank(output_root)
    if len(bank.samples) != 127:
        raise ValueError(f"Expected 127 combined entries, got {len(bank.samples)}")
    if sum(
        sample.midi_note == 27 and sample.velocity_min == 97
        and sample.velocity_max == 127 and sample.selection_priority == 10
        for sample in bank.samples
    ) != 4:
        raise ValueError("Supplement priority metadata did not survive bank loading")

    from velocity_layer_planner import plan_velocity_layers
    lower = plan_velocity_layers(bank, "contrabass", 27, 100, "pizzicato")
    upper = plan_velocity_layers(bank, "contrabass", 27, 123, "pizzicato")
    note34 = plan_velocity_layers(bank, "contrabass", 34, 123, "pizzicato")
    if len(lower["layers"]) != 1 or lower["layers"][0]["sample"].recording_session_id != "d_smolken_rubner_pizzicato":
        raise ValueError("Existing Rubner source was not preserved below the supplement threshold")
    if len(upper["layers"]) != 1 or upper["layers"][0]["sample"].recording_session_id != "karoryfer_meatbass_pizzicato":
        raise ValueError("Meatbass supplement was not selected for MIDI 27 high velocity")
    if note34["layers"]:
        raise ValueError("MIDI 34 high velocity must remain uncovered until an exact-root recording is found")

    return {
        "status": "validated_contrabass_midi27_supplement",
        "baseline_samples": 123,
        "supplement_samples": 4,
        "combined_samples": len(bank.samples),
        "supplement_pitch_center": 27,
        "supplement_source_velocity_range": [97, 127],
        "supplement_selection_threshold": 121,
        "baseline_selected_at_velocity_100": True,
        "supplement_selected_at_velocity_123": True,
        "midi34_high_velocity_remains_uncovered": True,
        "pitch_shifted_midi34_samples_added": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build_supplement(args.baseline, args.candidate, args.output), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
