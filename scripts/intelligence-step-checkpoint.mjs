import { createHash } from "node:crypto";

export const REPOSITORY_TEST_STEPS = Object.freeze([
  "worker_syntax",
  "capability_syntax",
  "capability_tests"
]);

function canonicalPayload(value) {
  return JSON.stringify({
    schemaVersion: 1,
    phase: "step_progress",
    taskId: value.taskId,
    actionType: value.actionType,
    baseSha: value.baseSha,
    completedSteps: value.completedSteps
  });
}

export function createIntelligenceStepCheckpoint({ taskId, actionType, baseSha, completedSteps }) {
  if (typeof taskId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(taskId)) {
    throw new Error("Invalid checkpoint task identity.");
  }
  if (actionType !== "run_repository_tests") throw new Error("Unsupported resumable action.");
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error("Invalid immutable checkpoint base SHA.");
  }
  if (!Array.isArray(completedSteps) || completedSteps.length > REPOSITORY_TEST_STEPS.length ||
      completedSteps.some((step, index) => step !== REPOSITORY_TEST_STEPS[index])) {
    throw new Error("Completed steps must be an ordered prefix of the fixed test plan.");
  }
  const payload = { taskId, actionType, baseSha, completedSteps: [...completedSteps] };
  return {
    ...JSON.parse(canonicalPayload(payload)),
    digestSha256: createHash("sha256").update(canonicalPayload(payload)).digest("hex")
  };
}

export function verifyIntelligenceStepCheckpoint(checkpoint, expected) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { valid: false, reason: "invalid_checkpoint" };
  }
  const allowedKeys = ["actionType", "baseSha", "completedSteps", "digestSha256", "phase", "schemaVersion", "taskId"];
  const actualKeys = Object.keys(checkpoint).sort();
  if (actualKeys.length !== allowedKeys.length ||
      actualKeys.some((key, index) => key !== allowedKeys[index])) {
    return { valid: false, reason: "unexpected_checkpoint_fields" };
  }
  if (checkpoint.phase !== "step_progress" || checkpoint.schemaVersion !== 1) {
    return { valid: false, reason: "unsupported_checkpoint_schema" };
  }
  if (!expected || checkpoint.taskId !== expected.taskId ||
      checkpoint.actionType !== expected.actionType || checkpoint.baseSha !== expected.baseSha) {
    return { valid: false, reason: "task_identity_mismatch" };
  }
  let rebuilt;
  try {
    rebuilt = createIntelligenceStepCheckpoint(checkpoint);
  } catch {
    return { valid: false, reason: "invalid_completed_steps" };
  }
  if (typeof checkpoint.digestSha256 !== "string" || checkpoint.digestSha256 !== rebuilt.digestSha256) {
    return { valid: false, reason: "digest_mismatch" };
  }
  return { valid: true, completedSteps: [...rebuilt.completedSteps] };
}
