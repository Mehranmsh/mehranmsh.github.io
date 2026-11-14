"""Build an exact-root CC0 contrabass upper-velocity supplement.

The original Rubner bank remains the baseline. Four Meatbass MIDI 27 takes
cover its missing 121-127 range; two VSCO 2 CE MIDI 34 takes cover the other
missing 121-127 range. Original source velocity bounds and source SFZ key
zones remain in provenance. Engine playback zones are narrowed to exact roots.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from sample_bank import load_sample_bank


def _copy_entry(source_root: Path, output_root: Path, entry: dict, subdir: str) -> dict:
    source = (source_root / entry["path"]).resolve()
    if not source.is_relative_to(source_root):
        raise ValueError("Unsafe source sample path")
    relative = Path(subdir) / Path(entry["path"]).name
    target = output_root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    copied = dict(entry)
    copied["path"] = relative.as_posix()
    return copied


def build_supplement(
    baseline_root: Path,
    meatbass_root: Path,
    vsco2_root: Path,
    output_root: Path,
) -> dict:
    baseline_root = baseline_root.resolve(strict=True)
    meatbass_root = meatbass_root.resolve(strict=True)
    vsco2_root = vsco2_root.resolve(strict=True)
    output_root = output_root.resolve()
    if output_root.exists():
        raise ValueError(f"Output directory already exists: {output_root}")

    baseline = json.loads((baseline_root / "bank.json").read_text(encoding="utf-8"))
    meatbass = json.loads((meatbass_root / "bank.json").read_text(encoding="utf-8"))
    vsco2 = json.loads((vsco2_root / "bank.json").read_text(encoding="utf-8"))
    if len(baseline.get("samples", [])) != 123:
        raise ValueError("Expected the pinned 123-entry Rubner contrabass baseline")
    if len(meatbass.get("samples", [])) != 224:
        raise ValueError("Expected the fully validated 224-entry Meatbass candidate")
    if len(vsco2.get("samples", [])) != 2:
        raise ValueError("Expected exactly two VSCO 2 CE MIDI 34 pizzicato recordings")

    meatbass_entries = [
        dict(entry) for entry in meatbass["samples"]
        if entry.get("instrument") == "contrabass"
        and entry.get("midi_note") == 27
        and entry.get("articulation") == "pizzicato"
        and entry.get("velocity_min") == 97
        and entry.get("velocity_max") == 127
    ]
    if len(meatbass_entries) != 4 or sorted(x.get("round_robin_index") for x in meatbass_entries) != [0, 1, 2, 3]:
        raise ValueError("Expected four exact-root MIDI 27 high-layer Meatbass round robins")
    if any(
        x.get("playable_key_min") != 26 or x.get("playable_key_max") != 28
        for x in meatbass_entries
    ):
        raise ValueError("Unexpected original Meatbass MIDI 27 source key zone")

    vsco_entries = [dict(entry) for entry in vsco2["samples"]]
    if any(
        x.get("instrument") != "contrabass"
        or x.get("midi_note") != 34
        or x.get("velocity_min") != 63
        or x.get("velocity_max") != 127
        or x.get("round_robin_index") not in (0, 1)
        or x.get("selection_priority_min_velocity") != 121
        or x.get("playable_key_min") != 34
        or x.get("playable_key_max") != 34
        for x in vsco_entries
    ):
        raise ValueError("VSCO supplement must contain exact-root MIDI 34 high-layer samples only")
    if sorted(x["round_robin_index"] for x in vsco_entries) != [0, 1]:
        raise ValueError("VSCO MIDI 34 supplement must retain two distinct takes")

    output_root.mkdir(parents=True)
    for directory in ("rubner", "meatbass-supplement", "vsco2-supplement"):
        (output_root / directory).mkdir()

    baseline_entries = []
    for entry in baseline["samples"]:
        copied = _copy_entry(baseline_root, output_root, entry, "rubner")
        baseline_entries.append(copied)

    meatbass_supplement = []
    for entry in meatbass_entries:
        copied = _copy_entry(meatbass_root, output_root, entry, "meatbass-supplement")
        # Keep original SFZ range 26-28 in provenance, but permit exact-root playback only.
        copied["playable_key_min"] = 27
        copied["playable_key_max"] = 27
        copied["selection_priority"] = 10
        copied["selection_priority_min_velocity"] = 121
        meatbass_supplement.append(copied)

    vsco2_supplement = []
    for entry in vsco_entries:
        copied = _copy_entry(vsco2_root, output_root, entry, "vsco2-supplement")
        copied["selection_priority"] = 10
        copied["selection_priority_min_velocity"] = 121
        vsco2_supplement.append(copied)

    sessions = dict(baseline.get("recording_sessions", {}))
    for source_manifest in (meatbass, vsco2):
        for session_id, metadata in source_manifest.get("recording_sessions", {}).items():
            if session_id in sessions and sessions[session_id] != metadata:
                raise ValueError(f"Recording session collision: {session_id}")
            sessions[session_id] = metadata

    sources = [
        *baseline.get("sources", []),
        {
            "instrument": "contrabass",
            "label": "Karoryfer Meatbass exact-root MIDI 27 upper-velocity supplement",
            "source_id": "karoryfer-meatbass-midi27-upper-velocity",
            "license": "CC0 1.0 Universal",
            "source_sample_count": 4,
            "copied_sample_count": 4,
        },
        {
            "instrument": "contrabass",
            "label": "VSCO 2 CE exact-root MIDI 34 upper-velocity supplement",
            "source_id": "vsco2-ce-midi34-upper-velocity",
            "license": "CC0 1.0 Universal",
            "source_sample_count": 2,
            "copied_sample_count": 2,
        },
    ]
    manifest = {
        "format_version": 1,
        "recording_sessions": sessions,
        "sources": sources,
        "samples": [*baseline_entries, *meatbass_supplement, *vsco2_supplement],
    }
    (output_root / "bank.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    shutil.copyfile(baseline_root / "LICENSE-CC0.txt", output_root / "LICENSE-RUBNER-CC0.txt")
    shutil.copyfile(meatbass_root / "LICENSE-CC0.txt", output_root / "LICENSE-MEATBASS-CC0.txt")
    shutil.copyfile(vsco2_root / "LICENSE-CC0.txt", output_root / "LICENSE-VSCO2-CC0.txt")
    shutil.copyfile(meatbass_root / "provenance.json", output_root / "provenance-meatbass.json")
    shutil.copyfile(vsco2_root / "provenance.json", output_root / "provenance-vsco2.json")
    if (baseline_root / "provenance.json").is_file():
        shutil.copyfile(baseline_root / "provenance.json", output_root / "provenance-rubner.json")

    bank = load_sample_bank(output_root)
    if len(bank.samples) != 129:
        raise ValueError(f"Expected 129 combined entries, got {len(bank.samples)}")
    if sum(s.midi_note == 27 and s.selection_priority == 10 for s in bank.samples) != 4:
        raise ValueError("Meatbass MIDI 27 source priority metadata did not survive loading")
    if sum(s.midi_note == 34 and s.selection_priority == 10 for s in bank.samples) != 2:
        raise ValueError("VSCO MIDI 34 source priority metadata did not survive loading")

    from velocity_layer_planner import plan_velocity_layers
    checks = {
        "midi27_low": plan_velocity_layers(bank, "contrabass", 27, 100, "pizzicato"),
        "midi27_high": plan_velocity_layers(bank, "contrabass", 27, 123, "pizzicato"),
        "midi34_low": plan_velocity_layers(bank, "contrabass", 34, 100, "pizzicato"),
        "midi34_high": plan_velocity_layers(bank, "contrabass", 34, 123, "pizzicato"),
        "midi33_high": plan_velocity_layers(bank, "contrabass", 33, 123, "pizzicato"),
    }
    expected_sessions = {
        "midi27_low": "d_smolken_rubner_pizzicato",
        "midi27_high": "karoryfer_meatbass_pizzicato",
        "midi34_low": "d_smolken_rubner_pizzicato",
        "midi34_high": "vsco2_ce_contrabass_pizzicato",
    }
    for key, session in expected_sessions.items():
        layers = checks[key]["layers"]
        if len(layers) != 1 or layers[0]["sample"].recording_session_id != session:
            raise ValueError(f"Unexpected recorded-source selection for {key}")
    if checks["midi33_high"]["layers"]:
        raise ValueError("MIDI 33 must not borrow the VSCO MIDI 34 recording through its wider source zone")

    return {
        "status": "validated_exact_root_contrabass_velocity_supplement",
        "baseline_samples": 123,
        "meatbass_supplement_samples": 4,
        "vsco2_supplement_samples": 2,
        "combined_samples": len(bank.samples),
        "midi27_source_velocity_range": [97, 127],
        "midi27_selection_threshold": 121,
        "midi34_source_velocity_range": [63, 127],
        "midi34_selection_threshold": 121,
        "rubner_preserved_below_supplement_threshold": True,
        "midi33_keyzone_fallback_blocked": True,
        "both_added_roots_are_exact": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("meatbass", type=Path)
    parser.add_argument("vsco2", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(
        build_supplement(args.baseline, args.meatbass, args.vsco2, args.output),
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
