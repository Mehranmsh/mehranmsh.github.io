"""Import pinned CC0 Karoryfer Babyblue picked electric-bass recordings."""
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
import urllib.request
from pathlib import Path
from typing import Any

SOURCE_REPOSITORY = "sfzinstruments/karoryfer.black-and-blue-basses"
SOURCE_COMMIT = "6e7d674cdb41be7a54dbccb15472401ad01099b9"
API_ROOT = f"https://api.github.com/repos/{SOURCE_REPOSITORY}"
RAW_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
MAPS = {
    "f": {"path": "Programs/maps/babyblue_reg_f_map.sfz", "velocity": [1, 63], "expected_rr": 4},
    "ff": {"path": "Programs/maps/babyblue_reg_ff_map.sfz", "velocity": [64, 127], "expected_rr": 8},
}
EXPECTED_NOTES = list(range(35, 76))


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


def _download_verified(path: str, expected_sha: str, destination: Path) -> None:
    data = _request(f"{RAW_ROOT}/{path}")
    actual = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
    if actual != expected_sha:
        raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)


def parse_babyblue_map(
    sfz_text: str, layer: str, *, require_complete: bool = True
) -> list[dict[str, Any]]:
    if layer not in MAPS:
        raise ValueError("Unsupported Babyblue velocity layer")
    if not isinstance(require_complete, bool):
        raise ValueError("require_complete must be a boolean")
    spec = MAPS[layer]
    regions: list[dict[str, Any]] = []
    for block in re.split(r"<region>\s*", sfz_text)[1:]:
        attrs = dict(re.findall(r"^\s*([a-z_]+)\s*=\s*([^\s]+)", block, re.MULTILINE))
        sample = attrs.get("sample", "").replace("\\", "/")
        match = re.fullmatch(
            rf"\.\./Samples/babyblue/reg/babyblue_[a-z0-9]+_{layer}_rr([1-{spec['expected_rr']}])\.wav",
            sample,
        )
        if not match:
            raise ValueError(f"Unexpected Babyblue source sample path: {sample}")
        low_key = int(attrs.get("lokey", "-1"))
        high_key = int(attrs.get("hikey", "-1"))
        center = int(attrs.get("pitch_keycenter", "-1"))
        if low_key != high_key or center != low_key or not 0 <= center <= 127:
            raise ValueError(f"Babyblue sample must map to one exact recorded pitch: {sample}")
        seq_length = int(attrs.get("seq_length", "1"))
        seq_position = int(attrs.get("seq_position", "1"))
        if seq_length != 8 or not 1 <= seq_position <= 8:
            raise ValueError(f"Unexpected Babyblue round-robin mapping: {sample}")
        rr = int(match.group(1)) - 1
        regions.append({
            "midi_note": center, "round_robin_index": rr,
            "source_path": "Samples/babyblue/reg/" + Path(sample).name,
            "filename": Path(sample).name, "seq_position": seq_position,
        })
    by_note: dict[int, list[dict[str, Any]]] = {}
    for region in regions:
        by_note.setdefault(region["midi_note"], []).append(region)
    if require_complete and sorted(by_note) != EXPECTED_NOTES:
        raise ValueError("Babyblue map must cover every recorded note from MIDI 35 through 75")
    for note, entries in by_note.items():
        if len(entries) != 8 or sorted(x["seq_position"] for x in entries) != list(range(1, 9)):
            raise ValueError(f"Babyblue note {note} must preserve all eight SFZ sequence positions")
        rr_indices = sorted({x["round_robin_index"] for x in entries})
        if rr_indices != list(range(spec["expected_rr"])):
            raise ValueError(f"Babyblue note {note} has incomplete recorded round-robin takes")
        filenames = [x["filename"] for x in entries]
        if len(set(filenames)) != spec["expected_rr"]:
            raise ValueError(f"Unexpected number of unique recorded takes for note {note}")
        if layer == "f" and any(filenames.count(name) != 2 for name in set(filenames)):
            raise ValueError(f"Low velocity map must repeat each of its four takes twice for note {note}")
        if layer == "ff" and len(set(filenames)) != 8:
            raise ValueError(f"High velocity map must contain eight unique takes for note {note}")
    unique: dict[str, dict[str, Any]] = {}
    for region in regions:
        unique[region["filename"]] = region
    return list(unique.values())


def fetch_babyblue_bass(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize verified source WAV files")
    tree_data = json.loads(_request(f"{API_ROOT}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned Babyblue source tree was truncated")
    tree = {x["path"]: x["sha"] for x in tree_data.get("tree", []) if x.get("type") == "blob"}
    required = ["license", *[x["path"] for x in MAPS.values()]]
    missing = [path for path in required if path not in tree]
    if missing:
        raise ValueError(f"Pinned Babyblue source is missing files: {missing}")
    license_path = root / "LICENSE-CC0.txt"
    _download_verified("license", tree["license"], license_path)
    regions: list[dict[str, Any]] = []
    for layer, spec in MAPS.items():
        map_path = root / "source-maps" / Path(spec["path"]).name
        _download_verified(spec["path"], tree[spec["path"]], map_path)
        parsed = parse_babyblue_map(map_path.read_text(encoding="utf-8"), layer)
        for item in parsed:
            regions.append({
                **item, "velocity_min": spec["velocity"][0],
                "velocity_max": spec["velocity"][1], "layer": layer,
            })
    if len(regions) != 492:
        raise ValueError(f"Expected 492 unique recorded Babyblue takes, got {len(regions)}")
    if len({x["source_path"] for x in regions}) != len(regions):
        raise ValueError("Duplicate Babyblue source sample path")
    for item in regions:
        if item["source_path"] not in tree:
            raise ValueError(f"Missing pinned source audio: {item['source_path']}")

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source = root / "source-wav" / item["filename"]
        _download_verified(item["source_path"], tree[item["source_path"]], source)
        relative = f"picked/{item['layer']}/{item['filename']}"
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(source), "-ac", "1",
             "-ar", "44100", "-c:a", "pcm_s16le", str(target)],
            check=True,
        )
        return {**item, "path": relative, "source_git_blob_sha": tree[item["source_path"]]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        prepared = list(executor.map(prepare, regions))
    session_id = "karoryfer_babyblue_picked"
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "Karoryfer Babyblue five-string electric bass",
                "notes": (
                    "Pinned CC0 Babyblue regular picked-bass SFZ maps. The original "
                    "f layer is mapped to MIDI velocities 1-63 with four unique "
                    "recorded round-robin takes per note; the ff layer is mapped to "
                    "velocities 64-127 with eight unique takes per note. Source maps "
                    "cover recorded MIDI notes 35-75. Every WAV is verified against "
                    "its pinned Git blob SHA-1 before conversion to mono 44.1 kHz PCM16."
                ),
            }
        },
        "samples": [{
            "instrument": "electric_bass", "midi_note": x["midi_note"],
            "velocity_min": x["velocity_min"], "velocity_max": x["velocity_max"],
            "articulation": "picked", "round_robin_index": x["round_robin_index"],
            "one_shot": False, "recording_session_id": session_id, "path": x["path"],
        } for x in prepared],
    }
    (root / "bank.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    provenance = {
        "source_repository": SOURCE_REPOSITORY, "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0", "license_file": "LICENSE-CC0.txt",
        "instrument": "Karoryfer Babyblue picked electric bass",
        "recorded_midi_range": [35, 75], "velocity_layers": {"f": [1, 63], "ff": [64, 127]},
        "samples": [{
            "path": x["path"], "source_path": x["source_path"],
            "source_git_blob_sha": x["source_git_blob_sha"],
            "midi_note": x["midi_note"], "velocity_range": [x["velocity_min"], x["velocity_max"]],
            "round_robin_index": x["round_robin_index"],
        } for x in prepared],
    }
    (root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 492:
        raise ValueError("Validated electric-bass sample count does not match SFZ maps")
    if any(s.sample_rate != 44100 or s.channels != 1 or s.one_shot for s in bank.samples):
        raise ValueError("Electric-bass samples must be pitched mono 44.1 kHz PCM, not one-shots")
    return {
        "status": "validated_recorded_picked_electric_bass",
        "source_commit": SOURCE_COMMIT, "license": "CC0-1.0",
        "samples": len(bank.samples), "notes": [35, 75],
        "velocity_layers": {"f": [1, 63], "ff": [64, 127]},
        "round_robin_takes_per_note": {"f": 4, "ff": 8},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch_babyblue_bass(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
