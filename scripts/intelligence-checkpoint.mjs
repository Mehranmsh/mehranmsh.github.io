import { createHash } from "node:crypto";

export function verifyIntelligenceResultCheckpoint(checkpoint, { maxResultChars = 3000 } = {}) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { valid: false, reason: "invalid_checkpoint" };
  }
  if (checkpoint.phase !== "result_ready") {
    return { valid: false, reason: "not_result_checkpoint" };
  }
  const result = typeof checkpoint.result === "string" ? checkpoint.result : "";
  const digest = typeof checkpoint.resultSha256 === "string" ? checkpoint.resultSha256 : "";
  const limit = Number.isInteger(maxResultChars) && maxResultChars > 0 ? maxResultChars : 3000;
  if (!result || result.length > limit) return { valid: false, reason: "invalid_result_length" };
  if (!/^[a-f0-9]{64}$/.test(digest)) return { valid: false, reason: "invalid_digest_format" };
  const actualDigest = createHash("sha256").update(result).digest("hex");
  if (actualDigest !== digest) return { valid: false, reason: "digest_mismatch" };
  return { valid: true, reason: null };
}
