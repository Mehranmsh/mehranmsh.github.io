import test from "node:test";
import assert from "node:assert/strict";
import { planIntelligenceRetry } from "./intelligence-retry-policy.mjs";

test("transient network failures receive bounded exponential backoff", () => {
  const first = planIntelligenceRetry({ attempts: 1, maxAttempts: 3, error: "fetch failed", now: 1000 });
  const second = planIntelligenceRetry({ attempts: 2, maxAttempts: 3, error: "HTTP 503", now: 1000 });
  assert.equal(first.retryable, true);
  assert.equal(first.delaySeconds, 30);
  assert.equal(second.delaySeconds, 60);
  assert.equal(first.nextAttemptAt, new Date(31000).toISOString());
});

test("permanent errors are blocked without retry", () => {
  const result = planIntelligenceRetry({ attempts: 0, error: "invalid task payload" });
  assert.equal(result.retryable, false);
  assert.equal(result.nextAttemptAt, null);
  assert.equal(result.errorCode, "execution_blocked");
});

test("retry limit prevents another attempt", () => {
  const result = planIntelligenceRetry({ attempts: 3, maxAttempts: 3, error: "timeout" });
  assert.equal(result.retryable, false);
  assert.equal(result.exhausted, true);
  assert.equal(result.errorCode, "retry_limit_reached");
});

test("backoff is capped at one hour", () => {
  const result = planIntelligenceRetry({ attempts: 11, maxAttempts: 20, error: "network error" });
  assert.equal(result.delaySeconds, 3600);
});

test("invalid numeric inputs are bounded and never throw", () => {
  const result = planIntelligenceRetry({
    attempts: Number.POSITIVE_INFINITY,
    maxAttempts: Number.NaN,
    baseDelaySeconds: Number.POSITIVE_INFINITY,
    maxDelaySeconds: Number.NaN,
    error: "timeout",
    now: Number.MAX_VALUE
  });
  assert.equal(result.retryable, false);
  assert.equal(result.exhausted, false);
  assert.equal(result.delaySeconds, 0);
  assert.equal(result.nextAttemptAt, null);
});

test("fractional and negative retry settings are normalized safely", () => {
  const result = planIntelligenceRetry({
    attempts: -4.8,
    maxAttempts: 2.9,
    baseDelaySeconds: -10,
    maxDelaySeconds: 0,
    error: "timeout",
    now: 0
  });
  assert.equal(result.retryable, true);
  assert.equal(result.delaySeconds, 1);
  assert.equal(result.nextAttemptAt, new Date(1000).toISOString());
});

test("unprintable error values do not break retry planning", () => {
  const hostile = { toString() { throw new Error("conversion failed"); } };
  const result = planIntelligenceRetry({ error: hostile, attempts: 0 });
  assert.equal(result.retryable, false);
  assert.equal(result.errorCode, "execution_blocked");
});
