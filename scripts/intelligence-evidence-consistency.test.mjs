import assert from "node:assert/strict";
import {buildEvidenceConsistency} from "../intelligence-evidence-consistency.mjs";
const f1="10000000-0000-4000-8000-000000000001",f2="10000000-0000-4000-8000-000000000002",f3="10000000-0000-4000-8000-000000000003";
const ids=Array.from({length:6},(_,i)=>"20000000-0000-4000-8000-"+String(i+1).padStart(12,"0")),a="a".repeat(64),b="b".repeat(64);
const rows=[
{id:ids[0],finding_id:f1,module_id:"social",check_id:"privacy",kind:"document",source_ref:"doc:shared",content_digest:a},
{id:ids[1],finding_id:f2,module_id:"security",check_id:"privacy",kind:"document",source_ref:"doc:shared",content_digest:b},
{id:ids[2],finding_id:f3,module_id:"data",check_id:"retention",kind:"document",source_ref:"doc:other",content_digest:a},
{id:ids[3],finding_id:f1,module_id:"social",check_id:"privacy",kind:"document",source_ref:"doc:local",content_digest:b},
{id:ids[4],finding_id:f1,module_id:"social",check_id:"privacy",kind:"document",source_ref:"doc:local",content_digest:a},
{id:ids[5],finding_id:f2,module_id:"security",check_id:"privacy",kind:"document",source_ref:"doc:no-digest",content_digest:null}];
const result=buildEvidenceConsistency(rows);
assert.equal(result.evidenceReferencesScanned,6);assert.equal(result.coverageComplete,true);assert.equal(result.missingDigestCount,1);
assert.equal(result.isConflictVerdict,false);assert.equal(result.isContradictionVerdict,false);assert.equal(result.checkPassed,false);assert.equal(result.executionEnabled,false);assert.equal(result.operationPerformed,false);
assert.ok(result.returnedCandidates.some(x=>x.candidateType==="source_reference_digest_variance_candidate"));
assert.ok(result.returnedCandidates.some(x=>x.candidateType==="digest_reused_across_source_references"));
assert.ok(result.returnedCandidates.some(x=>x.candidateType==="within_finding_source_digest_variance"));
assert.equal(buildEvidenceConsistency([rows[0]]).totalCandidateGroups,0);
const limited=buildEvidenceConsistency(Array.from({length:501},(_,i)=>({...rows[0],id:"30000000-0000-4000-8000-"+String(i+1).padStart(12,"0")})));
assert.equal(limited.evidenceReferenceScanLimitReached,true);assert.equal(limited.coverageComplete,false);
assert.throws(()=>buildEvidenceConsistency([{...rows[0],id:"bad"}]),/UUID/i);assert.throws(()=>buildEvidenceConsistency([{...rows[0],content_digest:"bad"}]),/digest/i);assert.throws(()=>buildEvidenceConsistency(rows,{maxGroups:101}),/bounds/i);
console.log("Intelligence evidence consistency tests passed.");
