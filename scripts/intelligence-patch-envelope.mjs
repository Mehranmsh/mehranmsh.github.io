import { createHash, timingSafeEqual } from "node:crypto";
import { validateIntelligencePatch } from "./intelligence-patch-guard.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ENVELOPE_KEYS = ["protocolVersion", "taskId", "approval", "baseSha", "files", "artifactSha256"];
const APPROVAL_KEYS = ["approvalId", "approvedAt", "expiresAt", "scopeSha256", "baseSha"];

function fail(reason) {
  return { ok: false, reason };
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every(key => Object.hasOwn(value, key));
}

function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() ===
    (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite number in canonical data.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (!value || typeof value !== "object") throw new TypeError("Unsupported canonical data type.");
  const keys = Object.keys(value).sort();
  return "{" + keys.map(key => JSON.stringify(key) + ":" + canonicalize(value[key])).join(",") + "}";
}

export function canonicalPatchEnvelopeBytes(envelope) {
  if (!exactKeys(envelope, ENVELOPE_KEYS)) throw new TypeError("Envelope fields do not match protocol v1.");
  const { artifactSha256, ...unsigned } = envelope;
  const normalized = {
    ...unsigned,
    files: [...unsigned.files].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")))
  };
  return Buffer.from(canonicalize(normalized), "utf8");
}

export function calculatePatchArtifactSha256(envelope) {
  return createHash("sha256").update(canonicalPatchEnvelopeBytes(envelope)).digest("hex");
}

function equalDigest(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Validate a patch envelope against an independently fetched trusted approval.
 * The approval object must come from the authenticated control plane, not the
 * envelope, task prompt, or model output. This helper has no write/execute path.
 */
export function validatePatchEnvelope(envelope, trustedApproval, now = new Date()) {
  if (!exactKeys(envelope, ENVELOPE_KEYS)) return fail("Envelope schema mismatch.");
  if (envelope.protocolVersion !== 1) return fail("Unsupported envelope protocol version.");
  if (typeof envelope.taskId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(envelope.taskId)) {
    return fail("Invalid task identifier.");
  }
  if (!exactKeys(envelope.approval, APPROVAL_KEYS)) return fail("Approval schema mismatch.");
  if (typeof envelope.approval.approvalId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(envelope.approval.approvalId)) {
    return fail("Invalid approval identifier.");
  }
  if (!validTimestamp(envelope.approval.approvedAt) || !validTimestamp(envelope.approval.expiresAt)) {
    return fail("Invalid approval timestamps.");
  }
  if (!SHA256.test(envelope.approval.scopeSha256) ||
      !GIT_SHA.test(envelope.approval.baseSha) ||
      !GIT_SHA.test(envelope.baseSha) ||
      !SHA256.test(envelope.artifactSha256)) {
    return fail("Malformed digest or commit identifier.");
  }
  if (!Array.isArray(envelope.files) || envelope.files.length === 0) {
    return fail("Envelope must contain at least one file.");
  }
  if (!trustedApproval || typeof trustedApproval !== "object" ||
      trustedApproval.status !== "approved" ||
      !Array.isArray(trustedApproval.allowedPaths)) {
    return fail("No active trusted owner approval was supplied.");
  }
  if (trustedApproval.taskId !== envelope.taskId ||
      trustedApproval.approvalId !== envelope.approval.approvalId) {
    return fail("Task or approval identity does not match the trusted record.");
  }
  if (trustedApproval.scopeSha256 !== envelope.approval.scopeSha256 ||
      trustedApproval.baseSha !== envelope.approval.baseSha ||
      envelope.baseSha !== trustedApproval.baseSha) {
    return fail("Approved scope or base commit does not match.");
  }
  if (trustedApproval.approvedAt !== envelope.approval.approvedAt ||
      trustedApproval.expiresAt !== envelope.approval.expiresAt) {
    return fail("Approval timestamps do not match the trusted record.");
  }
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(currentTime)) return fail("Invalid validation clock.");
  if (currentTime < Date.parse(trustedApproval.approvedAt)) return fail("Approval is not yet valid.");
  if (currentTime >= Date.parse(trustedApproval.expiresAt)) return fail("Approval has expired.");
  const allowed = new Set(trustedApproval.allowedPaths);
  const seen = new Set();
  for (const file of envelope.files) {
    if (!exactKeys(file, ["path", "status", "mode", "content"])) {
      return fail("Patch file entry schema mismatch.");
    }
    if (typeof file.path !== "string" || !allowed.has(file.path)) {
      return fail("Patch contains a path outside the exact approved path set.");
    }
    if (seen.has(file.path)) return fail("Patch contains duplicate paths.");
    seen.add(file.path);
  }
  const patchResult = validateIntelligencePatch(envelope.files);
  if (!patchResult.ok) return fail("Patch guard rejected the file set: " + patchResult.errors.join(" "));
  let calculated;
  try {
    calculated = calculatePatchArtifactSha256(envelope);
  } catch {
    return fail("Envelope cannot be canonically serialized.");
  }
  if (!equalDigest(calculated, envelope.artifactSha256)) return fail("Artifact digest mismatch.");
  return {
    ok: true,
    taskId: envelope.taskId,
    approvalId: envelope.approval.approvalId,
    baseSha: envelope.baseSha,
    artifactSha256: calculated,
    fileCount: patchResult.fileCount,
    totalBytes: patchResult.totalBytes
  };
}

export const PATCH_ENVELOPE_PROTOCOL_VERSION = 1;
