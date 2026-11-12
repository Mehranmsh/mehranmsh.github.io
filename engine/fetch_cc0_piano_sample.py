"""Fetch one verified CC0 piano sample and prepare a local MEHRAN sample bank.

Source: Meta Open Sound, Meta Piano, CC0 1.0 Universal.
Only one C4 recording is fetched for the first real-audio bootstrap.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/facebookincubator/Meta-open-sound/main/systems/instruments/meta-piano"
SOURCE_FILE = "INSPiano_Vel03_C4_01.ogg"
SOURCE_SHA256 = "f6df379bfb60e074fdb640eb33298a3150960b9c27fa9247740036fb8d9b55d6"


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "MEHRAN-Music-Engine/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def bootstrap_cc0_piano_sample(output_root: str | Path) -> dict[str, object]:
    root = Path(output_root).resolve()
    audio_dir = root / "piano" / "sustain"
    audio_dir.mkdir(parents=True, exist_ok=True)
    source_path = audio_dir / SOURCE_FILE
    wav_path = audio_dir / "meta_piano_C4_vel03.wav"
    if not source_path.exists():
        _download(f"{BASE}/ogg/{SOURCE_FILE}", source_path)
    digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError("Downloaded CC0 piano sample failed SHA-256 verification")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to convert the verified OGG preview to PCM16 WAV")
    subprocess.run([
        ffmpeg, "-y", "-v", "error", "-i", str(source_path),
        "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(wav_path),
    ], check=True)
    license_path = root / "SOURCE_LICENSE_CC0.txt"
    if not license_path.exists():
        _download(f"{BASE}/LICENSE", license_path)
    readme_path = root / "SOURCE_README.md"
    if not readme_path.exists():
        _download(f"{BASE}/README.md", readme_path)
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            "meta_piano_cc0": {
                "instrument_model": "Felt-damped upright piano, Meta Piano collection",
                "performer": "Meta Creative Audio team (performer details not specified)",
                "notes": "Source recording distributed under CC0 1.0; converted from official OGG preview to mono PCM16 WAV at 48 kHz.",
            }
        },
        "samples": [{
            "instrument": "piano",
            "midi_note": 60,
            "velocity_min": 56,
            "velocity_max": 103,
            "articulation": "sustain",
            "path": "piano/sustain/meta_piano_C4_vel03.wav",
            "recording_session_id": "meta_piano_cc0",
        }],
    }
    (root / "bank.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "status": "prepared",
        "instrument": "piano",
        "midi_note": 60,
        "note_name": "C4",
        "velocity_min": 56,
        "velocity_max": 103,
        "articulation": "sustain",
        "source": "Meta Open Sound / Meta Piano",
        "license": "CC0 1.0 Universal",
        "source_file_sha256_verified": digest,
        "wav_path": str(wav_path),
        "bank_manifest": str(root / "bank.json"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare the first verified CC0 piano sample for MEHRAN.")
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(bootstrap_cc0_piano_sample(args.output_root), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
