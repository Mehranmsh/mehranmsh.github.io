"""Import the pinned official FreePats CC0 Concert Harp SFZ bank."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import io
import json
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request
import wave
from pathlib import Path, PurePosixPath
from typing import Any

from sfz_region_parser import parse_sfz_regions

SOURCE_URL = "https://freepats.zenvoid.org/OrchestralStrings/ConcertHarp/ConcertHarp-SFZ-20200702.tar.xz"
SOURCE_SHA256 = "e7dacbb92ff11bbb2eff97fe837e370341ef175e6b401309f05b623da87e3a1e"
SOURCE_VERSION = "2020-07-02"
SOURCE_ROOT = "ConcertHarp-SFZ-20200702"
SFZ_PATH = f"{SOURCE_ROOT}/ConcertHarp-20200702.sfz"
CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt"
SESSION_ID = "freepats_concert_harp_20200702"


def _download(url: str, timeout: int = 90) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "MEHRAN-Music-Engine/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _safe_member(bundle: tarfile.TarFile, name: str) -> bytes:
    member = bundle.getmember(name)
    path = PurePosixPath(member.name)
    if not member.isfile() or path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Unsafe or missing archive member: {name}")
    stream = bundle.extractfile(member)
    if stream is None:
        raise ValueError(f"Could not read archive member: {name}")
    return stream.read()


def _coverage(regions: list[dict[str, Any]]) -> dict[str, int]:
    covered: dict[int, list[int]] = {}
    for region in regions:
        low, high = region["key_range"]
        vlow, vhigh = region["velocity_range"]
        for note in range(low, high + 1):
            covered.setdefault(note, [0] * 128)
            for velocity in range(max(1, vlow), vhigh + 1):
                covered[note][velocity] += 1
    missing = [(note, velocity) for note, values in covered.items()
               for velocity in range(1, 128) if values[velocity] == 0]
    overlap = [(note, velocity) for note, values in covered.items()
               for velocity in range(1, 128) if values[velocity] > 1]
    if missing or overlap:
        raise ValueError(f"SFZ velocity coverage is not unique: missing={missing[:8]}, overlap={overlap[:8]}")
    notes = sorted(covered)
    if not notes or notes != list(range(notes[0], notes[-1] + 1)):
        raise ValueError("Concert harp key map contains gaps")
    return {"midi_min": notes[0], "midi_max": notes[-1], "mapped_keys": len(notes)}


def import_concert_harp(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    if root.exists():
        raise ValueError(f"Output directory already exists: {root}")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize official harp WAV samples")

    archive = _download(SOURCE_URL)
    archive_sha = hashlib.sha256(archive).hexdigest()
    if archive_sha != SOURCE_SHA256:
        raise ValueError(f"Official FreePats archive SHA-256 mismatch: {archive_sha}")

    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:xz") as bundle:
        members = bundle.getmembers()
        names = {member.name for member in members}
        sfz_text = _safe_member(bundle, SFZ_PATH).decode("utf-8-sig")
        regions = parse_sfz_regions(sfz_text)
        if len(regions) != 36:
            raise ValueError(f"Expected 36 official Concert Harp SFZ regions, got {len(regions)}")
        coverage = _coverage(regions)
        if (coverage["midi_min"], coverage["midi_max"]) != (28, 102):
            raise ValueError(f"Unexpected Concert Harp MIDI coverage: {coverage}")
        referenced = {region["sample"] for region in regions}
        if len(referenced) != 36:
            raise ValueError(f"Expected 36 independent harp recordings, got {len(referenced)}")
        velocity_layers = Counter(tuple(region["velocity_range"]) for region in regions)
        expected_layers = {(0, 90): 14, (91, 127): 14, (0, 127): 8}
        if dict(velocity_layers) != expected_layers:
            raise ValueError(f"Unexpected Concert Harp velocity-layer layout: {dict(velocity_layers)}")

        source_wavs = {name for name in names if name.startswith(f"{SOURCE_ROOT}/samples/") and name.lower().endswith(".wav")}
        expected_paths = {f"{SOURCE_ROOT}/{sample}" for sample in referenced}
        missing = sorted(expected_paths - names)
        if missing:
            raise ValueError(f"Concert Harp SFZ references missing audio: {missing[:8]}")
        if source_wavs != expected_paths:
            unused = sorted(source_wavs - expected_paths)
            raise ValueError(f"Archive audio and SFZ map disagree; unused={unused[:8]}")

        root.mkdir(parents=True)
        samples_dir = root / "samples"
        samples_dir.mkdir()
        entries = []
        source_audio_report = []
        with tempfile.TemporaryDirectory(prefix="mehran-harp-source-") as temp_dir:
            temp = Path(temp_dir)
            for sample_path in sorted(referenced):
                source_name = f"{SOURCE_ROOT}/{sample_path}"
                raw = _safe_member(bundle, source_name)
                source_file = temp / Path(sample_path).name
                source_file.write_bytes(raw)
                try:
                    with wave.open(str(source_file), "rb") as wav:
                        source_info = {
                            "channels": wav.getnchannels(),
                            "sample_rate": wav.getframerate(),
                            "sample_width_bytes": wav.getsampwidth(),
                            "frames": wav.getnframes(),
                            "compression": wav.getcomptype(),
                        }
                except (wave.Error, EOFError) as exc:
                    raise ValueError(f"Invalid source WAV file: {sample_path}") from exc
                if source_info["compression"] != "NONE" or source_info["frames"] <= 0:
                    raise ValueError(f"Unsupported or empty source WAV: {sample_path}")
                target_name = Path(sample_path).name
                target_file = samples_dir / target_name
                subprocess.run(
                    [ffmpeg, "-y", "-v", "error", "-i", str(source_file),
                     "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", str(target_file)],
                    check=True,
                )
                source_audio_report.append({"file": target_name, **source_info})
            for index, region in enumerate(regions):
                sample_name = Path(region["sample"]).name
                low_velocity, high_velocity = region["velocity_range"]
                entries.append({
                    "instrument": "concert_harp",
                    "midi_note": region["pitch_keycenter"],
                    "velocity_min": max(1, low_velocity),
                    "velocity_max": high_velocity,
                    "articulation": "sustain",
                    "tuning_cents": region["tune_cents"],
                    "sfz_volume_db": region["volume_db"],
                    "playable_key_min": region["key_range"][0],
                    "playable_key_max": region["key_range"][1],
                    "path": f"samples/{sample_name}",
                    "recording_session_id": SESSION_ID,
                })

        license_text = _download(CC0_URL).decode("utf-8", errors="replace")
        if "CC0 1.0 Universal" not in license_text and "CC0" not in license_text:
            raise ValueError("Could not verify the canonical CC0 1.0 legal code")
        (root / "LICENSE-CC0.txt").write_text(
            "Concert Harp recordings: FreePats / Versilian Community Sample Library.\n"
            "Published under CC0 1.0 Universal.\n"
            "Official source: " + SOURCE_URL + "\n"
            "License: " + CC0_URL + "\n\n" + license_text,
            encoding="utf-8",
        )
        manifest = {
            "format_version": 1,
            "recording_sessions": {
                SESSION_ID: {
                    "performer": "K. Smith",
                    "room": "Small room, Boston, MA",
                    "microphone": "2x Rode NT1-A spaced pair; 2x AT Pro 37 close",
                    "audio_interface": "Focusrite Scarlett 18i8 (first generation)",
                    "recorded_at": "2015-01-26",
                    "notes": "Concert harp recordings assembled by FreePats from VCSL material; original source samples were edited by FreePats. Instrument model and reference tuning were not specified.",
                }
            },
            "samples": entries,
        }
        (root / "bank.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        provenance = {
            "instrument": "Concert Harp",
            "source_project": "FreePats",
            "upstream_library": "Versilian Community Sample Library",
            "source_version": SOURCE_VERSION,
            "source_url": SOURCE_URL,
            "archive_sha256": archive_sha,
            "sfz_path": SFZ_PATH,
            "license": "CC0-1.0",
            "license_url": CC0_URL,
            "region_count": len(regions),
            "unique_recorded_samples": len(referenced),
            "coverage": coverage,
            "velocity_ranges": sorted({tuple(r["velocity_range"]) for r in regions}),
            "sample_audio": source_audio_report,
        }
        (root / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != len(regions):
        raise ValueError("Installed harp sample count differs from the source SFZ region count")
    return {
        "bank_root": str(root),
        "source": "FreePats Concert Harp",
        "license": "CC0-1.0",
        "archive_sha256": archive_sha,
        "regions": len(regions),
        "unique_audio_files": len(referenced),
        "playable_midi_range": [coverage["midi_min"], coverage["midi_max"]],
        "samples_validated": len(bank.samples),
        "status": "validated_recorded_concert_harp_bank",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", default="sample-bank-freepats-concert-harp")
    args = parser.parse_args()
    print(json.dumps(import_concert_harp(args.output), indent=2))


if __name__ == "__main__":
    main()
