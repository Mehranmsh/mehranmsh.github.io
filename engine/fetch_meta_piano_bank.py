"""Fetch and validate the complete CC0 Meta Piano multisample set for MEHRAN.

Downloads all 88 keys across four recorded velocity layers (352 OGG assets),
verifies every upstream SHA-256 digest, converts each to PCM16 WAV, and builds
a provenance-linked MEHRAN sample-bank manifest. No audio is synthesized.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

BASE = "https://raw.githubusercontent.com/facebookincubator/Meta-open-sound/main/systems/instruments/meta-piano"
SOURCE_URL = "https://github.com/facebookincubator/Meta-open-sound/tree/main/systems/instruments/meta-piano"
NOTE_NAMES = ("C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B")


def _download(url: str, destination: Path) -> None:
    """Download atomically with bounded retries so interrupted files are never reused."""
    request = urllib.request.Request(url, headers={"User-Agent": "MEHRAN-Music-Engine/1.0"})
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    last_error = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=35) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if temporary.stat().st_size == 0:
                raise ValueError(f"Empty download: {url}")
            temporary.replace(destination)
            return
        except Exception as exc:
            last_error = exc
            temporary.unlink(missing_ok=True)
            if attempt < 3:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Download failed after 4 attempts: {url}") from last_error


def _download_missing_piano_sources(regions: dict[str, dict[str, int]], root: Path) -> int:
    """Fetch missing source recordings concurrently with a small bounded worker pool."""
    pending = []
    for source_name in regions:
        target = root / "source-ogg" / source_name
        if not target.exists() or target.stat().st_size == 0:
            pending.append((f"{BASE}/ogg/{source_name}", target))
    if not pending:
        return 0
    print(f"PIANO_DOWNLOAD_START missing={len(pending)} workers=8", flush=True)
    completed = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_download, url, path): path.name for url, path in pending}
        for future in as_completed(futures):
            future.result()
            completed += 1
            if completed % 16 == 0 or completed == len(pending):
                print(f"PIANO_DOWNLOAD_PROGRESS completed={completed}/{len(pending)}", flush=True)
    return completed


def parse_sfz_sample_map(sfz_text: str) -> dict[str, dict[str, int]]:
    """Map each SFZ sample filename to its exact key and group velocity bounds."""
    velocity_min = velocity_max = None
    mapped: dict[str, dict[str, int]] = {}
    for raw_line in sfz_text.splitlines():
        line = raw_line.strip()
        if line.startswith("<group>"):
            attrs = dict(re.findall(r"([a-z_]+)=([0-9]+)", line))
            if "lovel" not in attrs or "hivel" not in attrs:
                raise ValueError("Every Meta Piano group must define lovel and hivel")
            velocity_min, velocity_max = int(attrs["lovel"]), int(attrs["hivel"])
            if not 1 <= velocity_min <= velocity_max <= 127:
                raise ValueError("Invalid SFZ velocity range")
        elif line.startswith("<region>"):
            if velocity_min is None or velocity_max is None:
                raise ValueError("SFZ region appeared before a velocity group")
            attrs = dict(re.findall(r"([a-z_]+)=([^\s]+)", line))
            if "key" not in attrs or "sample" not in attrs:
                raise ValueError("SFZ region must define key and sample")
            key = int(attrs["key"])
            sample = attrs["sample"]
            if not 0 <= key <= 127 or not re.fullmatch(r"INSPiano_Vel0[1-4]_[A-G](?:s)?[0-8]_01\.ogg", sample):
                raise ValueError(f"Unsupported Meta Piano region: {line}")
            if sample in mapped:
                raise ValueError(f"Duplicate SFZ sample mapping: {sample}")
            mapped[sample] = {
                "midi_note": key,
                "velocity_min": velocity_min,
                "velocity_max": velocity_max,
            }
    if not mapped:
        raise ValueError("No sample regions were found in the Meta Piano SFZ map")
    return mapped


def parse_sha256sums(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})\s+(.+)", line.strip())
        if match:
            digest, relative = match.groups()
            result[relative] = digest
    if not result:
        raise ValueError("Upstream SHA256SUMS file contained no valid entries")
    return result


def _note_label(midi_note: int) -> str:
    return f"{NOTE_NAMES[midi_note % 12]}{midi_note // 12 - 1}"


def fetch_meta_piano_bank(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to convert the verified OGG recordings to PCM16 WAV")
    sfz_path = root / "source" / "meta-piano.sfz"
    sums_path = root / "source" / "SHA256SUMS"
    license_path = root / "SOURCE_LICENSE_CC0.txt"
    readme_path = root / "SOURCE_README.md"
    for url, path in (
        (f"{BASE}/meta-piano.sfz", sfz_path),
        (f"{BASE}/SHA256SUMS", sums_path),
        (f"{BASE}/LICENSE", license_path),
        (f"{BASE}/README.md", readme_path),
    ):
        if not path.exists():
            _download(url, path)

    regions = parse_sfz_sample_map(sfz_path.read_text(encoding="utf-8"))
    checksums = parse_sha256sums(sums_path.read_text(encoding="utf-8"))
    if len(regions) != 352:
        raise ValueError(f"Expected 352 mapped Meta Piano recordings, found {len(regions)}")
    if len({item["midi_note"] for item in regions.values()}) != 88:
        raise ValueError("Expected all 88 piano keys A0-C8")

    downloaded = _download_missing_piano_sources(regions, root)
    samples = []
    verified = 0
    for index, (source_name, mapping) in enumerate(sorted(regions.items()), start=1):
        source_relative = f"ogg/{source_name}"
        expected = checksums.get(source_relative)
        if not expected:
            raise ValueError(f"Missing upstream checksum for {source_relative}")
        source_path = root / "source-ogg" / source_name
        digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
        if digest != expected:
            raise ValueError(f"SHA-256 mismatch for {source_name}")
        verified += 1

        output_name = source_name.removesuffix(".ogg") + ".wav"
        relative_wav = f"piano/sustain/{output_name}"
        wav_path = root / relative_wav
        if not wav_path.exists():
            wav_path.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([
                ffmpeg, "-y", "-v", "error", "-i", str(source_path),
                "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(wav_path),
            ], check=True)
        if index % 32 == 0 or index == len(regions):
            print(f"PIANO_CONVERSION_PROGRESS completed={index}/{len(regions)} verified={verified}", flush=True)
        samples.append({
            "instrument": "piano",
            "midi_note": mapping["midi_note"],
            "velocity_min": mapping["velocity_min"],
            "velocity_max": mapping["velocity_max"],
            "articulation": "sustain",
            "path": relative_wav,
            "recording_session_id": "meta_piano_cc0",
        })

    manifest = {
        "format_version": 1,
        "recording_sessions": {
            "meta_piano_cc0": {
                "instrument_model": "Felt-damped upright piano, Meta Piano collection",
                "performer": "Meta Creative Audio team (performer details not specified)",
                "notes": (
                    "88 keys A0-C8, four recorded velocity layers, sourced from Meta Open Sound. "
                    "Every original OGG was SHA-256 verified against the upstream SHA256SUMS file "
                    "before conversion to mono PCM16 WAV at 48 kHz. SFZ velocity ranges preserve "
                    "the source group bounds and overlap; MEHRAN currently selects one matching "
                    "layer and does not yet implement the source SFZ crossfade curves."
                ),
            }
        },
        "samples": samples,
    }
    manifest_path = root / "bank.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 352:
        raise ValueError(f"Validated bank should contain 352 samples, got {len(bank.samples)}")
    return {
        "status": "validated",
        "instrument": "piano",
        "keys": 88,
        "midi_range": [21, 108],
        "velocity_layers": 4,
        "sample_count": len(bank.samples),
        "sha256_verified_files": verified,
        "source_files_downloaded_this_run": downloaded,
        "sample_rate_hz": 48000,
        "channels": "mono",
        "license": "CC0 1.0 Universal",
        "source": SOURCE_URL,
        "bank_manifest": str(manifest_path),
        "recorded_wav_bytes": sum(sample.path.stat().st_size for sample in bank.samples),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch all 352 verified CC0 Meta Piano recordings.")
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    report = fetch_meta_piano_bank(args.output_root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
