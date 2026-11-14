"""Import the pinned original CC0 Concert Harp recordings from VCSL."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any

from sfz_region_parser import parse_sfz_regions

VCSL_REPOSITORY = "sgossner/VCSL"
VCSL_COMMIT = "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
VCSL_API = f"https://api.github.com/repos/{VCSL_REPOSITORY}"
VCSL_RAW = f"https://raw.githubusercontent.com/{VCSL_REPOSITORY}/{VCSL_COMMIT}"
VCSL_HARP_DIR = "Chordophones/Composite Chordophones/Concert Harp"
MAP_REPOSITORY = "danigb/samples"
MAP_COMMIT = "eae8c5c7a10f4b0e06281211e704c36c30e25342"
MAP_PATH = "audio/vcsl/Composite Chordophones/Concert Harp.sfz"
MAP_BLOB_SHA = "b16a2e8142333066d6a40e2d5b50a1a20e77a037"
MAP_RAW = (
    "https://raw.githubusercontent.com/danigb/samples/"
    + MAP_COMMIT + "/" + urllib.parse.quote(MAP_PATH, safe="/")
)
CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt"
SESSION_ID = "vcsl_concert_harp_cc0"


def _request(url: str, timeout: int = 90) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "MEHRAN-Music-Engine/1.0"})
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


def _git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def _verified_raw(url: str, expected_sha: str, label: str) -> bytes:
    data = _request(url)
    actual = _git_blob_sha(data)
    if actual != expected_sha:
        raise ValueError(f"Pinned Git blob SHA-1 mismatch for {label}: {actual}")
    return data


def _map_coverage(regions: list[dict[str, Any]]) -> dict[str, Any]:
    active_counts: dict[int, list[int]] = {}
    for region in regions:
        low, high = region["key_range"]
        vlow, vhigh = region["velocity_range"]
        for note in range(low, high + 1):
            active_counts.setdefault(note, [0] * 128)
            for velocity in range(max(1, vlow), vhigh + 1):
                active_counts[note][velocity] += 1
    notes = sorted(active_counts)
    if not notes or notes != list(range(28, 103)):
        raise ValueError(f"Concert Harp must cover every key from MIDI 28 to 102: {notes}")
    missing = [(note, velocity) for note, counts in active_counts.items()
               for velocity in range(1, 128) if counts[velocity] == 0]
    if missing:
        raise ValueError(f"Concert Harp map has key/velocity holes: {missing[:12]}")
    maximum = max(max(counts[1:]) for counts in active_counts.values())
    if maximum > 2:
        raise ValueError(f"Unexpectedly more than two simultaneous harp regions: {maximum}")
    overlaps = sum(
        1 for counts in active_counts.values()
        for velocity in range(1, 128) if counts[velocity] > 1
    )
    return {
        "midi_min": notes[0],
        "midi_max": notes[-1],
        "mapped_keys": len(notes),
        "key_velocity_combinations_with_two_source_regions": overlaps,
        "maximum_regions_per_key_velocity": maximum,
    }


def import_vcsl_concert_harp(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    if root.exists():
        raise ValueError(f"Output directory already exists: {root}")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize original VCSL WAV files to PCM16")

    map_bytes = _verified_raw(MAP_RAW, MAP_BLOB_SHA, MAP_PATH)
    sfz_text = map_bytes.decode("utf-8-sig")
    regions = parse_sfz_regions(sfz_text)
    if len(regions) != 45:
        raise ValueError(f"Expected 45 pinned VCSL Concert Harp regions, got {len(regions)}")
    coverage = _map_coverage(regions)

    fade_out = sum(1 for region in regions if region["crossfade"] and region["crossfade"]["direction"] == "out")
    fade_in = sum(1 for region in regions if region["crossfade"] and region["crossfade"]["direction"] == "in")
    hard_high = sum(1 for region in regions if region["velocity_range"] == [0, 100])
    hard_low = sum(1 for region in regions if region["velocity_range"] == [101, 127])
    plain = sum(1 for region in regions if region["crossfade"] is None and region["velocity_range"] == [0, 127])
    if (fade_out, fade_in, hard_high, hard_low, plain) != (21, 21, 1, 1, 1):
        raise ValueError(
            "Unexpected VCSL velocity design: "
            f"fade_out={fade_out}, fade_in={fade_in}, hard_high={hard_high}, "
            f"hard_low={hard_low}, plain={plain}"
        )

    tree_data = json.loads(_request(f"{VCSL_API}/git/trees/{VCSL_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned VCSL repository tree was truncated")
    tree = {
        item["path"]: item["sha"]
        for item in tree_data.get("tree", [])
        if item.get("type") == "blob"
    }
    license_path = "LICENSE"
    if license_path not in tree:
        raise ValueError("Pinned VCSL repository is missing its CC0 license")
    license_bytes = _verified_raw(f"{VCSL_RAW}/LICENSE", tree[license_path], license_path)
    if b"CC0 1.0 Universal" not in license_bytes:
        raise ValueError("Pinned VCSL license does not identify CC0 1.0 Universal")

    sample_names = [PurePosixPath(region["sample"]).name for region in regions]
    if len(set(sample_names)) != 45:
        raise ValueError("Pinned harp SFZ map does not reference 45 unique audio files")
    source_paths = {
        name: f"{VCSL_HARP_DIR}/{name}" for name in sample_names
    }
    missing = [path for path in source_paths.values() if path not in tree]
    if missing:
        raise ValueError(f"VCSL source commit is missing mapped harp samples: {missing[:8]}")

    root.mkdir(parents=True)
    sample_dir = root / "samples"
    sample_dir.mkdir()
    (root / "LICENSE-CC0.txt").write_bytes(license_bytes)

    def download_convert(item: tuple[str, str]) -> dict[str, Any]:
        filename, source_path = item
        source_data = _verified_raw(
            f"{VCSL_RAW}/{urllib.parse.quote(source_path, safe='/')}",
            tree[source_path],
            source_path,
        )
        source_hash = hashlib.sha256(source_data).hexdigest()
        temporary = root / ".source" / filename
        target = sample_dir / filename
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(source_data)
        try:
            with wave.open(str(temporary), "rb") as wav:
                source_info = {
                    "channels": wav.getnchannels(),
                    "sample_rate": wav.getframerate(),
                    "sample_width_bytes": wav.getsampwidth(),
                    "frames": wav.getnframes(),
                    "compression": wav.getcomptype(),
                }
        except (wave.Error, EOFError) as exc:
            raise ValueError(f"Invalid VCSL WAV file: {source_path}") from exc
        if source_info["compression"] != "NONE" or source_info["frames"] <= 0:
            raise ValueError(f"Unsupported or empty VCSL WAV: {source_path}")
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(temporary),
             "-c:a", "pcm_s16le", str(target)],
            check=True,
        )
        temporary.unlink()
        return {
            "file": filename,
            "source_git_blob_sha": tree[source_path],
            "source_sha256": source_hash,
            **source_info,
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        audio_report = list(executor.map(download_convert, sorted(source_paths.items())))
    (root / ".source").rmdir()

    entries = []
    for region in regions:
        filename = PurePosixPath(region["sample"]).name
        crossfade = region["crossfade"]
        entries.append({
            "instrument": "concert_harp",
            "midi_note": region["pitch_keycenter"],
            "velocity_min": max(1, region["velocity_range"][0]),
            "velocity_max": region["velocity_range"][1],
            "articulation": "sustain",
            "tuning_cents": region["tune_cents"],
            "sfz_volume_db": region["volume_db"],
            "offset_frames": region["offset_sample_points"],
            "velocity_fade_in": crossfade["velocity_range"] if crossfade and crossfade["direction"] == "in" else None,
            "velocity_fade_out": crossfade["velocity_range"] if crossfade and crossfade["direction"] == "out" else None,
            "playable_key_min": region["key_range"][0],
            "playable_key_max": region["key_range"][1],
            "path": f"samples/{filename}",
            "recording_session_id": SESSION_ID,
        })

    manifest = {
        "format_version": 1,
        "recording_sessions": {
            SESSION_ID: {
                "performer": "K. Smith",
                "room": "Small room, Boston, MA",
                "microphone": "2x Rode NT1-A spaced pair; 2x AT Pro 37 close",
                "audio_interface": "Focusrite Scarlett 18i8 (first generation)",
                "recorded_at": "2015-01-26",
                "notes": "Original Concert Harp recordings from VCSL. Recording details are also documented by FreePats; instrument model and reference tuning were not specified.",
            }
        },
        "samples": entries,
    }
    (root / "bank.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    provenance = {
        "instrument": "Concert Harp",
        "source_project": "Versilian Community Sample Library (VCSL)",
        "source_repository": f"https://github.com/{VCSL_REPOSITORY}",
        "source_commit": VCSL_COMMIT,
        "source_directory": VCSL_HARP_DIR,
        "mapping_repository": f"https://github.com/{MAP_REPOSITORY}",
        "mapping_commit": MAP_COMMIT,
        "mapping_path": MAP_PATH,
        "mapping_git_blob_sha": MAP_BLOB_SHA,
        "license": "CC0-1.0",
        "license_path": license_path,
        "license_sha256": hashlib.sha256(license_bytes).hexdigest(),
        "region_count": len(regions),
        "unique_recorded_samples": len(sample_names),
        "coverage": coverage,
        "velocity_design": {
            "sfz_crossfade_out_regions": fade_out,
            "sfz_crossfade_in_regions": fade_in,
            "hard_split_low_velocity_regions": hard_high,
            "hard_split_high_velocity_regions": hard_low,
            "single_layer_regions": plain,
        },
        "sample_audio": audio_report,
    }
    (root / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 45:
        raise ValueError(f"Expected 45 validated harp samples, got {len(bank.samples)}")
    return {
        "bank_root": str(root),
        "source": "VCSL original Concert Harp recordings",
        "license": "CC0-1.0",
        "source_commit": VCSL_COMMIT,
        "regions": len(regions),
        "unique_audio_files": len(sample_names),
        "playable_midi_range": [coverage["midi_min"], coverage["midi_max"]],
        "fade_out_regions": fade_out,
        "fade_in_regions": fade_in,
        "hard_split_regions": hard_high + hard_low,
        "samples_validated": len(bank.samples),
        "status": "validated_recorded_vcsl_concert_harp_bank",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", default="sample-bank-vcsl-concert-harp")
    args = parser.parse_args()
    print(json.dumps(import_vcsl_concert_harp(args.output), indent=2))


if __name__ == "__main__":
    main()
