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
