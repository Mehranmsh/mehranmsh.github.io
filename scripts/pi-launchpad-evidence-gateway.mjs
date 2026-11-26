/**
 * Verified-evidence gateway for Pi Launchpad scoring.
 * Validates the raw envelope itself, re-verifies attestations against operator
 * trust records, and emits only exact-match allowlisted component scores.
 */
import { validateLaunchpadDataEnvelope } from "./pi-launchpad-data-adapter.mjs";
import { verifyPiLaunchpadAttestation } from "./pi-launchpad-attestation-verifier.mjs";
import { buildPiLaunchpadTrustStore } from "./pi-launchpad-trust-store.mjs";

export const PI_LAUNCHPAD_EVIDENCE_GATEWAY_VERSION = "0.3.0";
const SCORE_FIELDS = new Set(["utility", "teamTransparency", "tokenomics", "marketActivity", "contractSecurity"]);
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const rejected = (evidenceId, code) => Object.freeze({ evidenceId: evidenceId ?? null, accepted: false, code });

export function buildPiLaunchpadVerifiedScoringEvidence({
  envelope, attestations, trustRecords, now
} = {}) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) throw new TypeError("A finite gateway timestamp is required.");
  if (!Array.isArray(attestations) || attestations.length > 80) {
    throw new TypeError("Attestations must be an array of at most 80 entries.");
  }

  // Never trust a caller-supplied { accepted:true } validation object.
  const validation = validateLaunchpadDataEnvelope(envelope, { now: timestamp });
  if (!validation.accepted) {
    const error = new TypeError("Launchpad envelope failed validation: " + validation.code);
    error.code = validation.code;
    throw error;
  }

  const trustStore = buildPiLaunchpadTrustStore(trustRecords, { now: timestamp });
  const sourceById = new Map(validation.sources.map(source => [source.sourceId, source]));
  const evidenceById = new Map();
  for (const item of validation.evidence) {
    if (!evidenceById.has(item.reference)) evidenceById.set(item.reference, []);
    evidenceById.get(item.reference).push(item);
  }

  const rejectedRecords = [];
  const acceptedByField = new Map();
  const seenAttestationIds = new Set();
  for (const attestation of attestations) {
    const evidenceId = isRecord(attestation) && isRecord(attestation.payload)
      ? attestation.payload.evidenceId : null;
    const verified = verifyPiLaunchpadAttestation(attestation, trustStore.keys, { now: timestamp });
    if (!verified.accepted) {
      rejectedRecords.push(rejected(evidenceId, verified.code));
      continue;
    }
    const identity = verified.evidenceId;
    if (seenAttestationIds.has(identity)) {
      rejectedRecords.push(rejected(identity, "duplicate_attestation"));
      continue;
    }
    seenAttestationIds.add(identity);
    const matches = evidenceById.get(identity) ?? [];
    if (matches.length !== 1) {
      rejectedRecords.push(rejected(identity, matches.length ? "ambiguous_evidence_reference" : "evidence_not_found"));
      continue;
    }
    const item = matches[0];
    const source = sourceById.get(item.sourceId);
    if (verified.networkId !== validation.networkId || verified.tokenId !== validation.tokenId || verified.field !== item.field ||
        verified.sourceUrl !== source.url || verified.observedAt !== item.observedAt ||
        !Object.is(verified.value, item.value)) {
      rejectedRecords.push(rejected(identity, "attestation_evidence_mismatch"));
      continue;
    }
    if (!SCORE_FIELDS.has(verified.field)) {
      rejectedRecords.push(rejected(identity, "field_not_scoreable"));
      continue;
    }
    if (typeof verified.value !== "number" || !Number.isFinite(verified.value) ||
        verified.value < 0 || verified.value > 100) {
      rejectedRecords.push(rejected(identity, "score_out_of_range"));
      continue;
    }
    if (!acceptedByField.has(verified.field)) acceptedByField.set(verified.field, []);
    acceptedByField.get(verified.field).push(Object.freeze({
      evidenceId: identity, field: verified.field, value: verified.value,
      issuer: verified.issuer, keyId: verified.keyId, observedAt: verified.observedAt,
      sourceUrl: verified.sourceUrl, cryptographicallyVerified: true
    }));
  }

  const scoringEvidence = Object.create(null);
  const acceptedRecords = [];
  for (const [field, records] of acceptedByField) {
    if (records.length !== 1) {
      for (const record of records) rejectedRecords.push(rejected(record.evidenceId, "conflicting_component_attestations"));
      continue;
    }
    scoringEvidence[field] = records[0].value;
    acceptedRecords.push(records[0]);
  }

  return Object.freeze({
    gatewayVersion: PI_LAUNCHPAD_EVIDENCE_GATEWAY_VERSION,
    tokenId: validation.tokenId,
    networkId: validation.networkId,
    scoringEvidence: Object.freeze(scoringEvidence),
    acceptedRecords: Object.freeze(acceptedRecords),
    rejectedRecords: Object.freeze(rejectedRecords),
    acceptedCount: acceptedRecords.length,
    rejectedCount: rejectedRecords.length,
    trustStoreAcceptedKeyCount: trustStore.acceptedKeyCount,
    notice: "Only fresh Ed25519 attestations matching a freshly validated envelope and operator trust anchor are emitted. Cryptographic verification does not establish factual or on-chain truth. sourceVerification and liquidity metrics are never accepted by this gateway."
  });
}
