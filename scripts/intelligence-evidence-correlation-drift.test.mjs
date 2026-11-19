import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidenceCorrelationReviewDrift } from "../intelligence-evidence-correlation-drift.mjs";

const a="10000000-0000-4000-8000-000000000001";
const b="10000000-0000-4000-8000-000000000002";
const c="10000000-0000-4000-8000-000000000003";
const ref=(evidenceId,sourceRef="doc:shared",contentDigest="a".repeat(64))=>({
 evidenceId,findingId:"20000000-0000-4000-8000-000000000001",
 moduleId:"social",checkId:"privacy",kind:"document",sourceRef,contentDigest
});

test("classifies unchanged, changed, added, and removed correlation references",()=>{
 const result=buildEvidenceCorrelationReviewDrift(
  {references:[ref(a),ref(b)]},
  [ref(a),ref(b,"doc:shared","b".repeat(64)),ref(c)]
 );
 assert.deepEqual(result.counts,{unchanged:1,changed:1,added:1,removed:0});
 assert.equal(result.driftDetected,true);
 assert.equal(result.changed[0].evidenceId,b);
 assert.equal(result.isRelationshipVerdict,false);
 assert.equal(result.evidenceContentVerified,false);
 assert.equal(result.operationPerformed,false);
});

test("reports removed references and no drift for identical metadata",()=>{
 const same=buildEvidenceCorrelationReviewDrift({references:[ref(a),ref(b)]},[ref(b),ref(a)]);
 assert.equal(same.driftDetected,false);
 assert.equal(same.counts.unchanged,2);
 const removed=buildEvidenceCorrelationReviewDrift({references:[ref(a),ref(b)]},[ref(a)]);
 assert.equal(removed.counts.removed,1);
 assert.equal(removed.removed[0].evidenceId,b);
});

test("rejects invalid, duplicate, and oversized snapshots",()=>{
 assert.throws(()=>buildEvidenceCorrelationReviewDrift({references:[ref(a)]},[]),/invalid/i);
 assert.throws(()=>buildEvidenceCorrelationReviewDrift({references:[ref(a),ref(a)]},[]),/duplicate/i);
 assert.throws(()=>buildEvidenceCorrelationReviewDrift({references:[ref(a),ref(b)]},[ref(a),ref(a)]),/duplicate/i);
 assert.throws(()=>buildEvidenceCorrelationReviewDrift({references:[ref(a),ref(b)]},Array.from({length:21},(_,i)=>ref("10000000-0000-4000-8000-"+String(i+1).padStart(12,"0")))),/at most 20/i);
});
