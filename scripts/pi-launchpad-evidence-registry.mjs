/**
 * Immutable, provenance-aware Pi Launchpad evidence registry projection.
 *
 * This is a pure in-memory projection over a validated envelope. It does not
 * fetch, persist, authenticate sources, or prove ledger truth.
 */
import { createHash } from "node:crypto";
import { validateLaunchpadDataEnvelope } from "./pi-launchpad-data-adapter.mjs";
import { buildPiLaunchpadVerifiedScoringEvidence } from "./pi-launchpad-evidence-gateway.mjs";

export const PI_LAUNCHPAD_EVIDENCE_REGISTRY_VERSION = "0.1.0";

const EVIDENCE_TYPES = Object.freeze({
  official_project: "official_project_claim",
  chain_indexer: "chain_indexer_observation",
  dex_indexer: "dex_indexer_observation",
  security_auditor: "security_audit_claim",
  community: "community_claim"
});

const freeze = (value) => Object.freeze(value);
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])
  ).join(",") + "}";
};

/**
 * Converts a validated evidence envelope into stable, auditable records.
 * Attestations are optional. A valid Ed25519 signature authenticates a signer
 * and payload only; chainVerificationStatus therefore always remains unknown.
 */
export function buildPiLaunchpadEvidenceRegistry({
  envelope, attestations = [], trustRecords = [], now
} = {}) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) throw new TypeError("A finite registry timestamp is required.");

  const validation = validateLaunchpadDataEnvelope(envelope, { now: timestamp });
  if (!validation.accepted) {
    return freeze({
      accepted: false,
      code: validation.code,
      registryVersion: PI_LAUNCHPAD_EVIDENCE_REGISTRY_VERSION,
      records: freeze([]),
      summary: freeze({ total: 0, unverified: 0, signatureVerified: 0, attestationRejected: 0 }),
      notice: "Invalid evidence envelope. No registry records were created."
    });
  }

  const verified = buildPiLaunchpadVerifiedScoringEvidence({
    envelope, attestations, trustRecords, now: timestamp
  });
  const verifiedById = new Map(verified.acceptedRecords.map((record) => [record.evidenceId, record]));
  const rejectedById = new Map();
  for (const item of verified.rejectedRecords) {
    if (item.evidenceId && !rejectedById.has(item.evidenceId)) rejectedById.set(item.evidenceId, item.code);
  }
  const sources = new Map(validation.sources.map((source) => [source.sourceId, source]));

  const records = validation.evidence.map((item) => {
    const source = sources.get(item.sourceId);
    const signed = verifiedById.get(item.reference);
    const rejection = rejectedById.get(item.reference) ?? null;
    const verificationStatus = signed ? "signature_verified" : rejection ? "attestation_rejected" : "unverified";
    const identity = {
      networkId: validation.networkId,
      assetIdentifier: validation.tokenId,
      sourceId: item.sourceId,
      field: item.field,
      reference: item.reference,
      observedAt: item.observedAt
    };
    const recordId = "plev_" + digest(canonical(identity)).slice(0, 32);
    return freeze({
      recordId,
      evidenceId: item.reference,
      networkId: validation.networkId,
      assetIdentifier: validation.tokenId,
      evidenceType: EVIDENCE_TYPES[source.kind],
      field: item.field,
      value: item.value,
      source: freeze({
        sourceId: source.sourceId,
        kind: source.kind,
        url: source.url,
        claimedTrustLevel: source.trustLevel,
        retrievedAt: source.retrievedAt
      }),
      observedAt: item.observedAt,
      verificationStatus,
      verificationDetail: signed
        ? "Ed25519 signer and payload verified against an operator trust anchor; factual accuracy and chain truth remain unverified."
        : rejection
          ? "An associated attestation was rejected: " + rejection
          : "No accepted independent attestation is attached.",
      chainVerificationStatus: "not_verified",
      scoringStatus: "blocked_pending_independent_chain_verification",
      attestation: signed ? freeze({
        issuer: signed.issuer,
        keyId: signed.keyId,
        verifiedAt: new Date(timestamp).toISOString()
      }) : null
    });
  });

  const signatureVerified = records.filter((record) => record.verificationStatus === "signature_verified").length;
  const attestationRejected = records.filter((record) => record.verificationStatus === "attestation_rejected").length;
  const unverified = records.length - signatureVerified - attestationRejected;
  return freeze({
    accepted: true,
    registryVersion: PI_LAUNCHPAD_EVIDENCE_REGISTRY_VERSION,
    networkId: validation.networkId,
    assetIdentifier: validation.tokenId,
    records: freeze(records),
    summary: freeze({ total: records.length, unverified, signatureVerified, attestationRejected }),
    gateway: freeze({
      acceptedAttestations: verified.acceptedCount,
      rejectedAttestations: verified.rejectedCount,
      trustStoreAcceptedKeyCount: verified.trustStoreAcceptedKeyCount
    }),
    notice: "Registry projection only; records are not persisted. Signatures do not prove factual accuracy or on-chain truth. Chain verification and scoring remain blocked."
  });
}
