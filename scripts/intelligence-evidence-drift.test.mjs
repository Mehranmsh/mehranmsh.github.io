import assert from "node:assert/strict";
import { buildEvidenceDrift } from "../intelligence-evidence-drift.mjs";

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const c = "00000000-0000-4000-8000-000000000003";
const d = "00000000-0000-4000-8000-000000000004";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const baseline = [
  { id:a, kind:"test_run", contentDigest:digestA, observedAt:100 },
  { id:b, kind:"document", contentDigest:null, observedAt:null },
  { id:c, kind:"owner_observation", contentDigest:digestB, observedAt:200 }
];
const current = [
  { id:a, kind:"test_run", content_digest:digestA, observed_at:100 },
  { id:b, kind:"document", content_digest:digestB, observed_at:null },
  { id:d, kind:"other", content_digest:null, observed_at:300 }
];
const drift = buildEvidenceDrift(baseline, current);
assert.equal(drift.baselineAvailable, true);
assert.equal(drift.baselineEvidenceCount, 3);
assert.equal(drift.currentEvidenceCount, 3);
assert.deepEqual(drift.unchanged.map(x => x.id), [a]);
assert.deepEqual(drift.changed.map(x => x.id), [b]);
assert.deepEqual(drift.added.map(x => x.id), [d]);
assert.deepEqual(drift.removed.map(x => x.id), [c]);
assert.equal(drift.driftDetected, true);
assert.equal(drift.driftAssessmentAvailable, true);
const empty = buildEvidenceDrift(null, current);
assert.equal(empty.baselineAvailable, false);
assert.equal(empty.driftDetected, false);
assert.equal(empty.driftAssessmentAvailable, false);
assert.throws(() => buildEvidenceDrift([{id:a,kind:"x",contentDigest:null,observedAt:null},{id:a,kind:"x",contentDigest:null,observedAt:null}], current), /duplicate/i);
assert.throws(() => buildEvidenceDrift([{id:"bad",kind:"x",contentDigest:null,observedAt:null}], current), /identity/i);
assert.throws(() => buildEvidenceDrift(baseline, new Array(101).fill({})), /at most 100/i);
console.log("Intelligence evidence drift detection tests passed.");
