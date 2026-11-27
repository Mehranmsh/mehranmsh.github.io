/**
 * Deterministic, fail-closed mission acceptance v1.
 *
 * This verifies that explicitly declared acceptance criteria are backed by
 * completed task reports accepted by the action-specific report verifier.
 * It does NOT infer semantic goal satisfaction from free-form text.
 */
const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const ACTIONS = new Set([
  "service_health_report",
  "repository_quality_check",
  "source_security_audit",
  "inspect_repository",
  "run_repository_tests",
  "propose_code_patch"
]);

export function validateMissionAcceptanceCriteria(criteria, tasks) {
  const fail = error => ({ ok: false, error });
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 12) {
    return fail("acceptanceCriteria must contain 1-12 explicit criteria.");
  }
  if (!Array.isArray(tasks) || tasks.length < 1) return fail("Acceptance criteria require declared tasks.");
  const taskById = new Map();
  for (const task of tasks) {
    if (!task || typeof task.taskId !== "string" || !ID_RE.test(task.taskId) ||
        typeof task.actionType !== "string" || !ACTIONS.has(task.actionType)) {
      return fail("Every acceptance task must have a stable ID and allowlisted action.");
    }
    if (taskById.has(task.taskId)) return fail("Acceptance task IDs must be unique.");
    taskById.set(task.taskId, task);
  }
  const seen = new Set();
  const normalized = [];
  for (const item of criteria) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.id !== "string" || !ID_RE.test(item.id) || seen.has(item.id) ||
        typeof item.taskId !== "string" || !taskById.has(item.taskId) ||
        item.type !== "validated_task_report") {
      return fail("Each criterion must uniquely reference a task and use validated_task_report.");
    }
    const task = taskById.get(item.taskId);
    if (item.actionType !== task.actionType) {
      return fail("Acceptance criterion actionType must match its referenced task.");
    }
    seen.add(item.id);
    normalized.push(Object.freeze({
      id: item.id,
      taskId: item.taskId,
      actionType: item.actionType,
      type: item.type
    }));
  }
  return { ok: true, criteria: normalized };
}

export function evaluateMissionAcceptance(criteria, taskResults, verifyReport) {
  if (!Array.isArray(criteria) || !criteria.length || !Array.isArray(taskResults) ||
      typeof verifyReport !== "function") {
    return { verified: false, reason: "acceptance_inputs_invalid", checks: [] };
  }
  const byId = new Map();
  for (const task of taskResults) {
    if (task && typeof task.taskId === "string" && !byId.has(task.taskId)) byId.set(task.taskId, task);
  }
  const checks = criteria.map(criterion => {
    const task = byId.get(criterion?.taskId);
    if (!task || task.status !== "completed" || task.actionType !== criterion.actionType) {
      return { criterionId: criterion?.id || null, taskId: criterion?.taskId || null, passed: false, reason: "task_not_completed_or_mismatched" };
    }
    let report = task.report;
    if (typeof report === "string") {
      try { report = JSON.parse(report); } catch {
        return { criterionId: criterion.id, taskId: criterion.taskId, passed: false, reason: "task_report_invalid_json" };
      }
    }
    let result;
    try { result = verifyReport(criterion.actionType, report); } catch {
      result = { passed: false };
    }
    return {
      criterionId: criterion.id,
      taskId: criterion.taskId,
      actionType: criterion.actionType,
      passed: result?.passed === true,
      reason: result?.passed === true ? "action_report_verified" : "action_report_rejected",
      verifierChecks: Array.isArray(result?.checks) ? result.checks.slice(0, 20) : []
    };
  });
  const verified = checks.length === criteria.length && checks.every(check => check.passed);
  return {
    verified,
    reason: verified ? "all_declared_task_report_criteria_passed" : "acceptance_criteria_failed",
    checks
  };
}
