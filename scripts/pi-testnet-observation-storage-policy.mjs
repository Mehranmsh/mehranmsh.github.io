import { createHash } from "node:crypto";
import { verifyPiTestnetObservationArchive } from "./pi-testnet-observation-archive.mjs";

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const ALLOWED_ACTIONS = Object.freeze(["append", "read", "list", "verify"]);
const ROLE_BY_ACTION = Object.freeze({
  append: "archive_writer",
  read: "archive_reader",
  list: "archive_reader",
  verify: "archive_reader"
});

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
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new TypeError("sparse_array");
    result = "[" + value.map(item => canonicalJson(item, seen)).join(",") + "]";
  } else {
    if (!isPlainRecord(value)) throw new TypeError("non_plain_record");
    result = "{" + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ":" + canonicalJson(value[key], seen)).join(",") + "}";
  }
  seen.delete(value);
  return result;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validatePiTestnetArchiveStoragePolicy(policy) {
  if (!isPlainRecord(policy) || policy.schemaVersion !== 1 ||
      typeof policy.archiveScope !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(policy.archiveScope) ||
      !Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 3650 ||
      !Number.isSafeInteger(policy.maxArchiveBytes) || policy.maxArchiveBytes < 1024 ||
      policy.maxArchiveBytes > MAX_ARCHIVE_BYTES ||
      policy.allowAppend !== true || policy.allowRead !== true) {
    return Object.freeze({ accepted: false, code: "invalid_storage_policy" });
  }
  return Object.freeze({
    accepted: true,
    policy: Object.freeze({
      schemaVersion: 1,
      archiveScope: policy.archiveScope,
      retentionDays: policy.retentionDays,
      maxArchiveBytes: policy.maxArchiveBytes,
      allowAppend: true,
      allowRead: true,
      appendOnly: true,
      deletionAllowed: false,
      overwriteAllowed: false
    })
  });
}

/**
 * Authorization helper. The principal MUST come from trusted server-side
 * authentication/session verification, never from client-supplied request data.
 */
export function authorizePiTestnetArchiveAction(action, principal, policy) {
  const checkedPolicy = validatePiTestnetArchiveStoragePolicy(policy);
  if (!checkedPolicy.accepted) return checkedPolicy;
  if (!ALLOWED_ACTIONS.includes(action)) return Object.freeze({ accepted: false, code: "action_not_allowed" });
  if (!isPlainRecord(principal) || principal.active !== true ||
      typeof principal.id !== "string" || principal.id.length < 1 || principal.id.length > 128 ||
      !Array.isArray(principal.roles) ||
      principal.roles.some(role => typeof role !== "string" || role.length > 64)) {
    return Object.freeze({ accepted: false, code: "invalid_principal" });
  }
  const role = ROLE_BY_ACTION[action];
  if (!principal.roles.includes("archive_admin") && !principal.roles.includes(role)) {
    return Object.freeze({ accepted: false, code: "forbidden" });
  }
  return Object.freeze({
    accepted: true,
    action,
    principalId: principal.id,
    archiveScope: checkedPolicy.policy.archiveScope,
    policy: checkedPolicy.policy
  });
}

/**
 * Produces a write intent only. It does not persist, encrypt, or authenticate
 * the caller; a server adapter must enforce these controls before storage I/O.
 */
export function createPiTestnetArchiveAppendIntent(archive, principal, policy) {
  const authorization = authorizePiTestnetArchiveAction("append", principal, policy);
  if (!authorization.accepted) return authorization;
  const verified = verifyPiTestnetObservationArchive(archive);
  if (!verified.accepted) return verified;
  let serialized;
  try {
    serialized = canonicalJson(archive);
  } catch {
    return Object.freeze({ accepted: false, code: "invalid_archive_json" });
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > authorization.policy.maxArchiveBytes) {
    return Object.freeze({ accepted: false, code: "archive_exceeds_storage_policy" });
  }
  const archiveId = digest(serialized);
  return Object.freeze({
    accepted: true,
    intent: Object.freeze({
      operation: "append_only",
      archiveId,
      archiveScope: authorization.archiveScope,
      principalId: authorization.principalId,
      archiveBytes: bytes,
      recordCount: verified.recordCount,
      retentionDays: authorization.policy.retentionDays,
      overwriteAllowed: false,
      deletionAllowed: false,
      payload: serialized
    }),
    notice: "Write intent only. No storage operation, encryption, identity authentication, or retention enforcement has occurred."
  });
}

/** Creates a read intent after scope/role checks; never returns stored content. */
export function createPiTestnetArchiveReadIntent(archiveId, principal, policy) {
  const authorization = authorizePiTestnetArchiveAction("read", principal, policy);
  if (!authorization.accepted) return authorization;
  if (typeof archiveId !== "string" || !/^[a-f0-9]{64}$/.test(archiveId)) {
    return Object.freeze({ accepted: false, code: "invalid_archive_id" });
  }
  return Object.freeze({
    accepted: true,
    intent: Object.freeze({
      operation: "read_only",
      archiveId,
      archiveScope: authorization.archiveScope,
      principalId: authorization.principalId
    }),
    notice: "Read intent only. A server-side adapter must enforce scope and re-verify archive integrity after retrieval."
  });
}
