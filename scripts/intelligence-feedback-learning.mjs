const MAX_FEEDBACK=500;
const BLOCKED_SENSITIVITY=new Set(["secret","credential","wallet","financial","private_social","health","identity"]);
const clean=(value,max=160)=>typeof value==="string"?value.trim().slice(0,max):"";

/**
 * Summarize explicitly owner-confirmed feedback into reviewable preference proposals.
 * This function is advisory: it never changes memory, preferences, or engine settings.
 */
export function proposeIntelligencePreferenceUpdates(records, options={}) {
 const owner=clean(options.ownerUid,160);
 const minimumObservations=Number.isInteger(options.minimumObservations)
  ?Math.min(20,Math.max(2,options.minimumObservations)):2;
 const threshold=Number.isFinite(options.dominanceThreshold)
  ?Math.min(0.95,Math.max(0.75,options.dominanceThreshold)):0.75;
 const empty={proposals:[],diagnostics:{advisoryOnly:true,ownerApprovalRequired:true,preferencesChanged:false,inspectedFeedback:0,omittedFeedback:0}};
 if(!owner||!Array.isArray(records)) return empty;
 const eligible=records.filter(record=>record&&typeof record==="object"&&!Array.isArray(record)&&
  record.owner_uid===owner&&!record.deleted_at&&(!record.status||record.status==="active")&&
  !BLOCKED_SENSITIVITY.has(String(record.sensitivity||"").toLowerCase())&&
  record.feedback_confirmed===true&&record.confirmed_by===owner&&
  (record.outcome==="accepted"||record.outcome==="rejected")&&clean(record.feedback_id)&&clean(record.target_key));
 const ordered=eligible.slice().sort((a,b)=>clean(a.feedback_id).localeCompare(clean(b.feedback_id)));
 const seen=new Set(),unique=[];
 for(const record of ordered){
  const id=clean(record.feedback_id);
  if(seen.has(id)) continue;
  seen.add(id);unique.push(record);
 }
 const bounded=unique.slice(0,MAX_FEEDBACK),groups=new Map();
 for(const record of bounded){
  const key=clean(record.target_key);
  if(!groups.has(key)) groups.set(key,{accepted:0,rejected:0});
  groups.get(key)[record.outcome]+=1;
 }
 const proposals=[];
 for(const [targetKey,counts] of [...groups.entries()].sort(([a],[b])=>a.localeCompare(b))){
  const observations=counts.accepted+counts.rejected;
  if(observations<minimumObservations) continue;
  const acceptedShare=counts.accepted/observations,rejectedShare=counts.rejected/observations;
  const confidence=Math.max(acceptedShare,rejectedShare);
  if(confidence<threshold) continue;
  proposals.push({
   target_key:targetKey,
   recommendation:acceptedShare>rejectedShare?"increase_preference":"decrease_preference",
   accepted:counts.accepted,
   rejected:counts.rejected,
   observations,
   confidence:Number(confidence.toFixed(4)),
   evidence:["explicit_owner_confirmed_feedback"],
   approval_required:true,
   applied:false
  });
 }
 return {proposals,diagnostics:{advisoryOnly:true,ownerApprovalRequired:true,preferencesChanged:false,inspectedFeedback:Math.min(bounded.length,MAX_FEEDBACK),omittedFeedback:Math.max(0,unique.length-MAX_FEEDBACK)}};
}
