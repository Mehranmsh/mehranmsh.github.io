import { buildIntelligenceExecutionPlan } from "./intelligence-execution-planner.mjs";

const MAX_ITEMS = 200;
const SENSITIVE = new Set(["secret", "credential", "wallet", "financial", "private_social", "health", "identity"]);
const VALID_PROGRESS = new Set(["pending", "in_progress", "completed", "blocked", "failed"]);
const clean = (value, limit = 160) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const active = record => record && !record.deleted_at && (!record.status || String(record.status).toLowerCase() === "active") && !SENSITIVE.has(String(record.sensitivity || "").toLowerCase());
const timestamp = value => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Reconcile an explicitly scoped goal with proposed tasks and owner-confirmed
 * progress events. The result is advisory only; no record is written or run.
 */
export function buildIntelligenceGoalLifecycle(records, proposedTasks, progressEvents, options = {}) {
  const ownerUid = clean(options.ownerUid, 256);
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? Math.min(options.maxItems, MAX_ITEMS) : 100;
  const empty = {
    goals: [], acceptedTaskProposals: [], rejectedTaskProposals: [],
    progress: { acceptedEvents: 0, ignoredEvents: 0, taskStates: [] },
    executionPlans: [], replanningSuggestions: [],
    diagnostics: { ownerScoped: false, advisoryOnly: true, recordsChanged: false, tasksCreated: false, tasksExecuted: false, approvalRequired: true }
  };
  const actorUid = clean(options.actorUid, 256);
  if (!ownerUid || actorUid !== ownerUid || !Array.isArray(records) || !Array.isArray(proposedTasks) || !Array.isArray(progressEvents)) return empty;

  const ownerRecords = records.filter(record =>
    record && typeof record === "object" && !Array.isArray(record) &&
    record.owner_uid === ownerUid && active(record)
  );
  const goals = ownerRecords.filter(record =>
    String(record.memory_type || record.type || "").toLowerCase() === "goal" ||
    typeof record.goal_id === "string" && record.is_goal === true
  ).map(record => ({
    goal_id: clean(record.goal_id || record.memory_key || record.id, 120),
    title: clean(record.title || record.label || record.content, 200),
    state: clean(record.goal_state || record.state || "unspecified", 32)
  })).filter(goal => goal.goal_id).sort((a, b) => a.goal_id.localeCompare(b.goal_id)).slice(0, maxItems);
  const goalIds = new Set(goals.map(goal => goal.goal_id));

  const acceptedTaskProposals = [];
  const rejectedTaskProposals = [];
  const seenTaskIds = new Set();
  for (const raw of proposedTasks.slice(0, maxItems)) {
    const taskId = clean(raw?.task_id, 120);
    const goalId = clean(raw?.goal_id, 120);
    let reason = "";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) reason = "invalid_task_record";
    else if (raw.owner_uid !== ownerUid) reason = "owner_scope_mismatch";
    else if (!goalIds.has(goalId)) reason = "goal_missing_or_out_of_scope";
    else if (!taskId) reason = "task_id_required";
    else if (seenTaskIds.has(taskId)) reason = "duplicate_task_id";
    else if (!clean(raw.title, 200)) reason = "task_title_required";
    if (reason) {
      rejectedTaskProposals.push({ task_id: taskId || null, goal_id: goalId || null, reason });
      continue;
    }
    seenTaskIds.add(taskId);
    acceptedTaskProposals.push({
      owner_uid: ownerUid, memory_type: "task", task_id: taskId, goal_id: goalId,
      title: clean(raw.title, 200),
      priority: clean(raw.priority, 24) || "medium",
      task_state: "pending",
      due_at: timestamp(raw.due_at) === null ? null : new Date(timestamp(raw.due_at)).toISOString(),
      estimate_minutes: Number.isFinite(raw.estimate_minutes) && raw.estimate_minutes >= 0
        ? Math.min(Math.floor(raw.estimate_minutes), 100000) : null,
      depends_on_task_ids: Array.isArray(raw.depends_on_task_ids)
        ? [...new Set(raw.depends_on_task_ids.map(id => clean(id, 120)).filter(Boolean))].slice(0, 50).sort() : [],
      dependencies_confirmed: raw.dependencies_confirmed === true && raw.dependencies_confirmed_by === ownerUid,
      dependencies_confirmed_by: raw.dependencies_confirmed === true && raw.dependencies_confirmed_by === ownerUid ? ownerUid : null,
      proposal_only: true
    });
  }

  const taskIds = new Set(acceptedTaskProposals.map(task => task.task_id));
  const events = progressEvents.slice(0, maxItems).filter(event =>
    event && typeof event === "object" && !Array.isArray(event) &&
    event.owner_uid === ownerUid && event.actor_uid === ownerUid &&
    event.explicit_confirmation === true && VALID_PROGRESS.has(String(event.progress_state || "").toLowerCase()) &&
    clean(event.event_id, 120) && taskIds.has(clean(event.task_id, 120)) &&
    timestamp(event.occurred_at) !== null
  );
  const uniqueEvents = new Map();
  for (const event of events) {
    const eventId = clean(event.event_id, 120);
    if (!uniqueEvents.has(eventId)) uniqueEvents.set(eventId, event);
  }
  const orderedEvents = [...uniqueEvents.values()].sort((a, b) =>
    timestamp(a.occurred_at) - timestamp(b.occurred_at) ||
    clean(a.event_id, 120).localeCompare(clean(b.event_id, 120))
  );
  const latestByTask = new Map();
  for (const event of orderedEvents) latestByTask.set(clean(event.task_id, 120), event);
  const taskStates = [...latestByTask.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([taskId, event]) => ({
    task_id: taskId, state: String(event.progress_state).toLowerCase(),
    event_id: clean(event.event_id, 120), occurred_at: new Date(timestamp(event.occurred_at)).toISOString(),
    owner_confirmed: true
  }));
  const stateByTask = new Map(taskStates.map(item => [item.task_id, item.state]));
  const plans = [];
  for (const goal of goals) {
    const tasks = acceptedTaskProposals.filter(task => task.goal_id === goal.goal_id).map(task => ({
      ...task, task_state: stateByTask.get(task.task_id) || task.task_state
    }));
    if (!tasks.length) continue;
    const heldTasks = tasks.filter(task => ["failed", "blocked"].includes(task.task_state)).map(task => ({ task_id: task.task_id, state: task.task_state }));
    const planTasks = tasks.map(task => heldTasks.some(item => item.task_id === task.task_id) ? { ...task, task_state: "in_progress" } : task);
    const plan = buildIntelligenceExecutionPlan(planTasks, { ownerUid, maxTasks: maxItems });
    const failedOrBlocked = tasks.filter(task => ["failed", "blocked"].includes(task.task_state));
    const replanningSuggestions = failedOrBlocked.map(task => ({
      goal_id: goal.goal_id, task_id: task.task_id,
      reason: task.task_state === "failed" ? "owner_confirmed_failure" : "owner_confirmed_blocker",
      suggestion: "review_dependencies_and_propose_an_alternative_sequence",
      approval_required: true, advisory_only: true
    }));
    if (plan.blockedTasks.length) {
      for (const item of plan.blockedTasks) replanningSuggestions.push({
        goal_id: goal.goal_id, task_id: item.task_id,
        reason: item.reason, suggestion: "resolve_or_confirm_dependencies",
        approval_required: true, advisory_only: true
      });
    }
    const planRecord = {
      goal_id: goal.goal_id,
      orderedTasks: plan.orderedTasks,
      blockedTasks: plan.blockedTasks,
      heldTasks,
      unresolvedTasks: plan.unresolvedTasks,
      replanningSuggestions,
      diagnostics: { ...plan.diagnostics, advisoryOnly: true, tasksCreated: false, tasksExecuted: false }
    };
    plans.push(planRecord);
  }

  return {
    goals,
    acceptedTaskProposals,
    rejectedTaskProposals,
    progress: {
      acceptedEvents: orderedEvents.length,
      ignoredEvents: Math.max(0, progressEvents.length - orderedEvents.length),
      taskStates
    },
    executionPlans: plans,
    replanningSuggestions: plans.flatMap(plan => plan.replanningSuggestions),
    diagnostics: {
      ownerScoped: true, goalsInspected: goals.length,
      taskProposalsInspected: Math.min(proposedTasks.length, maxItems),
      taskProposalsAccepted: acceptedTaskProposals.length,
      taskProposalsRejected: rejectedTaskProposals.length,
      progressEventsInspected: Math.min(progressEvents.length, maxItems),
      advisoryOnly: true, recordsChanged: false, tasksCreated: false,
      tasksExecuted: false, approvalRequired: true
    }
  };
}
