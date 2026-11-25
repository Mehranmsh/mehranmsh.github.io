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
 const choice=decision.decision, actor=clean(decision.actor_uid), id=clean(decision.decision_id);
 const decidedAt=clean(decision.decided_at,64);
 if(!target||!["increase_preference","decrease_preference"].includes(recommendation)||
  !["accepted","rejected"].includes(choice)||actor!==owner||decision.explicit_confirmation!==true||
  !id||!validTime(decidedAt)) return {...result,reason:"owner_confirmation_required"};
 const proposal=reviewableProposals.slice(0,MAX_PROPOSALS).find(item=>
  item&&item.approval_required===true&&item.applied===false&&clean(item.target_key)===target&&clean(item.recommendation)===recommendation&&
  item.memory&&clean(item.memory.memory_key)===target&&
  !blocked.has(String(item.memory.sensitivity||"").toLowerCase()));
 if(!proposal) return {...result,reason:"proposal_not_in_current_review_queue"};
 const safeLedger=ledger.filter(item=>validLedgerRecord(item,owner)).slice(0,MAX_LEDGER);
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
 const unique=[...new Map(eligible.slice().sort((a,b)=>a.decision_id.localeCompare(b.decision_id)).map(item=>[item.decision_id,item])).values()];
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
 return {approvedPreferences,rejectedDecisions,diagnostics:{ownerScoped:true,inspectedDecisions:unique.length,
  omittedDecisions:Math.max(0,eligible.length-unique.length),advisoryOnly:true,preferencesChanged:false,applied:false}};
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
