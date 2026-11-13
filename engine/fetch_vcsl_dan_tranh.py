"""Pinned CC0 VCSL Dan Tranh sample-bank importer."""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, shutil, subprocess, time, urllib.error, urllib.request
from pathlib import Path
from urllib.parse import quote
from typing import Any
SOURCE_REPOSITORY="sgossner/VCSL"
SOURCE_COMMIT="c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"
MAP_REPOSITORY="danigb/samples"
MAP_COMMIT="eae8c5c7a10f4b0e06281211e704c36c30e25342"
MAP_PATH="audio/vcsl/Zithers/dan-tranh-normal.websfz.json"
SOURCE_ROOT=f"https://raw.githubusercontent.com/{SOURCE_REPOSITORY}/{SOURCE_COMMIT}"
MAP_ROOT=f"https://raw.githubusercontent.com/{MAP_REPOSITORY}/{MAP_COMMIT}"
EXPECTED_NOTES=[47,49,51,54,56,59,61,63,66,68,71,73,75,78,80,83]
def request(url: str, timeout: int=90)->bytes:
    req=urllib.request.Request(url,headers={"User-Agent":"MEHRAN-Music-Engine/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req,timeout=timeout) as res: return res.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in {408,425,429} and not 500<=exc.code<=599: raise
            if attempt==3: raise
        except (urllib.error.URLError,TimeoutError,ConnectionError):
            if attempt==3: raise
        time.sleep(2**attempt)
    raise RuntimeError("Unreachable download retry state")
def verified(root,path,sha,dest):
    data=request(f"{root}/{quote(path,safe='/')}")
    actual=hashlib.sha1(b"blob "+str(len(data)).encode()+b"\0"+data).hexdigest()
    if actual!=sha: raise ValueError(f"Pinned Git blob SHA-1 mismatch: {path}")
    dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(data); return data
def parse_dan_tranh_websfz(payload:dict[str,Any],require_complete:bool=True)->list[dict[str,Any]]:
    meta=payload.get("meta") if isinstance(payload,dict) else None
    if not isinstance(meta,dict) or meta.get("name")!="Dan Tranh - Normal" or meta.get("license")!="Creative Commons 0" or "sgossner/VCSL" not in meta.get("source",""):
        raise ValueError("Mapping must identify the CC0 VCSL Dan Tranh instrument")
    if not isinstance(payload.get("groups"),list): raise ValueError("Missing Dan Tranh SFZ groups")
    out=[]
    for group in payload["groups"]:
        for r in group.get("regions",[]):
            sample=r.get("sample")
            if not isinstance(sample,str) or not sample.startswith("Dan Tranh/Normal/"): raise ValueError(f"Unexpected Dan Tranh sample: {sample}")
            note,low,high=(r.get(k) for k in ("pitch_keycenter","lokey","hikey"))
            vmin,vmax=r.get("lovel",1),r.get("hivel",127); gain=r.get("volume",0)
            if any(isinstance(x,bool) or not isinstance(x,int) for x in (note,low,high,vmin,vmax)) or not 0<=low<=note<=high<=127 or not 0<=vmin<=vmax<=127: raise ValueError(f"Invalid pitch/velocity map: {sample}")
            if not isinstance(gain,(int,float)) or isinstance(gain,bool) or not -24<=gain<=24: raise ValueError(f"Invalid gain trim: {sample}")
            out.append({"filename":Path(sample).name+".wav","source_path":"Chordophones/Zithers/"+sample+".wav","midi_note":note,"low_key":low,"high_key":high,"velocity_min":max(1,vmin),"velocity_max":vmax,"gain_db":float(gain)})
    if len({x["source_path"] for x in out})!=len(out): raise ValueError("Duplicate Dan Tranh source sample")
    if require_complete:
        if len(out)!=47: raise ValueError(f"Expected 47 Dan Tranh samples, got {len(out)}")
        if sorted({x["midi_note"] for x in out})!=EXPECTED_NOTES: raise ValueError("Incomplete Dan Tranh pitch coverage")
        if sorted({(x["velocity_min"],x["velocity_max"]) for x in out})!=[(1,65),(66,99),(100,127)]: raise ValueError("Incomplete Dan Tranh velocity layers")
    for n in {x["midi_note"] for x in out}:
        zones=[(x["velocity_min"],x["velocity_max"]) for x in out if x["midi_note"]==n]
        if len(zones)!=len(set(zones)): raise ValueError(f"Duplicate velocity layer for note {n}")
    return out
def append_verified_b4_ff_region(regions: list[dict[str, Any]], source_files: dict[str, str]) -> list[dict[str, Any]]:
    """Restore the exact-root B4 forte-fortissimo recording omitted by the web mapping.

    The velocity interval is corroborated by every other mapped *_ff_ region
    (100-127); the playable zone is corroborated by both existing B4 layers
    (82-84). No audio is synthesized or pitch-shifted. A neutral gain trim is
    used because the web mapping omitted this region's gain metadata.
    """
    candidate = "Chordophones/Zithers/Dan Tranh/Normal/B4_ff_1.wav"
    matches = [path for path in source_files if path.casefold() == candidate.casefold()]
    if len(matches) != 1:
        raise ValueError(f"Expected one exact-root B4_ff source recording, found {len(matches)}")
    if any(x["source_path"].casefold() == matches[0].casefold() for x in regions):
        return regions
    ff_intervals = {
        (x["velocity_min"], x["velocity_max"])
        for x in regions
        if Path(x["source_path"]).name.casefold().endswith("_ff_1.wav")
    }
    if ff_intervals != {(100, 127)}:
        raise ValueError(f"Cannot corroborate B4 ff velocity range from peer regions: {ff_intervals}")
    b4 = [x for x in regions if x["midi_note"] == 83]
    if sorted((x["velocity_min"], x["velocity_max"]) for x in b4) != [(1, 65), (66, 99)]:
        raise ValueError("B4 mf/f mapping changed; refusing to infer B4 ff zone")
    if {(x["low_key"], x["high_key"]) for x in b4} != {(82, 84)}:
        raise ValueError("B4 playable key zone changed; refusing to infer B4 ff zone")
    return [*regions, {
        "filename": "B4_ff_1.wav",
        "source_path": matches[0],
        "midi_note": 83,
        "low_key": 82,
        "high_key": 84,
        "velocity_min": 100,
        "velocity_max": 127,
        "gain_db": 0.0,
        "mapping_note": "Exact-root source file omitted by pinned web mapping; velocity/key zone corroborated by all peer ff regions and both B4 mapped layers; neutral gain because no gain metadata was supplied.",
    }]


def fetch_dan_tranh(output_root):
    root=Path(output_root).resolve(); ffmpeg=shutil.which("ffmpeg")
    if not ffmpeg: raise RuntimeError("ffmpeg is required")
    api=f"https://api.github.com/repos/{SOURCE_REPOSITORY}/contents/"
    normal_path="Chordophones/Zithers/Dan Tranh/Normal"
    source_files=json.loads(request(api+quote(normal_path,safe="/")+f"?ref={SOURCE_COMMIT}"))
    license_meta=json.loads(request(api+f"LICENSE?ref={SOURCE_COMMIT}"))
    map_api=f"https://api.github.com/repos/{MAP_REPOSITORY}/contents/"+quote(MAP_PATH,safe="/")+f"?ref={MAP_COMMIT}"
    map_meta=json.loads(request(map_api))
    sf={normal_path+"/"+x["name"]:x["sha"] for x in source_files if x.get("type")=="file"}
    if license_meta.get("type")!="file" or map_meta.get("type")!="file": raise ValueError("Missing pinned license or SFZ mapping")
    mf={MAP_PATH:map_meta["sha"]}
    if not sf: raise ValueError("Pinned Dan Tranh Normal folder contains no recordings")
    mapping=verified(MAP_ROOT,MAP_PATH,mf[MAP_PATH],root/"source-map"/Path(MAP_PATH).name)
    regions=parse_dan_tranh_websfz(json.loads(mapping))
    regions=append_verified_b4_ff_region(regions, sf)
    verified(SOURCE_ROOT,"LICENSE",license_meta["sha"],root/"LICENSE-CC0.txt")
    for x in regions:
        matches=[p for p in sf if p.casefold()==x["source_path"].casefold()]
        if len(matches)!=1: raise ValueError(f"Expected one case-insensitive VCSL source match for {x['source_path']}, found {len(matches)}")
        x["source_path"]=matches[0]
    def prepare(x):
        src=root/"source-wav"/x["filename"]; verified(SOURCE_ROOT,x["source_path"],sf[x["source_path"]],src)
        rel="plucks/"+x["filename"]; dst=root/rel; dst.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run([ffmpeg,"-y","-v","error","-i",str(src),"-ac","1","-ar","44100","-c:a","pcm_s16le",str(dst)],check=True)
        return {**x,"path":rel,"source_git_blob_sha":sf[x["source_path"]]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: prepared=list(pool.map(prepare,regions))
    sid="vcsl_dan_tranh_normal"
    manifest={"format_version":1,"recording_sessions":{sid:{"instrument_model":"Versilian Community Sample Library Dan Tranh - Normal","notes":"Pinned CC0 VCSL recordings with 16 pitch centers and three velocity layers where mapped. Real plucked-string decays."}},"samples":[{"instrument":"dan_tranh","midi_note":x["midi_note"],"velocity_min":x["velocity_min"],"velocity_max":x["velocity_max"],"articulation":"pluck","gain_db":x["gain_db"],"one_shot":False,"recording_session_id":sid,"path":x["path"]} for x in prepared]}
    (root/"bank.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    provenance={"source_repository":SOURCE_REPOSITORY,"source_commit":SOURCE_COMMIT,"license":"CC0-1.0","license_file":"LICENSE-CC0.txt","mapping_repository":MAP_REPOSITORY,"mapping_commit":MAP_COMMIT,"mapping_path":MAP_PATH,"sample_count":len(prepared),"recorded_midi_notes":EXPECTED_NOTES,"samples":[{k:x[k] for k in ("path","source_path","source_git_blob_sha","midi_note","low_key","high_key","velocity_min","velocity_max","gain_db")} for x in prepared]}
    (root/"provenance.json").write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    from sample_bank import load_sample_bank
    bank=load_sample_bank(root)
    if len(bank.samples)!=48 or any(s.sample_rate!=44100 or s.channels!=1 or s.one_shot for s in bank.samples): raise ValueError("Dan Tranh bank failed sample manifest validation")
    return {"status":"validated_recorded_vcsl_dan_tranh","samples":len(bank.samples),"pitch_centers":EXPECTED_NOTES,"velocity_layers":3,"restored_exact_root_layer":{"midi_note":83,"velocity":[100,127],"source":"B4_ff_1.wav","mapping_basis":"consistent peer ff mapping and existing B4 key zone"},"license":"CC0-1.0"}
def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument("output_root",type=Path); a=p.parse_args()
    print(json.dumps(fetch_dan_tranh(a.output_root),ensure_ascii=False,indent=2))
if __name__=="__main__": main()
