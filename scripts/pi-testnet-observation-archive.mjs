import { createHash } from "node:crypto";

const MAX_RECORDS = 500;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const HEX_256 = /^[a-f0-9]{64}$/;
const ENDPOINT = "https://rpc.testnet.minepi.com";

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isCanonicalUtc(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non_finite_number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("non_json_value");
  if (seen.has(value)) throw new TypeError("cyclic_value");
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError("sparse_array");
    }
    output = "[" + value.map(item => canonicalJson(item, seen)).join(",") + "]";
  } else {
    if (!isPlainRecord(value)) throw new TypeError("non_plain_record");
    const keys = Object.keys(value).sort();
    output = "{" + keys.map(key => JSON.stringify(key) + ":" + canonicalJson(value[key], seen)).join(",") + "}";
  }
  seen.delete(value);
  return output;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateObservation(observation) {
  if (!isPlainRecord(observation)) return "invalid_observation";
  if (observation.schemaVersion !== 1 || observation.network !== "testnet" ||
      observation.endpoint !== ENDPOINT || observation.method !== "getHealth" ||
      observation.eligibleForMainnetScoring !== false) return "unsupported_observation";
  if (!(typeof observation.requestId === "string" && observation.requestId.length > 0 && observation.requestId.length <= 80) &&
      !(Number.isSafeInteger(observation.requestId) && observation.requestId >= 0)) return "invalid_request_id";
  if (!isCanonicalUtc(observation.retrievedAt)) return "invalid_retrieval_timestamp";
  if (!Number.isSafeInteger(observation.responseBytes) || observation.responseBytes < 1 || observation.responseBytes > 64 * 1024) {
    return "invalid_response_size";
  }
  if (typeof observation.serializedResponseSha256 !== "string" || !HEX_256.test(observation.serializedResponseSha256)) {
    return "invalid_response_digest";
  }
  if (!Object.hasOwn(observation, "result")) return "missing_result";
  try {
    const serialized = canonicalJson(observation);
    JSON.parse(serialized);
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) return "record_too_large";
  } catch {
    return "invalid_json_record";
  }
  return null;
}

function observationIdentity(observation) {
  return sha256(canonicalJson({
    network: observation.network,
    endpoint: observation.endpoint,
    method: observation.method,
    requestId: observation.requestId,
    retrievedAt: observation.retrievedAt,
    serializedResponseSha256: observation.serializedResponseSha256
  }));
}

function makeArchiveRecord(observation) {
  const payload = cloneJson(observation);
  const observationId = observationIdentity(payload);
  const integritySha256 = sha256(canonicalJson({ observationId, observation: payload }));
  return { observationId, observation: payload, integritySha256 };
}

/**
 * Builds a bounded, deterministic archive manifest in memory.
 * It does not persist data or perform network/AI/wallet operations.
 */
export function createPiTestnetObservationArchive(observations, options = {}) {
  if (!Array.isArray(observations) || !isPlainRecord(options)) {
    return Object.freeze({ accepted: false, code: "invalid_archive_input" });
  }
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) {
    return Object.freeze({ accepted: false, code: "invalid_record_limit" });
  }
  if (observations.length > maxRecords) return Object.freeze({ accepted: false, code: "record_limit_exceeded" });

  const records = [];
  const seen = new Map();
  let duplicateCount = 0;
  let totalBytes = 0;
  for (const observation of observations) {
    const invalid = validateObservation(observation);
    if (invalid) return Object.freeze({ accepted: false, code: invalid });
    const record = makeArchiveRecord(observation);
    if (seen.has(record.observationId)) {
      if (seen.get(record.observationId) !== canonicalJson(record.observation)) {
        return Object.freeze({ accepted: false, code: "conflicting_duplicate_identity" });
      }
      duplicateCount++;
      continue;
    }
    seen.set(record.observationId, canonicalJson(record.observation));
    const bytes = new TextEncoder().encode(canonicalJson(record)).byteLength;
    totalBytes += bytes;
    if (totalBytes > MAX_ARCHIVE_BYTES) return Object.freeze({ accepted: false, code: "archive_too_large" });
    records.push(record);
  }

  const manifest = {
    schemaVersion: 1,
    archiveType: "pi-testnet-observation-archive",
    createdAt: options.createdAt ?? null,
    recordCount: records.length,
    duplicateCount,
    records
  };
  if (manifest.createdAt !== null && !isCanonicalUtc(manifest.createdAt)) {
    return Object.freeze({ accepted: false, code: "invalid_archive_timestamp" });
  }
  manifest.manifestSha256 = sha256(canonicalJson(manifest));
  return Object.freeze({ accepted: true, archive: deepFreeze(manifest) });
}

/** Recomputes record and manifest digests; does not authenticate the source. */
export function verifyPiTestnetObservationArchive(archive) {
  if (!isPlainRecord(archive) || archive.schemaVersion !== 1 ||
      archive.archiveType !== "pi-testnet-observation-archive" ||
      !Array.isArray(archive.records) || archive.records.length > MAX_RECORDS ||
      archive.recordCount !== archive.records.length ||
      !Number.isSafeInteger(archive.duplicateCount) || archive.duplicateCount < 0 ||
      (archive.createdAt !== null && !isCanonicalUtc(archive.createdAt)) ||
      typeof archive.manifestSha256 !== "string" || !HEX_256.test(archive.manifestSha256)) {
    return Object.freeze({ accepted: false, code: "invalid_archive_manifest" });
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const record of archive.records) {
    if (!isPlainRecord(record) || typeof record.observationId !== "string" || !HEX_256.test(record.observationId) ||
        typeof record.integritySha256 !== "string" || !HEX_256.test(record.integritySha256)) {
      return Object.freeze({ accepted: false, code: "invalid_archive_record" });
    }
    const invalid = validateObservation(record.observation);
    if (invalid) return Object.freeze({ accepted: false, code: invalid });
    const expectedId = observationIdentity(record.observation);
    if (record.observationId !== expectedId || seen.has(expectedId)) {
      return Object.freeze({ accepted: false, code: "observation_identity_mismatch" });
    }
    seen.add(expectedId);
    const expectedDigest = sha256(canonicalJson({
      observationId: record.observationId,
      observation: record.observation
    }));
    if (record.integritySha256 !== expectedDigest) {
      return Object.freeze({ accepted: false, code: "record_integrity_mismatch" });
    }
    totalBytes += new TextEncoder().encode(canonicalJson(record)).byteLength;
    if (totalBytes > MAX_ARCHIVE_BYTES) return Object.freeze({ accepted: false, code: "archive_too_large" });
  }
  const { manifestSha256, ...manifestBody } = archive;
  if (manifestSha256 !== sha256(canonicalJson(manifestBody))) {
    return Object.freeze({ accepted: false, code: "manifest_integrity_mismatch" });
  }
  return Object.freeze({
    accepted: true,
    recordCount: archive.recordCount,
    duplicateCount: archive.duplicateCount,
    trustNotice: "Archive integrity verified locally only. This does not authenticate the RPC provider, prove response truth, or establish canonical Pi ledger state."
  });
}

/** Retrieves a record only from a manifest that passes full integrity validation. */
export function retrievePiTestnetObservation(archive, observationId) {
  const verified = verifyPiTestnetObservationArchive(archive);
  if (!verified.accepted) return verified;
  if (typeof observationId !== "string" || !HEX_256.test(observationId)) {
    return Object.freeze({ accepted: false, code: "invalid_observation_id" });
  }
  const record = archive.records.find(item => item.observationId === observationId);
  if (!record) return Object.freeze({ accepted: false, code: "observation_not_found" });
  return Object.freeze({ accepted: true, record: deepFreeze(cloneJson(record)) });
}
