"""Fetch the pinned CC0 FreePats Yamaha RBX electric bass recordings."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SOURCE_REPOSITORY = "freepats/electric-bass-YR"
SOURCE_COMMIT = "8dcb7ea9116f417273ef8c030d15e7b3aa654301"
API_ROOT = f"https://api.github.com/repos/{SOURCE_REPOSITORY}"
RAW_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
EXPECTED_COUNTS = {"finger": 12, "pick": 13}
EXPECTED_RANGES = {"finger": (26, 45), "pick": (26, 46)}
NOTE_MIDI = {
    "C": 36, "C#": 37, "D": 38, "D#": 39, "E": 28,
    "F": 29, "F#": 30, "G": 31, "G#": 32, "A": 33,
    "A#": 34, "B": 35, "E2": 40,
}
MAPS = {
    "finger": "FingerBassYR 20190930.sfz",
    "pick": "PickedBassYR 20190930.sfz",
}


def _request(url: str, *, timeout: int = 90) -> bytes:
    headers = {"User-Agent": "MEHRAN-Music-Engine/1.0", "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in {408, 425, 429} and not 500 <= exc.code <= 599:
                raise
            if attempt == 3:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("Unreachable download retry state")


def _download_verified(path: str, expected_git_sha: str, destination: Path) -> None:
    data = _request(f"{RAW_ROOT}/{urllib.parse.quote(path, safe='/')}")
    actual = hashlib.sha1(
        b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    ).hexdigest()
    if actual != expected_git_sha:
        raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)


def parse_freepats_bass_sfz(
    sfz_text: str, articulation: str, *, require_complete: bool = True
) -> list[dict[str, Any]]:
    """Parse one FreePats SFZ map, preserving playable range and source root pitch."""
    if articulation not in MAPS:
        raise ValueError("articulation must be finger or pick")
    if not isinstance(require_complete, bool):
        raise ValueError("require_complete must be a boolean")
    regions = []
    for block in re.split(r"<region>\s*", sfz_text)[1:]:
        attrs = dict(re.findall(r"([a-z_]+)\s*=\s*([^\s]+)", block))
        sample_path = attrs.get("sample", "")
        filename = Path(sample_path).name
        if not sample_path.startswith(f"samples/{articulation}/") or not filename.endswith(".flac"):
            raise ValueError(f"Unexpected FreePats {articulation} sample path: {sample_path}")
        note_label = filename.removesuffix(".flac")
        if note_label not in NOTE_MIDI:
            raise ValueError(f"Unknown FreePats bass sample pitch: {filename}")
        if "key" in attrs:
            low = high = int(attrs["key"])
            root = int(attrs.get("pitch_keycenter", attrs["key"]))
        elif "lokey" in attrs and "hikey" in attrs:
            low, high = int(attrs["lokey"]), int(attrs["hikey"])
            if "pitch_keycenter" not in attrs:
                raise ValueError(f"Sample region must declare pitch_keycenter: {filename}")
            root = int(attrs["pitch_keycenter"])
        else:
            raise ValueError(f"Sample region must define key or lokey/hikey: {filename}")
        if not 0 <= low <= high <= 127 or not 0 <= root <= 127:
            raise ValueError(f"Invalid MIDI range in FreePats region: {filename}")
        expected_root = NOTE_MIDI[note_label]
        if root != expected_root or not low <= root <= high:
            raise ValueError(f"Filename/source pitch mismatch for {filename}: {root}")
        regions.append({
            "instrument": "electric_bass",
            "articulation": "fingerstyle" if articulation == "finger" else "pick",
            "midi_note": root,
            "playable_key_min": low,
            "playable_key_max": high,
            "velocity_min": 1,
            "velocity_max": 127,
            "round_robin_index": 0,
            "one_shot": False,
            "filename": filename,
            "source_path": sample_path,
        })
    if require_complete and len(regions) != EXPECTED_COUNTS[articulation]:
        raise ValueError(
            f"{articulation} expected {EXPECTED_COUNTS[articulation]} SFZ regions, got {len(regions)}"
        )
    if not regions:
        raise ValueError(f"No playable {articulation} bass regions found")
    filenames = [item["filename"] for item in regions]
    if len(filenames) != len(set(filenames)):
        raise ValueError(f"Duplicate FreePats sample file in {articulation} map")
    ordered = sorted(regions, key=lambda item: item["playable_key_min"])
    expected_low, expected_high = EXPECTED_RANGES[articulation]
    cursor = expected_low
    for item in ordered:
        if item["playable_key_min"] != cursor:
            raise ValueError(
                f"Playable key coverage gap or overlap for {articulation} at MIDI {cursor}"
            )
        cursor = item["playable_key_max"] + 1
    if require_complete and cursor != expected_high + 1:
        raise ValueError(
            f"{articulation} playable range ends at MIDI {cursor - 1}, expected {expected_high}"
        )
    return regions


def fetch_freepats_electric_bass(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to convert verified FLAC samples to PCM16 WAV")
    tree_data = json.loads(_request(f"{API_ROOT}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned FreePats Git tree was truncated")
    tree = {item["path"]: item["sha"] for item in tree_data.get("tree", [])
            if item.get("type") == "blob"}
    required = [*MAPS.values(), "README.txt", "LICENSE.txt"]
    missing = [path for path in required if path not in tree]
    if missing:
        raise ValueError(f"Pinned FreePats repository is missing required files: {missing}")
    source_dir = root / "source"
    source_dir.mkdir(parents=True, exist_ok=True)

    def fetch_text(path: str) -> str:
        destination = source_dir / Path(path).name
        _download_verified(path, tree[path], destination)
        return destination.read_text(encoding="utf-8")

    readme = fetch_text("README.txt")
    license_text = fetch_text("LICENSE.txt")
    if "CC0" not in license_text or "Andrea Biasior" not in readme or "Yamaha RBX" not in readme:
        raise ValueError("FreePats source identity or CC0 license could not be verified")
    regions = []
    for articulation, path in MAPS.items():
        regions.extend(parse_freepats_bass_sfz(
            fetch_text(path), articulation
        ))
    if len(regions) != sum(EXPECTED_COUNTS.values()):
        raise ValueError("Unexpected FreePats electric bass region count")

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source_path = item["source_path"]
        if source_path not in tree:
            raise ValueError(f"SFZ references a missing source recording: {source_path}")
        source_file = root / "source-flac" / item["filename"]
        _download_verified(source_path, tree[source_path], source_file)
        relative_wav = f"{item['articulation']}/{item['filename'].removesuffix('.flac')}.wav"
        wav_path = root / relative_wav
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            ffmpeg, "-y", "-v", "error", "-i", str(source_file),
            "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(wav_path),
        ], check=True)
        return {**item, "path": relative_wav, "source_git_blob_sha": tree[source_path]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        prepared = list(executor.map(prepare, regions))
    session_id = "freepats_electric_bass_cc0"
    manifest_samples = [{
        "instrument": item["instrument"],
        "midi_note": item["midi_note"],
        "playable_key_min": item["playable_key_min"],
        "playable_key_max": item["playable_key_max"],
        "velocity_min": item["velocity_min"],
        "velocity_max": item["velocity_max"],
        "articulation": item["articulation"],
        "round_robin_index": item["round_robin_index"],
        "one_shot": item["one_shot"],
        "path": item["path"],
        "recording_session_id": session_id,
    } for item in prepared]
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "Yamaha RBX electric bass guitar",
                "performer": "Andrea Biasior",
                "notes": (
                    "FreePats Electric Bass Guitar YR. Original fingerstyle and "
                    "picked FLAC samples are Git-blob-SHA1 verified against the "
                    "pinned source commit, then converted to mono 48 kHz PCM16 WAV. "
                    "SFZ playable key ranges and source pitch centers are retained "
                    "in provenance; renderer selects the nearest real recording "
                    "and applies bounded sample-rate pitch transposition."
                ),
            }
        },
        "samples": manifest_samples,
    }
    (root / "bank.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (root / "LICENSE-CC0.txt").write_text(license_text, encoding="utf-8")
    provenance = {
        "source_repository": SOURCE_REPOSITORY,
        "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0",
        "source_license_file": "LICENSE-CC0.txt",
        "instrument": "electric_bass",
        "sample_count": len(prepared),
        "articulation_counts": EXPECTED_COUNTS,
        "playable_key_ranges": EXPECTED_RANGES,
        "samples": [{
            "filename": item["filename"],
            "source_path": item["source_path"],
            "source_git_blob_sha": item["source_git_blob_sha"],
            "articulation": item["articulation"],
            "source_midi_note": item["midi_note"],
            "playable_key_range": [item["playable_key_min"], item["playable_key_max"]],
        } for item in prepared],
    }
    (root / "provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != len(prepared):
        raise ValueError("Validated electric bass sample count differs from SFZ regions")
    invalid = [sample.path.relative_to(root).as_posix() for sample in bank.samples
               if sample.sample_rate != 48000 or sample.channels != 1]
    if invalid:
        raise ValueError(f"Invalid converted electric bass samples: {invalid[:5]}")
    return {
        "bank_root": str(root), "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0", "samples": len(bank.samples),
        "articulations": EXPECTED_COUNTS,
        "status": "validated_recorded_electric_bass_bank",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch_freepats_electric_bass(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
