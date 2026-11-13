"""Split validated CC0 contrabass candidates into single-session installer banks."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from sample_bank import load_sample_bank


def _build_one(
    source_root: Path,
    output_root: Path,
    session_id: str,
    entries: list[dict],
    source_subdir: str,
    exact_root: int,
    expected_count: int,
    expected_velocity: tuple[int, int],
) -> dict:
    source_root = source_root.resolve(strict=True)
    output_root = output_root.resolve()
    if output_root.exists():
        raise ValueError(f"Output directory already exists: {output_root}")
    source_manifest = json.loads((source_root / "bank.json").read_text(encoding="utf-8"))
    source_sessions = source_manifest.get("recording_sessions", {})
    if session_id not in source_sessions:
        raise ValueError(f"Missing expected recording session: {session_id}")
    selected = [dict(entry) for entry in entries]
    if len(selected) != expected_count:
        raise ValueError(f"Expected {expected_count} supplement samples, got {len(selected)}")
    if any(
        entry.get("instrument") != "contrabass"
        or entry.get("midi_note") != exact_root
        or (entry.get("velocity_min"), entry.get("velocity_max")) != expected_velocity
        or entry.get("recording_session_id") != session_id
        for entry in selected
    ):
        raise ValueError(f"Unexpected {session_id} supplement mapping")

    output_root.mkdir(parents=True)
    (output_root / "pizzicato").mkdir()
    output_entries = []
    for entry in selected:
        source = (source_root / entry["path"]).resolve()
        if not source.is_relative_to(source_root):
            raise ValueError("Unsafe source sample path")
        relative = Path("pizzicato") / Path(entry["path"]).name
        shutil.copyfile(source, output_root / relative)
        entry["path"] = relative.as_posix()
        entry["playable_key_min"] = exact_root
        entry["playable_key_max"] = exact_root
        entry["selection_priority"] = 10
        entry["selection_priority_min_velocity"] = 121
        output_entries.append(entry)

    manifest = {
        "format_version": 1,
        "recording_sessions": {session_id: source_sessions[session_id]},
        "samples": output_entries,
    }
    (output_root / "bank.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    shutil.copyfile(source_root / "LICENSE-CC0.txt", output_root / "LICENSE-CC0.txt")
    provenance = source_root / "provenance.json"
    if provenance.is_file():
        shutil.copyfile(provenance, output_root / "provenance.json")

    bank = load_sample_bank(output_root)
    if len(bank.samples) != expected_count:
        raise ValueError("Supplement installer-bank validation count mismatch")
    return {
        "recording_session_id": session_id,
        "instrument": "contrabass",
        "recorded_root": exact_root,
        "source_velocity_range": list(expected_velocity),
        "selection_priority_min_velocity": 121,
        "sample_count": len(bank.samples),
        "channels": sorted({sample.channels for sample in bank.samples}),
    }


def build_contrabass_supplement_banks(
    meatbass_root: Path,
    vsco2_root: Path,
    meatbass_output: Path,
    vsco2_output: Path,
) -> dict:
    meatbass_root = meatbass_root.resolve(strict=True)
    vsco2_root = vsco2_root.resolve(strict=True)
    meatbass_manifest = json.loads((meatbass_root / "bank.json").read_text(encoding="utf-8"))
    vsco2_manifest = json.loads((vsco2_root / "bank.json").read_text(encoding="utf-8"))
    meatbass_entries = [
        entry for entry in meatbass_manifest.get("samples", [])
        if entry.get("instrument") == "contrabass"
        and entry.get("midi_note") == 27
        and entry.get("articulation") == "pizzicato"
        and entry.get("velocity_min") == 97
        and entry.get("velocity_max") == 127
    ]
    vsco2_entries = list(vsco2_manifest.get("samples", []))
    if sorted(entry.get("round_robin_index") for entry in meatbass_entries) != [0, 1, 2, 3]:
        raise ValueError("Meatbass MIDI 27 supplement must retain four round-robin takes")
    if sorted(entry.get("round_robin_index") for entry in vsco2_entries) != [0, 1]:
        raise ValueError("VSCO MIDI 34 supplement must retain two round-robin takes")

    meatbass_report = _build_one(
        meatbass_root, meatbass_output, "karoryfer_meatbass_pizzicato",
        meatbass_entries, "meatbass-supplement", 27, 4, (97, 127),
    )
    vsco2_report = _build_one(
        vsco2_root, vsco2_output, "vsco2_ce_contrabass_pizzicato",
        vsco2_entries, "vsco2-supplement", 34, 2, (63, 127),
    )
    return {
        "status": "validated_separate_contrabass_supplement_banks",
        "banks": [meatbass_report, vsco2_report],
        "total_supplement_samples": meatbass_report["sample_count"] + vsco2_report["sample_count"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("meatbass", type=Path)
    parser.add_argument("vsco2", type=Path)
    parser.add_argument("meatbass_output", type=Path)
    parser.add_argument("vsco2_output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build_contrabass_supplement_banks(
        args.meatbass, args.vsco2, args.meatbass_output, args.vsco2_output,
    ), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
