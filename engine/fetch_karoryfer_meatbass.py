"""Import Karoryfer Meatbass pizzicato recordings under their pinned CC0 license."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SOURCE_REPOSITORY = "sfzinstruments/karoryfer.meatbass"
SOURCE_COMMIT = "ac9e859564bda286ab5ec672d00ff1aa2fef2895"
SOURCE_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
MAP_PATH = "Programs/pizz_basic_map.sfz"
EXPECTED_NOTES = [21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60]
EXPECTED_LAYERS = [(1, 32), (33, 64), (65, 96), (97, 127)]


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


def _download_verified(path: str, expected_sha: str, destination: Path) -> bytes:
    data = _request(f"{SOURCE_ROOT}/{path}")
    actual = hashlib.sha1(
        b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    ).hexdigest()
    if actual != expected_sha:
        raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return data


def parse_meatbass_pizz_sfz(sfz_text: str, *, require_complete: bool = True) -> list[dict[str, Any]]:
    """Parse only explicitly mapped pitched pizzicato regions from the basic SFZ map."""
    if not isinstance(require_complete, bool):
        raise ValueError("require_complete must be a boolean")
    group: dict[str, str] = {}
    region: dict[str, str] | None = None
    regions: list[dict[str, Any]] = []

    def flush() -> None:
        if region is None:
            return
        attrs = {**group, **region}
        sample = attrs.get("sample", "").replace("\\", "/")
        if not sample.startswith("../Samples/pizz/"):
            return
        filename = Path(sample).name
        import re
        match = re.fullmatch(r"([a-z]+\d)_vl([1-4])_rr([1-4])\.wav", filename)
        if not match:
            # The source SFZ also maps percussion hits.
            # Import only pitched, velocity-layered pizzicato recordings.
            return
        note_name, layer, rr = match.groups()
        pitch = {"a": 9, "c": 0, "eb": 3, "gb": 6}[note_name.rstrip("0123456789")]
        octave = int(note_name[-1])
        midi_note = 12 * (octave + 1) + pitch
        low_key = int(attrs.get("lokey", "-1"))
        high_key = int(attrs.get("hikey", "-1"))
        if not 0 <= low_key <= midi_note <= high_key <= 127:
            raise ValueError(f"Invalid Meatbass key zone for {filename}")
        velocity_min = int(attrs.get("lovel", "1"))
        velocity_max = int(attrs.get("hivel", "127"))
        if not 1 <= velocity_min <= velocity_max <= 127:
            raise ValueError(f"Invalid Meatbass velocity zone for {filename}")
        expected = EXPECTED_LAYERS[int(layer) - 1]
        if (velocity_min, velocity_max) != expected:
            raise ValueError(
                f"Unexpected velocity mapping for {filename}: "
                f"{velocity_min}-{velocity_max}, expected {expected}"
            )
        regions.append({
            "midi_note": midi_note,
            "velocity_min": velocity_min,
            "velocity_max": velocity_max,
            "round_robin_index": int(rr) - 1,
            "low_key": low_key,
            "high_key": high_key,
            "source_path": "Samples/pizz/" + filename,
            "filename": filename,
        })

    for line in sfz_text.splitlines():
        token = line.split("//", 1)[0].strip()
        if not token:
            continue
        if token == "<group>":
            flush()
            region = None
            group = {}
        elif token == "<region>":
            flush()
            region = {}
        else:
            import re
            match = re.fullmatch(r"([a-zA-Z0-9_]+)\s*=\s*(\S+)", token)
            if match:
                if region is None:
                    group[match.group(1)] = match.group(2)
                else:
                    region[match.group(1)] = match.group(2)
    flush()

    if len({item["source_path"] for item in regions}) != len(regions):
        raise ValueError("Duplicate Meatbass source mapping")
    if require_complete:
        notes = sorted({item["midi_note"] for item in regions})
        if notes != EXPECTED_NOTES:
            raise ValueError(f"Unexpected Meatbass recorded pitch centers: {notes}")
        expected_count = len(EXPECTED_NOTES) * len(EXPECTED_LAYERS) * 4
        if len(regions) != expected_count:
            raise ValueError(f"Expected {expected_count} mapped Meatbass takes, got {len(regions)}")
        groups: dict[tuple[int, int, int], list[int]] = {}
        for item in regions:
            key = (item["midi_note"], item["velocity_min"], item["velocity_max"])
            groups.setdefault(key, []).append(item["round_robin_index"])
        for key, indices in groups.items():
            if sorted(indices) != [0, 1, 2, 3]:
                raise ValueError(f"Incomplete Meatbass round robin for {key}: {sorted(indices)}")
        expected_groups = len(EXPECTED_NOTES) * len(EXPECTED_LAYERS)
        if len(groups) != expected_groups:
            raise ValueError(f"Expected {expected_groups} note/velocity groups, got {len(groups)}")
    return regions


def import_meatbass_pizzicato(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    if root.exists():
        raise ValueError(f"Output directory already exists: {root}")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize Meatbass WAV files")
    api = f"https://api.github.com/repos/{SOURCE_REPOSITORY}"
    tree_data = json.loads(_request(f"{api}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned Meatbass source tree was truncated")
    tree = {
        item["path"]: item["sha"]
        for item in tree_data.get("tree", [])
        if item.get("type") == "blob"
    }
    required = [MAP_PATH, "LICENSE", "readme.txt"]
    missing = [path for path in required if path not in tree]
    if missing:
        raise ValueError(f"Pinned Meatbass source is missing files: {missing}")
    map_bytes = _download_verified(MAP_PATH, tree[MAP_PATH], root / "source" / "pizz_basic_map.sfz")
    license_bytes = _download_verified("LICENSE", tree["LICENSE"], root / "LICENSE-CC0.txt")
    if b"CC0 1.0 Universal" not in license_bytes:
        raise ValueError("Pinned Meatbass license is not CC0 1.0 Universal")
    regions = parse_meatbass_pizz_sfz(map_bytes.decode("utf-8-sig"))
    for item in regions:
        if item["source_path"] not in tree:
            raise ValueError(f"Missing pinned Meatbass audio: {item['source_path']}")

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source = root / "source-wav" / item["filename"]
        _download_verified(item["source_path"], tree[item["source_path"]], source)
        relative = f"pizzicato/v{item['velocity_min']}-{item['velocity_max']}/{item['filename']}"
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
    session_id = "karoryfer_meatbass_pizzicato"
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "1958 Otto Rubner double bass",
                "performer": "Drogomir Smolken",
                "tuning": "Fifths tuning CGDA",
                "notes": (
                    "Pinned CC0 Karoryfer Meatbass pizzicato recordings. Recorded by Ludwik Zamenhof. "
                    "Four recorded velocity layers (1-32, 33-64, 65-96, 97-127) "
                    "and four recorded round-robin takes per pitch/layer. "
                    "Only regions in the basic pizzicato map are imported."
                ),
            }
        },
        "samples": [{
            "instrument": "contrabass",
            "midi_note": item["midi_note"],
            "velocity_min": item["velocity_min"],
            "velocity_max": item["velocity_max"],
            "articulation": "pizzicato",
            "round_robin_index": item["round_robin_index"],
            "one_shot": False,
            "recording_session_id": session_id,
            "path": item["path"],
        } for item in prepared],
    }
    (root / "bank.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    provenance = {
        "source_repository": SOURCE_REPOSITORY,
        "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0",
        "license_file": "LICENSE-CC0.txt",
        "mapping_path": MAP_PATH,
        "mapping_git_blob_sha": tree[MAP_PATH],
        "recorded_pitch_centers": EXPECTED_NOTES,
        "velocity_layers": [list(layer) for layer in EXPECTED_LAYERS],
        "round_robin_takes_per_group": 4,
        "samples": [{
            key: item[key] for key in (
                "path", "source_path", "source_git_blob_sha", "midi_note",
                "velocity_min", "velocity_max", "round_robin_index",
                "low_key", "high_key",
            )
        } for item in prepared],
    }
    (root / "provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != len(regions):
        raise ValueError("Meatbass sample count differs from the validated SFZ map")
    if any(sample.sample_rate != 44100 or sample.channels != 1 for sample in bank.samples):
        raise ValueError("Meatbass samples must be normalized mono 44.1 kHz PCM")
    return {
        "status": "validated_recorded_karoryfer_meatbass_pizzicato",
        "samples": len(bank.samples),
        "recorded_pitch_centers": EXPECTED_NOTES,
        "velocity_layers": [list(layer) for layer in EXPECTED_LAYERS],
        "round_robin_takes_per_group": 4,
        "license": "CC0-1.0",
        "source_commit": SOURCE_COMMIT,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(import_meatbass_pizzicato(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
