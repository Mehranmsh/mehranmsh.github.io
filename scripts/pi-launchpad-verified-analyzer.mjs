/**
 * Safe integration boundary between validated envelopes, signed evidence,
 * and the deterministic analyzer. Unsigned snapshot scores/metrics are ignored.
 */
import { analyzeLaunchpadOpportunity } from "./pi-launchpad-analyzer.mjs";
import { buildPiLaunchpadVerifiedScoringEvidence } from "./pi-launchpad-evidence-gateway.mjs";

export function analyzeVerifiedLaunchpadOpportunity({
  snapshot, envelope, attestations, trustRecords, now
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
  if (verified.tokenId !== snapshot.tokenId) {
    throw new TypeError("Snapshot tokenId does not match the validated evidence envelope.");
  }

  // Deliberately construct a narrow analyzer input. Never forward unsigned
  // evidence, liquidity, holder, contract, or risk fields from the snapshot.
  const analysis = analyzeLaunchpadOpportunity({
    tokenId: snapshot.tokenId,
    symbol: typeof snapshot.symbol === "string" ? snapshot.symbol : undefined,
    evidence: verified.scoringEvidence
  });
  return Object.freeze({
    ...analysis,
    verifiedEvidence: Object.freeze({
      gatewayVersion: verified.gatewayVersion,
      acceptedCount: verified.acceptedCount,
      rejectedCount: verified.rejectedCount,
      acceptedRecords: verified.acceptedRecords,
      rejectedRecords: verified.rejectedRecords,
      trustStoreAcceptedKeyCount: verified.trustStoreAcceptedKeyCount,
      notice: verified.notice
    }),
    limitations: Object.freeze([
      ...analysis.limitations,
      "Only attested component scores are included. Liquidity, holder distribution, contract flags, and source verification remain unknown until separately verified."
    ])
  });
}
