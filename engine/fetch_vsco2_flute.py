"""Pinned CC0 VSCO-2 CE concert-flute sustained importer."""
import argparse,concurrent.futures,hashlib,json,re,shutil,subprocess,time,urllib.request,urllib.error
from pathlib import Path
from urllib.parse import quote
REPO="sgossner/VSCO-2-CE";COMMIT="440300901dfe9275fd84e0b7763af1f8443ae62e";ROOT=f"https://raw.githubusercontent.com/{REPO}/{COMMIT}"
DIRS={"sustain_vibrato":"Woodwinds/Flute/susvib","expressive_vibrato":"Woodwinds/Flute/expvib"}
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
def parse(sustain,expressive,complete=True):
 out=[]
 for art,items in (("sustain_vibrato",sustain),("expressive_vibrato",expressive)):
  prefix="susvib" if art=="sustain_vibrato" else "expvib"
  for it in items:
   name=it.get("name","")
   if not name.lower().endswith(".wav"):continue
   m=re.fullmatch(rf"LDFlute_{prefix}_([A-G]#?[0-8])_v1_([1-9][0-9]*)\.wav",name)
   if not m:raise ValueError("unexpected flute filename: "+name)
   out.append({"source_path":DIRS[art]+"/"+name,"filename":name,"sha":it["sha"],"midi_note":note(m.group(1)),"articulation":art,"round_robin_index":int(m.group(2))-1})
 if len({x["source_path"] for x in out})!=len(out):raise ValueError("duplicate flute sample")
 if complete:
  a=[x for x in out if x["articulation"]=="sustain_vibrato"];b=[x for x in out if x["articulation"]=="expressive_vibrato"]
  if len(a)!=13 or len({x["midi_note"] for x in a})!=10:raise ValueError(f"expected 13 sustain samples / 10 pitches, got {len(a)}")
  if len(b)!=14 or len({x["midi_note"] for x in b})!=10:raise ValueError(f"expected 14 expressive samples / 10 pitches, got {len(b)}")
 return out
def build(dest):
 dest=Path(dest).resolve()
 if not shutil.which("ffmpeg"):raise RuntimeError("ffmpeg required")
 api=f"https://api.github.com/repos/{REPO}/contents/"
 ls={k:json.loads(req(api+quote(v,safe="/")+f"?ref={COMMIT}")) for k,v in DIRS.items()}
 lm=json.loads(req(api+f"LICENSE?ref={COMMIT}"))
 if lm.get("type")!="file":raise ValueError("CC0 license missing")
 entries=parse(ls["sustain_vibrato"],ls["expressive_vibrato"]);verify("LICENSE",lm["sha"],dest/"LICENSE-CC0.txt")
 def prep(x):
  src=dest/"source-wav"/x["filename"];verify(x["source_path"],x["sha"],src)
  rel=f"recordings/{x['articulation']}/{x['filename']}";target=dest/rel;target.parent.mkdir(parents=True,exist_ok=True)
  subprocess.run(["ffmpeg","-y","-v","error","-i",str(src),"-ac","1","-ar","44100","-c:a","pcm_s16le",str(target)],check=True)
  return {**x,"path":rel}
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:ready=list(ex.map(prep,entries))
 sid="vsco2_concert_flute"
 manifest={"format_version":1,"recording_sessions":{sid:{"instrument_model":"VSCO 2 Community Edition Concert Flute","notes":"Pinned CC0 recordings. Sustain-vibrato and expressive-vibrato are distinct recorded articulations. No velocity layers claimed; duplicate takes retained as round-robin only where supplied."}},"samples":[{"instrument":"concert_flute","midi_note":x["midi_note"],"velocity_min":1,"velocity_max":127,"articulation":x["articulation"],"round_robin_index":x["round_robin_index"],"recording_session_id":sid,"path":x["path"]} for x in ready]}
 (dest/"bank.json").write_text(json.dumps(manifest,indent=2)+"\n")
 prov={"source_repository":REPO,"source_commit":COMMIT,"license":"CC0-1.0","sample_count":len(ready),"sustain_vibrato_count":13,"expressive_vibrato_count":14,"samples":[{k:x[k] for k in ("path","source_path","sha","midi_note","articulation","round_robin_index")} for x in ready]}
 (dest/"provenance.json").write_text(json.dumps(prov,indent=2)+"\n")
 from sample_bank import load_sample_bank
 bank=load_sample_bank(dest)
 if len(bank.samples)!=27 or any(s.sample_rate!=44100 or s.channels!=1 for s in bank.samples):raise ValueError("flute bank validation failed")
 return {"status":"validated_vsco2_cc0_concert_flute","samples":27,"sustain_vibrato":13,"expressive_vibrato":14,"license":"CC0-1.0"}
if __name__=="__main__":
 p=argparse.ArgumentParser();p.add_argument("output_root",type=Path);a=p.parse_args();print(json.dumps(build(a.output_root),indent=2))
