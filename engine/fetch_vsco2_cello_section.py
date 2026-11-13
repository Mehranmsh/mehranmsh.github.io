"""Import the pinned CC0 VSCO-2 CE cello-section recordings and SFZ maps."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

from sfz_region_parser import parse_sfz_regions

SOURCE_REPOSITORY = "sgossner/VSCO-2-CE"
SOURCE_COMMIT = "440300901dfe9275fd84e0b7763af1f8443ae62e"
SOURCE_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
SOURCE_TREE_URL = f"https://api.github.com/repos/{SOURCE_REPOSITORY}/git/trees/{SOURCE_COMMIT}?recursive=1"
MAP_COMMIT = "6dd651d55dde97fd4028699be9d4481f26917891"
MAP_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{MAP_COMMIT}"
LICENSE_BLOB_SHA = "670154e3538863b2d9891fd5483160fbdfc89164"
SESSION_ID = "vsco2_cello_section"
INSTRUMENT_ID = "cello_section"
MAPS = {
    "pizzicato": {"file": "CelloEnsPizz.sfz", "sha": "5f1b075f5adfecab3556f14a3d45890b1b7c1bfb", "regions": 52, "articulation": "pizzicato", "rr": 2},
    "spiccato": {"file": "CelloEnsSpic.sfz", "sha": "5f60a7a6eb7ed8de53e60dd8145453691cb881b3", "regions": 52, "articulation": "spiccato", "rr": 2},
    "sustain_quiet": {"file": "CelloEnsSusVib-Quiet.sfz", "sha": "dac0009b38effd46d19311bc5243d64be8bd1350", "regions": 14, "articulation": "sustain_vibrato_quiet", "rr": 1},
    "sustain_vibrato": {"file": "CelloEnsSusVib.sfz", "sha": "9b34afd020314d1bfa01d5578c9b30aae9cdc603", "regions": 27, "articulation": "sustain_vibrato", "rr": 1},
    "tremolo": {"file": "CelloEnsTrem.sfz", "sha": "263ae2dd32d6058c441d1ad4071f3d8c4fc888d0", "regions": 25, "articulation": "tremolo", "rr": 1},
}
NOTE_NAMES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
              "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
FILENAME = re.compile(r"(?:pizzT|spic|susvib|trem)_([A-G]#?[0-8])_v([1-3])_(?:RR([1-2])|(\d+))\.wav")


def _request(url: str, timeout: int = 90) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "MEHRAN-Music-Engine/1.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in {408, 425, 429} and not 500 <= exc.code <= 599:
                raise
            if attempt == 4:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 4:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("download retries exhausted")


def _git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def _note_number(name: str) -> int:
    match = re.fullmatch(r"([A-G]#?)([0-8])", name)
    if not match or match.group(1) not in NOTE_NAMES:
        raise ValueError(f"Invalid cello-section pitch name: {name}")
    # VSCO's cello-section filenames use the same octave convention as its SFZ roots.
    return 12 * (int(match.group(2)) + 2) + NOTE_NAMES[match.group(1)]


def _parse_map(source: str, map_key: str) -> list[dict[str, Any]]:
    spec = MAPS[map_key]
    if not isinstance(source, str) or not source.strip():
        raise ValueError(f"{map_key} SFZ mapping must be non-empty text")

    sequence_positions: list[int] = []
    groups = re.findall(r"(?is)<group>(.*?)(?=<group>|$)", source)
    if spec["rr"] == 2:
        if len(groups) != 2:
            raise ValueError(f"{map_key} must contain two round-robin groups")
        for group in groups:
            length = re.search(r"(?im)^\s*seq_length\s*=\s*(\d+)", group)
            position = re.search(r"(?im)^\s*seq_position\s*=\s*(\d+)", group)
            if not length or int(length.group(1)) != 2 or not position:
                raise ValueError(f"{map_key} round-robin group metadata is incomplete")
            sequence_positions.append(int(position.group(1)))
        if sequence_positions != [1, 2]:
            raise ValueError(f"{map_key} has unexpected round-robin order: {sequence_positions}")
        group_counts = [len(re.findall(r"(?im)^\s*<region>\s*$", group)) for group in groups]
        if group_counts[0] != group_counts[1]:
            raise ValueError(f"{map_key} round-robin groups have different region counts")
    else:
        # SFZ uses a single ordinary <group> container for non-RR articulations.
        # It is not a round robin unless sequence metadata is explicitly present.
        if len(groups) != 1:
            raise ValueError(f"{map_key} must contain exactly one non-RR group")
        if re.search(r"(?im)^\\s*seq_(?:length|position)\\s*=", groups[0]):
            raise ValueError(f"{map_key} unexpectedly declares round-robin sequence metadata")

    region_source = re.sub(r"(?im)^\s*(?:seq_length|seq_position|group_label)\s*=.*$", "", source)
    regions = parse_sfz_regions(region_source)
    if len(regions) != spec["regions"]:
        raise ValueError(f"{map_key} expected {spec['regions']} regions, got {len(regions)}")

    default_match = re.search(r"(?im)^\s*default_path\s*=\s*(.+?)\s*$", source)
    if not default_match:
        raise ValueError(f"{map_key} has no default_path")
    default_path = default_match.group(1).replace("\\", "/").strip("/")
    if not default_path.startswith("Strings/Cello Section/"):
        raise ValueError(f"{map_key} points outside the official cello-section source directory")

    mapped = []
    for index, region in enumerate(regions):
        filename = PurePosixPath(region["sample"].replace("\\", "/")).name
        match = FILENAME.fullmatch(filename)
        if not match:
            raise ValueError(f"Unexpected cello-section filename in {map_key}: {filename}")
        pitch_name, velocity_layer, rr_name, take_name = match.groups()
        midi_note = _note_number(pitch_name)
        if region["pitch_keycenter"] != midi_note:
            raise ValueError(f"SFZ root does not match filename pitch: {filename}")
        rr_index = int(rr_name) - 1 if rr_name else 0
        if spec["rr"] == 2:
            expected_rr = 0 if index < spec["regions"] // 2 else 1
            if rr_index != expected_rr:
                raise ValueError(f"{map_key} sequence group disagrees with filename: {filename}")
        velocity = region["velocity_range"]
        if velocity[0] == 0:
            velocity_min = 1
        else:
            velocity_min = velocity[0]
        mapped.append({
            "filename": filename,
            "source_path": f"{default_path}/{filename}",
            "midi_note": midi_note,
            "velocity_min": velocity_min,
            "velocity_max": velocity[1],
            "articulation": spec["articulation"],
            "round_robin_index": rr_index,
            "playable_key_min": region["key_range"][0],
            "playable_key_max": region["key_range"][1],
            "sfz_volume_db": region["volume_db"],
            "velocity_layer": int(velocity_layer),
            "map_key": map_key,
            "take": take_name,
        })

    if spec["rr"] == 2:
        roots = {item["midi_note"] for item in mapped}
        if len(roots) != 13:
            raise ValueError(f"{map_key} must map 13 recorded pitch centers")
        for root in roots:
            takes = [item for item in mapped if item["midi_note"] == root]
            if {item["round_robin_index"] for item in takes} != {0, 1}:
                raise ValueError(f"{map_key} is missing a round-robin take at MIDI {root}")
    return mapped


def parse_cello_section_maps(maps: dict[str, str]) -> list[dict[str, Any]]:
    if set(maps) != set(MAPS):
        raise ValueError("All five official cello-section SFZ maps are required")
    result = []
    for key in MAPS:
        result.extend(_parse_map(maps[key], key))
    if len(result) != 170:
        raise ValueError(f"Expected 170 cello-section SFZ regions, got {len(result)}")
    unique_paths = {item["source_path"] for item in result}
    if len(unique_paths) != 156:
        raise ValueError(f"Expected 156 unique cello-section recordings, got {len(unique_paths)}")
    return result


def build(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize recorded cello-section WAV files")

    tree_data = json.loads(_request(SOURCE_TREE_URL))
    if tree_data.get("truncated"):
        raise ValueError("Pinned VSCO cello source tree was truncated")
    source_tree = {item["path"]: item["sha"] for item in tree_data.get("tree", [])
                   if item.get("type") == "blob"}
    license_bytes = _request(f"{SOURCE_ROOT}/LICENSE")
    if _git_blob_sha(license_bytes) != LICENSE_BLOB_SHA or b"CC0 1.0 Universal" not in license_bytes:
        raise ValueError("Pinned VSCO cello source license is not the expected CC0 license")

    map_texts = {}
    for key, spec in MAPS.items():
        data = _request(f"{MAP_ROOT}/{spec['file']}")
        if _git_blob_sha(data) != spec["sha"]:
            raise ValueError(f"Pinned SFZ map blob mismatch: {spec['file']}")
        map_texts[key] = data.decode("utf-8-sig")
    mapped = parse_cello_section_maps(map_texts)

    unique_paths = sorted({item["source_path"] for item in mapped})
    missing = [path for path in unique_paths if path not in source_tree]
    if missing:
        raise ValueError(f"Pinned cello source commit is missing mapped samples: {missing[:8]}")

    (root / "LICENSE-CC0.txt").write_bytes(license_bytes)
    source_by_path: dict[str, dict[str, str]] = {}

    def prepare(source_path: str) -> dict[str, str]:
        raw = _request(f"{SOURCE_ROOT}/{urllib.parse.quote(source_path, safe='/')}")
        expected = source_tree[source_path]
        if _git_blob_sha(raw) != expected:
            raise ValueError(f"Pinned cello sample blob mismatch: {source_path}")
        filename = PurePosixPath(source_path).name
        relative = f"recordings/{PurePosixPath(source_path).parent.name}/{filename}"
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = root / ".source-wav" / filename
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(raw)
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(temporary),
                        "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", str(target)],
                       check=True)
        temporary.unlink()
        return {"path": relative, "source_git_blob_sha": expected,
                "source_sha256": hashlib.sha256(raw).hexdigest()}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        prepared = list(executor.map(prepare, unique_paths))
    (root / ".source-wav").rmdir()
    source_by_path = dict(zip(unique_paths, prepared))

    manifest = {
        "format_version": 1,
        "recording_sessions": {
            SESSION_ID: {
                "instrument_model": "VSCO 2 Community Edition Cello Section",
                "performer": "VSCO 2 CE ensemble recording",
                "notes": "Pinned CC0 source. Five official SFZ maps are preserved as separate articulations; original velocity zones, key zones, SFZ gain, and two-take round robins are retained where defined. The quiet sustain patch reuses the same low-layer recordings as the main sustain patch and remains a distinct articulation mapping."
            }
        },
        "samples": []
    }
    for item in mapped:
        source = source_by_path[item["source_path"]]
        manifest["samples"].append({
            "instrument": INSTRUMENT_ID,
            "midi_note": item["midi_note"],
            "velocity_min": item["velocity_min"],
            "velocity_max": item["velocity_max"],
            "articulation": item["articulation"],
            "round_robin_index": item["round_robin_index"],
            "recording_session_id": SESSION_ID,
            "playable_key_min": item["playable_key_min"],
            "playable_key_max": item["playable_key_max"],
            "sfz_volume_db": item["sfz_volume_db"],
            "path": source["path"]
        })
    (root / "bank.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    provenance = {
        "source_repository": SOURCE_REPOSITORY,
        "source_commit": SOURCE_COMMIT,
        "mapping_commit": MAP_COMMIT,
        "license": "CC0-1.0",
        "instrument": INSTRUMENT_ID,
        "source_recording_count": len(unique_paths),
        "mapping_region_count": len(mapped),
        "maps": {key: {"file": spec["file"], "blob_sha": spec["sha"],
                       "articulation": spec["articulation"], "regions": spec["regions"]}
                 for key, spec in MAPS.items()},
        "recordings": [
            {"source_path": path, **source_by_path[path]}
            for path in unique_paths
        ],
        "mapping_entries": mapped
    }
    (root / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 170:
        raise ValueError(f"Expected 170 validated cello-section entries, got {len(bank.samples)}")
    if any(sample.instrument != INSTRUMENT_ID or sample.sample_rate != 44100 or sample.channels != 1
           for sample in bank.samples):
        raise ValueError("Cello-section bank validation failed")
    return {
        "status": "validated_vsco2_cc0_cello_section",
        "instrument": INSTRUMENT_ID,
        "recordings": len(unique_paths),
        "mapping_entries": len(bank.samples),
        "articulations": sorted({sample.articulation for sample in bank.samples}),
        "license": "CC0-1.0"
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.output_root), indent=2))