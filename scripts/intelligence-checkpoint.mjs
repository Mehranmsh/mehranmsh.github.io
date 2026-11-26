import { createHash } from "node:crypto";

const DEFAULT_MAX_RESULT_CHARS = 3000;
const HARD_MAX_RESULT_CHARS = 12000;

export function verifyIntelligenceResultCheckpoint(checkpoint, { maxResultChars = DEFAULT_MAX_RESULT_CHARS } = {}) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { valid: false, reason: "invalid_checkpoint" };
  }
  if (checkpoint.phase !== "result_ready") {
    return { valid: false, reason: "not_result_checkpoint" };
  }
  const result = typeof checkpoint.result === "string" ? checkpoint.result : "";
  const digest = typeof checkpoint.resultSha256 === "string" ? checkpoint.resultSha256 : "";
  const requestedLimit = Number.isSafeInteger(maxResultChars) && maxResultChars > 0
    ? maxResultChars
    : DEFAULT_MAX_RESULT_CHARS;
  const limit = Math.min(requestedLimit, HARD_MAX_RESULT_CHARS);
  if (!result || result.length > limit) return { valid: false, reason: "invalid_result_length" };
  if (!/^[a-f0-9]{64}$/.test(digest)) return { valid: false, reason: "invalid_digest_format" };
  const actualDigest = createHash("sha256").update(result).digest("hex");
  if (actualDigest !== digest) return { valid: false, reason: "digest_mismatch" };
  return { valid: true, reason: null };
}

export { DEFAULT_MAX_RESULT_CHARS, HARD_MAX_RESULT_CHARS };
