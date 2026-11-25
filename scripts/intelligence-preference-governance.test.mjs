import test from "node:test";
import assert from "node:assert/strict";
import {recordIntelligencePreferenceDecision,buildApprovedPreferenceProfile} from "./intelligence-preference-governance.mjs";

const proposals=[{target_key:"concise",recommendation:"increase_preference",approval_required:true,applied:false,
 memory:{memory_key:"concise",memory_type:"preference"}}];
const decision=(extra={})=>({target_key:"concise",recommendation:"increase_preference",decision:"accepted",
 actor_uid:"owner",decision_id:"d-1",decided_at:"2026-11-26T12:00:00.000Z",explicit_confirmation:true,...extra});

test("records an explicit owner approval without applying or changing preferences",()=>{
 const r=recordIntelligencePreferenceDecision(proposals,[],decision(),{ownerUid:"owner"});
 assert.equal(r.ledger.length,1);assert.equal(r.event.actor_uid,"owner");
 assert.equal(r.diagnostics.preferencesChanged,false);assert.equal(r.diagnostics.applied,false);
 const profile=buildApprovedPreferenceProfile(r.ledger,{ownerUid:"owner"});
 assert.equal(profile.approvedPreferences[0].target_key,"concise");
 assert.equal(profile.approvedPreferences[0].read_only,true);
});
test("rejects implicit, foreign, malformed, or unqueued decisions",()=>{
 for(const d of [decision({explicit_confirmation:false}),decision({actor_uid:"other"}),decision({decision:"maybe"}),decision({decided_at:"bad"})]){
  assert.equal(recordIntelligencePreferenceDecision(proposals,[],d,{ownerUid:"owner"}).ledger.length,0);
 }
 assert.equal(recordIntelligencePreferenceDecision([],[],decision(),{ownerUid:"owner"}).ledger.length,0);
});
test("rejects duplicate event IDs and never mutates caller data",()=>{
 const first=recordIntelligencePreferenceDecision(proposals,[],decision(),{ownerUid:"owner"});
 const before=structuredClone(first.ledger), input=structuredClone(proposals);
 const second=recordIntelligencePreferenceDecision(proposals,first.ledger,decision(),{ownerUid:"owner"});
 assert.equal(second.ledger.length,0);assert.equal(second.reason,"duplicate_decision_id");
 assert.deepEqual(first.ledger,before);assert.deepEqual(proposals,input);
});
test("latest explicit rejection revokes an earlier approval in the exported profile",()=>{
 const a=recordIntelligencePreferenceDecision(proposals,[],decision(),{ownerUid:"owner"});
 const b=recordIntelligencePreferenceDecision(proposals,a.ledger,decision({decision:"rejected",decision_id:"d-2",decided_at:"2026-11-26T13:00:00.000Z"}),{ownerUid:"owner"});
 const profile=buildApprovedPreferenceProfile(b.ledger,{ownerUid:"owner"});
 assert.equal(profile.approvedPreferences.length,0);
 assert.equal(profile.rejectedDecisions.length,1);
});
test("isolates owners and excludes malformed, unconfirmed, and sensitive ledger rows",()=>{
 const good=recordIntelligencePreferenceDecision(proposals,[],decision(),{ownerUid:"owner"}).ledger[0];
 const rows=[good,{...good,decision_id:"foreign",owner_uid:"other",actor_uid:"other"},
  {...good,decision_id:"implicit",explicit_confirmation:false},
  {...good,decision_id:"secret",sensitivity:"credential"}];
 assert.equal(buildApprovedPreferenceProfile(rows,{ownerUid:"owner"}).approvedPreferences.length,1);
 assert.equal(buildApprovedPreferenceProfile(rows,{ownerUid:"other"}).approvedPreferences.length,0);
});
test("is deterministic, bounded, and fails closed without owner scope",()=>{
 const r=recordIntelligencePreferenceDecision(proposals,[],decision(),{ownerUid:"owner"});
 const a=buildApprovedPreferenceProfile(r.ledger,{ownerUid:"owner"});
 const b=buildApprovedPreferenceProfile(r.ledger,{ownerUid:"owner"});
 assert.deepEqual(a,b);
 assert.equal(buildApprovedPreferenceProfile(r.ledger).approvedPreferences.length,0);
});
