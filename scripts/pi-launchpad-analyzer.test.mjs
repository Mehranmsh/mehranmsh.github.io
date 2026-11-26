import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLaunchpadOpportunity, LAUNCHPAD_ANALYZER_VERSION } from "./pi-launchpad-analyzer.mjs";
import "./pi-launchpad-data-adapter.test.mjs";
import "./pi-launchpad-attestation-verifier.test.mjs";
import "./pi-launchpad-trust-store.test.mjs";
import "./pi-launchpad-evidence-gateway.test.mjs";
import "./pi-launchpad-verified-analyzer.test.mjs";
import "./pi-launchpad-source-registry.test.mjs";
import "./pi-launchpad-batch-screen.test.mjs";
import "./pi-launchpad-portfolio-ranker.test.mjs";
import "./pi-launchpad-connector-policy.test.mjs";
import "./pi-launchpad-snapshot-monitor.test.mjs";

test("reports versioned insufficient-data result without inventing a score", () => {
  const result = analyzeLaunchpadOpportunity({ networkId: "pi-mainnet", tokenId: "pi-token-1", symbol: "PIT" });
  assert.equal(result.analyzerVersion, LAUNCHPAD_ANALYZER_VERSION);
  assert.equal(result.score, null);
  assert.equal(result.classification, "insufficient_data");
  assert.equal(result.coveragePercent, 0);
});

test("scores only supplied evidence and exposes evidence coverage", () => {
  const result = analyzeLaunchpadOpportunity({
    tokenId: "token-a",
    evidence: { utility: 90, teamTransparency: 80, tokenomics: 70, marketActivity: 60, contractSecurity: 90, sourceVerification: 100 }
  });
  assert.equal(result.coveragePercent, 85);
  assert.equal(result.confidence, "high");
  assert.equal(result.componentScores.liquidity, null);
  assert.equal(result.score, 82);
});

test("liquidity metrics are calculated from Pi-denominated inputs", () => {
  const result = analyzeLaunchpadOpportunity({
    fdvPi: 100000,
    liquidity: { tvlPi: 10000, volume24hPi: 2000, lockedPercent: 80 }
  });
  assert.equal(result.liquidity.turnover24h, 0.2);
  assert.equal(result.liquidity.fdvToLiquidity, 10);
  assert.equal(result.liquidity.score, 55);
});

test("critical risk flags cap the score and change classification", () => {
  const result = analyzeLaunchpadOpportunity({
    riskFlags: ["Possible honeypot: trading simulation failed"],
    evidence: { utility: 100, teamTransparency: 100, tokenomics: 100, marketActivity: 100, contractSecurity: 100, sourceVerification: 100 },
    liquidity: { tvlPi: 200000 }
  });
  assert.equal(result.score, 25);
  assert.equal(result.classification, "critical_risk");
});

test("concentration and unlocked liquidity produce explicit risk flags", () => {
  const result = analyzeLaunchpadOpportunity({
    holders: { top10Percent: 72 },
    liquidity: { tvlPi: 5000, lockedPercent: 20 }
  });
  assert.ok(result.risks.some((r) => r.includes("Top 10")));
  assert.ok(result.risks.some((r) => r.includes("locked")));
});

test("rejects non-object input and ignores invalid component scores", () => {
  assert.throws(() => analyzeLaunchpadOpportunity(null), TypeError);
  const result = analyzeLaunchpadOpportunity({ evidence: { utility: 101, tokenomics: -2 } });
  assert.equal(result.componentScores.utility, null);
  assert.equal(result.componentScores.tokenomics, null);
  assert.equal(result.score, null);
});
