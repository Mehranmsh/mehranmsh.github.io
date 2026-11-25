import test from "node:test";
import assert from "node:assert/strict";
import {buildIntelligenceFeedbackReview} from "./intelligence-feedback-review.mjs";
const feedback=[
 {feedback_id:"1",owner_uid:"owner",target_key:"preferred-tone",outcome:"accepted",feedback_confirmed:true,confirmed_by:"owner"},
 {feedback_id:"2",owner_uid:"owner",target_key:"preferred-tone",outcome:"accepted",feedback_confirmed:true,confirmed_by:"owner"},
 {feedback_id:"3",owner_uid:"owner",target_key:"missing-tone",outcome:"rejected",feedback_confirmed:true,confirmed_by:"owner"},
 {feedback_id:"4",owner_uid:"owner",target_key:"missing-tone",outcome:"rejected",feedback_confirmed:true,confirmed_by:"owner"}
];
const memories=[
 {owner_uid:"owner",memory_key:"preferred-tone",memory_type:"preference",status:"active"},
 {owner_uid:"owner",memory_key:"private-tone",memory_type:"preference",sensitivity:"private_social"},
 {owner_uid:"someone-else",memory_key:"foreign-tone",memory_type:"preference"}
];
test("matches proposals only to active owner preference memories",()=>{
 const r=buildIntelligenceFeedbackReview(memories,feedback,{ownerUid:"owner"});
 assert.equal(r.reviewableProposals.length,1);
 assert.equal(r.reviewableProposals[0].memory.memory_key,"preferred-tone");
 assert.equal(r.unmatchedProposals.length,1);
 assert.equal(r.unmatchedProposals[0].reason,"no_matching_active_owner_preference_memory");
});
test("never exposes other owners, sensitive, deleted, or inactive memories as targets",()=>{
 const rows=[...memories,
  {owner_uid:"owner",memory_key:"deleted-tone",memory_type:"preference",deleted_at:"2026-01-01"},
  {owner_uid:"owner",memory_key:"inactive-tone",memory_type:"decision",status:"inactive"}
 ];
 const f=[...feedback,
  {...feedback[0],feedback_id:"5",target_key:"private-tone"},
  {...feedback[0],feedback_id:"6",target_key:"foreign-tone"},
  {...feedback[0],feedback_id:"7",target_key:"deleted-tone"},
  {...feedback[0],feedback_id:"8",target_key:"inactive-tone"}
 ];
 const r=buildIntelligenceFeedbackReview(rows,f,{ownerUid:"owner"});
 assert.deepEqual(r.reviewableProposals.map(x=>x.memory.memory_key),["preferred-tone"]);
 assert.equal(r.diagnostics.memoryChanged,false);
});
test("review generation never mutates memory or feedback inputs",()=>{
 const m=structuredClone(memories),f=structuredClone(feedback);
 const beforeM=structuredClone(m),beforeF=structuredClone(f);
 const a=buildIntelligenceFeedbackReview(m,f,{ownerUid:"owner"});
 const b=buildIntelligenceFeedbackReview(m,f,{ownerUid:"owner"});
 assert.deepEqual(a,b);
 assert.deepEqual(m,beforeM);
 assert.deepEqual(f,beforeF);
 assert.equal(a.diagnostics.preferencesChanged,false);
 assert.ok(a.reviewableProposals.every(x=>x.approval_required&&x.applied===false));
});
test("fails closed when owner scope or source arrays are missing",()=>{
 assert.equal(buildIntelligenceFeedbackReview(memories,feedback).reviewableProposals.length,0);
 assert.equal(buildIntelligenceFeedbackReview(null,feedback,{ownerUid:"owner"}).reviewableProposals.length,0);
});
