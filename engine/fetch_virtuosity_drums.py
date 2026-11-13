"""Fetch a compact, pinned CC0 Virtuosity Drums subset for MEHRAN.

Only the kick, center snare, closed hi-hat, and open hi-hat mid/close-mic
recordings are imported. SFZ velocity and round-robin mapping is preserved.
"""
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

SOURCE_REPOSITORY = "sfzinstruments/virtuosity_drums"
SOURCE_COMMIT = "9f04cf9a734527edfbb0a4eee1f674e45bbf71bc"
API_ROOT = f"https://api.github.com/repos/{SOURCE_REPOSITORY}"
RAW_ROOT = f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
EXPECTED_COUNTS = {"kick": 16, "snare": 36, "closed_hat": 16, "open_hat": 12}
MAPPINGS = {
    "kick": {"sfz": "Programs/mappings/kickmic/kick_snon_map.sfz",
             "macro": "KICK_SNRIGHT_KEY", "note": 36, "articulation": "snares_on",
             "pattern": r"kickmic_kick_snon_vl([1-4])_rr([1-4])\.flac"},
    "snare": {"sfz": "Programs/mappings/kickmic/snare_center_map.sfz",
              "macro": "SNARE_CENTER_KEY", "note": 38, "articulation": "center",
              "pattern": r"kickmic_snare_center_vl([1-9]|[1-3][0-9])\.flac"},
    "closed_hat": {"sfz": "Programs/mappings/kickmic/hh_closed_map.sfz",
                   "macro": "HH_CLOSED_KEY", "note": 42, "articulation": "closed",
                   "pattern": r"kickmic_hh_closed_vl([1-4])_rr([1-4])\.flac"},
    "open_hat": {"sfz": "Programs/mappings/kickmic/hh_open_map.sfz",
                 "macro": "HH_OPEN_KEY", "note": 42, "articulation": "open",
                 "pattern": r"kickmic_hh_open_vl([1-4])_rr([1-3])\.flac"},
}


def _request(url: str, *, timeout: int = 90) -> bytes:
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


def _download_verified(path: str, expected_git_sha: str, destination: Path) -> None:
    data = _request(f"{RAW_ROOT}/{path}")
    git_blob_sha = hashlib.sha1(
        b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    ).hexdigest()
    if git_blob_sha != expected_git_sha:
        raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)


def parse_keymap_note(keymap_text: str, macro: str) -> int:
    pattern = r"^\s*#define\s+\$" + re.escape(macro) + r"\s+(\d+)\b"
    match = re.search(pattern, keymap_text, re.MULTILINE)
    if not match:
        raise ValueError(f"Missing MIDI key definition: {macro}")
    note = int(match.group(1))
    if not 0 <= note <= 127:
        raise ValueError(f"Invalid MIDI key for {macro}")
    return note


def parse_virtuosity_sfz_map(
    sfz_text: str, instrument: str, *, keymap_text: str,
    require_complete: bool = True,
) -> list[dict[str, Any]]:
    """Parse a narrowly scoped SFZ map while retaining velocity and RR identity."""
    if instrument not in MAPPINGS:
        raise ValueError("Unsupported Virtuosity instrument subset")
    if not isinstance(require_complete, bool):
        raise ValueError("require_complete must be a boolean")
    spec = MAPPINGS[instrument]
    midi_note = parse_keymap_note(keymap_text, spec["macro"])
    if midi_note != spec["note"]:
        raise ValueError(f"Unexpected MIDI key for {instrument}: {midi_note}")
    regions: list[dict[str, Any]] = []
    for block in re.split(r"<region>\s*", sfz_text)[1:]:
        attrs = dict(re.findall(r"^\s*([a-z_]+)\s*=\s*([^\s]+)", block, re.MULTILINE))
        filename = Path(attrs.get("sample", "")).name
        match = re.fullmatch(spec["pattern"], filename)
        if not match:
            raise ValueError(f"Unexpected sample filename in {instrument} map: {filename}")
        low = int(attrs.get("lovel", "1"))
        high = int(attrs.get("hivel", "127"))
        if not 1 <= low <= high <= 127:
            raise ValueError(f"Invalid SFZ velocity zone for {filename}")
        seq_length = int(attrs.get("seq_length", "1"))
        seq_position = int(attrs.get("seq_position", "1"))
        if seq_length < 1 or not 1 <= seq_position <= seq_length:
            raise ValueError(f"Invalid SFZ round-robin position for {filename}")
        if len(match.groups()) == 2:
            velocity_layer, filename_rr = map(int, match.groups())
            if seq_length > 1 and filename_rr != seq_position:
                raise ValueError(f"Filename/SFZ round-robin mismatch for {filename}")
            if seq_length == 1 and filename_rr != 1:
                raise ValueError(f"Unexpected round-robin filename suffix for {filename}")
            rr_index = seq_position - 1 if seq_length > 1 else filename_rr - 1
        else:
            velocity_layer = int(match.group(1))
            rr_index = 0
            if seq_length != 1 or seq_position != 1:
                raise ValueError(f"Snare center map unexpectedly declares round robin: {filename}")
        regions.append({
            "instrument": instrument, "midi_note": midi_note,
            "velocity_min": low, "velocity_max": high,
            "articulation": spec["articulation"],
            "round_robin_index": rr_index, "one_shot": True,
            "velocity_layer": velocity_layer, "filename": filename,
        })
    if require_complete and len(regions) != EXPECTED_COUNTS[instrument]:
        raise ValueError(f"{instrument} expected {EXPECTED_COUNTS[instrument]} SFZ regions, got {len(regions)}")
    identities = [(x["velocity_min"], x["velocity_max"], x["round_robin_index"]) for x in regions]
    if len(identities) != len(set(identities)):
        raise ValueError(f"Duplicate velocity/RR identity in {instrument} map")
    zones = sorted({(x["velocity_min"], x["velocity_max"]) for x in regions})
    cursor = 1
    for low, high in zones:
        if low != cursor:
            raise ValueError(f"Velocity coverage gap for {instrument} at velocity {cursor}")
        cursor = high + 1
    if cursor != 128:
        raise ValueError(f"Velocity coverage for {instrument} ends at {cursor - 1}, not 127")
    for low, high in zones:
        rr = sorted(x["round_robin_index"] for x in regions
                    if (x["velocity_min"], x["velocity_max"]) == (low, high))
        if rr != list(range(len(rr))):
            raise ValueError(f"Non-contiguous round-robin positions for {instrument} {low}-{high}")
    return regions


def fetch_virtuosity_drums(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to convert verified FLAC samples to PCM16 WAV")
    tree_data = json.loads(_request(f"{API_ROOT}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    if tree_data.get("truncated"):
        raise ValueError("Pinned upstream Git tree was truncated")
    tree = {item["path"]: item["sha"] for item in tree_data.get("tree", [])
            if item.get("type") == "blob"}
    required = ["Programs/keymaps/keymap.sfz", "Programs/03-kick-mic.sfz", "LICENSE",
                *(spec["sfz"] for spec in MAPPINGS.values())]
    missing = [path for path in required if path not in tree]
    if missing:
        raise ValueError(f"Pinned upstream repository is missing required files: {missing}")
    source_dir = root / "source"
    source_dir.mkdir(parents=True, exist_ok=True)

    def fetch_text(path: str) -> str:
        target = source_dir / Path(path).name
        _download_verified(path, tree[path], target)
        return target.read_text(encoding="utf-8")

    keymap = fetch_text("Programs/keymaps/keymap.sfz")
    main_program = fetch_text("Programs/03-kick-mic.sfz")
    if not re.search(r"(?m)^\s*loop_mode\s*=\s*one_shot\s*$", main_program):
        raise ValueError("Upstream kick-mic program is not explicitly configured for one-shot playback")
    license_text = fetch_text("LICENSE")
    regions: list[dict[str, Any]] = []
    for instrument, spec in MAPPINGS.items():
        regions.extend(parse_virtuosity_sfz_map(fetch_text(spec["sfz"]), instrument, keymap_text=keymap))
    if len(regions) != sum(EXPECTED_COUNTS.values()):
        raise ValueError("Unexpected compact Virtuosity subset size")

    def prepare(item: dict[str, Any]) -> dict[str, Any]:
        source_relative = next(
            path for path in tree
            if path.startswith("Samples/kickmic/") and path.endswith("/" + item["filename"])
        )
        source_path = root / "source-flac" / item["filename"]
        _download_verified(source_relative, tree[source_relative], source_path)
        relative_wav = f"{item['instrument']}/{item['filename'].removesuffix('.flac')}.wav"
        wav_path = root / relative_wav
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(source_path),
                        "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", str(wav_path)],
                       check=True)
        return {**item, "path": relative_wav, "source_path": source_relative,
                "source_git_blob_sha": tree[source_relative]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        prepared = list(executor.map(prepare, regions))
    session_id = "virtuosity_drums_cc0_pinned"
    samples = [{
        **{key: item[key] for key in (
            "instrument", "midi_note", "velocity_min", "velocity_max",
            "articulation", "round_robin_index", "one_shot", "path",
        )},
        "recording_session_id": session_id,
    } for item in prepared]
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "Virtuosity Musical Instruments house kit",
                "performer": "Austin McMahon",
                "microphone": "kick mic close-mic recording set",
                "room": "Virtuosity Musical Instruments, Boston",
                "notes": (
                    "Pinned Virtuosity Drums CC0 source. The compact subset retains "
                    "source SFZ velocity zones and round-robin takes for kick, center "
                    "snare, closed hi-hat, and open hi-hat. Original FLAC assets are "
                    "Git-blob-SHA1 verified before conversion to mono 44.1 kHz PCM16 "
                    "WAV. Percussion is marked one_shot; pitch transposition and "
                    "sustain looping are not permitted."
                ),
            }
        },
        "samples": samples,
    }
    (root / "bank.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "LICENSE-CC0.txt").write_text(license_text, encoding="utf-8")
    provenance = {
        "source_repository": SOURCE_REPOSITORY, "source_commit": SOURCE_COMMIT,
        "license": "CC0-1.0", "source_license_file": "LICENSE-CC0.txt",
        "instrument_counts": EXPECTED_COUNTS, "sample_count": len(prepared),
        "samples": [{
            "instrument": item["instrument"], "filename": item["filename"],
            "source_path": item["source_path"], "source_git_blob_sha": item["source_git_blob_sha"],
            "midi_note": item["midi_note"],
            "velocity_range": [item["velocity_min"], item["velocity_max"]],
            "round_robin_index": item["round_robin_index"],
        } for item in prepared],
    }
    (root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != len(prepared):
        raise ValueError("Validated percussion sample count differs from the SFZ map")
    invalid = [sample.path.relative_to(root).as_posix() for sample in bank.samples
               if sample.sample_rate != 44100 or sample.channels != 1 or not sample.one_shot]
    if invalid:
        raise ValueError(f"Invalid converted one-shot samples: {invalid[:5]}")
    return {"bank_root": str(root), "source_commit": SOURCE_COMMIT,
            "license": "CC0-1.0", "samples": len(bank.samples),
            "instruments": EXPECTED_COUNTS, "status": "validated_recorded_one_shot_bank"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch_virtuosity_drums(args.output_root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
