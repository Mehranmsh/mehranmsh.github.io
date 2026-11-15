#!/usr/bin/env python3
"""Import CC0 recorded instrument previews into MEHRAN MUSIC (self-hosted)."""
import concurrent.futures
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://raw.githubusercontent.com/facebookincubator/Meta-open-sound/main"
PACKS = {
    "acoustic_grand_piano": ("meta-piano", "systems/instruments/meta-piano"),
    "acoustic_guitar_steel": ("meta-steel-guitar", "systems/instruments/meta-steel-guitar"),
    "acoustic_guitar_nylon": ("meta-nylon-guitar", "systems/instruments/meta-nylon-guitar"),
}
NOTE = {"C":0,"Cs":1,"D":2,"Ds":3,"E":4,"F":5,"Fs":6,"G":7,"Gs":8,"A":9,"As":10,"B":11}
STRING_ORDER = {"LowE":0,"A":1,"D":2,"G":3,"B":4,"HighE":5}

def read_url(url):
    req = urllib.request.Request(url, headers={"User-Agent":"MEHRAN-MUSIC-Sample-Importer/1.0"})
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.read()

def midi(note):
    m = re.fullmatch(r"(Cs|Ds|Fs|Gs|As|[CDEFGAB])(\d)", note)
    if not m:
        raise ValueError("Unrecognized pitch: " + note)
    return (int(m.group(2)) + 1) * 12 + NOTE[m.group(1)]

def parse_sample(filename, instrument, pack_id):
    stem = filename.rsplit(".", 1)[0]
    m = re.search(r"_Vel(\d{2})(Finger|Pick)?_((?:Cs|Ds|Fs|Gs|As|[CDEFGAB])\d)_01$", stem)
    if not m:
        raise ValueError("Unrecognized sample name: " + filename)
    layer = int(m.group(1))
    technique = m.group(2) or ""
    pitch = m.group(3)
    if pack_id == "meta-piano":
        lo, hi = [(0,.25),(.25,.5),(.5,.75),(.75,1)][layer-1]
    else:
        lo, hi = [(0,.34),(.34,.68),(.68,1)][layer-1]
    entry = {
        "rootNote": midi(pitch),
        "velocityMin": lo,
        "velocityMax": hi,
        "url": f"./assets/instruments/samples/{pack_id}/{stem}.ogg",
        "sourceFile": filename
    }
    if pack_id != "meta-piano":
        sm = re.search(r"_String(LowE|HighE|A|D|G|B)_", stem)
        if sm:
            entry["stringRank"] = STRING_ORDER[sm.group(1)]
    if technique:
        entry["technique"] = "fingerstyle" if technique == "Finger" else "picked"
    return entry

def main():
    manifest_path = ROOT / "assets/instruments/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    jobs = []
    for instrument, (pack_id, folder) in PACKS.items():
        upstream = json.loads(read_url(f"{BASE}/{folder}/manifest.json").decode("utf-8"))
        samples = upstream.get("samples", [])
        if not samples:
            raise RuntimeError(f"No sample entries in {pack_id}")
        target_dir = ROOT / "assets/instruments/samples" / pack_id
        target_dir.mkdir(parents=True, exist_ok=True)
        entries = []
        for item in samples:
            filename = item["file"]
            stem = filename.rsplit(".", 1)[0]
            relative = f"{folder}/ogg/{stem}.ogg"
            target = target_dir / f"{stem}.ogg"
            jobs.append((relative, target))
            entries.append(parse_sample(filename, instrument, pack_id))
        manifest["instruments"][instrument] = {
            "displayName": {
                "acoustic_grand_piano":"Acoustic Piano",
                "acoustic_guitar_steel":"Steel-string Acoustic Guitar",
                "acoustic_guitar_nylon":"Nylon-string Classical Guitar"
            }[instrument],
            "attackSeconds": .004 if pack_id == "meta-piano" else .002,
            "releaseSeconds": .35 if pack_id == "meta-piano" else .22,
            "filterHz": 16000 if pack_id == "meta-piano" else 14000,
            "source": "Meta Open Sound",
            "license": "CC0-1.0",
            "samples": entries
        }

    def download(job):
        relative, target = job
        if target.exists() and target.stat().st_size > 128:
            return target.stat().st_size
        data = read_url(f"{BASE}/{relative}")
        if not data.startswith(b"OggS"):
            raise RuntimeError(f"Invalid OGG file: {relative}")
        target.write_bytes(data)
        return len(data)

    total = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        for size in pool.map(download, jobs):
            total += size

    manifest["status"] = "partial-recorded-bank"
    manifest["sourcePolicy"] = "CC0 samples imported once; runtime playback is same-origin only."
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    license_text = read_url(f"{BASE}/LICENSE").decode("utf-8")
    (ROOT / "assets/instruments/samples/META-OPEN-SOUND-CC0-LICENSE.txt").write_text(license_text, encoding="utf-8")
    source_record = {
        "provider": "Meta Creative Audio",
        "repository": "https://github.com/facebookincubator/Meta-open-sound",
        "license": "CC0-1.0",
        "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "collections": [{"id": p[0], "path": p[1], "sample_count": len(manifest["instruments"][k]["samples"])} for k,p in PACKS.items()],
        "note": "Recorded OGG web previews copied into this project for same-origin playback. Full-quality 24-bit/48kHz WAV source bundles are available from the upstream releases."
    }
    (ROOT / "assets/instruments/samples/SOURCES.json").write_text(json.dumps(source_record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(jobs)} recorded samples ({total/1024/1024:.1f} MiB).")
    for instrument, (pack_id, _) in PACKS.items():
        print(f"{instrument}: {len(manifest['instruments'][instrument]['samples'])} samples")

if __name__ == "__main__":
    main()
