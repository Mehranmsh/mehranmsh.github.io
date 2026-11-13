"""Safely combine validated MEHRAN recorded instrument banks for local runtime use.

The installer copies only manifest-referenced WAV files into a fresh staging
directory, preserves source license/provenance and percussion playback metadata,
validates the combined bank, and publishes it atomically.
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


# label, source id, recording-session prefix, required source sample rate
EXPECTED_BANKS = {
    "nylon_guitar": ("Meta Nylon Guitar", "meta-nylon-guitar", "meta-nylon-guitar", 48000),
    "acoustic_guitar": ("Meta Steel Guitar", "meta-steel-guitar", "meta-steel-guitar", 48000),
    "piano": ("Meta Piano", "meta-piano", "meta_piano", 48000),
    "electric_bass": ("Karoryfer Babyblue Picked Electric Bass", "karoryfer-babyblue-bass", "karoryfer_babyblue_picked", 44100),
    "kick": ("Virtuosity Kick", "virtuosity-drums", "virtuosity_drums_cc0_pinned", 44100),
    "snare": ("Virtuosity Snare", "virtuosity-drums", "virtuosity_drums_cc0_pinned", 44100),
    "closed_hat": ("Virtuosity Closed Hi-Hat", "virtuosity-drums", "virtuosity_drums_cc0_pinned", 44100),
    "open_hat": ("Virtuosity Open Hi-Hat", "virtuosity-drums", "virtuosity_drums_cc0_pinned", 44100),
    "cajon": ("VCSL Cajon", "vcsl-cajon", "vcsl_cajon_recordings", 44100),
    "kalimba": ("VCSL Kalimba Kenya", "vcsl-kalimba-kenya", "vcsl_kalimba_kenya", 44100),
    "contrabass": ("Rubner Contrabass Pizzicato", "rubner-contrabass-pizzicato", "d_smolken_rubner_pizzicato", 44100),
    "solo_violin": ("VSCO 2 CE Solo Violin", "vsco2-ce-solo-violin", "vsco2_solo_violin", 44100),
    "concert_flute": ("VSCO 2 CE Concert Flute", "vsco2-ce-concert-flute", "vsco2_concert_flute", 44100),
    "dan_tranh": ("VCSL Dan Tranh Normal", "vcsl-dan-tranh-normal", "vcsl_dan_tranh_normal", 44100),
    "baroque_soprano_recorder": ("VCSL Baroque Soprano Recorder", "vcsl-baroque-soprano-recorder", "vcsl_baroque_soprano_recorder", 44100),
    "concert_harp": ("VCSL Concert Harp", "vcsl-concert-harp", "vcsl_concert_harp_cc0", 44100, 2),
}

CONTRABASS_SESSION_SPECS = {
    "d_smolken_rubner_pizzicato": (
        "Rubner Contrabass Pizzicato", "rubner-contrabass-pizzicato", 44100, 1
    ),
    "karoryfer_meatbass_pizzicato": (
        "Karoryfer Meatbass MIDI 27 Upper-Velocity Supplement",
        "karoryfer-meatbass-midi27-upper-velocity", 44100, 1
    ),
    "vsco2_ce_contrabass_pizzicato": (
        "VSCO 2 CE Contrabass MIDI 34 Upper-Velocity Supplement",
        "vsco2-ce-contrabass-midi34-upper-velocity", 44100, 2
    ),
}


def _source_license(root: Path) -> str:
    candidates = (
        root / "source" / "SOURCE_LICENSE.txt",
        root / "SOURCE_LICENSE.txt",
        root / "SOURCE_LICENSE_CC0.txt",
        root / "LICENSE-CC0.txt",
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
    """Install validated CC0 Meta and Virtuosity banks as one combined sample bank."""
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
    seen_instruments: set[str] = set()
    try:
        for raw_root in bank_roots:
            source_root = Path(raw_root).expanduser().resolve(strict=True)
            if not source_root.is_dir():
                raise ValueError(f"Source bank is not a directory: {source_root}")
            bank = load_sample_bank(source_root)
            instruments = sorted({sample.instrument for sample in bank.samples})
            if not instruments or any(instrument not in EXPECTED_BANKS for instrument in instruments):
                raise ValueError(
                    f"Only validated CC0 recorded instrument banks are accepted: {source_root}"
                )
            duplicates = seen_instruments.intersection(instruments)
            unexpected_duplicates = duplicates - {"contrabass"}
            if unexpected_duplicates:
                raise ValueError(
                    f"Duplicate instrument bank supplied: {', '.join(sorted(unexpected_duplicates))}"
                )

            session_ids = {sample.recording_session_id for sample in bank.samples}
            if None in session_ids or not session_ids:
                raise ValueError("Every sample in a source bank must reference a declared recording session")
            if len(session_ids) > 1 and instruments != ["solo_violin"]:
                raise ValueError("Only the solo violin source bank may contain multiple recording sessions")
            duplicates_sessions = session_ids.intersection(combined_sessions)
            if duplicates_sessions:
                raise ValueError(
                    "Duplicate recording session supplied: " + ", ".join(sorted(duplicates_sessions))
                )
            session_metadata: dict[str, dict[str, str]] = {}
            for sample in bank.samples:
                sample_session_id = sample.recording_session_id
                if sample_session_id is None or sample.recording_metadata is None:
                    raise ValueError("Every sample must have declared recording-session metadata")
                metadata = dict(sample.recording_metadata)
                if sample_session_id in session_metadata and session_metadata[sample_session_id] != metadata:
                    raise ValueError(f"Inconsistent recording metadata for session: {sample_session_id}")
                session_metadata[sample_session_id] = metadata
            session_id = next(iter(session_ids)) if len(session_ids) == 1 else None
            license_text = _source_license(source_root)
            copied_by_instrument: dict[str, int] = {}
            copied_by_session: dict[str, int] = {item: 0 for item in session_ids}

            for instrument in instruments:
                if instrument == "contrabass":
                    if session_id not in CONTRABASS_SESSION_SPECS:
                        raise ValueError(f"Unexpected contrabass recording session: {session_id}")
                    label, source_id, _expected_rate, _expected_channels = CONTRABASS_SESSION_SPECS[session_id]
                    license_dir = staged / "provenance" / instrument
                    if session_id != "d_smolken_rubner_pizzicato":
                        license_dir = license_dir / session_id
                else:
                    label, source_id, session_prefix, _expected_rate = EXPECTED_BANKS[instrument][:4]
                    if not all(item.startswith(session_prefix) for item in session_ids):
                        raise ValueError(f"Unexpected recording session provenance for {instrument}")
                    license_dir = staged / "provenance" / instrument
                license_dir.mkdir(parents=True, exist_ok=True)
                (license_dir / "SOURCE_LICENSE.txt").write_text(license_text, encoding="utf-8")
                copied_by_instrument[instrument] = 0
            seen_instruments.update(instruments)

            for sample in bank.samples:
                relative = sample.path.relative_to(source_root)
                sample_session_id = sample.recording_session_id
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unsafe sample path in validated source bank")
                if sample_session_id not in session_ids:
                    raise ValueError("Sample references a session outside its source bank")
                if sample.instrument == "contrabass" and sample_session_id != "d_smolken_rubner_pizzicato":
                    destination_relative = Path(sample.instrument) / sample_session_id / relative
                elif len(session_ids) > 1:
                    destination_relative = Path(sample.instrument) / sample_session_id / relative
                else:
                    destination_relative = Path(sample.instrument) / relative
                output_path = staged / destination_relative
                output_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(sample.path, output_path)
                combined_samples.append({
                    "instrument": sample.instrument,
                    "midi_note": sample.midi_note,
                    "velocity_min": sample.velocity_min,
                    "velocity_max": sample.velocity_max,
                    "articulation": sample.articulation,
                    "string": sample.string_name,
                    "round_robin_index": sample.round_robin_index,
                    "one_shot": sample.one_shot,
                    "tuning_cents": sample.tuning_cents,
                    "gain_db": sample.gain_db,
                    "playable_key_min": sample.playable_key_min,
                    "playable_key_max": sample.playable_key_max,
                    "offset_frames": sample.offset_frames,
                    "velocity_fade_in": list(sample.velocity_fade_in) if sample.velocity_fade_in else None,
                    "velocity_fade_out": list(sample.velocity_fade_out) if sample.velocity_fade_out else None,
                    "sfz_volume_db": sample.sfz_volume_db,
                    "selection_priority": sample.selection_priority,
                    "selection_priority_min_velocity": sample.selection_priority_min_velocity,
                    "path": destination_relative.as_posix(),
                    "recording_session_id": sample_session_id,
                })
                copied_by_instrument[sample.instrument] += 1
                copied_by_session[sample_session_id] += 1

            combined_sessions.update(session_metadata)
            for instrument in instruments:
                for source_session_id in sorted(session_ids):
                    if instrument == "contrabass":
                        label, source_id, _expected_rate, _expected_channels = CONTRABASS_SESSION_SPECS[source_session_id]
                    else:
                        label, source_id, _session_prefix, _expected_rate = EXPECTED_BANKS[instrument][:4]
                        if instrument == "solo_violin" and source_session_id.endswith("_spiccato"):
                            label = "VSCO 2 CE Solo Violin Spiccato"
                            source_id = "vsco2-ce-solo-violin-spiccato"
                    source_records.append({
                        "instrument": instrument,
                        "label": label,
                        "source_id": source_id,
                        "recording_session_id": source_session_id,
                        "license": "CC0 1.0 Universal",
                        "source_sample_count": copied_by_session[source_session_id],
                        "copied_sample_count": copied_by_session[source_session_id],
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
        def expected_audio_format(sample):
            if sample.instrument == "contrabass":
                _label, _source_id, rate, channels = CONTRABASS_SESSION_SPECS[sample.recording_session_id]
                return rate, channels
            spec = EXPECTED_BANKS[sample.instrument]
            return spec[3], (spec[4] if len(spec) > 4 else 1)

        invalid = [
            sample.path.relative_to(staged).as_posix()
            for sample in validated.samples
            if (sample.sample_rate, sample.channels) != expected_audio_format(sample)
        ]
        if invalid:
            raise ValueError(
                "Installed sample rate/channel validation failed for instrument source requirements: "
                + ", ".join(invalid[:5])
            )
        os.replace(staged, target)
        return {
            "installed": True,
            "destination": str(target),
            "instrument_count": len(seen_instruments),
            "bank_package_count": len(bank_roots),
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
