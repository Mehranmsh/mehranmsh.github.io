"""Pinned CC0 VCSL Baroque soprano recorder sample-bank importer."""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, os, re, shutil, subprocess, time, urllib.error, urllib.request
from pathlib import Path
from urllib.parse import quote
from typing import Any

SOURCE_REPOSITORY="sgossner/VCSL"
SOURCE_COMMIT="c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
SOURCE_ROOT=f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
SUSTAIN_DIR="Aerophones/Edge-blown Aerophones/Baroque Soprano Recorder/Sustain"
STACCATO_DIR="Aerophones/Edge-blown Aerophones/Baroque Soprano Recorder/Staccato"
NOTE_NAMES={"C":0,"C#":1,"D":2,"D#":3,"E":4,"F":5,"F#":6,"G":7,"G#":8,"A":9,"A#":10,"B":11}
EXPECTED_NOTES=[60,62,64,66,68,70,72,74,76,78,79,82,84]

def request(url: str, timeout: int=90)->bytes:
    headers={"User-Agent":"MEHRAN-Music-Engine/1.0"}
    token=os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"]=f"Bearer {token}"
        headers["X-GitHub-Api-Version"]="2022-11-28"
    req=urllib.request.Request(url,headers=headers)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req,timeout=timeout) as res: return res.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in {408,425,429} and not 500<=exc.code<=599: raise
            if attempt==4: raise
        except (urllib.error.URLError,TimeoutError,ConnectionError):
            if attempt==4: raise
        time.sleep(2**attempt)
    raise RuntimeError("Unreachable download retry state")

def verified(path: str,sha: str,dest: Path)->bytes:
    data=request(f"{SOURCE_ROOT}/{quote(path,safe='/')}")
    actual=hashlib.sha1(b"blob "+str(len(data)).encode()+b"\0"+data).hexdigest()
    if actual!=sha: raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(data); return data

def parse_recordings(sustain:list[dict[str,Any]],staccato:list[dict[str,Any]],require_complete:bool=True)->list[dict[str,Any]]:
    out=[]
    for articulation,items in (("sustain",sustain),("staccato",staccato)):
        for item in items:
            name=item.get("name","")
            if not isinstance(name,str) or not name.lower().endswith(".wav"): raise ValueError("Invalid recorder WAV filename")
            match=re.fullmatch(r"SopRecorder_(?:Sus|Stac)_([A-G](?:#)?[0-9])_rr([0-9]+)_Main\.wav",name)
            if not match: raise ValueError(f"Unexpected recorder filename: {name}")
            pitch,rr=match.groups()
            if int(rr)!=1: raise ValueError(f"Unsupported recorder round-robin index: {name}")
            octave=int(pitch[-1]); key=pitch[:-1]
            midi=12*(octave+1)+NOTE_NAMES[key]
            out.append({"filename":name,"source_path":(SUSTAIN_DIR if articulation=="sustain" else STACCATO_DIR)+"/"+name,"midi_note":midi,"articulation":articulation,"round_robin_index":0,"source_git_blob_sha":item["sha"]})
    if len({x["source_path"] for x in out})!=len(out): raise ValueError("Duplicate recorder source recording")
    if require_complete:
        sustained=[x["midi_note"] for x in out if x["articulation"]=="sustain"]
        short=[x["midi_note"] for x in out if x["articulation"]=="staccato"]
        if len(sustained)!=13 or sorted(sustained)!=EXPECTED_NOTES: raise ValueError(f"Expected 13 sustained recorder notes, got {len(sustained)}")
        if len(short)!=12 or sorted(short)!=EXPECTED_NOTES[:-1]: raise ValueError(f"Expected 12 staccato recorder notes, got {len(short)}")
    return out

def fetch_recorder(output_root):
    root=Path(output_root).resolve(); ffmpeg=shutil.which("ffmpeg")
    if not ffmpeg: raise RuntimeError("ffmpeg is required")
    api=f"https://api.github.com/repos/{SOURCE_REPOSITORY}/contents/"
    sustain=json.loads(request(api+quote(SUSTAIN_DIR,safe="/")+f"?ref={SOURCE_COMMIT}"))
    staccato=json.loads(request(api+quote(STACCATO_DIR,safe="/")+f"?ref={SOURCE_COMMIT}"))
    license_meta=json.loads(request(api+f"LICENSE?ref={SOURCE_COMMIT}"))
    if license_meta.get("type")!="file": raise ValueError("Pinned VCSL CC0 license is missing")
    recordings=parse_recordings(sustain,staccato)
    verified("LICENSE",license_meta["sha"],root/"LICENSE-CC0.txt")
    def prepare(x):
        src=root/"source-wav"/x["filename"]; verified(x["source_path"],x["source_git_blob_sha"],src)
        rel=f"recordings/{x['articulation']}/{x['filename']}"; dst=root/rel; dst.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run([ffmpeg,"-y","-v","error","-i",str(src),"-ac","1","-ar","44100","-c:a","pcm_s16le",str(dst)],check=True)
        return {**x,"path":rel}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: prepared=list(pool.map(prepare,recordings))
    sid="vcsl_baroque_soprano_recorder"
    manifest={"format_version":1,"recording_sessions":{sid:{"instrument_model":"VCSL Baroque Soprano Recorder","notes":"Pinned CC0 VCSL recordings. Sustain and staccato are separately recorded articulations; one mapped sample per note/articulation, no velocity layers or RR variation."}},"samples":[{"instrument":"baroque_soprano_recorder","midi_note":x["midi_note"],"velocity_min":1,"velocity_max":127,"articulation":x["articulation"],"round_robin_index":0,"one_shot":False,"recording_session_id":sid,"path":x["path"]} for x in prepared]}
    (root/"bank.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    provenance={"source_repository":SOURCE_REPOSITORY,"source_commit":SOURCE_COMMIT,"license":"CC0-1.0","license_file":"LICENSE-CC0.txt","instrument":"Baroque Soprano Recorder","sample_count":len(prepared),"sustain_samples":sum(x["articulation"]=="sustain" for x in prepared),"staccato_samples":sum(x["articulation"]=="staccato" for x in prepared),"recorded_midi_notes":EXPECTED_NOTES,"samples":[{k:x[k] for k in ("path","source_path","source_git_blob_sha","midi_note","articulation")} for x in prepared]}
    (root/"provenance.json").write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    from sample_bank import load_sample_bank
    bank=load_sample_bank(root)
    if len(bank.samples)!=25 or any(s.sample_rate!=44100 or s.channels!=1 for s in bank.samples): raise ValueError("Recorder bank failed WAV manifest validation")
    return {"status":"validated_recorded_vcsl_baroque_soprano_recorder","samples":len(bank.samples),"sustain":13,"staccato":12,"license":"CC0-1.0"}

def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument("output_root",type=Path); a=p.parse_args()
    print(json.dumps(fetch_recorder(a.output_root),ensure_ascii=False,indent=2))
if __name__=="__main__": main()
