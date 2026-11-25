import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIntelligenceAnswer, MAX_INTELLIGENCE_ANSWER_CHARS } from "./intelligence-answer-quality.mjs";

test("answer gate accepts clean text and trims whitespace", () => {
  assert.deepEqual(normalizeIntelligenceAnswer("  پاسخ معتبر  "), { ok: true, text: "پاسخ معتبر", reason: null });
});
test("answer gate rejects non-text and empty model responses", () => {
  assert.equal(normalizeIntelligenceAnswer(null).reason, "not_text");
  assert.equal(normalizeIntelligenceAnswer(" \n ").reason, "empty");
});
test("answer gate removes control characters without damaging Persian text", () => {
  assert.equal(normalizeIntelligenceAnswer("سلام\u0000 دنیا").text, "سلام دنیا");
});
test("answer gate rejects oversized responses instead of silently truncating them", () => {
  const result = normalizeIntelligenceAnswer("x".repeat(MAX_INTELLIGENCE_ANSWER_CHARS + 1));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too_long");
});
