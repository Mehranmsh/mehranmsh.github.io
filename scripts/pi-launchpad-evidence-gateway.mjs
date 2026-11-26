/**
 * Verified-evidence gateway for Pi Launchpad scoring.
 * Re-verifies raw attestations against operator trust records and only emits
 * allowlisted, exact-match component scores. No network, persistence, or AI.
 */
import { verifyPiLaunchpadAttestation } from "./pi-launchpad-attestation-verifier.mjs";
import { buildPiLaunchpadTrustStore } from "./pi-launchpad-trust-store.mjs";

export const PI_LAUNCHPAD_EVIDENCE_GATEWAY_VERSION = "0.1.0";
const SCORE_FIELDS = new Set([
  "utility", "teamTransparency", "tokenomics", "marketActivity", "contractSecurity"
]);
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const rejected = (evidenceId, code) => Object.freeze({ evidenceId: evidenceId ?? null, accepted: false, code });

/**
 * validation must be the normalized output of validateLaunchpadDataEnvelope.
 * trustRecords are operator-provisioned raw trust-store records, never candidate input.
 * Attestation payload evidenceId maps to the adapter's stable evidence.reference.
 */
export function buildPiLaunchpadVerifiedScoringEvidence({
  validation, attestations, trustRecords, now
} = {}) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) throw new TypeError("A finite gateway timestamp is required.");
  if (!isRecord(validation) || validation.accepted !== true ||
      typeof validation.tokenId !== "string" || !Array.isArray(validation.sources) ||
      !Array.isArray(validation.evidence)) {
    throw new TypeError("An accepted normalized Launchpad validation result is required.");
  }
  if (!Array.isArray(attestations) || attestations.length > 80) {
    throw new TypeError("Attestations must be an array of at most 80 entries.");
  }

  const trustStore = buildPiLaunchpadTrustStore(trustRecords, { now: timestamp });
  const sourceById = new Map();
  for (const source of validation.sources) {
    if (!isRecord(source) || typeof source.sourceId !== "string" ||
        typeof source.url !== "string" || sourceById.has(source.sourceId)) {
      throw new TypeError("Normalized source records are malformed or duplicated.");
    }
    sourceById.set(source.sourceId, source);
  }

  const evidenceById = new Map();
  for (const item of validation.evidence) {
    if (!isRecord(item) || typeof item.reference !== "string" ||
        typeof item.field !== "string" || typeof item.sourceId !== "string" ||
        !sourceById.has(item.sourceId)) {
      throw new TypeError("Normalized evidence records are malformed.");
    }
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
    if (verified.tokenId !== validation.tokenId || verified.field !== item.field ||
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
      evidenceId: identity,
      field: verified.field,
      value: verified.value,
      issuer: verified.issuer,
      keyId: verified.keyId,
      observedAt: verified.observedAt,
      sourceUrl: verified.sourceUrl,
      cryptographicallyVerified: true
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
    scoringEvidence: Object.freeze(scoringEvidence),
    acceptedRecords: Object.freeze(acceptedRecords),
    rejectedRecords: Object.freeze(rejectedRecords),
    acceptedCount: acceptedRecords.length,
    rejectedCount: rejectedRecords.length,
    trustStoreAcceptedKeyCount: trustStore.acceptedKeyCount,
    notice: "Only fresh Ed25519 attestations matching the validated token, evidence ID, field, source URL, timestamp, and value are emitted. Cryptographic verification does not establish factual or on-chain truth. sourceVerification is never accepted from this gateway."
  });
}
