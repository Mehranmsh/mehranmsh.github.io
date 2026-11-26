import { createHash } from "node:crypto";
import { verifyPiTestnetObservationArchive } from "./pi-testnet-observation-archive.mjs";

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const HEX_256 = /^[a-f0-9]{64}$/;

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validOptions(options) {
  return isPlainRecord(options) &&
    typeof options.archiveScope === "string" &&
    /^[a-zA-Z0-9._:-]{1,100}$/.test(options.archiveScope) &&
    Number.isSafeInteger(options.maxEntries) && options.maxEntries >= 1 && options.maxEntries <= 1000 &&
    Number.isSafeInteger(options.maxArchiveBytes) && options.maxArchiveBytes >= 1024 &&
    options.maxArchiveBytes <= MAX_ARCHIVE_BYTES;
}

/**
 * Creates a volatile, process-local repository for isolated tests and adapter
 * contract development. It is NOT durable storage and does not authenticate
 * principals. Callers must obtain intents from the server-side authorization
 * policy before invoking it. No filesystem, database, network, or AI is used.
 */
export function createPiTestnetObservationMemoryRepository(options) {
  if (!validOptions(options)) {
    return Object.freeze({ accepted: false, code: "invalid_repository_options" });
  }

  const entries = new Map();
  let totalBytes = 0;
  const archiveScope = options.archiveScope;
  const maxEntries = options.maxEntries;
  const maxArchiveBytes = options.maxArchiveBytes;

  function validateIntent(intent, operation) {
    if (!isPlainRecord(intent) || intent.operation !== operation ||
        intent.archiveScope !== archiveScope ||
        typeof intent.principalId !== "string" || intent.principalId.length < 1 ||
        intent.principalId.length > 128 || typeof intent.archiveId !== "string" ||
        !HEX_256.test(intent.archiveId)) {
      return { accepted: false, code: "invalid_or_out_of_scope_intent" };
    }
    return { accepted: true };
  }

  function append(intent) {
    const authorizedShape = validateIntent(intent, "append_only");
    if (!authorizedShape.accepted) return Object.freeze(authorizedShape);
    if (typeof intent.payload !== "string" || intent.payload.length === 0) {
      return Object.freeze({ accepted: false, code: "invalid_archive_payload" });
    }

    const bytes = new TextEncoder().encode(intent.payload).byteLength;
    if (bytes > maxArchiveBytes || bytes !== intent.archiveBytes) {
      return Object.freeze({ accepted: false, code: "archive_size_mismatch" });
    }
    if (sha256(intent.payload) !== intent.archiveId) {
      return Object.freeze({ accepted: false, code: "archive_id_mismatch" });
    }

    let archive;
    try {
      archive = JSON.parse(intent.payload);
    } catch {
      return Object.freeze({ accepted: false, code: "invalid_archive_json" });
    }
    const verified = verifyPiTestnetObservationArchive(archive);
    if (!verified.accepted) return Object.freeze(verified);

    const existing = entries.get(intent.archiveId);
    if (existing) {
      if (existing.payload !== intent.payload) {
        return Object.freeze({ accepted: false, code: "archive_id_conflict" });
      }
      return Object.freeze({
        accepted: true,
        duplicate: true,
        archiveId: intent.archiveId,
        recordCount: verified.recordCount,
        totalEntries: entries.size
      });
    }

    if (entries.size >= maxEntries || totalBytes + bytes > MAX_ARCHIVE_BYTES) {
      return Object.freeze({ accepted: false, code: "repository_capacity_exceeded" });
    }

    entries.set(intent.archiveId, Object.freeze({
      payload: intent.payload,
      bytes,
      principalId: intent.principalId
    }));
    totalBytes += bytes;
    return Object.freeze({
      accepted: true,
      duplicate: false,
      archiveId: intent.archiveId,
      recordCount: verified.recordCount,
      totalEntries: entries.size
    });
  }

  function read(intent) {
    const authorizedShape = validateIntent(intent, "read_only");
    if (!authorizedShape.accepted) return Object.freeze(authorizedShape);
    const stored = entries.get(intent.archiveId);
    if (!stored) return Object.freeze({ accepted: false, code: "archive_not_found" });

    if (sha256(stored.payload) !== intent.archiveId) {
      return Object.freeze({ accepted: false, code: "stored_archive_digest_mismatch" });
    }
    let archive;
    try {
      archive = JSON.parse(stored.payload);
    } catch {
      return Object.freeze({ accepted: false, code: "stored_archive_invalid_json" });
    }
    const verified = verifyPiTestnetObservationArchive(archive);
    if (!verified.accepted) return Object.freeze(verified);

    return Object.freeze({
      accepted: true,
      archive: deepFreeze(JSON.parse(stored.payload)),
      integrity: verified
    });
  }

  function verify(intent) {
    const result = read(intent);
    if (!result.accepted) return result;
    return Object.freeze({
      accepted: true,
      archiveId: intent.archiveId,
      recordCount: result.integrity.recordCount,
      trustNotice: result.integrity.trustNotice
    });
  }

  return Object.freeze({
    accepted: true,
    append,
    read,
    verify,
    get size() { return entries.size; },
    get bytesUsed() { return totalBytes; },
    notice: "Volatile in-memory prototype only. No durability, authentication, encryption-at-rest, retention enforcement, or cross-process sharing."
  });
}
