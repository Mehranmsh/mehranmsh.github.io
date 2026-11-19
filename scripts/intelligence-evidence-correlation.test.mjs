import assert from "node:assert/strict";
import { buildEvidenceCorrelation } from "../intelligence-evidence-correlation.mjs";
const f1="10000000-0000-4000-8000-000000000001";
const f2="10000000-0000-4000-8000-000000000002";
const f3="10000000-0000-4000-8000-000000000003";
const e1="20000000-0000-4000-8000-000000000001";
const e2="20000000-0000-4000-8000-000000000002";
const e3="20000000-0000-4000-8000-000000000003";
const e4="20000000-0000-4000-8000-000000000004";
const d1="a".repeat(64), d2="b".repeat(64);
const rows=[
 {id:e1,finding_id:f1,module_id:"social",check_id:"privacy",kind:"document",source_ref:"doc:shared",content_digest:d1},
 {id:e2,finding_id:f2,module_id:"security",check_id:"privacy",kind:"document",source_ref:"doc:shared",content_digest:d1},
 {id:e3,finding_id:f3,module_id:"data",check_id:"retention",kind:"test_run",source_ref:"doc:shared",content_digest:d2},
 {id:e4,finding_id:f1,module_id:"social",check_id:"privacy",kind:"other",source_ref:"doc:private",content_digest:null}
];
const result=buildEvidenceCorrelation(rows);
assert.equal(result.evidenceReferencesScanned,4);
assert.equal(result.coverageComplete,true);
assert.equal(result.isContradictionVerdict,false);
assert.equal(result.executionEnabled,false);
assert.equal(result.operationPerformed,false);
const digest=result.returnedCorrelationGroups.find(x=>x.correlationType==="shared_digest");
assert.ok(digest);
assert.equal(digest.findingCount,2);
assert.equal(digest.referenceCount,2);
const variance=result.returnedCorrelationGroups.find(x=>x.correlationType==="source_reference_digest_variance_candidate");
assert.ok(variance);
assert.equal(variance.findingCount,3);
assert.equal(variance.references.length,3);
const shared=result.returnedCorrelationGroups.find(x=>x.correlationType==="shared_source_reference");
assert.equal(shared,undefined);
assert.equal(buildEvidenceCorrelation([{...rows[0]}]).totalCorrelationGroups,0);
const truncated=buildEvidenceCorrelation(Array.from({length:501},(_,i)=>({...rows[0],id:"30000000-0000-4000-8000-"+String(i+1).padStart(12,"0")})));
assert.equal(truncated.evidenceReferenceScanLimitReached,true);
assert.equal(truncated.coverageComplete,false);
assert.equal(truncated.evidenceReferencesScanned,500);
assert.throws(()=>buildEvidenceCorrelation([{...rows[0],id:"invalid"}]),/UUID/i);
assert.throws(()=>buildEvidenceCorrelation([{...rows[0],content_digest:"bad"}]),/digest/i);
assert.throws(()=>buildEvidenceCorrelation(rows,{maxRows:501}),/bounds/i);
console.log("Intelligence evidence correlation tests passed.");
