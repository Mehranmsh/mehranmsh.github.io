import assert from "node:assert/strict";
import { buildEvidenceMetadataReview, classifyEvidenceMetadata } from "../intelligence-evidence-review.mjs";

const none = classifyEvidenceMetadata({id:"f0",module_id:"social",check_id:"privacy",severity:"high",status:"open",evidence_state:"missing",evidence_count:0});
assert.equal(none.metadataState,"no_evidence_references");
assert.equal(none.checkPassed,false);
const incomplete = classifyEvidenceMetadata({id:"f1",module_id:"social",check_id:"privacy",severity:"high",status:"open",evidence_state:"partial",evidence_count:2,missing_digest_count:1,missing_observed_at_count:0,duplicate_digest_count:0});
assert.equal(incomplete.metadataState,"metadata_incomplete");
const recorded = classifyEvidenceMetadata({id:"f2",module_id:"security",check_id:"auditability",severity:"medium",status:"open",evidence_state:"sufficient",evidence_count:2,missing_digest_count:0,missing_observed_at_count:0,duplicate_digest_count:1});
assert.equal(recorded.metadataState,"metadata_recorded_unverified");
assert.equal(recorded.contentVerified,false);
const result = buildEvidenceMetadataReview([
 {id:"f0",module_id:"social",check_id:"privacy",severity:"high",status:"open",evidence_state:"missing",evidence_count:0},
 {id:"f1",module_id:"social",check_id:"privacy",severity:"high",status:"open",evidence_state:"partial",evidence_count:2,missing_digest_count:1,missing_observed_at_count:0,duplicate_digest_count:0},
 {id:"f2",module_id:"security",check_id:"auditability",severity:"medium",status:"open",evidence_state:"sufficient",evidence_count:2,missing_digest_count:0,missing_observed_at_count:0,duplicate_digest_count:1}
]);
assert.equal(result.summary.findingsReviewed,3);
assert.equal(result.summary.withoutEvidenceReferences,1);
assert.equal(result.summary.withIncompleteMetadata,1);
assert.equal(result.summary.withMetadataRecordedButUnverified,1);
assert.equal(result.summary.duplicateDigestReferences,1);
assert.equal(result.evidenceValidity,"unverified");
assert.equal(result.executionEnabled,false);
assert.equal(result.operationPerformed,false);
assert.ok(result.limitations.length >= 4);
console.log("Intelligence evidence metadata review tests passed.");
