/* MEHRAN MUSIC STUDIO · self-hosted recorded-instrument sampler
 * No remote audio providers. All sample URLs must be same-origin.
 */
(function(){
 "use strict";
 const MANIFEST_URL="./assets/instruments/manifest.json";
 let manifestPromise=null;
 const decodedCache=new Map();
 const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
 async function loadManifest(){
  if(!manifestPromise)manifestPromise=fetch(MANIFEST_URL,{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error("Instrument manifest unavailable ("+r.status+").");return r.json();}).then(m=>{
   if(!m||m.schemaVersion!==1||!m.instruments||typeof m.instruments!=="object")throw new Error("Invalid MEHRAN instrument manifest.");
   return m;
  }).catch(e=>{manifestPromise=null;throw e;});
  return manifestPromise;
 }
 function sameOriginUrl(path){
  const u=new URL(path,document.baseURI);
  if(u.origin!==location.origin)throw new Error("External sample URL blocked: MEHRAN samples must be self-hosted.");
  return u.href;
 }
 async function decodeSample(ctx,sample){
  const url=sameOriginUrl(sample.url);
  if(!decodedCache.has(url))decodedCache.set(url,fetch(url).then(r=>{if(!r.ok)throw new Error("Missing recorded sample: "+sample.url);return r.arrayBuffer();}).then(b=>ctx.decodeAudioData(b.slice(0))));
  return decodedCache.get(url);
 }
 async function create(){
  const manifest=await loadManifest();
  return {
   async status(requiredIds){const rows=Object.entries(manifest.instruments).map(([id,item])=>({id,displayName:item.displayName,recordedSamples:Array.isArray(item.samples)?item.samples.length:0}));const required=Array.isArray(requiredIds)?rows.filter(x=>requiredIds.includes(x.id)):rows;return {ready:required.length>0&&required.every(x=>x.recordedSamples>0),instruments:rows,totalSamples:rows.reduce((n,x)=>n+x.recordedSamples,0)};},
   async instrument(ctx,name,options){
    const spec=manifest.instruments[name];
    if(!spec||!Array.isArray(spec.samples)||spec.samples.length===0)throw new Error("No real recorded samples are installed for "+name+". Synthetic fallback is disabled.");
    const prepared=await Promise.all(spec.samples.map(async s=>{
     if(!Number.isInteger(s.rootNote)||s.rootNote<0||s.rootNote>127||typeof s.url!=="string")throw new Error("Invalid sample entry for "+name);
     return {...s,buffer:await decodeSample(ctx,s)};
    }));
    return {play(midi,at,duration,settings){
     const note=Number(midi),start=Number(at),length=Number(duration),velocity=clamp(Number((settings&&settings.velocity)??(settings&&settings.gain)??.8),.01,1);
     if(!Number.isFinite(note)||note<0||note>127||!Number.isFinite(start)||start<0||!Number.isFinite(length)||length<=0)throw new Error("Invalid sample playback event for "+name);
     const candidates=prepared.filter(s=>velocity>=Number(s.velocityMin??0)&&velocity<=Number(s.velocityMax??1));
     const pool=candidates.length?candidates:prepared;
     const selected=pool.reduce((best,s)=>Math.abs(s.rootNote-note)<Math.abs(best.rootNote-note)?s:best,pool[0]);
     const source=ctx.createBufferSource(),gain=ctx.createGain(),filter=ctx.createBiquadFilter();
     source.buffer=selected.buffer;
     source.playbackRate.setValueAtTime(Math.pow(2,(note-selected.rootNote)/12),start);
     filter.type="lowpass";filter.frequency.setValueAtTime(Math.min(ctx.sampleRate*.45,Number(spec.filterHz)||18000),start);
     const peak=clamp(Number((options&&options.gain)??1)*Number((settings&&settings.gain)??1)*(.35+.65*velocity),.0001,1.5);
     const attack=clamp(Number(spec.attackSeconds??.006),.001,.5),release=clamp(Number(spec.releaseSeconds??.12),.015,2);
     gain.gain.setValueAtTime(.0001,start);gain.gain.linearRampToValueAtTime(peak,start+attack);
     const loop=Number.isFinite(selected.loopStart)&&Number.isFinite(selected.loopEnd)&&selected.loopEnd>selected.loopStart;
     const stopAt=start+length;
     if(loop){
      source.loop=true;source.loopStart=selected.loopStart;source.loopEnd=selected.loopEnd;
      gain.gain.setValueAtTime(peak,Math.max(start+attack,stopAt-release));
      gain.gain.setTargetAtTime(.0001,Math.max(start+attack,stopAt-release),Math.max(.008,release/4));
      source.start(start,0);
      source.stop(stopAt+release);
     }else{
      gain.gain.setTargetAtTime(.0001,stopAt,Math.max(.008,release/4));
      source.start(start);
      source.stop(Math.min(start+selected.buffer.duration/Math.max(.125,source.playbackRate.value)+.02,stopAt+release));
     }
     source.connect(filter);filter.connect(gain);gain.connect(options&&options.destination||ctx.destination);
    }};
   }
  };
 }
 window.MEHRAN_SAMPLE_ENGINE={create};
})();