import assert from "node:assert/strict";
import test from "node:test";
import { isIntelligenceReportQuiescent } from "./intelligence-report-finalization.mjs";

const quiet = {
  inProgress: 0,
  retryWaiting: 0,
  awaitingApproval: 0,
  queued: 0,
  blockedDependencies: 0
};

test("completed packages are eligible for immutable report finalization", () => {
  assert.equal(isIntelligenceReportQuiescent(quiet), true);
});

test("queued tasks blocked by terminal dependencies are quiescent", () => {
  assert.equal(isIntelligenceReportQuiescent({ ...quiet, queued: 2, blockedDependencies: 2 }), true);
});

test("a runnable queued task prevents report finalization", () => {
  assert.equal(isIntelligenceReportQuiescent({ ...quiet, queued: 2, blockedDependencies: 1 }), false);
});

test("in-progress, retry-waiting, or approval tasks prevent report finalization", () => {
  for (const field of ["inProgress", "retryWaiting", "awaitingApproval"]) {
    assert.equal(isIntelligenceReportQuiescent({ ...quiet, [field]: 1 }), false, field);
  }
});

test("missing, negative, or non-integer counters fail closed", () => {
  assert.equal(isIntelligenceReportQuiescent(null), false);
  assert.equal(isIntelligenceReportQuiescent({ ...quiet, queued: undefined }), false);
  assert.equal(isIntelligenceReportQuiescent({ ...quiet, queued: null }), false);
  assert.equal(isIntelligenceReportQuiescent({ ...quiet, blockedDependencies: -1 }), false);
  assert.equal(isIntelligenceReportQuiescent({ ...quiet, inProgress: 0.5 }), false);
});
