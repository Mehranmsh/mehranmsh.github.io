/**
 * Separate fail-closed gateway for Pi-denominated market and AMM metrics.
 * It deliberately does not reuse the component-score allowlist.
 */
import { validateLaunchpadDataEnvelope } from "./pi-launchpad-data-adapter.mjs";
import { verifyPiLaunchpadAttestation } from "./pi-launchpad-attestation-verifier.mjs";
import { buildPiLaunchpadTrustStore } from "./pi-launchpad-trust-store.mjs";

export const PI_LAUNCHPAD_METRICS_GATEWAY_VERSION = "0.1.0";
const FIELDS = Object.freeze({
  "liquidity.tvlPi": { path: ["liquidity", "tvlPi"], min: 0 },
  "liquidity.volume24hPi": { path: ["liquidity", "volume24hPi"], min: 0 },
  "liquidity.lockedPercent": { path: ["liquidity", "lockedPercent"], min: 0, max: 100 },
  "market.fdvPi": { path: ["fdvPi"], min: 0 },
  "holders.top10Percent": { path: ["holders", "top10Percent"], min: 0, max: 100 }
});
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const reject = (evidenceId, code) => Object.freeze({ evidenceId: evidenceId ?? null, accepted: false, code });
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export function buildPiLaunchpadVerifiedMetrics({ envelope, attestations, trustRecords, now } = {}) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) throw new TypeError("A finite metrics-gateway timestamp is required.");
  if (!Array.isArray(attestations) || attestations.length > 80) {
    throw new TypeError("Attestations must be an array of at most 80 entries.");
  }
  const validation = validateLaunchpadDataEnvelope(envelope, { now: timestamp });
  if (!validation.accepted) {
    const error = new TypeError("Launchpad envelope failed validation: " + validation.code);
    error.code = validation.code;
    throw error;
  }
  const trustStore = buildPiLaunchpadTrustStore(trustRecords, { now: timestamp });
  const sources = new Map(validation.sources.map(source => [source.sourceId, source]));
  const evidence = new Map();
  for (const item of validation.evidence) {
    if (!evidence.has(item.reference)) evidence.set(item.reference, []);
    evidence.get(item.reference).push(item);
  }
  const rejectedRecords = [];
  const acceptedByField = new Map();
  const seen = new Set();
  for (const attestation of attestations) {
    const id = isRecord(attestation) && isRecord(attestation.payload) ? attestation.payload.evidenceId : null;
    const verified = verifyPiLaunchpadAttestation(attestation, trustStore.keys, { now: timestamp });
    if (!verified.accepted) { rejectedRecords.push(reject(id, verified.code)); continue; }
    if (seen.has(verified.evidenceId)) { rejectedRecords.push(reject(verified.evidenceId, "duplicate_attestation")); continue; }
    seen.add(verified.evidenceId);
    const matches = evidence.get(verified.evidenceId) ?? [];
    if (matches.length !== 1) {
      rejectedRecords.push(reject(verified.evidenceId, matches.length ? "ambiguous_evidence_reference" : "evidence_not_found"));
      continue;
    }
    const item = matches[0], source = sources.get(item.sourceId), rule = FIELDS[verified.field];
    if (verified.tokenId !== validation.tokenId || verified.field !== item.field ||
        verified.sourceUrl !== source.url || verified.observedAt !== item.observedAt ||
        !Object.is(verified.value, item.value)) {
      rejectedRecords.push(reject(verified.evidenceId, "attestation_evidence_mismatch")); continue;
    }
    if (!rule) { rejectedRecords.push(reject(verified.evidenceId, "field_not_metric")); continue; }
    if (typeof verified.value !== "number" || !Number.isFinite(verified.value) ||
        verified.value < rule.min || (rule.max !== undefined && verified.value > rule.max)) {
      rejectedRecords.push(reject(verified.evidenceId, "metric_out_of_range")); continue;
    }
    if (!acceptedByField.has(verified.field)) acceptedByField.set(verified.field, []);
    acceptedByField.get(verified.field).push(Object.freeze({
      evidenceId: verified.evidenceId, field: verified.field, value: verified.value,
      issuer: verified.issuer, keyId: verified.keyId, observedAt: verified.observedAt,
      sourceUrl: verified.sourceUrl, cryptographicallyVerified: true
    }));
  }
  const verifiedMetrics = Object.create(null), acceptedRecords = [];
  for (const [field, records] of acceptedByField) {
    if (records.length !== 1) {
      for (const record of records) rejectedRecords.push(reject(record.evidenceId, "conflicting_metric_attestations"));
      continue;
    }
    let target = verifiedMetrics;
    const path = FIELDS[field].path;
    for (const segment of path.slice(0, -1)) target = target[segment] ??= Object.create(null);
    target[path.at(-1)] = records[0].value;
    acceptedRecords.push(records[0]);
  }
  return Object.freeze({
    gatewayVersion: PI_LAUNCHPAD_METRICS_GATEWAY_VERSION,
    tokenId: validation.tokenId,
    verifiedMetrics: deepFreeze(verifiedMetrics),
    acceptedRecords: Object.freeze(acceptedRecords),
    rejectedRecords: Object.freeze(rejectedRecords),
    acceptedCount: acceptedRecords.length,
    rejectedCount: rejectedRecords.length,
    trustStoreAcceptedKeyCount: trustStore.acceptedKeyCount,
    notice: "Only exact-match, fresh Ed25519 attestations from operator-trusted signers are emitted. Signatures establish signer and payload integrity, not factual accuracy or on-chain truth. Values are not independently fetched."
  });
}
