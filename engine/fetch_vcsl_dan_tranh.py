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
def fetch_dan_tranh(output_root):
    root=Path(output_root).resolve(); ffmpeg=shutil.which("ffmpeg")
    if not ffmpeg: raise RuntimeError("ffmpeg is required")
    st=json.loads(request(f"https://api.github.com/repos/{SOURCE_REPOSITORY}/git/trees/{SOURCE_COMMIT}?recursive=1"))
    mt=json.loads(request(f"https://api.github.com/repos/{MAP_REPOSITORY}/git/trees/{MAP_COMMIT}?recursive=1"))
    if st.get("truncated") or mt.get("truncated"): raise ValueError("Pinned source tree truncated")
    sf={x["path"]:x["sha"] for x in st["tree"] if x.get("type")=="blob"}; mf={x["path"]:x["sha"] for x in mt["tree"] if x.get("type")=="blob"}
    if "LICENSE" not in sf or MAP_PATH not in mf: raise ValueError("Missing pinned license or SFZ mapping")
    mapping=verified(MAP_ROOT,MAP_PATH,mf[MAP_PATH],root/"source-map"/Path(MAP_PATH).name)
    regions=parse_dan_tranh_websfz(json.loads(mapping))
    verified(SOURCE_ROOT,"LICENSE",sf["LICENSE"],root/"LICENSE-CC0.txt")
    for x in regions:
        if x["source_path"] not in sf: raise ValueError(f"Missing source recording: {x['source_path']}")
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
    if len(bank.samples)!=47 or any(s.sample_rate!=44100 or s.channels!=1 or s.one_shot for s in bank.samples): raise ValueError("Dan Tranh bank failed sample manifest validation")
    return {"status":"validated_recorded_vcsl_dan_tranh","samples":len(bank.samples),"pitch_centers":EXPECTED_NOTES,"velocity_layers":3,"license":"CC0-1.0"}
def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument("output_root",type=Path); a=p.parse_args()
    print(json.dumps(fetch_dan_tranh(a.output_root),ensure_ascii=False,indent=2))
if __name__=="__main__": main()
