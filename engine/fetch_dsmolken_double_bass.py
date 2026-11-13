"""Import pinned CC0 D. Smolken Rubner double-bass pizzicato recordings."""
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
import urllib.request
from pathlib import Path
from typing import Any

SOURCE_REPOSITORY = "sfzinstruments/dsmolken.double-bass"
SOURCE_COMMIT = "c2985eb647109d2a8f30a70071e3e163339d7396"
API_ROOT = f"https://api.github.com/repos/{SOURCE_REPOSITORY}"
RAW_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
SFZ_PATH = "d_smolken_rubner_bass_pizz.sfz"
EXPECTED_NOTES = [24, 27, 31, 34, 38, 41, 45, 48, 52, 55, 57]
EXPECTED_ZONES = [(1, 74), (75, 120), (121, 127)]


def _request(url: str, timeout: int = 90) -> bytes:
    headers = {
        "User-Agent": "MEHRAN-Music-Engine/1.0",
        "Accept": "application/vnd.github+json",
    }
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


def _download_verified(path: str, expected_sha: str, destination: Path) -> None:
    data = _request(f"{RAW_ROOT}/{path}")
    actual = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
    if actual != expected_sha:
        raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)


def parse_double_bass_pizz_sfz(
    sfz_text: str, *, require_complete: bool = True
) -> list[dict[str, Any]]:
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
        if not re.fullmatch(r"pizz/pizz_[a-z0-9]+_[pmf][a-d]\.wav", sample):
            return
        midi_note = int(attrs.get("pitch_keycenter", "-1"))
        low_key = int(attrs.get("lokey", "-1"))
        high_key = int(attrs.get("hikey", "-1"))
        if not 0 <= midi_note <= 127 or not 0 <= low_key <= midi_note <= high_key <= 127:
            raise ValueError(f"Invalid double-bass SFZ pitch map: {sample}")
        velocity_min = int(attrs.get("lovel", "1"))
        velocity_max = int(attrs.get("hivel", "127"))
        if not 1 <= velocity_min <= velocity_max <= 127:
            raise ValueError(f"Invalid double-bass velocity layer: {sample}")
        seq_length = int(attrs.get("seq_length", "1"))
        seq_position = int(attrs.get("seq_position", "1"))
        if seq_length not in (3, 4) or not 1 <= seq_position <= seq_length:
            raise ValueError(f"Invalid double-bass round-robin map: {sample}")
        regions.append({
            "midi_note": midi_note, "velocity_min": velocity_min,
            "velocity_max": velocity_max, "round_robin_index": seq_position - 1,
            "seq_length": seq_length, "low_key": low_key, "high_key": high_key,
            "source_path": sample, "filename": Path(sample).name,
        })

    for line in sfz_text.splitlines():
        token = line.strip()
        if token.startswith("//") or not token:
            continue
        if token == "<group>":
            flush()
            region = None
            group = {}
        elif token == "<region>":
            flush()
            region = {}
        else:
            match = re.fullmatch(r"([a-z_]+)\s*=\s*(\S+)", token)
            if match:
                if region is None:
                    group[match.group(1)] = match.group(2)
                else:
                    region[match.group(1)] = match.group(2)
    flush()

    identities = set()
    for item in regions:
        key = (item["source_path"], item["velocity_min"], item["velocity_max"])
        if key in identities:
            raise ValueError(f"Duplicate double-bass sample mapping: {key}")
        identities.add(key)
    grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = {}
    for item in regions:
        key = (item["midi_note"], item["velocity_min"], item["velocity_max"])
        grouped.setdefault(key, []).append(item)
    if require_complete:
        notes = sorted({item["midi_note"] for item in regions})
        zones = sorted({(item["velocity_min"], item["velocity_max"]) for item in regions})
        if notes != EXPECTED_NOTES or zones != EXPECTED_ZONES:
            raise ValueError("Double-bass pizzicato map does not cover its full recorded notes and velocity layers")
        if len(regions) != 123:
            raise ValueError(f"Expected 123 tonal pizzicato takes, got {len(regions)}")
    for (note, low, high), takes in grouped.items():
        indices = sorted(item["round_robin_index"] for item in takes)
        if indices != list(range(len(indices))) or len(indices) not in (3, 4):
            raise ValueError(f"Invalid round-robin take sequence for note {note}, velocity {low}-{high}")
        if len({item["seq_length"] for item in takes}) != 1 or len(indices) != takes[0]["seq_length"]:
            raise ValueError(f"Round-robin sequence length mismatch for note {note}, velocity {low}-{high}")
    return regions


def fetch_double_bass_pizzicato(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize verified double-bass WAV samples")
    tree_data = json.loads(_request(f"{API_ROOT}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned double-bass source tree was truncated")
    tree = {x["path"]: x["sha"] for x in tree_data.get("tree", []) if x.get("type") == "blob"}
    required = [SFZ_PATH, "LICENSE", "readme.txt"]
    missing = [path for path in required if path not in tree]
    if missing:
        raise ValueError(f"Pinned double-bass source is missing files: {missing}")
    sfz_file = root / "source" / Path(SFZ_PATH).name
    license_file = root / "LICENSE-CC0.txt"
    _download_verified(SFZ_PATH, tree[SFZ_PATH], sfz_file)
    _download_verified("LICENSE", tree["LICENSE"], license_file)
    sfz_text = sfz_file.read_text(encoding="utf-8")
    regions = parse_double_bass_pizz_sfz(sfz_text)
    for item in regions:
        if item["source_path"] not in tree:
            raise ValueError(f"Missing pinned double-bass source audio: {item['source_path']}")

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source = root / "source-wav" / item["filename"]
        _download_verified(item["source_path"], tree[item["source_path"]], source)
        relative = (
            f"pizzicato/v{item['velocity_min']}-{item['velocity_max']}/"
            f"{item['filename']}"
        )
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
    session_id = "d_smolken_rubner_pizzicato"
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "1958 Otto Rubner double bass",
                "performer": "D. Smolken",
                "tuning": "Fifths tuning CGDA",
                "notes": (
                    "Pinned CC0 pizzicato SFZ mapping. The source records sampled "
                    "notes C1 through A3, with soft (velocity 1-74), medium "
                    "(75-120), and loud (121-127) layers and three or four recorded "
                    "round-robin takes per note/layer. Unmapped percussive noises "
                    "and key-switch-only assets are intentionally excluded."
                ),
            }
        },
        "samples": [{
            "instrument": "contrabass", "midi_note": x["midi_note"],
            "velocity_min": x["velocity_min"], "velocity_max": x["velocity_max"],
            "articulation": "pizzicato", "round_robin_index": x["round_robin_index"],
            "one_shot": False, "recording_session_id": session_id, "path": x["path"],
        } for x in prepared],
    }
    (root / "bank.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    provenance = {
        "source_repository": SOURCE_REPOSITORY, "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0", "license_file": "LICENSE-CC0.txt",
        "instrument": "D. Smolken 1958 Otto Rubner double bass, pizzicato",
        "recorded_note_centers": EXPECTED_NOTES,
        "velocity_layers": {"low": [1, 74], "middle": [75, 120], "high": [121, 127]},
        "samples": [{
            "path": x["path"], "source_path": x["source_path"],
            "source_git_blob_sha": x["source_git_blob_sha"],
            "midi_note": x["midi_note"],
            "velocity_range": [x["velocity_min"], x["velocity_max"]],
            "round_robin_index": x["round_robin_index"],
            "sfz_key_range": [x["low_key"], x["high_key"]],
        } for x in prepared],
    }
    (root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 123:
        raise ValueError("Validated contrabass sample count differs from pinned SFZ map")
    if any(s.sample_rate != 44100 or s.channels != 1 or s.one_shot for s in bank.samples):
        raise ValueError("Contrabass pizzicato samples must be pitched mono PCM, not one-shots")
    return {
        "status": "validated_recorded_contrabass_pizzicato",
        "source_commit": SOURCE_COMMIT, "license": "CC0-1.0",
        "samples": len(bank.samples), "recorded_note_centers": EXPECTED_NOTES,
        "velocity_layers": {"low": [1, 74], "middle": [75, 120], "high": [121, 127]},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch_double_bass_pizzicato(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
