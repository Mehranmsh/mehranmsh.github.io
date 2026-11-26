/**
 * Pi Launchpad data-ingestion contract.
 * Validation only: this module never fetches URLs or declares a source truthful.
 * Every accepted field retains bounded provenance and freshness metadata.
 */
export const LAUNCHPAD_ADAPTER_VERSION = "0.1.0";
export const LAUNCHPAD_DATA_POLICY = Object.freeze({
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxFutureSkewMs: 5 * 60 * 1000,
  maxSources: 20,
  maxEvidenceItems: 80,
  maxTextLength: 500,
  maxIdLength: 160,
  allowedSourceKinds: Object.freeze(["official_project", "chain_indexer", "dex_indexer", "security_auditor", "community"]),
  allowedTrustLevels: Object.freeze(["unverified", "publisher_claim", "independently_verified"])
});

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isText = (v, max = LAUNCHPAD_DATA_POLICY.maxTextLength) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const boundedNumber = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function validHttpsUrl(value) {
  if (!isText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function reject(code, detail) {
  return Object.freeze({ accepted: false, code, detail });
}

/**
 * Envelope shape:
 * { schemaVersion, tokenId, observedAt, sources:[{sourceId,kind,url,trustLevel,
 *   retrievedAt, evidence:[{field,value,trustLevel,observedAt,reference}]}] }
 */
export function validateLaunchpadDataEnvelope(input, options = {}) {
  if (!isObject(input)) return reject("invalid_envelope", "A plain envelope object is required.");
  const now = options.now instanceof Date ? options.now.getTime() : options.now;
  if (!Number.isFinite(now)) throw new TypeError("A finite validation timestamp is required.");
  if (input.schemaVersion !== 1) return reject("unsupported_schema", "Only schemaVersion 1 is accepted.");
  if (!isText(input.tokenId, LAUNCHPAD_DATA_POLICY.maxIdLength)) return reject("invalid_token_id", "tokenId is missing or too long.");
  if (!isIsoDate(input.observedAt)) return reject("invalid_observed_at", "observedAt must be a UTC ISO timestamp.");
  const observed = Date.parse(input.observedAt);
  if (observed > now + LAUNCHPAD_DATA_POLICY.maxFutureSkewMs) return reject("future_observation", "Observation timestamp is too far in the future.");
  if (now - observed > LAUNCHPAD_DATA_POLICY.maxAgeMs) return reject("stale_observation", "Token snapshot is older than the 24-hour freshness window.");
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > LAUNCHPAD_DATA_POLICY.maxSources) {
    return reject("invalid_sources", "Between 1 and 20 source records are required.");
  }

  const sourceIds = new Set();
  let evidenceCount = 0;
  const normalizedSources = [];
  const normalizedEvidence = [];
  for (const source of input.sources) {
    if (!isObject(source) || !isText(source.sourceId, LAUNCHPAD_DATA_POLICY.maxIdLength) ||
        sourceIds.has(source.sourceId) || !LAUNCHPAD_DATA_POLICY.allowedSourceKinds.includes(source.kind) ||
        !LAUNCHPAD_DATA_POLICY.allowedTrustLevels.includes(source.trustLevel) ||
        !validHttpsUrl(source.url) || !isIsoDate(source.retrievedAt)) {
      return reject("invalid_source_record", "A source record has invalid identity, kind, trust, URL, or retrieval time.");
    }
    sourceIds.add(source.sourceId);
    const retrieved = Date.parse(source.retrievedAt);
    if (retrieved > now + LAUNCHPAD_DATA_POLICY.maxFutureSkewMs || retrieved < observed - LAUNCHPAD_DATA_POLICY.maxFutureSkewMs) {
      return reject("invalid_source_time", "Source retrieval time is inconsistent with the snapshot observation.");
    }
    if (!Array.isArray(source.evidence)) return reject("invalid_evidence", "Each source must contain an evidence array.");
    normalizedSources.push(Object.freeze({
      sourceId: source.sourceId,
      kind: source.kind,
      url: source.url,
      trustLevel: source.trustLevel,
      retrievedAt: source.retrievedAt
    }));
    for (const item of source.evidence) {
      evidenceCount++;
      if (evidenceCount > LAUNCHPAD_DATA_POLICY.maxEvidenceItems) return reject("evidence_limit", "Evidence item limit exceeded.");
      if (!isObject(item) || !isText(item.field, 64) || !isIsoDate(item.observedAt) ||
          !LAUNCHPAD_DATA_POLICY.allowedTrustLevels.includes(item.trustLevel) ||
          !isText(item.reference, 2048) || !boundedNumber(Date.parse(item.observedAt), 0) || !(item.value === null || ["string", "number", "boolean"].includes(typeof item.value)) || (typeof item.value === "string" && item.value.length > LAUNCHPAD_DATA_POLICY.maxTextLength) || (typeof item.value === "number" && !Number.isFinite(item.value))) {
        return reject("invalid_evidence_item", "An evidence item is missing required provenance.");
      }
      const itemTime = Date.parse(item.observedAt);
      if (itemTime > now + LAUNCHPAD_DATA_POLICY.maxFutureSkewMs || now - itemTime > LAUNCHPAD_DATA_POLICY.maxAgeMs) {
        return reject("stale_evidence", "An evidence item is outside the accepted freshness window.");
      }
      normalizedEvidence.push(Object.freeze({
        sourceId: source.sourceId,
        field: item.field,
        value: item.value,
        trustLevel: item.trustLevel,
        observedAt: item.observedAt,
        reference: item.reference
      }));
    }
  }

  return Object.freeze({
    accepted: true,
    adapterVersion: LAUNCHPAD_ADAPTER_VERSION,
    tokenId: input.tokenId,
    observedAt: input.observedAt,
    sources: Object.freeze(normalizedSources),
    evidence: Object.freeze(normalizedEvidence),
    evidenceCount,
    trustNotice: "Schema and provenance validated only. Source identity, factual accuracy, and on-chain state require independent verification."
  });
}

/** Convert accepted provenance into a safe, explicit evidence ledger. */
export function buildLaunchpadEvidenceLedger(validation) {
  if (!isObject(validation) || validation.accepted !== true || !Array.isArray(validation.evidence)) {
    throw new TypeError("An accepted validated data envelope is required.");
  }
  return Object.freeze(validation.evidence.map((item) => Object.freeze({
    ...item,
    usableForScoring: false,
    scoringNote: "Not eligible for scoring yet. Claimed trust labels are metadata only; a separate trusted attestation verifier is required."
  })));
}
