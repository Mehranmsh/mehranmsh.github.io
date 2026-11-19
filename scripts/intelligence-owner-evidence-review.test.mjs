import assert from "node:assert/strict";
import {
  OWNER_EVIDENCE_REVIEW_OUTCOMES,
  buildEvidenceSnapshot,
  buildOwnerEvidenceReviewHistory
} from "../intelligence-owner-evidence-review.mjs";

assert.deepEqual(OWNER_EVIDENCE_REVIEW_OUTCOMES, ["accepted", "rejected", "needs_more_info"]);
const snapshot = buildEvidenceSnapshot([
  {id:"00000000-0000-4000-8000-000000000002",kind:"test_run",content_digest:"b".repeat(64),observed_at:200},
  {id:"00000000-0000-4000-8000-000000000001",kind:"owner_observation",content_digest:null,observed_at:null}
]);
assert.equal(snapshot.evidenceCount, 2);
assert.equal(snapshot.evidenceRefs[0].id, "00000000-0000-4000-8000-000000000001");
assert.equal(snapshot.evidenceRefs[0].contentDigest, null);
assert.equal(JSON.parse(snapshot.evidenceSnapshotJson).length, 2);
assert.throws(() => buildEvidenceSnapshot(new Array(101).fill({})), RangeError);
assert.throws(() => buildEvidenceSnapshot([{id:"not-a-uuid"}]), TypeError);
assert.throws(() => buildEvidenceSnapshot([{id:"00000000-0000-4000-8000-000000000001",content_digest:"bad"}]), TypeError);

const history = buildOwnerEvidenceReviewHistory([{
  id:"review-a",
  finding_id:"finding-a",
  outcome:"needs_more_info",
  reason:"Need a reproducible test report.",
  reviewer_uid:"owner-a",
  reviewed_at:123,
  evidence_count:2,
  evidence_snapshot_sha256:"a".repeat(64),
  evidence_snapshot_json:snapshot.evidenceSnapshotJson
}]);
assert.equal(history.items[0].outcome, "needs_more_info");
assert.equal(history.items[0].evidenceSnapshot.length, 2);
assert.equal(history.historyIsAppendOnly, true);
assert.equal(history.evidenceContentVerified, false);
assert.equal(history.checkPassed, false);
assert.equal(history.executionEnabled, false);
assert.equal(history.operationPerformed, false);
console.log("Intelligence owner evidence review ledger tests passed.");
