const MAX_CRITERIA = 8;
const MAX_EVIDENCE_PER_CRITERION = 5;
const PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){0,5}$/;
const OPERATORS = new Set(["exists", "equals", "not_equals", "gte", "lte", "includes", "min_items"]);
const own = (value, key) => value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key);

function readPath(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (!own(current, part)) return { found: false, value: undefined };
    current = current[part];
  }
  return { found: true, value: current };
}

function compare(actual, operator, expected) {
  if (operator === "exists") return actual !== undefined && actual !== null;
  if (operator === "equals") return actual === expected;
  if (operator === "not_equals") return actual !== expected;
  if (operator === "gte") return typeof actual === "number" && typeof expected === "number" && actual >= expected;
  if (operator === "lte") return typeof actual === "number" && typeof expected === "number" && actual <= expected;
  if (operator === "includes") return typeof actual === "string" && typeof expected === "string" ? actual.includes(expected) : Array.isArray(actual) && actual.includes(expected);
  if (operator === "min_items") return Array.isArray(actual) && Number.isInteger(expected) && expected >= 0 && actual.length >= expected;
  return false;
}

export function normalizeIntelligenceAcceptanceCriteria(criteria, tasks) {
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > MAX_CRITERIA || !Array.isArray(tasks)) {
    return { valid: false, reason: "acceptance_criteria_required" };
  }
  const sourceTaskId = task => {
    if (typeof task?.taskId === "string" && task.taskId) return task.taskId;
    try {
      const payload = typeof task?.action_payload === "string" ? JSON.parse(task.action_payload) : task?.action_payload;
      if (typeof payload?.sourceTaskId === "string" && payload.sourceTaskId) return payload.sourceTaskId;
    } catch {}
    return String(task?.id || "");
  };
  const taskIds = new Set(tasks.map(sourceTaskId).filter(Boolean));
  const ids = new Set();
  const normalized = [];
  for (const item of criteria) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const description = typeof item?.description === "string" ? item.description.trim() : "";
    if (!/^[a-zA-Z0-9._:-]{1,60}$/.test(id) || ids.has(id) || !description || description.length > 300 ||
        !Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > MAX_EVIDENCE_PER_CRITERION) {
      return { valid: false, reason: "acceptance_criterion_shape_invalid" };
    }
    ids.add(id);
    const evidence = [];
    for (const entry of item.evidence) {
      const taskId = typeof entry?.taskId === "string" ? entry.taskId : "";
      const path = typeof entry?.path === "string" ? entry.path : "";
      const operator = typeof entry?.operator === "string" ? entry.operator : "";
      const hasExpected = Object.hasOwn(entry || {}, "expected");
      const expected = entry?.expected;
      if (!taskIds.has(taskId) || !PATH_PATTERN.test(path) || !OPERATORS.has(operator) ||
          (operator !== "exists" && (!hasExpected || !["string", "number", "boolean"].includes(typeof expected))) ||
          (["gte", "lte", "min_items"].includes(operator) && typeof expected !== "number") ||
          (operator === "min_items" && (!Number.isInteger(expected) || expected < 0))) {
        return { valid: false, reason: "acceptance_evidence_invalid" };
      }
      evidence.push({ taskId, path, operator, ...(operator === "exists" ? {} : { expected }) });
    }
    normalized.push({ id, description, evidence });
  }
  return { valid: true, criteria: normalized };
}

export function verifyIntelligenceObjective(criteria, tasks) {
  const normalized = normalizeIntelligenceAcceptanceCriteria(criteria, tasks);
  if (!normalized.valid) {
    return { verified: false, status: "attention_required", criteria: [], passed: 0, total: 0, reason: normalized.reason };
  }
  const taskById = new Map(tasks.map(task => {
    let sourceId = typeof task?.taskId === "string" ? task.taskId : "";
    if (!sourceId) {
      try {
        const payload = typeof task?.action_payload === "string" ? JSON.parse(task.action_payload) : task?.action_payload;
        sourceId = typeof payload?.sourceTaskId === "string" ? payload.sourceTaskId : "";
      } catch {}
    }
    return [sourceId || String(task?.id || ""), task];
  }));
  let passed = 0;
  const results = normalized.criteria.map(criterion => {
    const evidence = criterion.evidence.map(item => {
      const task = taskById.get(item.taskId);
      if (!task || task.status !== "completed") {
        return { taskId: item.taskId, path: item.path, passed: false, reason: "verification_task_not_completed" };
      }
      let report;
      try { report = JSON.parse(String(task.result_text || task.result || "")); }
      catch { return { taskId: item.taskId, path: item.path, passed: false, reason: "verification_report_invalid" }; }
      const found = readPath(report, item.path);
      const ok = found.found && compare(found.value, item.operator, item.expected);
      return { taskId: item.taskId, path: item.path, passed: ok, reason: ok ? "evidence_verified" : "evidence_mismatch" };
    });
    const verified = evidence.every(item => item.passed);
    if (verified) passed++;
    return { id: criterion.id, description: criterion.description, verified, evidence };
  });
  const verified = passed === normalized.criteria.length;
  return {
    verified,
    status: verified ? "completed" : "attention_required",
    criteria: results,
    passed,
    total: results.length,
    reason: verified ? "all_acceptance_criteria_verified" : "acceptance_criteria_unproven"
  };
}
