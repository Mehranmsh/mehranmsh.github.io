#!/usr/bin/env python3
"""Import original sustained human singing vowels from VocalSet into MEHRAN MUSIC.

Source recordings are CC BY 4.0. This script downloads only the 100 long-straight
vowel tokens, estimates their sung pitch, extracts a stable loopable sustain,
and self-hosts OGG copies. No remote audio is used at runtime.
"""
import io, json, math, re, subprocess, tempfile, time, wave
from array import array
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://raw.githubusercontent.com/mblackman/vocalset-vowel-voicebanks/main/source/vocalset/"
OUT = ROOT / "assets/instruments/samples/vocalset"
SINGERS = [("female", [f"f{i}" for i in range(1,10)]), ("male", [f"m{i}" for i in range(1,12)])]
VOWELS = ("a","e","i","o","u")
SR_OUT = 44100
TARGET_SECONDS = 0.42
CROSSFADE_SECONDS = 0.032

def fetch(url):
    req = Request(url, headers={"User-Agent":"MEHRAN-MUSIC/1.0 vocal sample importer"})
    for attempt in range(6):
        try:
            with urlopen(req, timeout=90) as r:
                return r.read()
        except HTTPError as e:
            if e.code not in (429,503) or attempt == 5: raise
            time.sleep(min(45, 3 * (2 ** attempt)))

def read_wav(data):
    with wave.open(io.BytesIO(data), "rb") as w:
        channels, width, sr, count = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(count)
    if width != 2: raise ValueError(f"Expected 16-bit PCM, got {width*8}-bit")
    values = array("h"); values.frombytes(raw)
    if __import__("sys").byteorder == "big": values.byteswap()
    if channels > 1:
        values = array("h", [round(sum(values[i:i+channels])/channels) for i in range(0,len(values),channels)])
    return list(values), sr

def rms_frames(x, sr, hop_ms=10):
    hop=max(1,round(sr*hop_ms/1000))
    return [math.sqrt(sum(v*v for v in x[i:i+hop])/len(x[i:i+hop])) for i in range(0,len(x)-hop+1,hop)]

def stable_bounds(x, sr):
    env=rms_frames(x,sr)
    if not env: return 0,len(x)
    threshold=max(env)*0.55
    runs=[]; start=None
    for i,v in enumerate(env):
        if v>=threshold and start is None: start=i
        if (v<threshold or i==len(env)-1) and start is not None:
            end=i if v<threshold else i+1
            if end-start>=25: runs.append((start,end))
            start=None
    if not runs: return 0,len(x)
    a,b=max(runs,key=lambda z:z[1]-z[0])
    hop=round(sr*.01)
    return max(0,a*hop),min(len(x),b*hop)

def estimate_pitch(x, sr):
    # Autocorrelation over a short, downsampled steady-state window.
    factor=max(1,round(sr/11025))
    y=x[::factor]
    rate=sr/factor
    if len(y)>5000: y=y[len(y)//2-2500:len(y)//2+2500]
    if len(y)<500: raise ValueError("Too little stable audio for pitch detection")
    mean=sum(y)/len(y); y=[v-mean for v in y]
    min_lag=max(2,int(rate/650)); max_lag=min(len(y)//3,int(rate/65))
    best_lag=0; best=-1.0
    for lag in range(min_lag,max_lag+1):
        n=len(y)-lag
        corr=sum(y[i]*y[i+lag] for i in range(n))
        norm=math.sqrt(sum(y[i]*y[i] for i in range(n))*sum(y[i+lag]*y[i+lag] for i in range(n))) or 1
        score=corr/norm
        if score>best: best,best_lag=score,lag
    if best_lag<=0 or best<0.35: raise ValueError(f"Unreliable vocal pitch estimate ({best:.2f})")
    hz=rate/best_lag
    midi=round(69+12*math.log2(hz/440))
    if not 30<=midi<=90: raise ValueError(f"Vocal pitch outside expected range: {hz:.1f} Hz")
    return midi,hz,best

def make_loop(x, sr):
    a,b=stable_bounds(x,sr)
    length=min(round(TARGET_SECONDS*sr),b-a)
    if length<round(.30*sr): raise ValueError(f"Stable vowel too short: {(b-a)/sr:.2f}s")
    center=(a+b)//2
    lo=max(a,min(center-length//2,b-length))
    segment=[float(v) for v in x[lo:lo+length]]
    fade=max(8,round(CROSSFADE_SECONDS*sr))
    # Circular overlap-add: the loop ends at the sample immediately before its start.
    head=segment[:fade]; tail=segment[-fade:]
    blended=[tail[i]*(1-i/(fade-1))+head[i]*(i/(fade-1)) for i in range(fade)]
    loop=segment[fade:-fade]+blended
    peak=max(abs(v) for v in loop) or 1
    gain=(32767*10**(-12/20))/peak
    return [max(-32768,min(32767,round(v*gain))) for v in loop]

def write_wav(path, samples, sr):
    a=array("h",samples)
    if __import__("sys").byteorder=="big": a.byteswap()
    with wave.open(str(path),"wb") as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(sr);w.writeframes(a.tobytes())

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    manifest_path=ROOT/"assets/instruments/manifest.json"
    manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    results={}
    total=0
    with tempfile.TemporaryDirectory() as tmp:
        for gender,singers in SINGERS:
            entries=[]
            for singer in singers:
                for vowel in VOWELS:
                    filename=f"{singer}_long_straight_{vowel}.wav"
                    raw=fetch(BASE+filename)
                    samples,sr=read_wav(raw)
                    pitch,hz,confidence=estimate_pitch(samples,sr)
                    loop=make_loop(samples,sr)
                    wav_path=Path(tmp)/(filename)
                    ogg_path=OUT/f"{singer}_{vowel}.ogg"
                    write_wav(wav_path,loop,sr)
                    subprocess.run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(wav_path),"-c:a","libvorbis","-q:a","5",str(ogg_path)],check=True)
                    if not ogg_path.is_file() or ogg_path.stat().st_size<256: raise RuntimeError("Invalid encoded vocal sample: "+filename)
                    entries.append({"rootNote":pitch,"velocityMin":0,"velocityMax":1,
                        "url":f"./assets/instruments/samples/vocalset/{singer}_{vowel}.ogg",
                        "sourceFile":filename,"singer":singer,"vowel":vowel,
                        "rootHz":round(hz,2),"pitchConfidence":round(confidence,3),
                        "loopStart":0,"loopEnd":round(len(loop)/sr,5)})
                    total+=1
                    print(f"Imported {gender}/{singer}/{vowel}: MIDI {pitch}, {hz:.1f} Hz, {ogg_path.stat().st_size} bytes")
            bank=f"{gender}_vocal"
            manifest["instruments"][bank]={
                "displayName":("Female" if gender=="female" else "Male")+" Human Vocal Pad",
                "attackSeconds":0.055,"releaseSeconds":0.28,"filterHz":11500,
                "source":"VocalSet long-straight sustained human singing vowels",
                "license":"CC-BY-4.0","roundRobin":True,"samples":entries
            }
            results[bank]=len(entries)
    attribution = """MEHRAN MUSIC · VOCALSET HUMAN VOWEL BANKS

Original recordings: VocalSet, a singing voice dataset by Julia Wilkins,
Prem Seetharaman, Alison Wahl, and Bryan Pardo (2018), ISMIR 2018.
Source: https://zenodo.org/records/1442513
Subset: long-straight sustained vowel recordings (a, e, i, o, u) from
9 female and 11 male singers.
License: Creative Commons Attribution 4.0 International (CC BY 4.0)
https://creativecommons.org/licenses/by/4.0/

Changes made for MEHRAN MUSIC: stable sustained regions were selected,
pitch was estimated for note mapping, loop points were prepared with a
short circular crossfade, samples were peak-normalized to -12 dBFS, and
audio was encoded as OGG Vorbis. These are original human recordings,
not synthesized choir or AI-generated voices. Pitch-shifted playback is
processed playback of the recorded human voice.

Please credit:
Wilkins, J., Seetharaman, P., Wahl, A., & Pardo, B. (2018).
VocalSet: A Singing Voice Dataset. Proceedings of ISMIR 2018.
"""
    (OUT/"VOCALSET-ATTRIBUTION.txt").write_text(attribution,encoding="utf-8")
    manifest["name"]="MEHRAN Recorded Instrument and Human Vocal Library"
    manifest["status"]="expanded-recorded-instrument-and-human-vocal-bank"
    manifest_path.write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    print(json.dumps({"vocalBanks":results,"totalHumanVocalSamples":total},indent=2))

if __name__=="__main__": main()
