"""Import the pinned CC0 VCSL Kalimba, Kenya recordings and SFZ mapping."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import quote

SOURCE_REPOSITORY = "sgossner/VCSL"
SOURCE_COMMIT = "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
MAP_REPOSITORY = "danigb/samples"
MAP_COMMIT = "eae8c5c7a10f4b0e06281211e704c36c30e25342"
MAP_PATH = "audio/vcsl/Plucked Idiophones/kalimba-kenya.websfz.json"
SOURCE_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
MAP_ROOT = f"https://raw.githubusercontent.com/{MAP_REPOSITORY}/{MAP_COMMIT}"
EXPECTED_NOTES = [59, 61, 63, 66, 68, 71, 73, 75, 78, 81]


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


def _verified_download(url_root: str, path: str, expected_sha: str, destination: Path) -> bytes:
    data = _request(f"{url_root}/{quote(path, safe='/')}")
    actual = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
    if actual != expected_sha:
        raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return data


def parse_kalimba_websfz(
    payload: dict[str, Any], *, require_complete: bool = True
) -> list[dict[str, Any]]:
    if not isinstance(require_complete, bool):
        raise ValueError("require_complete must be a boolean")
    if not isinstance(payload, dict) or not isinstance(payload.get("meta"), dict):
        raise ValueError("Kalimba mapping must contain source metadata")
    meta = payload["meta"]
    if (meta.get("name") != "Kalimba, Kenya"
            or meta.get("license") != "Creative Commons 0"
            or "sgossner/VCSL" not in meta.get("source", "")):
        raise ValueError("Kalimba map must identify the CC0 VCSL Kenya instrument")
    groups = payload.get("groups")
    if not isinstance(groups, list):
        raise ValueError("Kalimba mapping must contain SFZ groups")
    regions: list[dict[str, Any]] = []
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("regions"), list):
            raise ValueError("Invalid Kalimba SFZ group")
        for region in group["regions"]:
            if not isinstance(region, dict):
                raise ValueError("Invalid Kalimba SFZ region")
            sample = region.get("sample")
            if not isinstance(sample, str) or not sample.startswith("Kalimba, Kenya/"):
                raise ValueError(f"Unexpected Kalimba source sample: {sample}")
            midi_note = region.get("pitch_keycenter")
            low_key = region.get("lokey")
            high_key = region.get("hikey")
            if (isinstance(midi_note, bool) or not isinstance(midi_note, int)
                    or not 0 <= midi_note <= 127
                    or isinstance(low_key, bool) or not isinstance(low_key, int)
                    or isinstance(high_key, bool) or not isinstance(high_key, int)
                    or not 0 <= low_key <= midi_note <= high_key <= 127):
                raise ValueError(f"Invalid Kalimba pitch mapping: {sample}")
            velocity_min = region.get("lovel", 1)
            velocity_max = region.get("hivel", 127)
            if (isinstance(velocity_min, bool) or not isinstance(velocity_min, int)
                    or isinstance(velocity_max, bool) or not isinstance(velocity_max, int)
                    or not 1 <= velocity_min <= velocity_max <= 127):
                raise ValueError(f"Invalid Kalimba velocity layer: {sample}")
            seq_length = region.get("seq_length", 1)
            seq_position = region.get("seq_position", 1)
            if (isinstance(seq_length, bool) or not isinstance(seq_length, int)
                    or isinstance(seq_position, bool) or not isinstance(seq_position, int)
                    or seq_length not in (1, 2) or not 1 <= seq_position <= seq_length):
                raise ValueError(f"Invalid Kalimba round-robin map: {sample}")
            tuning_cents = region.get("tune", 0)
            gain_db = region.get("volume", 0)
            if (isinstance(tuning_cents, bool) or not isinstance(tuning_cents, (int, float))
                    or not -100 <= tuning_cents <= 100
                    or isinstance(gain_db, bool) or not isinstance(gain_db, (int, float))
                    or not -24 <= gain_db <= 24):
                raise ValueError(f"Invalid Kalimba tuning or gain trim: {sample}")
            filename = Path(sample).name + ".wav"
            regions.append({
                "filename": filename,
                "source_path": "Idiophones/Plucked Idiophones/" + sample + ".wav",
                "midi_note": midi_note, "low_key": low_key, "high_key": high_key,
                "velocity_min": velocity_min, "velocity_max": velocity_max,
                "round_robin_index": seq_position - 1,
                "tuning_cents": float(tuning_cents), "gain_db": float(gain_db),
                "seq_length": seq_length,
            })
    if require_complete and len(regions) != 14:
        raise ValueError(f"Expected 14 mapped Kalimba, Kenya recordings, got {len(regions)}")
    if require_complete and sorted({x["midi_note"] for x in regions}) != EXPECTED_NOTES:
        raise ValueError("Kalimba map does not cover the expected recorded pitch centers")
    if len({x["source_path"] for x in regions}) != len(regions):
        raise ValueError("Duplicate Kalimba source sample path")
    by_note: dict[int, list[dict[str, Any]]] = {}
    for item in regions:
        by_note.setdefault(item["midi_note"], []).append(item)
    for note, takes in by_note.items():
        indices = sorted(x["round_robin_index"] for x in takes)
        if indices != list(range(len(indices))) or len(indices) not in (1, 2):
            raise ValueError(f"Invalid Kalimba recorded take sequence at MIDI {note}")
        if any(x["seq_length"] != len(indices) for x in takes):
            raise ValueError(f"Kalimba sequence length mismatch at MIDI {note}")
    return regions


def fetch_vcsl_kalimba(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize verified Kalimba WAV samples")
    source_tree = json.loads(_request(f"https://api.github.com/repos/{SOURCE_REPOSITORY}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    map_tree = json.loads(_request(f"https://api.github.com/repos/{MAP_REPOSITORY}/git/trees/{MAP_COMMIT}?recursive=1"))
    if source_tree.get("truncated") or map_tree.get("truncated"):
        raise ValueError("Pinned Kalimba source tree was truncated")
    source_files = {x["path"]: x["sha"] for x in source_tree.get("tree", []) if x.get("type") == "blob"}
    map_files = {x["path"]: x["sha"] for x in map_tree.get("tree", []) if x.get("type") == "blob"}
    if "LICENSE" not in source_files or MAP_PATH not in map_files:
        raise ValueError("Pinned VCSL license or Kalimba mapping file is missing")
    map_bytes = _verified_download(
        MAP_ROOT, MAP_PATH, map_files[MAP_PATH], root / "source-map" / Path(MAP_PATH).name
    )
    payload = json.loads(map_bytes)
    regions = parse_kalimba_websfz(payload)
    license_bytes = _verified_download(
        SOURCE_ROOT, "LICENSE", source_files["LICENSE"], root / "LICENSE-CC0.txt"
    )
    for item in regions:
        if item["source_path"] not in source_files:
            raise ValueError(f"Missing pinned VCSL Kalimba recording: {item['source_path']}")

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source = root / "source-wav" / item["filename"]
        _verified_download(SOURCE_ROOT, item["source_path"], source_files[item["source_path"]], source)
        relative = f"pluck/{item['filename']}"
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(source), "-ac", "1",
             "-ar", "44100", "-c:a", "pcm_s16le", str(target)],
            check=True,
        )
        return {**item, "path": relative, "source_git_blob_sha": source_files[item["source_path"]]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        prepared = list(executor.map(prepare, regions))
    session_id = "vcsl_kalimba_kenya"
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "Versilian Community Sample Library Kalimba, Kenya",
                "notes": (
                    "Pinned CC0 VCSL Kalimba, Kenya sample recordings. The pinned "
                    "SFZ-derived mapping supplies 10 pitch centers, one recorded "
                    "velocity layer, four two-take round-robin note groups, and "
                    "per-sample tuning and gain trims. Samples are plucked decays, "
                    "not sustained loops or percussion one-shots."
                ),
            }
        },
        "samples": [{
            "instrument": "kalimba", "midi_note": x["midi_note"],
            "velocity_min": x["velocity_min"], "velocity_max": x["velocity_max"],
            "articulation": "pluck", "round_robin_index": x["round_robin_index"],
            "tuning_cents": x["tuning_cents"], "gain_db": x["gain_db"],
            "one_shot": False, "recording_session_id": session_id, "path": x["path"],
        } for x in prepared],
    }
    (root / "bank.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    provenance = {
        "source_repository": SOURCE_REPOSITORY, "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0", "license_file": "LICENSE-CC0.txt",
        "mapping_repository": MAP_REPOSITORY, "mapping_commit": MAP_COMMIT,
        "mapping_path": MAP_PATH, "sample_count": len(prepared),
        "recorded_midi_notes": EXPECTED_NOTES,
        "samples": [{
            "path": x["path"], "source_path": x["source_path"],
            "source_git_blob_sha": x["source_git_blob_sha"],
            "midi_note": x["midi_note"], "sfz_key_range": [x["low_key"], x["high_key"]],
            "velocity_range": [x["velocity_min"], x["velocity_max"]],
            "round_robin_index": x["round_robin_index"],
            "tuning_cents": x["tuning_cents"], "gain_db": x["gain_db"],
        } for x in prepared],
    }
    (root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 14:
        raise ValueError("Validated Kalimba sample count differs from pinned mapping")
    if any(sample.sample_rate != 44100 or sample.channels != 1 or sample.one_shot for sample in bank.samples):
        raise ValueError("Kalimba samples must be pitched mono 44.1 kHz PCM, not one-shots")
    return {
        "status": "validated_recorded_vcsl_kalimba",
        "source_commit": SOURCE_COMMIT, "license": "CC0-1.0",
        "samples": len(bank.samples), "pitch_centers": EXPECTED_NOTES,
        "round_robin_groups": sum(1 for note in EXPECTED_NOTES
                                  if sum(s.midi_note == note for s in bank.samples) == 2),
        "sample_tuning_offsets": sum(1 for sample in bank.samples if sample.tuning_cents != 0.0),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch_vcsl_kalimba(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
