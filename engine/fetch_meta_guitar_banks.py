"""Fetch and validate CC0 Meta Nylon and Steel Guitar multisample banks.

The SFZ default-performance maps are parsed for exact note, string, velocity
and articulation identity. Every upstream OGG is SHA-256 checked before PCM16
conversion. No synthesized or substituted audio is added.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path
from typing import Any

BASE_ROOT = "https://raw.githubusercontent.com/facebookincubator/Meta-open-sound/main/systems/instruments"
SOURCE_ROOT = "https://github.com/facebookincubator/Meta-open-sound/tree/main/systems/instruments"
NOTE_NAMES = ("C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B")
STRINGS = {"LowE", "A", "D", "G", "B", "HighE"}
EXPECTED = {
    "meta-nylon-guitar": 348,
    "meta-steel-guitar": 375,
}


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "MEHRAN-Music-Engine/1.0"})
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def parse_sha256sums(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})\s+(.+)", line.strip())
        if match:
            digest, relative = match.groups()
            result[relative] = digest
    if not result:
        raise ValueError("Upstream SHA256SUMS file contained no valid entries")
    return result


def _note_label(midi_note: int) -> str:
    return f"{NOTE_NAMES[midi_note % 12]}{midi_note // 12 - 1}"


def _note_midi(label: str) -> int:
    match = re.fullmatch(r"([A-G])([s]?)([0-8])", label)
    if not match:
        raise ValueError(f"Unsupported note label: {label}")
    letter, sharp, octave = match.groups()
    semitones = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    pitch = semitones[letter] + (1 if sharp else 0)
    midi = (int(octave) + 1) * 12 + pitch
    if not 0 <= midi <= 127:
        raise ValueError(f"Note outside MIDI range: {label}")
    return midi


def parse_guitar_sfz_sample_map(sfz_text: str, instrument_id: str) -> dict[str, dict[str, Any]]:
    """Parse default playable SFZ regions without flattening string or technique identity."""
    if instrument_id not in EXPECTED:
        raise ValueError("Unsupported Meta guitar bank")
    nylon = instrument_id == "meta-nylon-guitar"
    velocity_min = velocity_max = None
    selected_group = False
    master_channel = None
    mapped: dict[str, dict[str, Any]] = {}
    prefix = "INSGuitarNylon" if nylon else "INSGuitarSteel"
    pattern = (
        rf"{prefix}_String(LowE|HighE|A|D|G|B)_Vel(0[1-3])(Finger|Pick)_([A-G]s?[0-8])_01\.ogg"
        if nylon else
        rf"{prefix}_String(LowE|HighE|A|D|G|B)_Vel(0[1-3])_([A-G]s?[0-8])_01\.ogg"
    )
    for raw_line in sfz_text.splitlines():
        line = raw_line.strip()
        if line.startswith("<master>"):
            # Steel's seven MIDI channels expose recordings through the
            # automatic first-position map and six dedicated-string maps.
            # Include all channels, then deduplicate identical source files.
            selected_group = False
            velocity_min = velocity_max = None
        elif line.startswith("<group>"):
            attrs = dict(re.findall(r"([a-z_]+)=([^\s]+)", line))
            selected_group = (
                attrs.get("sw_last") == "24" if nylon else "sw_last" not in attrs
            )
            if selected_group and "lovel" in attrs and "hivel" in attrs:
                velocity_min, velocity_max = int(attrs["lovel"]), int(attrs["hivel"])
                if not 1 <= velocity_min <= velocity_max <= 127:
                    raise ValueError("Invalid guitar SFZ velocity range")
            else:
                velocity_min = velocity_max = None
        elif line.startswith("<region>") and selected_group:
            attrs = dict(re.findall(r"([a-z_]+)=([^\s]+)", line))
            if "key" not in attrs or "sample" not in attrs:
                raise ValueError("Guitar SFZ region must define key and sample")
            if velocity_min is None or velocity_max is None:
                raise ValueError("Default guitar region has no valid velocity range")
            key = int(attrs["key"])
            filename = attrs["sample"]
            match = re.fullmatch(pattern, filename)
            if not match:
                raise ValueError(f"Unsupported Meta Guitar region: {line}")
            if not 0 <= key <= 127:
                raise ValueError("Guitar SFZ key is outside MIDI range")
            if nylon:
                string_name, velocity_layer, technique, note_label = match.groups()
                articulation = technique.lower()
                # Preserve the dedicated SFZ keyswitch modes: finger is full-range;
                # picked layers use the pick-mode overlap (1-71 and 56-127).
                if articulation == "finger":
                    velocity_min, velocity_max = 1, 127
                else:
                    velocity_min, velocity_max = (
                        (1, 71) if velocity_layer == "02" else (56, 127)
                    )
            else:
                string_name, velocity_layer, note_label = match.groups()
                articulation = "sustain"
            if string_name not in STRINGS or _note_midi(note_label) != key:
                raise ValueError(f"Guitar filename/key identity mismatch: {filename} -> {key}")
            entry = {
                "midi_note": key,
                "velocity_min": velocity_min,
                "velocity_max": velocity_max,
                "string": string_name,
                "articulation": articulation,
                "velocity_layer": int(velocity_layer),
            }
            if filename in mapped:
                if mapped[filename] != entry:
                    raise ValueError(f"Conflicting default SFZ sample mapping: {filename}")
                # The SFZ intentionally maps the same recording on the
                # automatic channel and the dedicated-string channel.
                continue
            mapped[filename] = entry
    if not mapped:
        raise ValueError("No default playable guitar regions were found")
    return mapped


def fetch_meta_guitar_bank(instrument_id: str, output_root: str | Path) -> dict[str, Any]:
    if instrument_id not in EXPECTED:
        raise ValueError("instrument_id must be meta-nylon-guitar or meta-steel-guitar")
    root = Path(output_root).resolve()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to convert verified OGG recordings to PCM16 WAV")
    base = f"{BASE_ROOT}/{instrument_id}"
    source = root / "source"
    sfz_path, sums_path = source / f"{instrument_id}.sfz", source / "SHA256SUMS"
    license_path, readme_path = source / "SOURCE_LICENSE.txt", source / "SOURCE_README.md"
    for url, path in (
        (f"{base}/{instrument_id}.sfz", sfz_path),
        (f"{base}/SHA256SUMS", sums_path),
        (f"{base}/LICENSE", license_path),
        (f"{base}/README.md", readme_path),
    ):
        if not path.exists():
            _download(url, path)

    regions = parse_guitar_sfz_sample_map(sfz_path.read_text(encoding="utf-8"), instrument_id)
    checksums = parse_sha256sums(sums_path.read_text(encoding="utf-8"))
    expected_count = EXPECTED[instrument_id]
    if len(regions) != expected_count:
        raise ValueError(f"Expected {expected_count} default playable regions, found {len(regions)}")
    if not all(f"ogg/{name}" in checksums for name in regions):
        missing = [name for name in regions if f"ogg/{name}" not in checksums]
        raise ValueError(f"Missing upstream checksums for {len(missing)} recordings: {missing[:3]}")

    samples = []
    for filename, mapping in sorted(regions.items()):
        relative_source = f"ogg/{filename}"
        source_path = root / "source-ogg" / filename
        if not source_path.exists():
            _download(f"{base}/{relative_source}", source_path)
        digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
        if digest != checksums[relative_source]:
            raise ValueError(f"SHA-256 mismatch for {filename}")

        wav_name = filename.removesuffix(".ogg") + ".wav"
        relative_wav = f"{'nylon' if instrument_id == 'meta-nylon-guitar' else 'steel'}/{mapping['string']}/{wav_name}"
        wav_path = root / relative_wav
        if not wav_path.exists():
            wav_path.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([
                ffmpeg, "-y", "-v", "error", "-i", str(source_path),
                "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(wav_path),
            ], check=True)
        samples.append({
            "instrument": "nylon_guitar" if instrument_id == "meta-nylon-guitar" else "acoustic_guitar",
            "midi_note": mapping["midi_note"],
            "velocity_min": mapping["velocity_min"],
            "velocity_max": mapping["velocity_max"],
            "articulation": mapping["articulation"],
            "string": mapping["string"],
            "path": relative_wav,
            "recording_session_id": f"{instrument_id}_cc0",
        })

    session_id = f"{instrument_id}_cc0"
    manifest = {
        "format_version": 1,
        "recording_sessions": {
            session_id: {
                "instrument_model": "Meta Nylon Guitar" if instrument_id == "meta-nylon-guitar" else "Meta Steel Guitar",
                "performer": "Meta Creative Audio team (performer details not specified)",
                "notes": (
                    f"{len(samples)} real recorded OGG samples from the Meta Open Sound collection. "
                    "Each source OGG was SHA-256 verified against upstream SHA256SUMS before conversion "
                    "to mono PCM16 WAV at 48 kHz. Default SFZ playable string/note/velocity regions "
                    "are retained; no pitch-shifted substitutes are generated."
                ),
            }
        },
        "samples": samples,
    }
    (root / "bank.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from sample_bank import load_sample_bank
    bank = load_sample_bank(root)
    if len(bank.samples) != expected_count:
        raise ValueError(f"Validated bank should contain {expected_count} samples, got {len(bank.samples)}")
    return {
        "status": "validated",
        "instrument": "nylon_guitar" if instrument_id == "meta-nylon-guitar" else "acoustic_guitar",
        "sample_count": len(bank.samples),
        "sha256_verified_files": len(samples),
        "recorded_strings": sorted({sample.string_name for sample in bank.samples}),
        "articulations": sorted({sample.articulation for sample in bank.samples}),
        "velocity_ranges": sorted({(sample.velocity_min, sample.velocity_max) for sample in bank.samples}),
        "sample_rate_hz": 48000,
        "channels": "mono",
        "license": "CC0 1.0 Universal",
        "source": f"{SOURCE_ROOT}/{instrument_id}",
        "bank_manifest": str(root / "bank.json"),
        "recorded_wav_bytes": sum(sample.path.stat().st_size for sample in bank.samples),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch verified CC0 Meta guitar recordings.")
    parser.add_argument("instrument_id", choices=sorted(EXPECTED))
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch_meta_guitar_bank(args.instrument_id, args.output_root), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
