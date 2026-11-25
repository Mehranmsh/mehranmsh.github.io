import test from "node:test";
import assert from "node:assert/strict";
import { runVerificationLoop, INTELLIGENCE_VERIFICATION_MAX_ATTEMPTS } from "./intelligence-verification-loop.mjs";

test("verification loop repairs a failure and rechecks until passing", async () => {
  let checks = 0;
  let repairs = 0;
  const checkpoints = [];
  const result = await runVerificationLoop({
    verify: async () => ({ passed: ++checks === 2, code: checks === 2 ? "ok" : "lint_failed" }),
    repair: async () => { repairs++; return { changed: true, safe: true, summary: "bounded repair applied" }; },
    checkpoint: async value => checkpoints.push(value)
  });
  assert.equal(result.status, "verified");
  assert.equal(result.attempts, 2);
  assert.equal(repairs, 1);
  assert.equal(checks, 2);
  assert.equal(checkpoints.length, 3);
});

test("verification loop stops at the configured attempt cap and rolls back", async () => {
  let checks = 0;
  let repairs = 0;
  let rolledBack = false;
  const result = await runVerificationLoop({
    maxAttempts: 3,
    verify: async () => { checks++; return { passed: false, code: "test_failed" }; },
    repair: async () => { repairs++; return { changed: true, safe: true }; },
    rollback: async () => { rolledBack = true; return { restored: true, summary: "last known good restored" }; }
  });
  assert.equal(checks, 3);
  assert.equal(repairs, 2);
  assert.equal(rolledBack, true);
  assert.equal(result.status, "rolled_back");
});

test("unsafe or no-op repair is never retried", async () => {
  let checks = 0;
  let repairs = 0;
  const result = await runVerificationLoop({
    verify: async () => { checks++; return { passed: false }; },
    repair: async () => { repairs++; return { changed: true, safe: false }; }
  });
  assert.equal(checks, 1);
  assert.equal(repairs, 1);
  assert.equal(result.status, "needs_attention");
});

test("verification rejects invalid attempt budgets and missing verifier", async () => {
  await assert.rejects(() => runVerificationLoop({}), /verify must be a function/);
  await assert.rejects(() => runVerificationLoop({ verify: async () => ({ passed: true }), maxAttempts: 4 }), /maxAttempts/);
  assert.equal(INTELLIGENCE_VERIFICATION_MAX_ATTEMPTS, 3);
});
