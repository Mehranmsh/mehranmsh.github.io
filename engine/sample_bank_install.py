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
    "electric_bass": ("FreePats Electric Bass YR", "freepats-electric-bass-yr", "freepats_electric_bass_cc0", 48000),
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
            if duplicates:
                raise ValueError(f"Duplicate instrument bank supplied: {', '.join(sorted(duplicates))}")
            seen_instruments.update(instruments)

            session_ids = {sample.recording_session_id for sample in bank.samples}
            if None in session_ids or len(session_ids) != 1:
                raise ValueError("All samples in a source bank must share one declared recording session")
            session_id = next(iter(session_ids))
            metadata = next(
                sample.recording_metadata for sample in bank.samples
                if sample.recording_metadata is not None
            )
            license_text = _source_license(source_root)
            copied_by_instrument: dict[str, int] = {}

            for instrument in instruments:
                label, source_id, session_prefix, _expected_rate = EXPECTED_BANKS[instrument][:4]
                if not session_id.startswith(session_prefix):
                    raise ValueError(f"Unexpected recording session provenance for {instrument}")
                license_dir = staged / "provenance" / instrument
                license_dir.mkdir(parents=True, exist_ok=True)
                (license_dir / "SOURCE_LICENSE.txt").write_text(license_text, encoding="utf-8")
                copied_by_instrument[instrument] = 0

            for sample in bank.samples:
                relative = sample.path.relative_to(source_root)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unsafe sample path in validated source bank")
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
                    "path": destination_relative.as_posix(),
                    "recording_session_id": session_id,
                })
                copied_by_instrument[sample.instrument] += 1

            combined_sessions[session_id] = dict(metadata)
            for instrument in instruments:
                label, source_id, _session_prefix, _expected_rate = EXPECTED_BANKS[instrument]
                source_records.append({
                    "instrument": instrument,
                    "label": label,
                    "source_id": source_id,
                    "license": "CC0 1.0 Universal",
                    "source_sample_count": copied_by_instrument[instrument],
                    "copied_sample_count": copied_by_instrument[instrument],
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
        invalid = [
            sample.path.relative_to(staged).as_posix()
            for sample in validated.samples
            if (sample.sample_rate != EXPECTED_BANKS[sample.instrument][3]
                or sample.channels != (EXPECTED_BANKS[sample.instrument][4]
                                       if len(EXPECTED_BANKS[sample.instrument]) > 4 else 1))
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
