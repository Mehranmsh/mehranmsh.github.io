/**
 * Safe integration boundary between validated envelopes, signed evidence,
 * and the deterministic analyzer. Unsigned snapshot scores/metrics are ignored.
 */
import { analyzeLaunchpadOpportunity } from "./pi-launchpad-analyzer.mjs";
import { buildPiLaunchpadAnalysisReport } from "./pi-launchpad-analysis-report.mjs";
import { buildPiLaunchpadVerifiedScoringEvidence } from "./pi-launchpad-evidence-gateway.mjs";
import { buildPiLaunchpadVerifiedMetrics } from "./pi-launchpad-metrics-gateway.mjs";

export function analyzeVerifiedLaunchpadOpportunity({
  snapshot, envelope, attestations, metricAttestations = [], trustRecords, now
} = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("A token snapshot object is required.");
  }
  if (typeof snapshot.tokenId !== "string" || !snapshot.tokenId.trim()) {
    throw new TypeError("A tokenId is required.");
  }
  const verified = buildPiLaunchpadVerifiedScoringEvidence({
    envelope, attestations, trustRecords, now
  });
  const verifiedMetrics = buildPiLaunchpadVerifiedMetrics({
    envelope, attestations: metricAttestations, trustRecords, now
  });
  if (verified.tokenId !== snapshot.tokenId || verifiedMetrics.tokenId !== snapshot.tokenId) {
    throw new TypeError("Snapshot tokenId does not match the validated evidence envelope.");
  }

  // Deliberately construct a narrow analyzer input. Never forward unsigned
  // evidence, liquidity, holder, contract, or risk fields from the snapshot.
  const analysis = analyzeLaunchpadOpportunity({
    tokenId: snapshot.tokenId,
    symbol: typeof snapshot.symbol === "string" ? snapshot.symbol : undefined,
    evidence: verified.scoringEvidence,
    ...verifiedMetrics.verifiedMetrics
  });
  const analysisReport = buildPiLaunchpadAnalysisReport(analysis, {
    verifiedEvidence: verified,
    verifiedMetrics,
    now
  });

  return Object.freeze({
    ...analysis,
    analysisReport,
    verifiedEvidence: Object.freeze({
      gatewayVersion: verified.gatewayVersion,
      acceptedCount: verified.acceptedCount,
      rejectedCount: verified.rejectedCount,
      acceptedRecords: verified.acceptedRecords,
      rejectedRecords: verified.rejectedRecords,
      trustStoreAcceptedKeyCount: verified.trustStoreAcceptedKeyCount,
      notice: verified.notice
    }),
    verifiedMetrics: Object.freeze({
      gatewayVersion: verifiedMetrics.gatewayVersion,
      acceptedCount: verifiedMetrics.acceptedCount,
      rejectedCount: verifiedMetrics.rejectedCount,
      acceptedRecords: verifiedMetrics.acceptedRecords,
      rejectedRecords: verifiedMetrics.rejectedRecords,
      trustStoreAcceptedKeyCount: verifiedMetrics.trustStoreAcceptedKeyCount,
      notice: verifiedMetrics.notice
    }),
    limitations: Object.freeze([
      ...analysis.limitations,
      "Only independently attested component scores and allowlisted Pi market metrics are included. Contract flags and source verification remain unknown until separate verification paths exist."
    ])
  });
}
