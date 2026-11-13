"""Import the pinned CC0 VSCO-2 CE solo-violin spiccato articulation."""
from __future__ import annotations

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
SOURCE_DIR = "Strings/Solo Violin/spic"
MAP_COMMIT = "6dd651d55dde97fd4028699be9d4481f26917891"
MAP_PATH = "SViolinSpic.sfz"
MAP_BLOB_SHA = "a04d077361f034474a32b71504edc1c987655400"
MAP_LICENSE_SHA = "670154e3538863b2d9891fd5483160fbdfc89164"
MAP_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{MAP_COMMIT}"
MAP_URL = f"{MAP_ROOT}/{MAP_PATH}"
SESSION_ID = "vsco2_solo_violin_spiccato"
EXPECTED_ROOTS = (55, 57, 60, 64, 67, 69, 72, 76, 79, 81, 84, 88, 91, 93, 96)
_FILENAME = re.compile(r"LLVln_spic_([A-G]#?[0-8])_v([12])_rr([12])\.wav")
_NOTE_NAMES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
               "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


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
    if not match or match.group(1) not in _NOTE_NAMES:
        raise ValueError(f"Invalid spiccato pitch name: {name}")
    return 12 * (int(match.group(2)) + 1) + _NOTE_NAMES[match.group(1)]


def parse_spiccato_mapping(source: str, require_complete: bool = True) -> list[dict[str, Any]]:
    """Parse the pinned SFZ map, including its two sequence groups and two dynamics."""
    if not isinstance(source, str) or not source.strip():
        raise ValueError("Spiccato SFZ mapping must be non-empty text")

    groups = re.findall(r"(?is)<group>(.*?)(?=<group>|$)", source)
    if len(groups) != 2:
        raise ValueError(f"Expected two spiccato round-robin groups, got {len(groups)}")

    sequence_positions = []
    for group in groups:
        length = re.search(r"(?im)^\s*seq_length\s*=\s*(\d+)", group)
        position = re.search(r"(?im)^\s*seq_position\s*=\s*(\d+)", group)
        if not length or int(length.group(1)) != 2 or not position:
            raise ValueError("Each spiccato group must declare seq_length=2 and seq_position")
        sequence_positions.append(int(position.group(1)))
    if sequence_positions != [1, 2]:
        raise ValueError(f"Unexpected spiccato sequence positions: {sequence_positions}")

    regions = parse_sfz_regions(source)
    group_region_counts = [len(re.findall(r"(?im)^\s*<region>\s*$", group)) for group in groups]
    if group_region_counts[0] != group_region_counts[1]:
        raise ValueError("Spiccato round-robin groups must contain matching region counts")
    split = group_region_counts[0]
    if split + group_region_counts[1] != len(regions):
        raise ValueError("Could not align parsed spiccato regions with sequence groups")

    mapped = []
    for index, region in enumerate(regions):
        filename = PurePosixPath(region["sample"].replace("\\", "/")).name
        match = _FILENAME.fullmatch(filename)
        if not match:
            raise ValueError(f"Unexpected spiccato sample filename: {filename}")
        pitch_name, velocity_layer, rr_name = match.groups()
        rr = int(rr_name)
        expected_rr = 1 if index < split else 2
        if rr != expected_rr:
            raise ValueError(f"SFZ sequence group does not match filename round robin: {filename}")
        midi_note = _note_number(pitch_name)
        if region["pitch_keycenter"] != midi_note:
            raise ValueError(f"SFZ root does not match recorded pitch in {filename}")
        expected_velocity = [0, 62] if velocity_layer == "1" else [63, 127]
        if region["velocity_range"] != expected_velocity:
            raise ValueError(f"Unexpected source velocity layer in {filename}: {region['velocity_range']}")
        mapped.append({
            "filename": filename,
            "source_path": f"{SOURCE_DIR}/{filename}",
            "midi_note": midi_note,
            "velocity_min": max(1, region["velocity_range"][0]),
            "velocity_max": region["velocity_range"][1],
            "articulation": "spiccato",
            "round_robin_index": rr - 1,
            "playable_key_min": region["key_range"][0],
            "playable_key_max": region["key_range"][1],
            "sfz_volume_db": region["volume_db"],
            "velocity_layer": int(velocity_layer),
            "sequence_position": rr,
        })

    names = [item["filename"] for item in mapped]
    if len(names) != len(set(names)):
        raise ValueError("Spiccato SFZ map references a sample more than once")

    if require_complete:
        if len(mapped) != 60:
            raise ValueError(f"Expected 60 mapped spiccato recordings, got {len(mapped)}")
        if tuple(sorted({item["midi_note"] for item in mapped})) != EXPECTED_ROOTS:
            raise ValueError("Spiccato map does not contain the 15 expected recorded pitch centers")
        for root in EXPECTED_ROOTS:
            note_items = [item for item in mapped if item["midi_note"] == root]
            expected = {
                (1, 0, 1, 62), (1, 1, 1, 62),
                (2, 0, 63, 127), (2, 1, 63, 127),
            }
            actual = {
                (item["velocity_layer"], item["round_robin_index"],
                 item["velocity_min"], item["velocity_max"])
                for item in note_items
            }
            if actual != expected:
                raise ValueError(f"Incomplete spiccato velocity/RR coverage for MIDI {root}")
    return mapped


def import_vsco2_solo_violin_spiccato(bank_root: str | Path) -> dict[str, Any]:
    root = Path(bank_root).resolve()
    manifest_path = root / "bank.json"
    provenance_path = root / "provenance.json"
    if not manifest_path.is_file() or not provenance_path.is_file():
        raise ValueError("The validated VSCO solo-violin base bank must exist first")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize recorded spiccato WAV files")

    map_bytes = _request(MAP_URL)
    if _git_blob_sha(map_bytes) != MAP_BLOB_SHA:
        raise ValueError("Pinned SViolinSpic.sfz mapping blob mismatch")
    map_license = _request(f"{MAP_ROOT}/LICENSE")
    if _git_blob_sha(map_license) != MAP_LICENSE_SHA or b"CC0 1.0 Universal" not in map_license:
        raise ValueError("Pinned spiccato mapping revision does not have the expected CC0 license")
    mapped = parse_spiccato_mapping(map_bytes.decode("utf-8-sig"))

    tree_data = json.loads(_request(SOURCE_TREE_URL))
    if tree_data.get("truncated"):
        raise ValueError("Pinned VSCO source tree was truncated")
    tree = {item["path"]: item["sha"] for item in tree_data.get("tree", [])
            if item.get("type") == "blob"}
    missing = [item["source_path"] for item in mapped if item["source_path"] not in tree]
    if missing:
        raise ValueError(f"Pinned VSCO source commit is missing spiccato samples: {missing[:8]}")

    source_license = _request(f"{SOURCE_ROOT}/LICENSE")
    license_item = tree.get("LICENSE")
    if not license_item or _git_blob_sha(source_license) != license_item:
        raise ValueError("Pinned VSCO source license does not match its repository tree")
    if b"CC0 1.0 Universal" not in source_license:
        raise ValueError("Pinned VSCO sample source is not CC0")

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source_data = _request(
            f"{SOURCE_ROOT}/{urllib.parse.quote(item['source_path'], safe='/')}"
        )
        if _git_blob_sha(source_data) != tree[item["source_path"]]:
            raise ValueError(f"Pinned source blob mismatch: {item['source_path']}")
        source_sha256 = hashlib.sha256(source_data).hexdigest()
        temporary = root / ".spiccato-source" / item["filename"]
        target_relative = f"recordings/spiccato/{item['filename']}"
        target = root / target_relative
        temporary.parent.mkdir(parents=True, exist_ok=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(source_data)
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(temporary),
             "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", str(target)],
            check=True,
        )
        temporary.unlink()
        return {
            **item,
            "path": target_relative,
            "source_git_blob_sha": tree[item["source_path"]],
            "source_sha256": source_sha256,
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        ready = list(executor.map(prepare, mapped))
    (root / ".spiccato-source").rmdir()

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if SESSION_ID in manifest.get("recording_sessions", {}):
        raise ValueError("Spiccato recording session is already present in the violin bank")
    manifest.setdefault("recording_sessions", {})[SESSION_ID] = {
        "instrument_model": "VSCO 2 Community Edition Solo Violin",
        "performer": "Lily Lyons",
        "notes": (
            "Pinned CC0 solo-violin spiccato recordings. The official SFZ map defines "
            "two velocity layers (1-62 and 63-127), two sequence positions, original "
            "playable key zones, and source SFZ volume values."
        ),
    }
    for item in ready:
        manifest["samples"].append({
            "instrument": "solo_violin",
            "midi_note": item["midi_note"],
            "velocity_min": item["velocity_min"],
            "velocity_max": item["velocity_max"],
            "articulation": "spiccato",
            "round_robin_index": item["round_robin_index"],
            "recording_session_id": SESSION_ID,
            "playable_key_min": item["playable_key_min"],
            "playable_key_max": item["playable_key_max"],
            "sfz_volume_db": item["sfz_volume_db"],
            "path": item["path"],
        })
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    provenance["sample_count"] = len(manifest["samples"])
    provenance["spiccato_count"] = len(ready)
    provenance["spiccato_mapping"] = {
        "repository": f"https://github.com/{SOURCE_REPOSITORY}",
        "sample_source_commit": SOURCE_COMMIT,
        "mapping_commit": MAP_COMMIT,
        "mapping_path": MAP_PATH,
        "mapping_blob_sha": MAP_BLOB_SHA,
        "mapping_license": "CC0-1.0",
        "mapping_license_blob_sha": MAP_LICENSE_SHA,
        "velocity_layers": [[1, 62], [63, 127]],
        "round_robin_positions": [1, 2],
        "recorded_pitch_centers": list(EXPECTED_ROOTS),
        "samples": ready,
    }
    provenance.setdefault("samples", []).extend(ready)
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    return {
        "status": "validated_vsco2_cc0_solo_violin_spiccato",
        "samples": len(ready),
        "recorded_pitch_centers": len(EXPECTED_ROOTS),
        "velocity_layers": 2,
        "round_robin_takes_per_layer": 2,
        "license": "CC0-1.0",
    }
