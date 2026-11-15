/* MEHRAN MUSIC STUDIO · self-hosted recorded-instrument sampler
 * No remote audio providers. All sample URLs must be same-origin.
 */
(function(){
 "use strict";
 const MANIFEST_URL="./assets/instruments/manifest.json";
 let manifestPromise=null;
 const decodedCache=new Map();
 const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
 const NOTE_SEMITONES={C:0,Cs:1,D:2,Ds:3,E:4,F:5,Fs:6,G:7,Gs:8,A:9,As:10,B:11};
 function midiValue(value){
  const raw=String(value??"").trim();
  if(raw!==""&&Number.isFinite(Number(raw)))return Number(raw);
  const match=/^(Cs|Ds|Fs|Gs|As|[CDEFGAB])(-?\d)$/i.exec(raw);
  if(!match)return NaN;
  return (Number(match[2])+1)*12+NOTE_SEMITONES[match[1][0].toUpperCase()+match[1].slice(1)];
 }
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
    const valid=spec.samples.filter(s=>Number.isInteger(s.rootNote)&&s.rootNote>=0&&s.rootNote<=127&&typeof s.url==="string");
    if(valid.length!==spec.samples.length)throw new Error("Invalid sample entry for "+name);
    const requestedVowel=String(options&&options.vowel||"").toLowerCase();
    const bankSamples=requestedVowel?valid.filter(s=>String(s.vowel||"").toLowerCase()===requestedVowel):valid;
    if(!bankSamples.length)throw new Error("No recorded "+requestedVowel+" vowel samples are installed for "+name+".");
    const requested=Array.isArray(options&&options.noteEvents)?options.noteEvents:[];
    const selected=new Map();
    if(requested.length){
     for(const event of requested){
      const note=midiValue(event&&event.note);
      if(!Number.isFinite(note))continue;
      const rawVelocity=Number(event.velocity??80);
      const velocity=clamp(rawVelocity>1?rawVelocity/127:rawVelocity,.01,1);
      const candidates=bankSamples.filter(s=>velocity>=Number(s.velocityMin??0)&&velocity<=Number(s.velocityMax??1));
      const pool=candidates.length?candidates:bankSamples;
      const bestDistance=Math.min(...pool.map(sample=>Math.abs(sample.rootNote-note)));
      const nearest=pool.filter(sample=>Math.abs(sample.rootNote-note)===bestDistance);
      if(spec.layered===true){
       const perSinger=new Map();
       for(const sample of pool){
        const singer=String(sample.singer||sample.url),distance=Math.abs(sample.rootNote-note),previous=perSinger.get(singer);
        if(!previous||distance<previous.distance)perSinger.set(singer,{sample,distance});
       }
       for(const item of perSinger.values())selected.set(item.sample.url,item.sample);
      }else if(spec.roundRobin===true){for(const sample of pool.filter(item=>Math.abs(item.rootNote-note)===bestDistance))selected.set(sample.url,sample);}
      else{const best=nearest.reduce((a,b)=>Number(b.stringRank??99)<Number(a.stringRank??99)?b:a);selected.set(best.url,best);}
     }
    }else{
     for(const sample of bankSamples)selected.set(sample.url,sample);
    }
    if(!selected.size)throw new Error("No playable note samples selected for "+name+"; event note examples: "+requested.slice(0,4).map(event=>String(event&&event.note)).join(", "));
    const prepared=await Promise.all([...selected.values()].map(async sample=>{const sourceBuffer=await decodeSample(ctx,sample);let samplePeak=0,squareSum=0,sampleCount=0;for(let channel=0;channel<sourceBuffer.numberOfChannels;channel++){const data=sourceBuffer.getChannelData(channel);for(let i=0;i<data.length;i++){const value=data[i],magnitude=Math.abs(value);samplePeak=Math.max(samplePeak,magnitude);squareSum+=value*value;sampleCount++;}}const sourceRms=Math.sqrt(squareSum/Math.max(1,sampleCount)),normalizationGain=samplePeak>0?Math.min(Math.max(1,Number(spec.maxNormalizationGain)||512),.78/samplePeak):1,buffer=ctx.createBuffer(sourceBuffer.numberOfChannels,sourceBuffer.length,sourceBuffer.sampleRate);let normalizedPeak=0;for(let channel=0;channel<sourceBuffer.numberOfChannels;channel++){const source=sourceBuffer.getChannelData(channel),target=buffer.getChannelData(channel);for(let i=0;i<source.length;i++){target[i]=source[i]*normalizationGain;normalizedPeak=Math.max(normalizedPeak,Math.abs(target[i]));}}return {...sample,buffer,normalizationGain:1,sourcePeak,sampleRms:sourceRms,appliedNormalizationGain:normalizationGain,normalizedPeak,sampleDuration:sourceBuffer.duration};}));const roundRobinCounters=new Map();
    return {layeredVoiceCount:spec.layered===true?new Set(prepared.map(sample=>String(sample.singer||sample.url))).size:1,play(midi,at,duration,settings){
     const note=Number(midi),start=Number(at),length=Number(duration),velocity=clamp(Number((settings&&settings.velocity)??(settings&&settings.gain)??.8),.01,1);
     if(!Number.isFinite(note)||note<0||note>127||!Number.isFinite(start)||start<0||!Number.isFinite(length)||length<=0)throw new Error("Invalid sample playback event for "+name);
     const candidates=prepared.filter(s=>velocity>=Number(s.velocityMin??0)&&velocity<=Number(s.velocityMax??1));
     const pool=candidates.length?candidates:prepared;
     let voices=[];
     if(spec.layered===true){
      const perSinger=new Map();
      for(const sample of pool){
       const singer=String(sample.singer||sample.url),distance=Math.abs(sample.rootNote-note),previous=perSinger.get(singer);
       if(!previous||distance<previous.distance)perSinger.set(singer,{sample,distance});
      }
      voices=[...perSinger.values()].map(item=>item.sample);
     }else{
      const nearestDistance=Math.min(...pool.map(s=>Math.abs(s.rootNote-note)));
      const nearest=pool.filter(s=>Math.abs(s.rootNote-note)===nearestDistance);
      const rrKey=String(note)+":"+String(Math.round(velocity*127));
      const rrIndex=roundRobinCounters.get(rrKey)||0;
      voices=[nearest[spec.roundRobin===true?rrIndex%nearest.length:0]];
      if(spec.roundRobin===true)roundRobinCounters.set(rrKey,rrIndex+1);
     }
     const requestedDetuneCents=clamp(Number(settings&&settings.detuneCents)||0,-200,200);const basePeak=clamp(Number((options&&options.gain)??1)*Number((settings&&settings.gain)??1)*(.35+.65*velocity),.0001,1.5);
     const peak=spec.layered===true?basePeak/Math.sqrt(Math.max(1,voices.length))*.72:basePeak;
     const attack=clamp(Number(spec.attackSeconds??.006),.001,.5),release=clamp(Number(spec.releaseSeconds??.12),.015,2);
     const stopAt=start+length,destination=options&&options.destination||ctx.destination;
     voices.forEach((selected,index)=>{
      const source=ctx.createBufferSource(),gain=ctx.createGain(),filter=ctx.createBiquadFilter();
      const ensemble=spec.layered===true;
      let voiceStart=start,voiceStopAt=stopAt,voicePeak=peak;
      let ensembleCents=ensemble?(((()=>{const identity=String(selected.singer||selected.url);let seed=0;for(let i=0;i<identity.length;i++)seed=(seed*31+identity.charCodeAt(i))>>>0;return ((seed%1000)/1000-.5)*10;})())):0;
      if(ensemble){
       const identity=String(selected.singer||selected.url);
       let seed=0;for(let i=0;i<identity.length;i++)seed=(seed*31+identity.charCodeAt(i))>>>0;
       const variation=(seed%1000)/1000;
       ensembleCents=(variation-.5)*10;
       const onset=((Math.floor(seed/1000)%19)/1000);
       const level=.88+((Math.floor(seed/19000)%25)/100);
       voiceStart=start+onset;voiceStopAt=stopAt+onset;voicePeak=peak*level;
      }
      if(source.detune)source.detune.setValueAtTime(requestedDetuneCents+(ensemble?ensembleCents:0),voiceStart);
      source.buffer=selected.buffer;
      source.playbackRate.setValueAtTime(Math.pow(2,(note-selected.rootNote)/12),voiceStart);
      filter.type="lowpass";filter.frequency.setValueAtTime(Math.min(ctx.sampleRate*.45,Number(spec.filterHz)||18000),voiceStart);
      gain.gain.setValueAtTime(.0001,voiceStart);voicePeak=Math.min(1.35,voicePeak*Math.max(1,Number(selected.normalizationGain)||1));gain.gain.linearRampToValueAtTime(voicePeak,voiceStart+attack);
      const loop=Number.isFinite(selected.loopStart)&&Number.isFinite(selected.loopEnd)&&selected.loopEnd>selected.loopStart;
      if(loop){
       source.loop=true;source.loopStart=selected.loopStart;source.loopEnd=selected.loopEnd;
       gain.gain.setValueAtTime(voicePeak,Math.max(voiceStart+attack,voiceStopAt-release));
       gain.gain.setTargetAtTime(.0001,Math.max(voiceStart+attack,voiceStopAt-release),Math.max(.008,release/4));
       source.start(voiceStart,0);
       source.stop(voiceStopAt+release);
      }else{
       gain.gain.setTargetAtTime(.0001,voiceStopAt,Math.max(.008,release/4));
       source.start(voiceStart);
       source.stop(Math.min(voiceStart+selected.buffer.duration/Math.max(.125,source.playbackRate.value)+.02,voiceStopAt+release));
      }
      source.connect(filter);filter.connect(gain);
      if(ensemble){
       const panner=ctx.createStereoPanner();
       panner.pan.value=voices.length>1?-.48+.96*(index/(voices.length-1)):0;
       gain.connect(panner);panner.connect(destination);
      }else gain.connect(destination);
     });
    }};
   }
  };
 }
 window.MEHRAN_SAMPLE_ENGINE={create};
})();