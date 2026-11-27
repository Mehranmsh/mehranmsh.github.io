import test from "node:test";
import assert from "node:assert/strict";
import {
  createIntelligenceStepCheckpoint,
  verifyIntelligenceStepCheckpoint,
  REPOSITORY_TEST_STEPS
} from "./intelligence-step-checkpoint.mjs";

const identity = {
  taskId: "task-123",
  actionType: "run_repository_tests",
  baseSha: "a".repeat(40)
};

test("creates and verifies a durable ordered step checkpoint", () => {
  const saved = createIntelligenceStepCheckpoint({
    ...identity,
    completedSteps: REPOSITORY_TEST_STEPS.slice(0, 2)
  });
  assert.equal(saved.phase, "step_progress");
  assert.deepEqual(verifyIntelligenceStepCheckpoint(saved, identity), {
    valid: true,
    completedSteps: ["worker_syntax", "capability_syntax"]
  });
});

test("rejects checkpoint reuse for another task or source commit", () => {
  const saved = createIntelligenceStepCheckpoint({...identity, completedSteps: ["worker_syntax"]});
  assert.equal(verifyIntelligenceStepCheckpoint(saved, {...identity, taskId: "other"}).reason, "task_identity_mismatch");
  assert.equal(verifyIntelligenceStepCheckpoint(saved, {...identity, baseSha: "b".repeat(40)}).reason, "task_identity_mismatch");
});

test("rejects reordered, skipped, unknown, and excessive steps", () => {
  for (const completedSteps of [
    ["capability_syntax"],
    ["worker_syntax", "unknown"],
    ["worker_syntax", "capability_tests"],
    [...REPOSITORY_TEST_STEPS, "extra"]
  ]) {
    assert.throws(() => createIntelligenceStepCheckpoint({...identity, completedSteps}));
  }
});

test("rejects tampered progress and malformed checkpoints", () => {
  const saved = createIntelligenceStepCheckpoint({...identity, completedSteps: ["worker_syntax"]});
  saved.completedSteps.push("capability_syntax");
  assert.equal(verifyIntelligenceStepCheckpoint(saved, identity).reason, "digest_mismatch");
  assert.equal(verifyIntelligenceStepCheckpoint(null, identity).reason, "invalid_checkpoint");
});

test("rejects unsupported action types and malformed immutable identity", () => {
  assert.throws(() => createIntelligenceStepCheckpoint({...identity, actionType: "propose_code_patch", completedSteps: []}));
  assert.throws(() => createIntelligenceStepCheckpoint({...identity, baseSha: "latest", completedSteps: []}));
});
