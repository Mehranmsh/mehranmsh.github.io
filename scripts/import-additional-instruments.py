#!/usr/bin/env python3
"""Import four additional recorded instruments into the self-hosted MEHRAN bank."""
import json
import hashlib
import io
import re
import subprocess
import tarfile
import zipfile
import time
import urllib.parse
from urllib.error import HTTPError
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master"
TONEJS_TREE = "https://api.github.com/repos/nbrosowsky/tonejs-instruments/git/trees/master?recursive=1"
VCSL_TREE = "https://api.github.com/repos/sgossner/VCSL/git/trees/master?recursive=1"
VCSL_RAW = "https://raw.githubusercontent.com/sgossner/VCSL/master/"
NOTE = {"C":0,"Cs":1,"C#":1,"D":2,"Ds":3,"D#":3,"E":4,"F":5,"Fs":6,"F#":6,"G":7,"Gs":8,"G#":8,"A":9,"As":10,"A#":10,"B":11}

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent":"MEHRAN-MUSIC/1.0 (https://mehranmsh.github.io; self-hosted sample import)"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return response.read()
        except HTTPError as error:
            if error.code not in (429, 503) or attempt == 5:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = max(3, int(retry_after)) if retry_after and retry_after.isdigit() else min(45, 3 * (2 ** attempt))
            print(f"Source rate limit ({error.code}); retrying in {delay}s: {url}")
            time.sleep(delay)

def midi(note):
    match = re.fullmatch(r"(Cs|Ds|Fs|Gs|As|C#|D#|F#|G#|A#|[CDEFGAB])(-?\d+)", note)
    if not match:
        raise ValueError("Unsupported sample pitch: " + note)
    return (int(match.group(2)) + 1) * 12 + NOTE[match.group(1)]


def import_setar_commons(manifest):
    params = {
        "action":"query","format":"json","generator":"categorymembers",
        "gcmtitle":"Category:Setar","gcmtype":"file","gcmlimit":"500",
        "prop":"imageinfo","iiprop":"url|extmetadata"
    }
    api_url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    payload = json.loads(get(api_url).decode("utf-8"))
    pages = payload.get("query", {}).get("pages", {}).values()
    by_fret = {}
    for page in pages:
        title = page.get("title", "")
        if not title.startswith("File:Setar 1st string tuned to C,") or not title.lower().endswith(".ogg"):
            continue
        info_list = page.get("imageinfo", [])
        if not info_list:
            continue
        info = info_list[0]
        ext = info.get("extmetadata", {})
        license_name = re.sub(r"<[^>]+>", "", ext.get("LicenseShortName", {}).get("value", ""))
        if "CC BY-SA 4.0" not in license_name:
            continue
        if "open string" in title.lower():
            fret = 0
            note_label = "C open string"
        else:
            match = re.search(r",\s*(\d+)(?:st|nd|rd|th)\s+fret\s+(.+?)\.ogg$", title, re.I)
            if not match:
                continue
            fret = int(match.group(1))
            note_label = match.group(2)
        if 0 <= fret <= 25 and fret not in by_fret:
            by_fret[fret] = {"title": title, "url": info["url"], "artist": "Jacqke",
                "noteLabel": note_label, "license": license_name}
    if len(by_fret) < 12:
        raise RuntimeError(f"Not enough verified CC BY-SA setar note recordings: {len(by_fret)}")
    target_dir = ROOT / "assets/instruments/samples/commons-setar"
    target_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    fret_to_midi = {0:60,1:61,2:62,3:63,4:63,5:64,6:65,7:66,8:66,9:67,10:68,11:68,12:69,13:70,14:70,15:71,16:72,17:73,18:74,19:75,20:75,21:76,22:77,23:78,24:79,25:80}
    for fret, item in sorted(by_fret.items()):
        filename = f"setar-fret-{fret:02d}.ogg"
        target = target_dir / filename
        if not target.exists() or target.stat().st_size < 128:
            audio = get(item["url"])
            if not audio.startswith(b"OggS"):
                raise RuntimeError("Invalid Commons OGG file: " + item["title"])
            target.write_bytes(audio)
            time.sleep(1.5)
        entries.append({"rootNote":fret_to_midi[fret],"velocityMin":0,"velocityMax":1,
            "url":f"./assets/instruments/samples/commons-setar/{filename}",
            "sourceFile":item["title"],"noteLabel":item["noteLabel"]})
    manifest["instruments"]["setar"] = {
        "displayName":"Persian Setar","attackSeconds":0.004,"releaseSeconds":0.55,
        "filterHz":14500,"source":"Wikimedia Commons, note recordings by Jacqke",
        "license":"CC-BY-SA-4.0","samples":entries
    }
    attribution = [
        "Persian Setar recorded notes by Jacqke, sourced from Wikimedia Commons Category:Setar.",
        "License: Creative Commons Attribution-ShareAlike 4.0 International.",
        "https://creativecommons.org/licenses/by-sa/4.0/",
        "Source category: https://commons.wikimedia.org/wiki/Category:Setar",
        "The samples are redistributed in the original OGG format. The root-key mapping follows the recorded 1st-string fret positions; Persian quarter-tone labels are retained in manifest noteLabel metadata."
    ]
    (ROOT / "assets/instruments/samples/SETAR-ATTRIBUTION.txt").write_text("\n".join(attribution)+"\n", encoding="utf-8")
    return len(entries)


def import_drum_and_percussion_banks(manifest):
    sample_root = ROOT / "assets/instruments/samples"
    # FreePats: authentic cajon and world-percussion recordings, CC0.
    archive = get("https://codeload.github.com/freepats/world-percussion/zip/refs/heads/main")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        freepats_license = bundle.read(next(n for n in bundle.namelist() if n.endswith("/LICENSE.txt")))
        sfz_name = next(n for n in bundle.namelist() if n.endswith("WorldPercussion 20200905.sfz"))
        sfz = bundle.read(sfz_name).decode("utf-8")
        groups = re.findall(r"<group>(.*?)(?=<group>|$)", sfz, re.S)
        percussion_entries = []
        cajon_entries = []
        world_dir = sample_root / "freepats-world"
        world_dir.mkdir(parents=True, exist_ok=True)
        for group in groups:
            key_match = re.search(r"(?m)^\s*key=(\d+)", group)
            if not key_match:
                continue
            root_note = int(key_match.group(1))
            for source_path in re.findall(r"(?m)^\s*sample=([^\s]+)", group):
                archive_path = next((n for n in bundle.namelist() if n.endswith("/" + source_path)), None)
                if not archive_path:
                    raise RuntimeError("Missing FreePats sample in source archive: " + source_path)
                original = Path(source_path).name
                target_name = source_path.replace("/", "-").replace(".flac", ".ogg").replace(".wav", ".ogg")
                target = world_dir / target_name
                if not target.exists() or target.stat().st_size < 128:
                    raw_path = ROOT / "tmp-freepats-" / original
                    raw_path.parent.mkdir(parents=True, exist_ok=True)
                    raw_path.write_bytes(bundle.read(archive_path))
                    subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(raw_path),"-c:a","libvorbis","-q:a","5",str(target)],check=True)
                    raw_path.unlink(missing_ok=True)
                entry = {"rootNote":root_note,"velocityMin":0,"velocityMax":1,
                    "url":f"./assets/instruments/samples/freepats-world/{target.name}","sourceFile":source_path}
                percussion_entries.append(entry)
                if source_path.startswith("samples/CajonFlamenco/"):
                    cajon_entries.append(entry)
        if len(cajon_entries) < 20 or len(percussion_entries) < 150:
            raise RuntimeError(f"FreePats percussion import incomplete: cajon={len(cajon_entries)}, total={len(percussion_entries)}")
    manifest["instruments"]["cajon"] = {
        "displayName":"Cajón Flamenco","attackSeconds":0.001,"releaseSeconds":0.22,
        "filterHz":16000,"source":"FreePats World Percussion, recorded by Xavimart, Gonzalo and Roberto",
        "license":"CC0-1.0","roundRobin":True,"samples":cajon_entries
    }
    manifest["instruments"]["world_percussion"] = {
        "displayName":"World Percussion Kit","attackSeconds":0.001,"releaseSeconds":0.28,
        "filterHz":16000,"source":"FreePats World Percussion, real recorded instruments",
        "license":"CC0-1.0","roundRobin":True,"samples":percussion_entries
    }
    (sample_root / "FREEPATS-CC0-LICENSE.txt").write_bytes(freepats_license)

    # Virtuosity Drums: compact 128-take CC0 acoustic kit with velocity layers and round robins.
    crate = get("https://crates.io/api/v1/crates/ferrosintesis-samples-drumkit/0.2.0/download")
    with tarfile.open(fileobj=io.BytesIO(crate), mode="r:gz") as package:
        members = {Path(m.name).name:m for m in package.getmembers() if m.isfile() and "/samples/" in m.name and m.name.endswith(".flac")}
        target_dir = sample_root / "virtuosity-drums"
        target_dir.mkdir(parents=True, exist_ok=True)
        articulation_notes = {"kick":36,"snare":38,"sidestick":37,"hhc":42,"hho":46,"hhp":44,
            "ride":51,"ridebell":53,"tomhi":50,"tomlo":43}
        velocity_high = {"kick":[31,63,95,127],"snare":[21,41,63,84,105,127],
            "sidestick":[47,87,127],"hhc":[31,63,95,127],"hho":[31,63,95,127],
            "hhp":[42,85,127],"ride":[42,85,127],"ridebell":[42,85,127],
            "tomhi":[31,63,95,127],"tomlo":[31,63,95,127]}
        drum_entries = []
        for filename, member in sorted(members.items()):
            match = re.fullmatch(r"(kick|snare|sidestick|hhc|hho|hhp|ride|ridebell|tomhi|tomlo)_vl(\d+)_rr(\d+)\.flac", filename)
            if not match:
                continue
            name, layer_text, rr_text = match.groups()
            layer = int(layer_text)
            highs = velocity_high[name]
            low = 0 if layer == 1 else highs[layer-2] + 1
            high = highs[layer-1]
            target = target_dir / (Path(filename).stem + ".ogg")
            if not target.exists() or target.stat().st_size < 128:
                raw_path = ROOT / "tmp-virtuosity-" / filename
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                raw_path.write_bytes(package.extractfile(member).read())
                subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(raw_path),"-c:a","libvorbis","-q:a","5",str(target)],check=True)
                raw_path.unlink(missing_ok=True)
            drum_entries.append({"rootNote":articulation_notes[name],"velocityMin":low/127,
                "velocityMax":high/127,"url":f"./assets/instruments/samples/virtuosity-drums/{target.name}",
                "sourceFile":filename,"roundRobin":int(rr_text)})
        if len(drum_entries) != 128:
            raise RuntimeError(f"Virtuosity drum import expected 128 samples, found {len(drum_entries)}")
        drum_license_bytes = package.extractfile(next(m for m in package.getmembers() if m.isfile() and m.name.endswith("/LICENSE-CC0"))).read()
        drum_provenance_bytes = package.extractfile(next(m for m in package.getmembers() if m.isfile() and m.name.endswith("/PROVENANCE.md"))).read()
    manifest["instruments"]["acoustic_drums"] = {
        "displayName":"Acoustic Drum Kit","attackSeconds":0.001,"releaseSeconds":0.18,
        "filterHz":18000,"source":"Virtuosity Drums (CC0) via ferrosintesis-samples-drumkit",
        "license":"CC0-1.0","roundRobin":True,"samples":drum_entries
    }
    (sample_root / "VIRTUOSITY-DRUMS-CC0-LICENSE.txt").write_bytes(drum_license_bytes)
    (sample_root / "VIRTUOSITY-DRUMS-ATTRIBUTION.txt").write_bytes(drum_provenance_bytes)
    print(f"Imported cajon {len(cajon_entries)} samples, world percussion {len(percussion_entries)} samples, acoustic drums {len(drum_entries)} samples")


def import_handpan_bank(manifest):
    """Import FreePats Hang recordings; only the nine native pitches are playable."""
    archive = get("https://codeload.github.com/freepats/hang-D-minor/zip/refs/heads/main")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        names = bundle.namelist()
        sfz_name = next((n for n in names if n.endswith("Hang-D-minor 20220330.sfz")), None)
        license_name = next((n for n in names if n.endswith("LICENSE.txt")), None)
        if not sfz_name or not license_name:
            raise RuntimeError("FreePats Hang archive is missing its SFZ or CC0 license")
        groups = re.findall(r"<group>(.*?)(?=<group>|$)", bundle.read(sfz_name).decode("utf-8"), re.S)
        target_dir = ROOT / "assets/instruments/samples/freepats-handpan"
        target_dir.mkdir(parents=True, exist_ok=True)
        entries = []
        for group in groups:
            km = re.search(r"(?m)^\s*key=(\d+)", group)
            if not km:
                continue
            root_note = int(km.group(1))
            for rr_index, source_path in enumerate(re.findall(r"(?m)^\s*sample=([^\s]+)", group)):
                archive_path = next((n for n in names if Path(n).name.casefold() == Path(source_path).name.casefold() and n.lower().endswith((".flac", ".wav", ".ogg"))), None)
                if not archive_path:
                    raise RuntimeError("Missing FreePats Hang sample: " + source_path)
                filename = Path(source_path).stem + ".ogg"
                target = target_dir / filename
                if not target.exists() or target.stat().st_size < 128:
                    raw_path = ROOT / "tmp-freepats-handpan" / Path(source_path).name
                    raw_path.parent.mkdir(parents=True, exist_ok=True)
                    raw_path.write_bytes(bundle.read(archive_path))
                    subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(raw_path),"-c:a","libvorbis","-q:a","5",str(target)],check=True)
                    raw_path.unlink(missing_ok=True)
                entries.append({"rootNote":root_note,"velocityMin":0,"velocityMax":1,
                    "url":f"./assets/instruments/samples/freepats-handpan/{filename}",
                    "sourceFile":source_path,"roundRobin":rr_index})
        expected = {57,62,64,65,67,69,70,72,74}
        actual = {x["rootNote"] for x in entries}
        if len(entries) != 51 or actual != expected:
            raise RuntimeError(f"Handpan import incomplete: {len(entries)} samples, notes={sorted(actual)}")
        manifest["instruments"]["handpan"] = {
            "displayName":"Handpan (Hang, D minor)","attackSeconds":0.004,"releaseSeconds":0.8,
            "filterHz":16000,"source":"FreePats Hang D minor, recorded live in 2017",
            "license":"CC0-1.0","roundRobin":True,"samples":entries}
        (ROOT / "assets/instruments/samples/FREEPATS-HANG-CC0-LICENSE.txt").write_bytes(bundle.read(license_name))
        (ROOT / "assets/instruments/samples/FREEPATS-HANG-ATTRIBUTION.txt").write_text(
            "Hang D minor recordings by Mar, recorded July 2017 at Medialab-Prado by Gonzalo and Roberto using a Zoom H1.\\n"
            "Source: https://github.com/freepats/hang-D-minor\\n"
            "Project page: https://freepats.zenvoid.org/ChromaticPercussion/hang.html\\n"
            "License: CC0 1.0.\\n"
            "Only native pitches MIDI 57, 62, 64, 65, 67, 69, 70, 72 and 74 are mapped. Pitch shifting is disabled because of fixed background harmonics.\\n",
            encoding="utf-8")
    print(f"Handpan: imported {len(entries)} real recordings across {len(actual)} native pitches; pitch shifting disabled")

def import_xylophone_bank(manifest):
    """Import the FreePats/Floe CC0 xylophone with its two recorded velocity layers."""
    archive = get("https://codeload.github.com/floe-audio/Xylophone/zip/refs/heads/main")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        names = bundle.namelist()
        sfz_name = next((n for n in names if n.endswith("Xylophone-MediumMallets-20200706.sfz")), None)
        license_name = next((n for n in names if n.endswith("/library/license.txt")), None)
        if not sfz_name or not license_name:
            raise RuntimeError("FreePats/Floe xylophone archive is missing SFZ or CC0 license")
        sfz = bundle.read(sfz_name).decode("utf-8")
        target_dir = ROOT / "assets/instruments/samples/freepats-xylophone"
        target_dir.mkdir(parents=True, exist_ok=True)
        entries = []
        for group in re.findall(r"<group>(.*?)(?=<group>|$)", sfz, re.S):
            low_velocity = re.search(r"\blovel=(\d+)", group)
            high_velocity = re.search(r"\bhivel=(\d+)", group)
            if not low_velocity or not high_velocity:
                continue
            velocity_min = int(low_velocity.group(1)) / 127
            velocity_max = int(high_velocity.group(1)) / 127
            for region in re.findall(r"<region>(.*?)(?=<region>|$)", group, re.S):
                values = {key:int(value) for key,value in re.findall(r"\b(lokey|hikey|pitch_keycenter)=(\d+)", region)}
                sample_match = re.search(r"\bsample=([^\s]+)", region)
                if len(values) != 3 or not sample_match:
                    continue
                source_path = sample_match.group(1)
                archive_path = next((n for n in names if n.lower().endswith("/" + source_path.lower())), None)
                if not archive_path:
                    raise RuntimeError("Missing xylophone recording: " + source_path)
                filename = Path(source_path).stem + ".ogg"
                target = target_dir / filename
                if not target.exists() or target.stat().st_size < 128:
                    raw_path = ROOT / "tmp-freepats-xylophone" / Path(source_path).name
                    raw_path.parent.mkdir(parents=True, exist_ok=True)
                    raw_path.write_bytes(bundle.read(archive_path))
                    subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(raw_path),"-c:a","libvorbis","-q:a","5",str(target)],check=True)
                    raw_path.unlink(missing_ok=True)
                entries.append({
                    "rootNote":values["pitch_keycenter"],"pitchKeyCenter":values["pitch_keycenter"],
                    "keyLow":values["lokey"],"keyHigh":values["hikey"],
                    "velocityMin":velocity_min,"velocityMax":velocity_max,
                    "url":f"./assets/instruments/samples/freepats-xylophone/{filename}","sourceFile":source_path
                })
        expected_centers = {48,55,60,67,72,79,84,91,96}
        actual_centers = {x["rootNote"] for x in entries}
        if len(entries) != 18 or actual_centers != expected_centers:
            raise RuntimeError(f"Xylophone import incomplete: {len(entries)} samples, centers={sorted(actual_centers)}")
        manifest["instruments"]["xylophone"] = {
            "displayName":"Xylophone (medium mallets)","attackSeconds":0.004,"releaseSeconds":0.7,
            "filterHz":16000,"source":"FreePats/Floe Xylophone, based on VCSL recordings",
            "license":"CC0-1.0","samples":entries
        }
        (ROOT / "assets/instruments/samples/FREEPATS-XYLOPHONE-CC0-LICENSE.txt").write_bytes(bundle.read(license_name))
        (ROOT / "assets/instruments/samples/FREEPATS-XYLOPHONE-ATTRIBUTION.txt").write_text(
            "Xylophone (medium mallets), FreePats bank packaged by Floe Audio; samples based on the Versilian Community Sample Library.\n"
            "Source: https://github.com/floe-audio/Xylophone\n"
            "Original bank: https://freepats.zenvoid.org/ChromaticPercussion/xylophone.html\n"
            "License: CC0 1.0. Includes nine mapped pitch zones and two recorded velocity layers.\n",
            encoding="utf-8")
    print(f"Xylophone: imported {len(entries)} real recordings, 9 mapped zones, 2 velocity layers")



def import_violin_bank(manifest):
    """Merge CC0 solo-violin multisamples with preserved ToneJS recordings."""
    base = "https://huggingface.co/AEmotionStudio/stringstudio-violin-samples/resolve/main/"
    metadata = json.loads(get(base + "manifest.json").decode("utf-8"))
    if metadata.get("license") != "CC0-1.0" or metadata.get("instrument") != "violin":
        raise RuntimeError("Violin source metadata/license check failed")
    zones = metadata.get("zones", [])
    expected_roots = {55,57,60,64,67,69,72,76,79,81,84,88,91,93,96}
    roots = {int(zone["rootPitch"]) for zone in zones}
    if len(zones) != 30 or roots != expected_roots:
        raise RuntimeError(f"Violin source coverage mismatch: {len(zones)} zones, roots={sorted(roots)}")
    target_dir = ROOT / "assets/instruments/samples/cc0-solo-violin"
    target_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for zone in zones:
        source_path = zone["file"]
        raw = get(base + urllib.parse.quote(source_path, safe="/"))
        digest = hashlib.sha256(raw).hexdigest()
        if digest != zone.get("sha256"):
            raise RuntimeError("Violin sample checksum mismatch: " + source_path)
        root = int(zone["rootPitch"])
        low_velocity = int(zone["lowVelocity"])
        high_velocity = int(zone["highVelocity"])
        filename = Path(source_path).stem + ".ogg"
        target = target_dir / filename
        raw_path = ROOT / "tmp-cc0-violin" / Path(source_path).name
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(raw)
        subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(raw_path),
            "-c:a","libvorbis","-q:a","5",str(target)],check=True)
        raw_path.unlink(missing_ok=True)
        if not target.is_file() or target.stat().st_size < 128:
            raise RuntimeError("Converted violin sample is missing or too small: " + filename)
        entries.append({
            "rootNote":root,"pitchKeyCenter":root,
            "velocityMin":low_velocity/127,"velocityMax":high_velocity/127,
            "url":f"./assets/instruments/samples/cc0-solo-violin/{filename}",
            "sourceFile":source_path,"sourceSha256":digest
        })
    layer_roots = {}
    for entry in entries:
        layer_roots.setdefault(entry["rootNote"], set()).add(round(entry["velocityMin"]*127))
    if len(entries) != 30 or any(layers != {0,64} for layers in layer_roots.values()):
        raise RuntimeError("Violin bank failed two-velocity-layer validation")
    previous_spec = manifest["instruments"].get("violin", {})
    previous_samples = list(previous_spec.get("samples", []))
    # Preserve the original ToneJS recordings as an emergency fallback layer.
    legacy_samples = []
    for sample in previous_samples:
        legacy = dict(sample)
        legacy["velocityMin"] = 0
        legacy["velocityMax"] = 0.0001
        legacy["sourceBank"] = "ToneJS legacy"
        legacy_samples.append(legacy)
    merged = entries + legacy_samples
    manifest["instruments"]["violin"] = {
        "displayName":"Violin (hybrid multisample)",
        "attackSeconds":0.008,"releaseSeconds":0.45,"filterHz":15500,
        "source":"VSCO 2 CE Solo Violin CC0 + preserved ToneJS violin recordings CC-BY-3.0",
        "license":"Mixed: CC0-1.0 and CC-BY-3.0; see per-sample sourceFile and license notices",
        "maxPitchShiftSemitones":2,"expectedKeyRange":[55,98],"samples":merged
    }
    (ROOT / "assets/instruments/samples/CC0-SOLO-VIOLIN-LICENSE.txt").write_text(
        "CC0-1.0. Source recordings: VSCO 2 Community Edition, Solo Violin (LLVln).\\n"
        "Repackaged multisamples: AEmotionStudio/stringstudio-violin-samples.\\n"
        "Source: https://huggingface.co/AEmotionStudio/stringstudio-violin-samples\\n"
        "Original library: https://github.com/sgossner/VSCO-2-CE\\n",
        encoding="utf-8")
    print(f"Violin: installed {len(entries)} checksum-verified real samples, {len(roots)} roots, 2 velocity layers; CC0")


def main():
    manifest_path = ROOT / "assets/instruments/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tone_tree = json.loads(get(TONEJS_TREE).decode("utf-8"))["tree"]
    total_bytes = 0
    mapping = {
        "violin": ("violin", "Violin"),
        "cello": ("cello", "Cello"),
        "acoustic_bass": ("contrabass", "Acoustic Double Bass"),
        "electric_bass": ("bass-electric", "Electric Bass"),
        "bassoon": ("bassoon", "Bassoon"),
        "clarinet": ("clarinet", "Clarinet"),
        "flute": ("flute", "Concert Flute"),
        "french_horn": ("french-horn", "French Horn"),
        "electric_guitar": ("guitar-electric", "Electric Guitar"),
        "harmonium": ("harmonium", "Harmonium"),
        "harp": ("harp", "Concert Harp"),
        "organ": ("organ", "Pipe Organ"),
        "saxophone": ("saxophone", "Saxophone"),
        "trombone": ("trombone", "Trombone"),
        "trumpet": ("trumpet", "Trumpet"),
        "tuba": ("tuba", "Tuba"),
        "xylophone": ("xylophone", "Xylophone")
    }
    for instrument, (folder, label) in mapping.items():
        names = sorted(item["path"].split("/")[-1] for item in tone_tree
            if item.get("type") == "blob" and item["path"].startswith(f"samples/{folder}/")
            and item["path"].lower().endswith(".ogg")
            and re.fullmatch(r"(?:Cs|Ds|Fs|Gs|As|[A-G])\d+\.ogg", item["path"].split("/")[-1]))
        if not names:
            raise RuntimeError("No recorded OGG notes found for " + instrument)
        target_dir = ROOT / "assets/instruments/samples" / folder
        target_dir.mkdir(parents=True, exist_ok=True)
        entries = []
        for name in names:
            note = name[:-4]
            target = target_dir / name
            if not target.exists() or target.stat().st_size < 128:
                data = get(f"{BASE}/samples/{folder}/{urllib.parse.quote(name)}")
                if not data.startswith(b"OggS"):
                    raise RuntimeError("Invalid OGG sample: " + name)
                target.write_bytes(data)
                total_bytes += len(data)
            entries.append({"rootNote":midi(note),"velocityMin":0,"velocityMax":1,
                "url":f"./assets/instruments/samples/{folder}/{name}","sourceFile":name})
        previous_spec = manifest["instruments"].get(instrument, {})
        updated_spec = {
            "displayName":label,"attackSeconds":0.008,
            "releaseSeconds":0.35 if instrument != "acoustic_bass" else 0.22,
            "filterHz":14500,"source":"nbrosowsky/tonejs-instruments",
            "license":"CC-BY-3.0","samples":entries
        }
        if "maxPitchShiftSemitones" in previous_spec:
            updated_spec["maxPitchShiftSemitones"] = previous_spec["maxPitchShiftSemitones"]
        manifest["instruments"][instrument] = updated_spec
        print(f"{instrument}: {len(entries)} recorded notes")

    import_violin_bank(manifest)
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
        ogg_path = kalimba_dir / f"kalimba-midi-{midi(pitch)}.ogg"
        if not ogg_path.exists() or ogg_path.stat().st_size < 128:
            if not wav_path.exists() or wav_path.stat().st_size < 128:
                wav_path.write_bytes(get(VCSL_RAW + urllib.parse.quote(path)))
            subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(wav_path),
                "-c:a","libvorbis","-q:a","5",str(ogg_path)],check=True)
        entries.append({"rootNote":midi(pitch),"velocityMin":0,"velocityMax":1,
            "url":f"./assets/instruments/samples/vcsl-kalimba/{ogg_path.name}","sourceFile":filename})
        wav_path.unlink(missing_ok=True)
    previous_kalimba = manifest["instruments"].get("kalimba", {})
    kalimba_spec = {
        "displayName":"Kalimba","attackSeconds":0.003,"releaseSeconds":0.7,
        "filterHz":15000,"source":"Versilian Community Sample Library (VCSL), Kalimba Tanzania",
        "license":"CC0-1.0","samples":entries
    }
    if "maxPitchShiftSemitones" in previous_kalimba:
        kalimba_spec["maxPitchShiftSemitones"] = previous_kalimba["maxPitchShiftSemitones"]
    manifest["instruments"]["kalimba"] = kalimba_spec
    license_text = get("https://raw.githubusercontent.com/sgossner/VCSL/master/LICENSE").decode("utf-8")
    (ROOT / "assets/instruments/samples/VCSL-CC0-LICENSE.txt").write_text(license_text, encoding="utf-8")
    existing_setar = manifest.get("instruments", {}).get("setar", {}).get("samples", [])
    setar_files_ready = len(existing_setar) >= 12 and all(
        (ROOT / "assets/instruments" / sample["url"].removeprefix("./assets/instruments/")).is_file()
        for sample in existing_setar
    )
    if setar_files_ready:
        setar_count = len(existing_setar)
        print(f"Setar: reusing {setar_count} already-installed recorded fret-note samples")
    else:
        setar_count = import_setar_commons(manifest)
    import_drum_and_percussion_banks(manifest)
    import_handpan_bank(manifest)
    import_xylophone_bank(manifest)
    manifest["status"] = "expanded-recorded-bank"
    manifest["sourcePolicy"] = "Samples are imported once and served same-origin by MEHRAN MUSIC; no runtime audio provider."
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Kalimba: {len(entries)} recorded pitch zones")
    print(f"Setar: {setar_count} recorded fret-note zones")
    print(f"Downloaded {total_bytes/1024/1024:.1f} MiB of ToneJS OGG samples; VCSL kalimba converted to OGG.")

if __name__ == "__main__":
    main()
