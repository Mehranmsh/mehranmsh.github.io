import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLaunchpadOpportunity } from "./pi-launchpad-analyzer.mjs";
import { buildPiLaunchpadAnalysisReport } from "./pi-launchpad-analysis-report.mjs";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

test("builds weighted component explanations and preserves missing values", () => {
  const analysis = analyzeLaunchpadOpportunity({
    tokenId: "pi-token-report",
    evidence: { utility: 90, tokenomics: 70 },
    liquidity: { tvlPi: 10000, volume24hPi: 1000 }
  });
  const report = buildPiLaunchpadAnalysisReport(analysis, { now: NOW });
  assert.equal(report.verdict.score, analysis.score);
  assert.equal(report.scoreBreakdown.components.find((item) => item.key === "utility").weightPercent, 20);
  assert.equal(report.scoreBreakdown.components.find((item) => item.key === "teamTransparency").score, null);
  assert.ok(report.scoreBreakdown.missingComponents.includes("contractSecurity"));
  assert.equal(report.liquidityAssessment.turnover24h, 0.1);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.scoreBreakdown.components));
});

test("reports provenance freshness and rejected evidence without claiming factual truth", () => {
  const analysis = analyzeLaunchpadOpportunity({
    tokenId: "pi-token-provenance",
    evidence: { utility: 80 }
  });
  const report = buildPiLaunchpadAnalysisReport(analysis, {
    now: NOW,
    verifiedEvidence: {
      acceptedRecords: [{
        evidenceId: "ev-fresh", field: "utility", sourceUrl: "https://auditor.example/report",
        issuer: "auditor", observedAt: "2026-11-26T12:00:00.000Z",
        cryptographicallyVerified: true
      }, {
        evidenceId: "ev-old", field: "tokenomics", observedAt: "2026-11-01T12:00:00.000Z",
        cryptographicallyVerified: true
      }],
      rejectedRecords: [{ evidenceId: "ev-bad", code: "attestation_expired" }]
    },
    verifiedMetrics: { acceptedRecords: [], rejectedRecords: [] }
  });
  assert.equal(report.provenance.acceptedEvidenceRecordCount, 2);
  assert.equal(report.provenance.rejectedEvidenceRecordCount, 1);
  assert.equal(report.provenance.staleOrUndatedEvidenceCount, 1);
  assert.equal(report.provenance.acceptedEvidence[0].freshness, "fresh_by_policy");
  assert.equal(report.provenance.acceptedEvidence[1].freshness, "stale_by_policy");
  assert.match(report.provenance.cryptographicNotice, /does not independently prove/);
});

test("does not invent liquidity metrics or a score for insufficient evidence", () => {
  const analysis = analyzeLaunchpadOpportunity({ tokenId: "empty" });
  const report = buildPiLaunchpadAnalysisReport(analysis, { now: NOW });
  assert.equal(report.verdict.score, null);
  assert.equal(report.liquidityAssessment.tvlPi, null);
  assert.ok(report.liquidityAssessment.notes.some((note) => note.includes("TVL is unavailable")));
});

test("requires explicit report time and bounds freshness policy", () => {
  const analysis = analyzeLaunchpadOpportunity({ tokenId: "validation" });
  assert.throws(() => buildPiLaunchpadAnalysisReport(analysis), /timestamp/);
  assert.throws(() => buildPiLaunchpadAnalysisReport(analysis, { now: NOW, maxEvidenceAgeDays: 500 }), /between 0 and 365/);
});

test("marks future-dated evidence as invalid freshness rather than fresh", () => {
  const analysis = analyzeLaunchpadOpportunity({ tokenId: "future-evidence", evidence: { utility: 80 } });
  const report = buildPiLaunchpadAnalysisReport(analysis, {
    now: NOW,
    verifiedEvidence: { acceptedRecords: [{ evidenceId: "ev-future", observedAt: "2026-11-28T12:00:00.000Z" }] }
  });
  assert.equal(report.provenance.acceptedEvidence[0].freshness, "future_timestamp");
  assert.equal(report.provenance.staleOrUndatedEvidenceCount, 1);
});

test("explains when critical-risk policy caps an otherwise higher weighted score", () => {
  const analysis = analyzeLaunchpadOpportunity({
    tokenId: "critical-cap",
    evidence: { utility: 100, teamTransparency: 100, tokenomics: 100, marketActivity: 100, contractSecurity: 100 },
    riskFlags: ["Honeypot behavior reported"]
  });
  const report = buildPiLaunchpadAnalysisReport(analysis, { now: NOW });
  assert.equal(report.verdict.score, 25);
  assert.equal(report.verdict.uncappedWeightedScore, 100);
  assert.equal(report.verdict.scoreCapApplied, true);
  assert.match(report.verdict.scoreCapExplanation, /capped/);
});
