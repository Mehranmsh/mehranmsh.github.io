"""Pinned CC0 VSCO-2 CE solo violin importer."""
import argparse,concurrent.futures,hashlib,json,re,shutil,subprocess,time,urllib.request,urllib.error
from pathlib import Path
from urllib.parse import quote
REPO="sgossner/VSCO-2-CE"; COMMIT="440300901dfe9275fd84e0b7763af1f8443ae62e"; ROOT=f"https://raw.githubusercontent.com/{REPO}/{COMMIT}"
DIRS={"arco":"Strings/Solo Violin/Arco Vib","pizz":"Strings/Solo Violin/Pizz"}
N={"C":0,"C#":1,"D":2,"D#":3,"E":4,"F":5,"F#":6,"G":7,"G#":8,"A":9,"A#":10,"B":11}
def req(url):
 r=urllib.request.Request(url,headers={"User-Agent":"MEHRAN-Music-Engine/1.0"})
 for i in range(5):
  try:
   with urllib.request.urlopen(r,timeout=90) as x:return x.read()
  except urllib.error.HTTPError as e:
   if e.code not in {408,425,429} and not 500<=e.code<=599:raise
   if i==4:raise
  except (urllib.error.URLError,TimeoutError,ConnectionError):
   if i==4:raise
  time.sleep(2**i)
 raise RuntimeError("download retries exhausted")
def verify(path,sha,dst):
 b=req(f"{ROOT}/{quote(path,safe='/')}")
 if hashlib.sha1(b"blob "+str(len(b)).encode()+b"\0"+b).hexdigest()!=sha:raise ValueError("pinned blob mismatch: "+path)
 dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(b)
def note(s):
 m=re.fullmatch(r"([A-G]#?)([0-8])",s)
 if not m:raise ValueError("bad pitch "+s)
 return 12*(int(m[2])+1)+N[m[1]]
def parse(arco,pizz,complete=True):
 out=[]
 for kind,items in (("arco",arco),("pizz",pizz)):
  for it in items:
   name=it.get("name","")
   if not name.lower().endswith(".wav"):continue
   if kind=="arco":
    m=re.fullmatch(r"LLVln_ArcoVib_([A-G]#?[0-8])_(p|f)\.wav",name); art="arco_vibrato"; rr=0
   else:
    m=re.fullmatch(r"LLVln_Pizz_([A-G]#?[0-8])_(p|f)(?:_RR([1-9][0-9]*))?\.wav",name); art="pizzicato"
   if not m:raise ValueError("unexpected "+kind+" filename: "+name)
   pitch,dyn=m.group(1),m.group(2)
   if kind=="pizz":rr=int(m.group(3) or "1")-1
   out.append({"source_path":DIRS[kind]+"/"+name,"filename":name,"sha":it["sha"],"midi_note":note(pitch),"articulation":art,"velocity_min":1 if dyn=="p" else 64,"velocity_max":63 if dyn=="p" else 127,"round_robin_index":rr,"dynamic_label":"soft" if dyn=="p" else "forte"})
 if len({x["source_path"] for x in out})!=len(out):raise ValueError("duplicate violin sample")
 if complete:
  a=[x for x in out if x["articulation"]=="arco_vibrato"];p=[x for x in out if x["articulation"]=="pizzicato"]
  if len(a)!=30 or len({x["midi_note"] for x in a})!=15:raise ValueError(f"expected 30 arco samples / 15 pitches, got {len(a)}")
  if len(p)!=44 or len({x["midi_note"] for x in p})<10:raise ValueError(f"expected 44 pizz samples, got {len(p)}")
 return out
def build(dest):
 dest=Path(dest).resolve()
 if not shutil.which("ffmpeg"):raise RuntimeError("ffmpeg required")
 api=f"https://api.github.com/repos/{REPO}/contents/"
 ls={k:json.loads(req(api+quote(v,safe="/")+f"?ref={COMMIT}")) for k,v in DIRS.items()}
 lm=json.loads(req(api+f"LICENSE?ref={COMMIT}"))
 if lm.get("type")!="file":raise ValueError("CC0 license missing")
 entries=parse(ls["arco"],ls["pizz"]);verify("LICENSE",lm["sha"],dest/"LICENSE-CC0.txt")
 def prep(x):
  src=dest/"source-wav"/x["filename"];verify(x["source_path"],x["sha"],src)
  rel=f"recordings/{x['articulation']}/{x['filename']}";target=dest/rel;target.parent.mkdir(parents=True,exist_ok=True)
  subprocess.run(["ffmpeg","-y","-v","error","-i",str(src),"-ac","1","-ar","44100","-c:a","pcm_s16le",str(target)],check=True)
  return {**x,"path":rel}
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:ready=list(ex.map(prep,entries))
 sid="vsco2_solo_violin"
 manifest={"format_version":1,"recording_sessions":{sid:{"instrument_model":"VSCO 2 Community Edition Solo Violin","notes":"Pinned CC0 source. Arco Vib and pizzicato are separately recorded. Source p/f labels mapped to engine velocity zones 1-63 and 64-127; these are not asserted to be original sampler thresholds."}},"samples":[{"instrument":"solo_violin","midi_note":x["midi_note"],"velocity_min":x["velocity_min"],"velocity_max":x["velocity_max"],"articulation":x["articulation"],"round_robin_index":x["round_robin_index"],"recording_session_id":sid,"path":x["path"]} for x in ready]}
 (dest/"bank.json").write_text(json.dumps(manifest,indent=2)+"\n")
 prov={"source_repository":REPO,"source_commit":COMMIT,"license":"CC0-1.0","sample_count":len(ready),"arco_vibrato_count":30,"pizzicato_count":44,"samples":[{k:x[k] for k in ("path","source_path","sha","midi_note","articulation","velocity_min","velocity_max","round_robin_index","dynamic_label")} for x in ready]}
 (dest/"provenance.json").write_text(json.dumps(prov,indent=2)+"\n")
 from sample_bank import load_sample_bank
 bank=load_sample_bank(dest)
 if len(bank.samples)!=74 or any(s.sample_rate!=44100 or s.channels!=1 for s in bank.samples):raise ValueError("violin bank validation failed")
 return {"status":"validated_vsco2_cc0_solo_violin","samples":74,"arco_vibrato":30,"pizzicato":44,"license":"CC0-1.0"}
if __name__=="__main__":
 p=argparse.ArgumentParser();p.add_argument("output_root",type=Path);a=p.parse_args();print(json.dumps(build(a.output_root),indent=2))
