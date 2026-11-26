/**
 * Pure D1 statement planner for the append-only Pi Launchpad evidence table.
 *
 * It builds parameterized statements only. It does not obtain credentials,
 * open a D1 binding, execute SQL, or persist data.
 */
const HEX_ID = /^plev_[a-f0-9]{32}$/;
const NETWORKS = new Set(["pi-mainnet", "pi-testnet"]);
const TYPES = new Set([
  "official_project_claim",
  "chain_indexer_observation",
  "dex_indexer_observation",
  "security_audit_claim",
  "community_claim"
]);
const VERIFICATION = new Set(["unverified", "signature_verified", "attestation_rejected"]);
const CHAIN_STATUS = "not_verified";
const SCORING_STATUS = "blocked_pending_independent_chain_verification";
const VERSION = /^\\d+\\.\\d+\\.\\d+$/;

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non_finite_number");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw new TypeError("invalid_json");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new TypeError("sparse_array");
    }
    result = "[" + value.map(item => canonicalJson(item, seen)).join(",") + "]";
  } else {
    if (!isPlainRecord(value)) throw new TypeError("non_plain_record");
    result = "{" + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ":" + canonicalJson(value[key], seen)).join(",") + "}";
  }
  seen.delete(value);
  return result;
}

function validUtcTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function statement(sql, params) {
  return Object.freeze({ sql, params: Object.freeze(params.slice()) });
}

/**
 * Returns an INSERT-then-SELECT D1 batch plan.
 *
 * INSERT uses ON CONFLICT DO NOTHING: retries cannot overwrite an original
 * record. The SELECT must be compared field-for-field with expectedRow after
 * the batch. An existing record with different content is a conflict, not a
 * successful duplicate. The caller must execute both statements in one
 * D1Database.batch() and fail closed if read-back is absent or mismatched.
 */
export function buildPiLaunchpadEvidenceD1InsertPlan({ record, createdAt } = {}) {
  if (!isPlainRecord(record) ||
      !HEX_ID.test(record.recordId) ||
      !NETWORKS.has(record.networkId) ||
      typeof record.assetIdentifier !== "string" ||
      record.assetIdentifier.length < 1 || record.assetIdentifier.length > 256 ||
      typeof record.evidenceId !== "string" ||
      record.evidenceId.length < 1 || record.evidenceId.length > 160 ||
      !TYPES.has(record.evidenceType) ||
      typeof record.field !== "string" || record.field.length < 1 || record.field.length > 64 ||
      !isPlainRecord(record.source) ||
      typeof record.source.sourceId !== "string" || record.source.sourceId.length < 1 ||
      typeof record.source.kind !== "string" ||
      typeof record.source.url !== "string" ||
      !validUtcTimestamp(record.observedAt) ||
      !validUtcTimestamp(record.source.retrievedAt) ||
      !VERIFICATION.has(record.verificationStatus) ||
      record.chainVerificationStatus !== CHAIN_STATUS ||
      record.scoringStatus !== SCORING_STATUS ||
      typeof record.registryVersion !== "string" || !VERSION.test(record.registryVersion) ||
      !validUtcTimestamp(createdAt)) {
    return Object.freeze({ accepted: false, code: "invalid_evidence_d1_record" });
  }

  let valueJson, provenanceJson;
  try {
    valueJson = canonicalJson(record.value);
    provenanceJson = canonicalJson({
      source: record.source,
      observedAt: record.observedAt,
      verificationDetail: record.verificationDetail ?? null,
      attestation: record.attestation ?? null
    });
  } catch {
    return Object.freeze({ accepted: false, code: "invalid_evidence_d1_json" });
  }

  let parsedProvenance;
  try { parsedProvenance = JSON.parse(provenanceJson); }
  catch { return Object.freeze({ accepted: false, code: "invalid_evidence_d1_provenance" }); }
  if (!isPlainRecord(parsedProvenance.source) ||
      typeof parsedProvenance.source.sourceId !== "string" ||
      typeof parsedProvenance.source.kind !== "string" ||
      typeof parsedProvenance.source.url !== "string" ||
      !validUtcTimestamp(parsedProvenance.observedAt)) {
    return Object.freeze({ accepted: false, code: "invalid_evidence_d1_provenance" });
  }

  const expectedRow = Object.freeze({
    record_id: record.recordId,
    network_id: record.networkId,
    asset_identifier: record.assetIdentifier,
    evidence_id: record.evidenceId,
    evidence_type: record.evidenceType,
    field_name: record.field,
    value_json: valueJson,
    provenance_json: provenanceJson,
    verification_status: record.verificationStatus,
    chain_verification_status: CHAIN_STATUS,
    scoring_status: SCORING_STATUS,
    registry_version: record.registryVersion
  });

  const insert = statement(
    `INSERT INTO pi_launchpad_evidence_records (
      record_id, network_id, asset_identifier, evidence_id, evidence_type,
      field_name, value_json, provenance_json, verification_status,
      chain_verification_status, scoring_status, registry_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO NOTHING`,
    [
      expectedRow.record_id, expectedRow.network_id, expectedRow.asset_identifier,
      expectedRow.evidence_id, expectedRow.evidence_type, expectedRow.field_name,
      expectedRow.value_json, expectedRow.provenance_json, expectedRow.verification_status,
      expectedRow.chain_verification_status, expectedRow.scoring_status,
      expectedRow.registry_version, createdAt
    ]
  );
  const readBack = statement(
    `SELECT record_id, network_id, asset_identifier, evidence_id, evidence_type,
      field_name, value_json, provenance_json, verification_status,
      chain_verification_status, scoring_status, registry_version
    FROM pi_launchpad_evidence_records
    WHERE record_id = ?`,
    [expectedRow.record_id]
  );

  return Object.freeze({
    accepted: true,
    statements: Object.freeze([insert, readBack]),
    expectedRow,
    verification: "Compare every selected column with expectedRow; missing or mismatched rows must fail closed.",
    execution: "Plan only. Execute both statements together with D1Database.batch(); never execute this plan automatically.",
    notice: "No database binding, credentials, SQL execution, persistence, network access, or live D1 write is performed."
  });
}

/** Compares a D1 read-back row against the exact immutable projection. */
export function verifyPiLaunchpadEvidenceD1ReadBack(expectedRow, actualRow) {
  if (!isPlainRecord(expectedRow) || !isPlainRecord(actualRow)) {
    return Object.freeze({ accepted: false, code: "invalid_d1_readback" });
  }
  const keys = Object.keys(expectedRow);
  if (keys.length !== 12 || keys.some(key =>
    !Object.hasOwn(actualRow, key) || actualRow[key] !== expectedRow[key])) {
    return Object.freeze({ accepted: false, code: "d1_record_conflict" });
  }
  return Object.freeze({ accepted: true, duplicateOrInserted: true });
}
