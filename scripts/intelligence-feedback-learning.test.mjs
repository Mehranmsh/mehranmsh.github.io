import test from "node:test";
import assert from "node:assert/strict";
import {proposeIntelligencePreferenceUpdates} from "./intelligence-feedback-learning.mjs";
const feedback=[
 {feedback_id:"1",owner_uid:"owner",target_key:"concise_answers",outcome:"accepted",feedback_confirmed:true,confirmed_by:"owner"},
 {feedback_id:"2",owner_uid:"owner",target_key:"concise_answers",outcome:"accepted",feedback_confirmed:true,confirmed_by:"owner"},
 {feedback_id:"3",owner_uid:"owner",target_key:"verbose_answers",outcome:"rejected",feedback_confirmed:true,confirmed_by:"owner"},
 {feedback_id:"4",owner_uid:"owner",target_key:"verbose_answers",outcome:"rejected",feedback_confirmed:true,confirmed_by:"owner"}
];
test("proposes evidence-backed preference updates without applying them",()=>{
 const r=proposeIntelligencePreferenceUpdates(feedback,{ownerUid:"owner"});
 assert.deepEqual(r.proposals.map(x=>[x.target_key,x.recommendation]),[
  ["concise_answers","increase_preference"],["verbose_answers","decrease_preference"]
 ]);
 assert.equal(r.proposals[0].confidence,1);
 assert.equal(r.proposals[0].approval_required,true);
 assert.equal(r.proposals[0].applied,false);
 assert.equal(r.diagnostics.preferencesChanged,false);
});
test("requires explicit owner confirmation and never learns from silence",()=>{
 const rows=[feedback[0],{...feedback[1],feedback_confirmed:false},{...feedback[2],confirmed_by:"someone-else"}];
 assert.equal(proposeIntelligencePreferenceUpdates(rows,{ownerUid:"owner"}).proposals.length,0);
 assert.equal(proposeIntelligencePreferenceUpdates([],{ownerUid:"owner"}).proposals.length,0);
});
test("isolates owners and excludes deleted, inactive, and sensitive feedback",()=>{
 const rows=[feedback[0],feedback[1],
  {...feedback[0],feedback_id:"other",owner_uid:"other"},
  {...feedback[0],feedback_id:"deleted",deleted_at:"2026-01-01"},
  {...feedback[0],feedback_id:"inactive",status:"inactive"},
  {...feedback[0],feedback_id:"wallet",sensitivity:"wallet"}
 ];
 const r=proposeIntelligencePreferenceUpdates(rows,{ownerUid:"owner"});
 assert.equal(r.proposals.length,1);
 assert.equal(r.proposals[0].observations,2);
});
test("does not produce a proposal without enough dominant observations",()=>{
 const r=proposeIntelligencePreferenceUpdates([
  feedback[0],{...feedback[1],outcome:"rejected"}
 ],{ownerUid:"owner"});
 assert.equal(r.proposals.length,0);
 assert.equal(proposeIntelligencePreferenceUpdates([feedback[0]],{ownerUid:"owner"}).proposals.length,0);
});
test("deduplicates feedback IDs and remains deterministic",()=>{
 const rows=[...feedback,feedback[0]];
 const before=structuredClone(rows);
 const a=proposeIntelligencePreferenceUpdates(rows,{ownerUid:"owner"});
 const b=proposeIntelligencePreferenceUpdates(rows,{ownerUid:"owner"});
 assert.deepEqual(a,b);
 assert.deepEqual(rows,before);
 assert.equal(a.proposals.find(x=>x.target_key==="concise_answers").observations,2);
});
test("bounds feedback volume and clamps thresholds",()=>{
 const rows=Array.from({length:510},(_,i)=>({...feedback[0],feedback_id:String(i)}));
 const r=proposeIntelligencePreferenceUpdates(rows,{ownerUid:"owner",minimumObservations:1,dominanceThreshold:0.1});
 assert.equal(r.diagnostics.inspectedFeedback,500);
 assert.equal(r.diagnostics.omittedFeedback,10);
 assert.equal(r.proposals[0].observations,500);
});
test("returns no proposals without owner scope or valid inputs",()=>{
 assert.equal(proposeIntelligencePreferenceUpdates(feedback).proposals.length,0);
 assert.equal(proposeIntelligencePreferenceUpdates(null,{ownerUid:"owner"}).proposals.length,0);
});
