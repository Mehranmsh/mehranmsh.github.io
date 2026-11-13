"""Import the pinned CC0 VCSL cajón one-shot recordings."""
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

SOURCE_REPOSITORY = "sgossner/VCSL"
SOURCE_COMMIT = "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
API_ROOT = f"https://api.github.com/repos/{SOURCE_REPOSITORY}"
RAW_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
SAMPLE_ROOT = "Idiophones/Struck Idiophones/Cajon"
# Region mapping is pinned to the VCSL Cajon web-SFZ export at
# danigb/samples@eae8c5c7a10f4b0e06281211e704c36c30e25342.
# Sequence positions and velocity zones are retained exactly.
REGIONS = [
    ("Cajon_hit1_mp_rr2.wav", 60, "bass", 1, 65, 0),
    ("Cajon_hit1_mp_rr1.wav", 60, "bass", 1, 65, 1),
    ("Cajon_hit1_f_rr1.wav", 60, "bass", 66, 99, 0),
    ("Cajon_hit1_f_rr2.wav", 60, "bass", 66, 99, 1),
    ("Cajon_hit1_fff_rr2.wav", 60, "bass", 100, 127, 0),
    ("Cajon_hit1_fff_rr1.wav", 60, "bass", 100, 127, 1),
    ("Cajon_hit2_pp_rr2.wav", 61, "slap", 1, 65, 0),
    ("Cajon_hit2_pp_rr1.wav", 61, "slap", 1, 65, 1),
    ("Cajon_hit2_mp_rr2.wav", 61, "slap", 66, 99, 0),
    ("Cajon_hit2_mp_rr1.wav", 61, "slap", 66, 99, 1),
    ("Cajon_hit2_f_rr1.wav", 61, "slap", 100, 127, 0),
    ("Cajon_hit2_f_rr2.wav", 61, "slap", 100, 127, 1),
    ("Cajon_hit3_p_rr2.wav", 62, "tone", 1, 65, 0),
    ("Cajon_hit3_p_rr1.wav", 62, "tone", 1, 65, 1),
    ("Cajon_hit3_mp_rr2.wav", 62, "tone", 66, 99, 0),
    ("Cajon_hit3_mp_rr1.wav", 62, "tone", 66, 99, 1),
    ("Cajon_hit3_f_rr1.wav", 62, "tone", 100, 127, 0),
]


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
        raise ValueError(f"Pinned VCSL Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)


def parse_cajon_regions() -> list[dict[str, Any]]:
    regions = [{
        "filename": filename, "source_path": f"{SAMPLE_ROOT}/{filename}",
        "midi_note": note, "articulation": articulation,
        "velocity_min": low, "velocity_max": high,
        "round_robin_index": rr, "one_shot": True,
    } for filename, note, articulation, low, high, rr in REGIONS]
    if len(regions) != 17 or len({x["source_path"] for x in regions}) != 17:
        raise ValueError("VCSL cajón mapping must contain 17 unique recorded samples")
    expected = {
        ("bass", 60): [(1, 65), (66, 99), (100, 127)],
        ("slap", 61): [(1, 65), (66, 99), (100, 127)],
        ("tone", 62): [(1, 65), (66, 99), (100, 127)],
    }
    for (articulation, note), zones in expected.items():
        selected = [x for x in regions if x["articulation"] == articulation and x["midi_note"] == note]
        if sorted({(x["velocity_min"], x["velocity_max"]) for x in selected}) != zones:
            raise ValueError(f"Incomplete VCSL cajón velocity zones for {articulation}")
        for low, high in zones:
            takes = sorted(x["round_robin_index"] for x in selected
                           if (x["velocity_min"], x["velocity_max"]) == (low, high))
            if takes not in ([0, 1], [0]):
                raise ValueError(f"Invalid cajón round-robin takes for {articulation} {low}-{high}")
    return regions


def fetch_vcsl_cajon(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize verified VCSL WAV samples")
    tree_data = json.loads(_request(f"{API_ROOT}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned VCSL source tree was truncated")
    tree = {x["path"]: x["sha"] for x in tree_data.get("tree", []) if x.get("type") == "blob"}
    required = ["LICENSE", *[x["source_path"] for x in parse_cajon_regions()]]
    missing = [path for path in required if path not in tree]
    if missing:
        raise ValueError(f"Pinned VCSL source is missing required cajón files: {missing}")
    license_file = root / "LICENSE-CC0.txt"
    _download_verified("LICENSE", tree["LICENSE"], license_file)

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source = root / "source-wav" / item["filename"]
        _download_verified(item["source_path"], tree[item["source_path"]], source)
        relative = f"one-shots/{item['articulation']}/{item['filename']}"
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(source), "-ac", "1",
             "-ar", "44100", "-c:a", "pcm_s16le", str(target)],
            check=True,
        )
        return {**item, "path": relative, "source_git_blob_sha": tree[item["source_path"]]}

    regions = parse_cajon_regions()
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        prepared = list(executor.map(prepare, regions))
    session_id = "vcsl_cajon_recordings"
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "Versilian Community Sample Library Cajón",
                "notes": (
                    "Pinned CC0 VCSL cajón recordings. Three distinct strokes are "
                    "mapped as bass, slap, and tone at MIDI keys 60, 61, and 62. "
                    "Three velocity zones are preserved (1-65, 66-99, 100-127), "
                    "with two recorded round-robin takes where the source map "
                    "provides them. All samples are one-shots; no pitch transposition "
                    "or sustain looping is permitted."
                ),
            }
        },
        "samples": [{
            "instrument": "cajon", "midi_note": x["midi_note"],
            "velocity_min": x["velocity_min"], "velocity_max": x["velocity_max"],
            "articulation": x["articulation"],
            "round_robin_index": x["round_robin_index"], "one_shot": True,
            "recording_session_id": session_id, "path": x["path"],
        } for x in prepared],
    }
    (root / "bank.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    provenance = {
        "source_repository": SOURCE_REPOSITORY, "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0", "license_file": "LICENSE-CC0.txt",
        "mapping_source": "danigb/samples@eae8c5c7a10f4b0e06281211e704c36c30e25342",
        "sample_count": len(prepared),
        "samples": [{
            "path": x["path"], "source_path": x["source_path"],
            "source_git_blob_sha": x["source_git_blob_sha"],
            "midi_note": x["midi_note"], "articulation": x["articulation"],
            "velocity_range": [x["velocity_min"], x["velocity_max"]],
            "round_robin_index": x["round_robin_index"],
        } for x in prepared],
    }
    (root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != 17 or any(not sample.one_shot for sample in bank.samples):
        raise ValueError("Validated cajón sample bank does not match the one-shot map")
    if any(sample.sample_rate != 44100 or sample.channels != 1 for sample in bank.samples):
        raise ValueError("VCSL cajón recordings must be mono 44.1 kHz PCM16")
    return {
        "status": "validated_recorded_vcsl_cajon",
        "source_commit": SOURCE_COMMIT, "license": "CC0-1.0",
        "samples": len(bank.samples),
        "strokes": {"bass": 60, "slap": 61, "tone": 62},
        "velocity_zones": [[1, 65], [66, 99], [100, 127]],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch_vcsl_cajon(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
