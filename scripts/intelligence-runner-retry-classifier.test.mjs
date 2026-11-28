import test from "node:test";
import assert from "node:assert/strict";
import { shouldRetryIntelligenceRunnerTask } from "./intelligence-runner-retry-classifier.mjs";

test("retries rate limits and transient server failures", () => {
  assert.equal(shouldRetryIntelligenceRunnerTask({ status: 429, message: "HTTP 429" }), true);
  for (const status of [500, 502, 503, 504, 599]) {
    assert.equal(shouldRetryIntelligenceRunnerTask({ status, message: "upstream failure" }), true);
  }
});

test("retries network and timeout failures after request-level retries", () => {
  for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
    assert.equal(shouldRetryIntelligenceRunnerTask({ name, message: "request failed" }), true);
  }
  assert.equal(shouldRetryIntelligenceRunnerTask({ message: "fetch failed: connection reset" }), true);
});

test("retries only the known patch reservation conflict", () => {
  assert.equal(shouldRetryIntelligenceRunnerTask({
    status: 409, message: "Proposal already in progress"
  }, "propose_code_patch"), true);
  assert.equal(shouldRetryIntelligenceRunnerTask({
    status: 409, message: "Proposal already in progress"
  }, "repository_quality_check"), false);
  assert.equal(shouldRetryIntelligenceRunnerTask({
    status: 409, message: "Unrelated conflict"
  }, "propose_code_patch"), false);
});

test("never retries provider inference failures or permanent client errors", () => {
  assert.equal(shouldRetryIntelligenceRunnerTask({
    status: 503, message: "provider unavailable",
    safeDiagnostic: { stage: "workers_ai_inference" }
  }), false);
  assert.equal(shouldRetryIntelligenceRunnerTask({ status: 401, message: "unauthorized" }), false);
  assert.equal(shouldRetryIntelligenceRunnerTask({ status: 403, message: "forbidden" }), false);
  assert.equal(shouldRetryIntelligenceRunnerTask({ status: 422, message: "invalid payload" }), false);
  assert.equal(shouldRetryIntelligenceRunnerTask(null), false);
});
