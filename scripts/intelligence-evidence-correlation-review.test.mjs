import assert from "node:assert/strict";
import {
 buildEvidenceCorrelationReviewSnapshot,
 buildEvidenceCorrelationReviewHistory,
 EVIDENCE_CORRELATION_REVIEW_OUTCOMES,
 EVIDENCE_CORRELATION_TYPES
} from "../intelligence-evidence-correlation-review.mjs";
const f1="10000000-0000-4000-8000-000000000001";
const f2="10000000-0000-4000-8000-000000000002";
const e1="20000000-0000-4000-8000-000000000001";
const e2="20000000-0000-4000-8000-000000000002";
const refs=[
 {evidenceId:e2,findingId:f2,moduleId:"security",checkId:"privacy",kind:"document",sourceRef:"doc:shared",contentDigest:"b".repeat(64)},
 {evidenceId:e1,findingId:f1,moduleId:"social",checkId:"privacy",kind:"document",sourceRef:"doc:shared",contentDigest:"a".repeat(64)}
];
const snapshot=buildEvidenceCorrelationReviewSnapshot(refs);
assert.equal(snapshot.referenceCount,2);
assert.deepEqual(snapshot.references.map(x=>x.evidenceId),[e1,e2]);
assert.equal(JSON.parse(snapshot.snapshotJson).length,2);
assert.deepEqual(EVIDENCE_CORRELATION_REVIEW_OUTCOMES,["related","unrelated","needs_more_info"]);
assert.equal(EVIDENCE_CORRELATION_TYPES.length,3);
assert.throws(()=>buildEvidenceCorrelationReviewSnapshot([refs[0]]),/2 to 20/i);
assert.throws(()=>buildEvidenceCorrelationReviewSnapshot([...refs,...refs]),/duplicate/i);
assert.throws(()=>buildEvidenceCorrelationReviewSnapshot([{...refs[0],evidenceId:"bad"},refs[1]]),/identity/i);
assert.throws(()=>buildEvidenceCorrelationReviewSnapshot([{...refs[0],contentDigest:"bad"},refs[1]]),/digest/i);
assert.throws(()=>buildEvidenceCorrelationReviewSnapshot([{...refs[0],sourceRef:"bad\nref"},refs[1]]),/source reference/i);
const history=buildEvidenceCorrelationReviewHistory([{
 id:"review-1",correlation_type:"shared_source_reference",correlation_key_sha256:"c".repeat(64),
 outcome:"related",reason:"Same source reference was reviewed.",reviewer_uid:"owner-a",
 reviewed_at:100,reference_count:2,correlation_snapshot_sha256:"d".repeat(64),
 correlation_snapshot_json:snapshot.snapshotJson
}]);
assert.equal(history.items.length,1);
assert.equal(history.items[0].snapshot.length,2);
assert.equal(history.historyIsAppendOnly,true);
assert.equal(history.evidenceContentVerified,false);
assert.equal(history.relationshipFactVerified,false);
assert.equal(history.checkPassed,false);
assert.equal(history.executionEnabled,false);
assert.equal(history.operationPerformed,false);
assert.throws(()=>buildEvidenceCorrelationReviewHistory([{correlation_snapshot_json:"{broken"}]),SyntaxError);
console.log("Intelligence evidence correlation review ledger tests passed.");
