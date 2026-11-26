import test from "node:test";
import assert from "node:assert/strict";
import { rankPiLaunchpadPortfolio, PI_LAUNCHPAD_RANKER_VERSION } from "./pi-launchpad-portfolio-ranker.mjs";

const candidate = (tokenId, score, coveragePercent = 85, classification = "strong_candidate", risks = []) => ({
  tokenId, symbol: tokenId.toUpperCase(), score, coveragePercent, classification, risks
});

test("ranks eligible candidates by adjusted priority and stable tie-breaks", () => {
  const result = rankPiLaunchpadPortfolio([
    candidate("b", 80, 90), candidate("a", 80, 95), candidate("c", 75, 90)
  ]);
  assert.equal(result.rankerVersion, PI_LAUNCHPAD_RANKER_VERSION);
  assert.deepEqual(result.ranked.map((item) => item.tokenId), ["a", "b", "c"]);
  assert.deepEqual(result.ranked.map((item) => item.rank), [1, 2, 3]);
});

test("excludes critical-risk, insufficient-data, and low-coverage candidates", () => {
  const result = rankPiLaunchpadPortfolio([
    candidate("critical", 95, 100, "critical_risk"),
    candidate("unknown", 80, 90, "insufficient_data"),
    candidate("thin", 90, 40)
  ]);
  assert.equal(result.ranked.length, 0);
  assert.deepEqual(result.excluded.map((item) => item.reason), [
    "critical_risk", "insufficient_data", "coverage_below_minimum"
  ]);
});

test("risk flags and monitoring events reduce priority without hiding source score", () => {
  const result = rankPiLaunchpadPortfolio([
    { analysis: candidate("clean", 90), monitor: { events: [] } },
    { analysis: candidate("risk", 90, 85, "strong_candidate", ["owner risk"]), monitor: {
      events: [{ severity: "high" }, { severity: "medium" }]
    } }
  ]);
  assert.equal(result.ranked[0].tokenId, "clean");
  const risk = result.ranked.find((item) => item.tokenId === "risk");
  assert.equal(risk.score, 90);
  assert.equal(risk.riskPenalty, 2);
  assert.equal(risk.monitoringPenalty, 15);
  assert.equal(risk.priorityScore, 73);
});

test("rejects malformed entries, duplicate IDs, and invalid options safely", () => {
  const result = rankPiLaunchpadPortfolio([
    null, candidate("same", 70), candidate("same", 99), candidate("bad", 101)
  ], { minCoveragePercent: 70 });
  assert.equal(result.ranked.length, 1);
  assert.deepEqual(result.excluded.map((item) => item.reason), [
    "invalid_or_incomplete_analysis", "duplicate_token_id", "invalid_or_incomplete_analysis"
  ]);
  assert.equal(result.minimumCoveragePercent, 70);
  assert.throws(() => rankPiLaunchpadPortfolio({}), TypeError);
});

test("applies configured coverage threshold and bounded penalties", () => {
  const result = rankPiLaunchpadPortfolio([
    candidate("edge", 50, 70, "weak_candidate", Array(20).fill("risk"))
  ], { minCoveragePercent: 70, riskPenaltyPerFlag: 9, maxRiskPenalty: 12 });
  assert.equal(result.ranked[0].riskPenalty, 12);
  assert.equal(result.ranked[0].priorityScore, 38);
});
