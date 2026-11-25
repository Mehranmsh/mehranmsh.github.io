const MAX_PROPOSALS=100, MAX_LEDGER=1000;
const clean=(value,max=160)=>typeof value==="string"?value.trim().slice(0,max):"";
const blocked=new Set(["secret","credential","wallet","financial","private_social","health","identity"]);
const validTime=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));
const proposalKey=(target,recommendation)=>JSON.stringify([target,recommendation]);
const empty=()=>({ledger:[],accepted:[],rejected:[],diagnostics:{advisoryOnly:true,ownerApprovalRequired:true,preferencesChanged:false,applied:false}});

/**
 * Append one explicit owner decision to an immutable governance ledger.
 * The caller must supply a proposal from the current review queue. No preference is applied.
 */
export function recordIntelligencePreferenceDecision(reviewableProposals, ledger, decision, options={}) {
 const owner=clean(options.ownerUid);
 const result=empty();
 if(!owner||!Array.isArray(reviewableProposals)||!Array.isArray(ledger)||!decision||typeof decision!=="object") return {...result,reason:"invalid_input"};
 const target=clean(decision.target_key), recommendation=clean(decision.recommendation);
 const choice=decision.decision, actor=clean(options.actorUid), id=clean(decision.decision_id);
 const decidedAt=clean(decision.decided_at,64);
 if(!target||!["increase_preference","decrease_preference"].includes(recommendation)||
  !["accepted","rejected"].includes(choice)||actor!==owner||decision.explicit_confirmation!==true||
  !id||!validTime(decidedAt)) return {...result,reason:"owner_confirmation_required"};
 const proposal=reviewableProposals.slice(0,MAX_PROPOSALS).find(item=>
  item&&item.approval_required===true&&item.applied===false&&clean(item.target_key)===target&&clean(item.recommendation)===recommendation&&
  item.memory&&clean(item.memory.memory_key)===target&&
  !blocked.has(String(item.memory.sensitivity||"").toLowerCase()));
 if(!proposal) return {...result,reason:"proposal_not_in_current_review_queue"};
 const safeLedger=ledger.filter(item=>validLedgerRecord(item,owner))
  .sort((a,b)=>Date.parse(a.decided_at)-Date.parse(b.decided_at)||a.decision_id.localeCompare(b.decision_id)).slice(-MAX_LEDGER);
 if(safeLedger.some(item=>item.decision_id===id)) return {...result,reason:"duplicate_decision_id"};
 const event={record_type:"intelligence_preference_decision",decision_id:id,owner_uid:owner,actor_uid:owner,
  proposal_key:proposalKey(target,recommendation),target_key:target,recommendation,decision:choice,
  decided_at:new Date(Date.parse(decidedAt)).toISOString(),explicit_confirmation:true};
 const next=[...safeLedger,event].slice(-MAX_LEDGER);
 return {ledger:next,accepted:[],rejected:[],event,diagnostics:{advisoryOnly:true,ownerApprovalRequired:false,preferencesChanged:false,applied:false,ledgerAppended:true}};
}

/** Export the latest explicit owner-approved preferences as a read-only profile. */
export function buildApprovedPreferenceProfile(ledger, options={}) {
 const owner=clean(options.ownerUid);
 if(!owner||!Array.isArray(ledger)) return {approvedPreferences:[],rejectedDecisions:[],diagnostics:{ownerScoped:false,advisoryOnly:true,preferencesChanged:false,applied:false}};
 const eligible=ledger.filter(item=>validLedgerRecord(item,owner));
 const deduplicated=[...new Map(eligible.slice().sort((a,b)=>a.decision_id.localeCompare(b.decision_id)).map(item=>[item.decision_id,item])).values()];
 const bounded=deduplicated.sort((a,b)=>Date.parse(a.decided_at)-Date.parse(b.decided_at)||a.decision_id.localeCompare(b.decision_id)).slice(-MAX_LEDGER);
 const unique=bounded;
 const latest=new Map();
 for(const item of unique) {
  const prior=latest.get(item.proposal_key);
  if(!prior||Date.parse(item.decided_at)>Date.parse(prior.decided_at)||
   (Date.parse(item.decided_at)===Date.parse(prior.decided_at)&&item.decision_id.localeCompare(prior.decision_id)>0)) latest.set(item.proposal_key,item);
 }
 const decisions=[...latest.values()].sort((a,b)=>a.proposal_key.localeCompare(b.proposal_key));
 const approvedPreferences=decisions.filter(item=>item.decision==="accepted").map(item=>({
  target_key:item.target_key,recommendation:item.recommendation,proposal_key:item.proposal_key,
  approved_by_owner:true,decision_id:item.decision_id,decided_at:item.decided_at,read_only:true
 }));
 const rejectedDecisions=decisions.filter(item=>item.decision==="rejected").map(item=>({
  target_key:item.target_key,recommendation:item.recommendation,decision_id:item.decision_id,decided_at:item.decided_at
 }));
 return {ownerUid:owner,approvedPreferences,rejectedDecisions,diagnostics:{ownerScoped:true,inspectedDecisions:unique.length,
  omittedDecisions:Math.max(0,deduplicated.length-unique.length),advisoryOnly:true,preferencesChanged:false,applied:false}};
}

/**
 * Apply approved feedback as a temporary criteria-weight overlay only when the
 * owner explicitly opts in for this evaluation. Source criteria stay untouched.
 */
export function buildDecisionCriteriaWithApprovedPreferences(criteria, profile, options={}) {
 const owner=clean(options.ownerUid);
 const empty={criteria:Array.isArray(criteria)?criteria.map(item=>item&&typeof item==="object"?{...item}:item):[],
  diagnostics:{ownerOptInRequired:true,preferencesApplied:false,advisoryOnly:true}};
 if(!owner||options.allowApprovedPreferences!==true||!profile||profile.ownerUid!==owner||
  !Array.isArray(profile.approvedPreferences)||!Array.isArray(criteria)) return empty;
 const influence=new Map();
 for(const item of profile.approvedPreferences) {
  if(!item||item.approved_by_owner!==true||item.read_only!==true||
   !["increase_preference","decrease_preference"].includes(item.recommendation)||
   !clean(item.target_key)||!clean(item.decision_id)) continue;
  influence.set(clean(item.target_key),item.recommendation);
 }
 let applied=0;
 const adjusted=criteria.map(item=>{
  if(!item||typeof item!=="object"||!clean(item.key)||!Number.isFinite(item.weight)||item.weight<0||item.weight>100) return item&&typeof item==="object"?{...item}:item;
  const direction=influence.get(clean(item.key));
  if(!direction) return {...item};
  applied++;
  const factor=direction==="increase_preference"?1.1:0.9;
  return {...item,weight:Number(Math.min(100,Math.max(0,item.weight*factor)).toFixed(4)),
   preference_overlay:direction,preference_source:"owner_approved_feedback"};
 });
 return {criteria:adjusted,diagnostics:{ownerOptInRequired:true,preferencesApplied:applied>0,
  adjustedCriteria:applied,advisoryOnly:true,sourceCriteriaChanged:false}};
}

function validLedgerRecord(item,owner) {
 return !!item&&typeof item==="object"&&!Array.isArray(item)&&item.record_type==="intelligence_preference_decision"&&
  item.owner_uid===owner&&item.actor_uid===owner&&item.explicit_confirmation===true&&
  ["accepted","rejected"].includes(item.decision)&&
  ["increase_preference","decrease_preference"].includes(item.recommendation)&&
  clean(item.target_key)&&item.proposal_key===proposalKey(clean(item.target_key),item.recommendation)&&
  clean(item.decision_id)&&validTime(item.decided_at)&&!item.deleted_at&&
  !blocked.has(String(item.sensitivity||"").toLowerCase());
}
