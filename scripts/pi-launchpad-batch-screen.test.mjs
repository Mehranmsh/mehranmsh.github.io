import test from "node:test";
import assert from "node:assert/strict";
import { screenPiLaunchpadBatch, PI_LAUNCHPAD_BATCH_MAX_CANDIDATES } from "./pi-launchpad-batch-screen.mjs";

const result = (tokenId, score, classification = "strong_candidate", coveragePercent = 85) => ({
  tokenId, score, classification, coveragePercent, risks: []
});

test("screens a batch, ranks eligible entries, and summarizes quality", () => {
  const report = screenPiLaunchpadBatch([
    result("alpha", 90), result("beta", 70, "watchlist", 65),
    result("unknown", null, "insufficient_data", 10)
  ]);
  assert.equal(report.accepted, true);
  assert.equal(report.received, 3);
  assert.equal(report.uniqueCandidates, 3);
  assert.equal(report.eligibleCount, 2);
  assert.equal(report.excludedCount, 1);
  assert.equal(report.averageEvidenceCoverage, 53.33);
  assert.equal(report.averageRawScore, 80);
  assert.equal(report.ranked[0].tokenId, "alpha");
  assert.equal(report.classifications.insufficient_data, 1);
});

test("records malformed and duplicate entries without aborting the batch", () => {
  const report = screenPiLaunchpadBatch([
    null, {}, result("same", 70), result("same", 90)
  ]);
  assert.equal(report.malformedRecords, 2);
  assert.equal(report.uniqueCandidates, 1);
  assert.ok(report.excluded.some((item) => item.reason === "duplicate_token_id"));
  assert.ok(report.excluded.some((item) => item.reason === "invalid_candidate_record"));
});

test("rejects oversized batches with a bounded response", () => {
  const input = Array.from({ length: 4 }, (_, index) => result("t" + index, 70));
  const report = screenPiLaunchpadBatch(input, { maxCandidates: 3 });
  assert.deepEqual(report, {
    accepted: false, code: "batch_limit_exceeded", limit: 3, received: 4
  });
  assert.equal(PI_LAUNCHPAD_BATCH_MAX_CANDIDATES, 500);
});

test("caps caller-supplied batch limit and validates input type", () => {
  assert.throws(() => screenPiLaunchpadBatch({}), TypeError);
  const input = [result("one", 80)];
  assert.equal(screenPiLaunchpadBatch(input, { maxCandidates: 999999 }).accepted, true);
});
