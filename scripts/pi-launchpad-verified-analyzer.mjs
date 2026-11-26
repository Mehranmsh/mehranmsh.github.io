/**
 * Safe integration boundary between validated envelopes, signed evidence,
 * and the deterministic analyzer. Unsigned snapshot scores/metrics are ignored.
 * This verified scoring entry point is Mainnet-only.
 */
import { analyzeLaunchpadOpportunity } from "./pi-launchpad-analyzer.mjs";
import { buildPiLaunchpadVerifiedScoringEvidence } from "./pi-launchpad-evidence-gateway.mjs";
import { buildPiLaunchpadVerifiedMetrics } from "./pi-launchpad-metrics-gateway.mjs";

export function analyzeVerifiedLaunchpadOpportunity({
  snapshot, envelope, attestations, metricAttestations = [], trustRecords, now
} = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("A token snapshot object is required.");
  }
  if (snapshot.networkId !== "pi-mainnet") {
    throw new TypeError("Verified Launchpad scoring requires an explicit pi-mainnet snapshot; Testnet and unknown networks are blocked.");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      envelope.networkId !== "pi-mainnet") {
    throw new TypeError("Verified Launchpad scoring requires a pi-mainnet evidence envelope; Testnet and unknown networks are blocked.");
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
  if (verified.networkId !== "pi-mainnet" || verifiedMetrics.networkId !== "pi-mainnet") {
    throw new TypeError("Verified scoring gateways returned a non-Mainnet network identity.");
  }

  // Deliberately construct a narrow analyzer input. Never forward unsigned
  // evidence, liquidity, holder, contract, or risk fields from the snapshot.
  const analysis = analyzeLaunchpadOpportunity({
    tokenId: snapshot.tokenId,
    symbol: typeof snapshot.symbol === "string" ? snapshot.symbol : undefined,
    evidence: verified.scoringEvidence,
    ...verifiedMetrics.verifiedMetrics
  });
  return Object.freeze({
    ...analysis,
    networkId: "pi-mainnet",
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
      "Verified scoring is Mainnet-only. Testnet, missing network identity, and cross-network evidence are rejected before analysis.",
      "Only independently attested component scores and allowlisted Pi market metrics are included. Contract flags and source verification remain unknown until separate verification paths exist."
    ])
  });
}
