import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceDecisionReviewSnapshot,
  buildEvidenceDecisionReviewHistory,
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
