import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyIntelligenceResultCheckpoint } from "./intelligence-checkpoint.mjs";

function checkpoint(result, overrides = {}) {
  return {
    phase: "result_ready",
    result,
    resultSha256: createHash("sha256").update(result).digest("hex"),
    ...overrides
  };
}

test("accepts a bounded result checkpoint with a matching SHA-256 digest", () => {
  assert.deepEqual(verifyIntelligenceResultCheckpoint(checkpoint('{"passed":true}')), {
    valid: true,
    reason: null
  });
});

test("rejects result content changed after checkpoint creation", () => {
  const saved = checkpoint('{"passed":true}');
  saved.result = '{"passed":false}';
  assert.equal(verifyIntelligenceResultCheckpoint(saved).reason, "digest_mismatch");
});

test("rejects missing, malformed, or non-result checkpoints", () => {
  assert.equal(verifyIntelligenceResultCheckpoint({phase:"result_ready",result:"x"}).reason, "invalid_digest_format");
  assert.equal(verifyIntelligenceResultCheckpoint({phase:"working",result:"x"}).reason, "not_result_checkpoint");
  assert.equal(verifyIntelligenceResultCheckpoint(null).reason, "invalid_checkpoint");
});

test("rejects empty and oversized result payloads", () => {
  assert.equal(verifyIntelligenceResultCheckpoint(checkpoint("")).reason, "invalid_result_length");
  assert.equal(verifyIntelligenceResultCheckpoint(checkpoint("12345"), {maxResultChars:4}).reason, "invalid_result_length");
});
