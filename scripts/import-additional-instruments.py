#!/usr/bin/env python3
"""Import four additional recorded instruments into the self-hosted MEHRAN bank."""
import json
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master"
TONEJS_TREE = "https://api.github.com/repos/nbrosowsky/tonejs-instruments/git/trees/master?recursive=1"
VCSL_TREE = "https://api.github.com/repos/sgossner/VCSL/git/trees/master?recursive=1"
VCSL_RAW = "https://raw.githubusercontent.com/sgossner/VCSL/master/"
NOTE = {"C":0,"Cs":1,"C#":1,"D":2,"Ds":3,"D#":3,"E":4,"F":5,"Fs":6,"F#":6,"G":7,"Gs":8,"G#":8,"A":9,"As":10,"A#":10,"B":11}

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent":"MEHRAN-MUSIC-Sample-Importer/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read()

def midi(note):
    match = re.fullmatch(r"(Cs|Ds|Fs|Gs|As|C#|D#|F#|G#|A#|[CDEFGAB])(-?\d+)", note)
    if not match:
        raise ValueError("Unsupported sample pitch: " + note)
    return (int(match.group(2)) + 1) * 12 + NOTE[match.group(1)]

def main():
    manifest_path = ROOT / "assets/instruments/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tone_tree = json.loads(get(TONEJS_TREE).decode("utf-8"))["tree"]
    total_bytes = 0
    mapping = {
        "violin": ("violin", "Violin"),
        "cello": ("cello", "Cello"),
        "acoustic_bass": ("contrabass", "Acoustic Double Bass")
    }
    for instrument, (folder, label) in mapping.items():
        names = sorted(item["path"].split("/")[-1] for item in tone_tree
            if item.get("type") == "blob" and item["path"].startswith(f"samples/{folder}/")
            and item["path"].lower().endswith(".ogg"))
        if not names:
            raise RuntimeError("No recorded OGG notes found for " + instrument)
        target_dir = ROOT / "assets/instruments/samples" / folder
        target_dir.mkdir(parents=True, exist_ok=True)
        entries = []
        for name in names:
            note = name[:-4]
            target = target_dir / name
            if not target.exists() or target.stat().st_size < 128:
                data = get(f"{BASE}/samples/{folder}/{name}")
                if not data.startswith(b"OggS"):
                    raise RuntimeError("Invalid OGG sample: " + name)
                target.write_bytes(data)
                total_bytes += len(data)
            entries.append({"rootNote":midi(note),"velocityMin":0,"velocityMax":1,
                "url":f"./assets/instruments/samples/{folder}/{name}","sourceFile":name})
        manifest["instruments"][instrument] = {
            "displayName":label,"attackSeconds":0.008,
            "releaseSeconds":0.35 if instrument != "acoustic_bass" else 0.22,
            "filterHz":14500,"source":"nbrosowsky/tonejs-instruments",
            "license":"CC-BY-3.0","samples":entries
        }
        print(f"{instrument}: {len(entries)} recorded notes")

    source_info = get(f"{BASE}/sample-source-info.txt").decode("utf-8")
    notice = ("The following bundled note samples are redistributed under CC BY 3.0.\n"
        "Source: https://github.com/nbrosowsky/tonejs-instruments\n"
        "License: https://creativecommons.org/licenses/by/3.0/\n"
        "Original sample authors and collections:\n\n" + source_info)
    (ROOT / "assets/instruments/samples/TONEJS-ATTRIBUTION.txt").write_text(notice, encoding="utf-8")

    vcsl = json.loads(get(VCSL_TREE).decode("utf-8"))["tree"]
    prefix = "Idiophones/Plucked Idiophones/Kalimba, Tanzania/"
    by_note = {}
    for item in vcsl:
        path = item.get("path", "")
        if item.get("type") != "blob" or not path.startswith(prefix) or not path.lower().endswith(".wav"):
            continue
        filename = path.rsplit("/", 1)[-1]
        if "_pluck_Main_" not in filename:
            continue
        match = re.search(r"_Main_([A-G](?:#)?[1-7])_k", filename)
        if match:
            by_note.setdefault(match.group(1), path)
    if len(by_note) < 8:
        raise RuntimeError(f"Expected at least 8 kalimba pitch zones, found {len(by_note)}")
    kalimba_dir = ROOT / "assets/instruments/samples/vcsl-kalimba"
    kalimba_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for pitch, path in sorted(by_note.items(), key=lambda pair:midi(pair[0])):
        filename = path.rsplit("/", 1)[-1]
        wav_path = kalimba_dir / filename
        ogg_path = kalimba_dir / (filename[:-4] + ".ogg")
        if not ogg_path.exists() or ogg_path.stat().st_size < 128:
            if not wav_path.exists() or wav_path.stat().st_size < 128:
                wav_path.write_bytes(get(VCSL_RAW + urllib.parse.quote(path)))
            subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(wav_path),
                "-c:a","libvorbis","-q:a","5",str(ogg_path)],check=True)
        entries.append({"rootNote":midi(pitch),"velocityMin":0,"velocityMax":1,
            "url":f"./assets/instruments/samples/vcsl-kalimba/{ogg_path.name}","sourceFile":filename})
        wav_path.unlink(missing_ok=True)
    manifest["instruments"]["kalimba"] = {
        "displayName":"Kalimba","attackSeconds":0.003,"releaseSeconds":0.7,
        "filterHz":15000,"source":"Versilian Community Sample Library (VCSL), Kalimba Tanzania",
        "license":"CC0-1.0","samples":entries
    }
    license_text = get("https://raw.githubusercontent.com/sgossner/VCSL/master/LICENSE").decode("utf-8")
    (ROOT / "assets/instruments/samples/VCSL-CC0-LICENSE.txt").write_text(license_text, encoding="utf-8")
    manifest["status"] = "expanded-recorded-bank"
    manifest["sourcePolicy"] = "Samples are imported once and served same-origin by MEHRAN MUSIC; no runtime audio provider."
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Kalimba: {len(entries)} recorded pitch zones")
    print(f"Downloaded {total_bytes/1024/1024:.1f} MiB of ToneJS OGG samples; VCSL kalimba converted to OGG.")

if __name__ == "__main__":
    main()
