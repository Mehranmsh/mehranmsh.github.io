import { proposeIntelligencePreferenceUpdates } from "./intelligence-feedback-learning.mjs";

const BLOCKED=new Set(["secret","credential","wallet","financial","private_social","health","identity"]);
const clean=(value,max=160)=>typeof value==="string"?value.trim().slice(0,max):"";

/**
 * Match feedback proposals to existing owner-scoped preference memories.
 * This is a review bridge only: no memory or preference is written or modified.
 */
export function buildIntelligenceFeedbackReview(memoryRecords, feedbackRecords, options={}) {
 const owner=clean(options.ownerUid,160);
 const base={reviewableProposals:[],unmatchedProposals:[],diagnostics:{
  advisoryOnly:true,ownerApprovalRequired:true,memoryChanged:false,preferencesChanged:false
 }};
 if(!owner||!Array.isArray(memoryRecords)||!Array.isArray(feedbackRecords)) return base;
 const eligible=new Map();
 for(const record of memoryRecords){
  if(!record||typeof record!=="object"||Array.isArray(record)||record.owner_uid!==owner||
   !clean(record.memory_key)||record.deleted_at||(record.status&&record.status!=="active")||
   BLOCKED.has(String(record.sensitivity||"").toLowerCase())) continue;
  const type=String(record.memory_type||record.category||"").toLowerCase();
  if(type!=="preference"&&type!=="decision") continue;
  const key=clean(record.memory_key);
  if(!eligible.has(key)) eligible.set(key,{memory_key:key,memory_type:type});
 }
 const proposed=proposeIntelligencePreferenceUpdates(feedbackRecords,{...options,ownerUid:owner});
 const reviewableProposals=[],unmatchedProposals=[];
 for(const proposal of proposed.proposals){
  const target=eligible.get(proposal.target_key);
  if(!target){
   unmatchedProposals.push({...proposal,reason:"no_matching_active_owner_preference_memory"});
   continue;
  }
  reviewableProposals.push({...proposal,memory:target,approval_required:true,applied:false});
 }
 return {
  reviewableProposals,unmatchedProposals,
  diagnostics:{...proposed.diagnostics,advisoryOnly:true,ownerApprovalRequired:true,memoryChanged:false,preferencesChanged:false,matchedProposals:reviewableProposals.length,unmatchedCount:unmatchedProposals.length}
 };
}
