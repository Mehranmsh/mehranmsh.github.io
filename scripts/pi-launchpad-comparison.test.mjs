import test from "node:test";
import assert from "node:assert/strict";
import { comparePiLaunchpadBatch, PI_LAUNCHPAD_COMPARISON_MAX_ENTRIES } from "./pi-launchpad-comparison.mjs";

const entry = (tokenId, priorityScore, coveragePercent, report = null) => ({
  tokenId, symbol: tokenId.toUpperCase(), classification: "watchlist",
  score: priorityScore, priorityScore, coveragePercent, riskCount: 1,
  riskPenalty: 2, monitoringPenalty: 0,
  reportStatus: report ? "attached_precomputed_report" : "report_unavailable",
  analysisReport: report
});
const report = (tokenId, overrides = {}) => ({
  identity: { tokenId },
  verdict: { classification: "watchlist" },
  scoreBreakdown: { missingComponents: ["contractSecurity"] },
  liquidityAssessment: { tvlPi: 100, volume24hPi: 20, turnover24h: 0.2, fdvToLiquidity: 5 },
  risks: ["contract_not_verified"],
  provenance: {
    acceptedEvidenceRecordCount: 3,
    rejectedEvidenceRecordCount: 1,
    staleOrUndatedEvidenceCount: 0
  },
  ...overrides
});

test("compares supplied candidates and sorts by priority, then coverage, then ID", () => {
  const result = comparePiLaunchpadBatch({
    accepted: true,
    ranked: [
      entry("beta", 80, 70),
      entry("charlie", 80, 90),
      entry("alpha", 90, 50)
    ]
  });
  assert.equal(result.comparedCount, 3);
  assert.deepEqual(result.entries.map((item) => item.tokenId), ["alpha", "charlie", "beta"]);
  assert.equal(result.entries[0].comparisonRank, 1);
  assert.equal(result.averages.priorityScore.value, 83.33);
});

test("preserves missing reports and missing metrics as unknown", () => {
  const result = comparePiLaunchpadBatch({
    accepted: true,
    ranked: [entry("no-report", 60, 40)]
  });
  assert.equal(result.entries[0].reportStatus, "report_unavailable");
  assert.equal(result.entries[0].liquidity.tvlPi, null);
  assert.equal(result.entries[0].missingComponents, null);
  assert.equal(result.reportUnavailableCount, 1);
});

test("includes explainable report fields only when report identity matches", () => {
  const result = comparePiLaunchpadBatch({
    accepted: true,
    ranked: [entry("good", 75, 80, report("good"))]
  });
  assert.equal(result.entries[0].liquidity.tvlPi, 100);
  assert.deepEqual(result.entries[0].missingComponents, ["contractSecurity"]);
  assert.equal(result.entries[0].acceptedEvidenceRecordCount, 3);
  const mismatch = comparePiLaunchpadBatch({
    accepted: true,
    ranked: [entry("actual", 75, 80, report("other"))]
  });
  assert.equal(mismatch.entries[0].reportStatus, "report_unavailable");
  assert.equal(mismatch.entries[0].liquidity.tvlPi, null);
});

test("reports duplicate and malformed ranked entries without inventing candidates", () => {
  const result = comparePiLaunchpadBatch({
    accepted: true,
    ranked: [entry("same", 70, 70), entry("same", 90, 90), null]
  });
  assert.equal(result.comparedCount, 1);
  assert.deepEqual(result.issues.map((item) => item.reason), [
    "duplicate_token_id", "invalid_ranked_candidate"
  ]);
});

test("rejects unsupported batch inputs and enforces the comparison bound", () => {
  assert.throws(() => comparePiLaunchpadBatch([]), TypeError);
  const ranked = Array.from(
    { length: PI_LAUNCHPAD_COMPARISON_MAX_ENTRIES + 1 },
    (_, index) => entry("token-" + index, 70, 70)
  );
  assert.deepEqual(comparePiLaunchpadBatch({ accepted: true, ranked }), {
    accepted: false,
    code: "comparison_limit_exceeded",
    limit: PI_LAUNCHPAD_COMPARISON_MAX_ENTRIES,
    received: PI_LAUNCHPAD_COMPARISON_MAX_ENTRIES + 1
  });
});
