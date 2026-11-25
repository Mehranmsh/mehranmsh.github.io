import test from "node:test";
import assert from "node:assert/strict";
import {evaluateIntelligenceOptions} from "./intelligence-decision-engine.mjs";
import {recordIntelligencePreferenceDecision,buildApprovedPreferenceProfile} from "./intelligence-preference-governance.mjs";
const criteria=[{key:"quality",weight:2,direction:"higher"},{key:"cost",weight:1,direction:"lower"}];
test("ranks by weighted explicit scores and explains evidence",()=>{
 const r=evaluateIntelligenceOptions([{id:"a",scores:{quality:5,cost:4}},{id:"b",scores:{quality:4,cost:1}}],criteria,{ownerUid:"owner"});
 assert.equal(r.rankedOptions[0].option_id,"b"); assert.equal(r.rankedOptions[0].score,4); assert.equal(r.diagnostics.decisionMade,false);
});
test("excludes only owner-confirmed failed hard constraints",()=>{
 const r=evaluateIntelligenceOptions([{id:"no",scores:{quality:5,cost:5},constraints:[{key:"budget",passed:false,confirmed:true,confirmed_by:"owner"}]},{id:"maybe",scores:{quality:3,cost:3},constraints:[{key:"budget",passed:false,confirmed:true,confirmed_by:"other"}]}],criteria,{ownerUid:"owner"});
 assert.deepEqual(r.excludedOptions.map(x=>x.option_id),["no"]); assert.equal(r.rankedOptions[0].option_id,"maybe"); assert.equal(r.rankedOptions[0].approval_required,true);
});
test("missing scores and unconfirmed constraints require review",()=>{
 const r=evaluateIntelligenceOptions([{id:"x",scores:{quality:4},constraints:[{key:"legal"}]}],criteria,{ownerUid:"owner"});
 assert.equal(r.rankedOptions[0].coverage,0.6667); assert.equal(r.rankedOptions[0].review_required,true); assert.equal(r.reviewRequired.length,1);
});
test("high-impact choices always require owner review",()=>{
 const r=evaluateIntelligenceOptions([{id:"x",high_impact:true,scores:{quality:4,cost:4}}],criteria,{ownerUid:"owner"});
 assert.equal(r.rankedOptions[0].approval_required,true);
});
test("is deterministic, bounded, and safe without owner scope",()=>{
 const opts=[{id:"b",scores:{quality:2,cost:2}},{id:"a",scores:{quality:2,cost:2}}],before=structuredClone(opts);
 const a=evaluateIntelligenceOptions(opts,criteria,{ownerUid:"owner"}),b=evaluateIntelligenceOptions(opts,criteria,{ownerUid:"owner"});
 assert.deepEqual(a,b);assert.deepEqual(opts,before);assert.deepEqual(a.rankedOptions.map(x=>x.option_id),["a","b"]);
 assert.equal(evaluateIntelligenceOptions(opts,criteria).rankedOptions.length,0);
});

test("decision engine consumes approved preference profile only after explicit opt-in",()=>{
 const proposals=[{target_key:"quality",recommendation:"increase_preference",approval_required:true,applied:false,
  memory:{memory_key:"quality",memory_type:"preference"}}];
 const recorded=recordIntelligencePreferenceDecision(proposals,[],{
  target_key:"quality",recommendation:"increase_preference",decision:"accepted",actor_uid:"owner",
  decision_id:"pref-1",decided_at:"2026-11-26T12:00:00.000Z",explicit_confirmation:true
 },{ownerUid:"owner",actorUid:"owner"});
 const profile=buildApprovedPreferenceProfile(recorded.ledger,{ownerUid:"owner"});
 const criteria=[{key:"quality",weight:50,direction:"higher"},{key:"cost",weight:50,direction:"higher"}];
 const options=[{id:"a",scores:{quality:5,cost:0}},{id:"b",scores:{quality:0,cost:5}}];
 const normal=evaluateIntelligenceOptions(options,criteria,{ownerUid:"owner"});
 const opted=evaluateIntelligenceOptions(options,criteria,{ownerUid:"owner",approvedPreferenceProfile:profile,allowApprovedPreferences:true,actorUid:"owner"});
 assert.equal(normal.diagnostics.preferencesApplied,false);
 assert.equal(opted.diagnostics.preferencesApplied,true);
 assert.equal(opted.rankedOptions[0].evidence.find(x=>x.criterion==="quality").weight,55);
 assert.deepEqual(criteria,[{key:"quality",weight:50,direction:"higher"},{key:"cost",weight:50,direction:"higher"}]);
});
