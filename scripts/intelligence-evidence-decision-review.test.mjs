import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  buildEvidenceDecisionReviewSnapshot,
  buildEvidenceDecisionReviewHistory,
  buildEvidenceDecisionReviewIntegrity,
  EVIDENCE_DECISION_REVIEW_OUTCOMES
} from "../intelligence-evidence-decision-review.mjs";

test("builds bounded deterministic recommendation snapshots", () => {
  const recommendation = {
    sourceType: "finding_metadata", sourceId: "f-1", moduleId: "security",
    checkId: "auth", priority: "high", priorityScore: 115,
    recommendation: "Attach evidence.", rationale: "No references recorded.",
    priorOwnerOutcome: null
  };
  const first = buildEvidenceDecisionReviewSnapshot(recommendation);
  const second = buildEvidenceDecisionReviewSnapshot(recommendation);
  assert.deepEqual(first, second);
  assert.equal(JSON.parse(first.snapshotJson).sourceId, "f-1");
  assert.ok(first.snapshotJson.length <= 20000);
});

test("rejects malformed recommendation identity and oversized snapshots", () => {
  assert.throws(() => buildEvidenceDecisionReviewSnapshot({sourceType:"unknown",sourceId:"x"}), /valid recommendation/);
  assert.throws(() => buildEvidenceDecisionReviewSnapshot({sourceType:"finding_metadata",sourceId:"x".repeat(301)}), /valid recommendation/);
  assert.throws(() => buildEvidenceDecisionReviewSnapshot({
    sourceType:"finding_metadata",sourceId:"x",recommendation:"x".repeat(21000)
  }), /size/);
});

test("maps append-only human review history without implying verification", () => {
  const history = buildEvidenceDecisionReviewHistory([{
    id:"review-1",review_key_sha256:"a".repeat(64),source_type:"finding_metadata",
    source_id:"f-1",outcome:"accepted",reason:"Reviewed",reviewer_uid:"owner",
    reviewed_at:123,review_snapshot_sha256:"b".repeat(64),
    review_snapshot_json:'{"sourceType":"finding_metadata","sourceId":"f-1"}'
  }]);
  assert.equal(history.items.length,1);
  assert.equal(history.items[0].outcome,"accepted");
  assert.equal(history.historyIsAppendOnly,true);
  assert.equal(history.evidenceContentVerified,false);
  assert.equal(history.checkPassed,false);
  assert.equal(history.executionEnabled,false);
  assert.throws(() => buildEvidenceDecisionReviewHistory(Array(101).fill({})), /100/);
  assert.deepEqual(EVIDENCE_DECISION_REVIEW_OUTCOMES,["accepted","rejected","needs_more_info"]);
});


const hashSnapshot = value => createHash("sha256").update(value).digest("hex");

test("reports matching owner decision snapshot metadata without claiming evidence verification", async () => {
  const snapshot = JSON.stringify({sourceType:"finding_metadata",sourceId:"finding-1"});
  const result = await buildEvidenceDecisionReviewIntegrity([{
    id:"review-1",owner_uid:"owner",reviewer_uid:"owner",
    source_type:"finding_metadata",source_id:"finding-1",outcome:"accepted",
    reviewed_at:123,review_snapshot_json:snapshot,review_snapshot_sha256:hashSnapshot(snapshot)
  }], async value => hashSnapshot(value));
  assert.equal(result.summary.integrityMatches,1);
  assert.equal(result.items[0].status,"integrity_match");
  assert.equal(result.evidenceContentVerified,false);
  assert.equal(result.sourceReachabilityChecked,false);
  assert.equal(result.decisionTruthVerified,false);
  assert.equal(result.checkPassed,false);
  assert.equal(result.executionEnabled,false);
});

test("detects stored snapshot hash mismatch and identity mismatch", async () => {
  const snapshot = JSON.stringify({sourceType:"finding_metadata",sourceId:"other-finding"});
  const result = await buildEvidenceDecisionReviewIntegrity([{
    id:"review-2",owner_uid:"owner",reviewer_uid:"owner",
    source_type:"finding_metadata",source_id:"finding-2",outcome:"rejected",
    reviewed_at:124,review_snapshot_json:snapshot,review_snapshot_sha256:"0".repeat(64)
  }], async value => hashSnapshot(value));
  assert.equal(result.items[0].status,"snapshot_hash_mismatch");
  assert.equal(result.items[0].snapshotIdentityMatches,false);
  assert.equal(result.summary.snapshotHashMismatches,1);
});

test("detects reviewer ownership mismatch and malformed stored JSON", async () => {
  const validJson = JSON.stringify({sourceType:"finding_metadata",sourceId:"finding-3"});
  const result = await buildEvidenceDecisionReviewIntegrity([
    {id:"review-3",owner_uid:"owner",reviewer_uid:"other",source_type:"finding_metadata",source_id:"finding-3",outcome:"accepted",reviewed_at:125,review_snapshot_json:validJson,review_snapshot_sha256:hashSnapshot(validJson)},
    {id:"review-4",owner_uid:"owner",reviewer_uid:"owner",source_type:"finding_metadata",source_id:"finding-4",outcome:"needs_more_info",reviewed_at:126,review_snapshot_json:"{broken",review_snapshot_sha256:"0".repeat(64)}
  ], async value => hashSnapshot(value));
  assert.equal(result.items[0].status,"reviewer_owner_mismatch");
  assert.equal(result.items[1].status,"invalid_snapshot_json");
  assert.equal(result.summary.reviewerOwnerMismatches,1);
  assert.equal(result.summary.invalidSnapshotJson,1);
});

test("bounds integrity review input to 100 records", async () => {
  await assert.rejects(
    buildEvidenceDecisionReviewIntegrity(Array(101).fill({}), async () => "0".repeat(64)),
    /at most 100/
  );
});
