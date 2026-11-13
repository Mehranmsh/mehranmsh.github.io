"""Import the exact-root VSCO 2 CE contrabass pizzicato MIDI 34 high layer.

The pinned SFZ mapping declares MIDI 34 as the recorded pitch center, velocity
63-127, with two recorded takes. Only that exact-root high layer is imported.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path
from typing import Any

SOURCE_REPOSITORY = "sgossner/VSCO-2-CE"
SOURCE_COMMIT = "6dd651d55dde97fd4028699be9d4481f26917891"
API_ROOT = f"https://api.github.com/repos/{SOURCE_REPOSITORY}"
RAW_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
MAP_PATH = "ContrabassPizz.sfz"
LICENSE_PATH = "LICENSE"
EXPECTED = {
    "BKCtbss_Pizz_A#0_v3_rr1.wav": {
        "midi_note": 34, "low_key": 33, "high_key": 34,
        "velocity_min": 63, "velocity_max": 127,
        "round_robin_index": 0, "sfz_volume_db": 5.0,
    },
    "BKCtbss_Pizz_A#0_v3_rr2.wav": {
        "midi_note": 34, "low_key": 33, "high_key": 34,
        "velocity_min": 63, "velocity_max": 127,
        "round_robin_index": 1, "sfz_volume_db": 5.0,
    },
}
SAMPLE_DIR = "Strings/Solo Contrabass/Pizz"


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


def _download_verified(path: str, expected_sha: str, destination: Path) -> bytes:
    url_path = urllib.parse.quote(path, safe="/")
    data = _request(f"{RAW_ROOT}/{url_path}")
    if _git_blob_sha(data) != expected_sha:
        raise ValueError(f"Pinned VSCO 2 CE Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return data


def parse_vsco2_contrabass_pizz_sfz(sfz_text: str) -> list[dict[str, Any]]:
    """Extract only the exact-root MIDI 34 v3 region and verify both RR takes."""
    group: dict[str, str] = {}
    region: dict[str, str] | None = None
    occurrences: dict[str, list[dict[str, Any]]] = {}

    def flush() -> None:
        if region is None:
            return
        attrs = {**group, **region}
        sample_path = attrs.get("sample", "").replace("\\", "/")
        filename = Path(sample_path).name
        if filename not in EXPECTED:
            return
        expected = EXPECTED[filename]
        parsed = {
            "midi_note": int(attrs.get("pitch_keycenter", "-1")),
            "low_key": int(attrs.get("lokey", "-1")),
            "high_key": int(attrs.get("hikey", "-1")),
            "velocity_min": int(attrs.get("lovel", "-1")),
            "velocity_max": int(attrs.get("hivel", "-1")),
            "sfz_volume_db": float(attrs.get("volume", "0")),
            "source_path": f"{SAMPLE_DIR}/{filename}",
            **{key: expected[key] for key in ("round_robin_index",)},
        }
        for key in ("midi_note", "low_key", "high_key", "velocity_min", "velocity_max", "sfz_volume_db"):
            if parsed[key] != expected[key]:
                raise ValueError(f"Unexpected VSCO 2 CE MIDI 34 SFZ mapping for {filename}: {key}={parsed[key]}")
        if not parsed["low_key"] <= parsed["midi_note"] <= parsed["high_key"]:
            raise ValueError(f"Invalid playable key zone for {filename}")
        occurrences.setdefault(filename, []).append(parsed)

    import re
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
            match = re.fullmatch(r"([a-zA-Z0-9_]+)\s*=\s*(\S+)", token)
            if match:
                if region is None:
                    group[match.group(1)] = match.group(2)
                else:
                    region[match.group(1)] = match.group(2)
    flush()

    if set(occurrences) != set(EXPECTED):
        raise ValueError(f"Expected only the two MIDI 34 high-layer samples, found {sorted(occurrences)}")
    for filename, mapped in occurrences.items():
        if len(mapped) != 1:
            raise ValueError(f"Expected one SFZ region per recorded take for {filename}")
    return [
        {**EXPECTED[filename], "source_path": f"{SAMPLE_DIR}/{filename}", "filename": filename}
        for filename in sorted(EXPECTED, key=lambda name: EXPECTED[name]["round_robin_index"])
    ]


def import_vsco2_contrabass_pizzicato(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    if root.exists():
        raise ValueError(f"Output directory already exists: {root}")
    tree_data = json.loads(_request(f"{API_ROOT}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned VSCO 2 CE source tree was truncated")
    tree = {
        item["path"]: item["sha"]
        for item in tree_data.get("tree", [])
        if item.get("type") == "blob"
    }
    required = [MAP_PATH, LICENSE_PATH, *[f"{SAMPLE_DIR}/{filename}" for filename in EXPECTED]]
    missing = [path for path in required if path not in tree]
    if missing:
        raise ValueError(f"Pinned VSCO 2 CE source is missing files: {missing}")

    map_bytes = _download_verified(MAP_PATH, tree[MAP_PATH], root / "source" / MAP_PATH)
    license_bytes = _download_verified(LICENSE_PATH, tree[LICENSE_PATH], root / "LICENSE-CC0.txt")
    if b"CC0 1.0 Universal" not in license_bytes:
        raise ValueError("Pinned VSCO 2 CE license is not CC0 1.0 Universal")
    regions = parse_vsco2_contrabass_pizz_sfz(map_bytes.decode("utf-8-sig"))

    samples = []
    for item in regions:
        source = root / "source-wav" / item["filename"]
        data = _download_verified(item["source_path"], tree[item["source_path"]], source)
        with wave.open(str(source), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (2, 2, 44100):
                raise ValueError(f"VSCO source must be stereo 16-bit 44.1 kHz PCM: {item['filename']}")
        relative = f"pizzicato/{item['filename']}"
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        samples.append({
            "instrument": "contrabass",
            "midi_note": item["midi_note"],
            "velocity_min": item["velocity_min"],
            "velocity_max": item["velocity_max"],
            "articulation": "pizzicato",
            "round_robin_index": item["round_robin_index"],
            "playable_key_min": item["midi_note"],
            "playable_key_max": item["midi_note"],
            "sfz_volume_db": item["sfz_volume_db"],
            "selection_priority": 10,
            "selection_priority_min_velocity": 121,
            "one_shot": False,
            "recording_session_id": "vsco2_ce_contrabass_pizzicato",
            "path": relative,
        })

    manifest = {
        "format_version": 1,
        "recording_sessions": {
            "vsco2_ce_contrabass_pizzicato": {
                "instrument_model": "VSCO 2 CE Solo Contrabass",
                "notes": (
                    "Pinned CC0 VSCO 2 CE pizzicato source. The SFZ declares exact "
                    "recorded MIDI 34, velocity 63-127, and two recorded takes. "
                    "The source SFZ zone is 33-34, but engine playback is deliberately "
                    "restricted to exact recorded root MIDI 34. The sample is "
                    "selected only for the incumbent upper gap at velocities 121-127."
                ),
            }
        },
        "samples": samples,
    }
    (root / "bank.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    provenance = {
        "source_repository": SOURCE_REPOSITORY,
        "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0",
        "license_file": "LICENSE-CC0.txt",
        "mapping_path": MAP_PATH,
        "mapping_git_blob_sha": tree[MAP_PATH],
        "recorded_pitch_centers": [34],
        "velocity_layers": [[63, 127]],
        "round_robin_takes_per_group": 2,
        "source_priority": 10,
        "source_priority_min_velocity": 121,
        "samples": [{
            "path": sample["path"],
            "source_path": item["source_path"],
            "source_git_blob_sha": tree[item["source_path"]],
            "midi_note": item["midi_note"],
            "velocity_min": item["velocity_min"],
            "velocity_max": item["velocity_max"],
            "round_robin_index": item["round_robin_index"],
            "source_sfz_playable_key_range": [item["low_key"], item["high_key"]],
            "engine_playable_key_range": [item["midi_note"], item["midi_note"]],
            "sfz_volume_db": item["sfz_volume_db"],
        } for sample, item in zip(samples, regions)],
    }
    (root / "provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\\n",
        encoding="utf-8",
    )
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 2 or any(sample.channels != 2 for sample in bank.samples):
        raise ValueError("VSCO 2 CE MIDI 34 supplement did not validate as two stereo recordings")
    return {
        "status": "validated_recorded_vsco2_ce_contrabass_pizzicato",
        "samples": len(bank.samples),
        "recorded_pitch_center": 34,
        "velocity_layer": [63, 127],
        "round_robin_takes": 2,
        "selection_priority_min_velocity": 121,
        "license": "CC0-1.0",
        "source_commit": SOURCE_COMMIT,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(import_vsco2_contrabass_pizzicato(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
