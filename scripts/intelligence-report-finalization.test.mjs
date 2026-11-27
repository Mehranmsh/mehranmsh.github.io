import assert from "node:assert/strict";
import test from "node:test";
import { buildIntelligenceReportRevisionPath, isIntelligenceReportQuiescent } from "./intelligence-report-finalization.mjs";

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


test("conflicting immutable reports receive deterministic content-addressed revision paths", () => {
  const hash = "AbCdEf0123456789_-";
  const first = buildIntelligenceReportRevisionPath("2026", "11", "package-123", hash);
  assert.equal(first, "reports/2026/11/package-123-AbCdEf0123456789.json");
  assert.equal(buildIntelligenceReportRevisionPath("2026", "11", "package-123", hash), first);
  assert.notEqual(buildIntelligenceReportRevisionPath("2026", "11", "package-123", "Z".repeat(16)), first);
});

test("report revision paths reject unsafe identity components", () => {
  assert.throws(() => buildIntelligenceReportRevisionPath("../", "11", "package-123", "A".repeat(16)));
  assert.throws(() => buildIntelligenceReportRevisionPath("2026", "13", "package-123", "A".repeat(16)));
  assert.throws(() => buildIntelligenceReportRevisionPath("2026", "11", "../secret", "A".repeat(16)));
  assert.throws(() => buildIntelligenceReportRevisionPath("2026", "11", "package-123", "short"));
});
