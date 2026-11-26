const MAX_REVISIONS = 50;
const MAX_TASKS = 200;
const MAX_EVENTS = 500;
const VALID_STATES = new Set(["pending", "in_progress", "completed", "blocked", "failed"]);
const clean = (value, limit = 160) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const time = value => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const safeTask = task => ({
  task_id: clean(task?.task_id, 120),
  title: clean(task?.title, 200),
  priority: clean(task?.priority, 24),
  due_at: clean(task?.due_at, 40),
  depends_on_task_ids: Array.isArray(task?.depends_on_task_ids)
    ? [...new Set(task.depends_on_task_ids.slice(0, 50).map(id => clean(id, 120)).filter(Boolean))].sort().slice(0, 50) : [],
  task_state: VALID_STATES.has(String(task?.task_state || "").toLowerCase())
    ? String(task.task_state).toLowerCase() : "unspecified"
});
const taskMap = revision => new Map(revision.tasks.map(task => [task.task_id, task]));
const stable = value => JSON.stringify(value);

/**
 * Compare explicitly supplied, immutable plan revisions.
 * Requires authenticated owner context and explicit change reasons.
 * Outcomes are accepted only from owner-confirmed progress events.
 * This helper is advisory and never persists or mutates data.
 */
export function compareIntelligencePlanVersions(revisions, progressEvents = [], options = {}) {
  const ownerUid = clean(options.ownerUid, 256);
  const actorUid = clean(options.actorUid, 256);
  const empty = {
    revisions: [], comparison: null, outcomes: [],
    diagnostics: { ownerScoped: false, advisoryOnly: true, recordsChanged: false, historyWritten: false, approvalRequired: true }
  };
  if (!ownerUid || actorUid !== ownerUid || !Array.isArray(revisions) || !Array.isArray(progressEvents)) return empty;
  const maxRevisions = Number.isInteger(options.maxRevisions) && options.maxRevisions > 0
    ? Math.min(options.maxRevisions, MAX_REVISIONS) : 20;
  const maxTasks = Number.isInteger(options.maxTasks) && options.maxTasks > 0
    ? Math.min(options.maxTasks, MAX_TASKS) : 100;
  const inspected = revisions.slice(0, maxRevisions);
  const rejected = [];
  const valid = [];
  for (const raw of inspected) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejected.push({ reason: "invalid_revision" }); continue;
    }
    if (raw.owner_uid !== ownerUid) { rejected.push({ revision_id: clean(raw.revision_id, 120) || null, reason: "owner_scope_mismatch" }); continue; }
    const revisionId = clean(raw.revision_id, 120);
    const version = raw.version;
    const created = time(raw.created_at);
    const reason = clean(raw.change_reason, 500);
    if (!revisionId || !Number.isInteger(version) || version < 1 || created === null ||
        !Array.isArray(raw.tasks) || !reason || raw.tasks.length > maxTasks) {
      rejected.push({ revision_id: revisionId || null, reason: "revision_metadata_or_reason_invalid" }); continue;
    }
    const tasks = [];
    const seen = new Set();
    let invalidTask = false;
    for (const task of raw.tasks) {
      const normalized = safeTask(task);
      if (!normalized.task_id || seen.has(normalized.task_id)) { invalidTask = true; break; }
      seen.add(normalized.task_id);
      tasks.push(normalized);
    }
    if (invalidTask) { rejected.push({ revision_id: revisionId, reason: "invalid_or_duplicate_task" }); continue; }
    valid.push({
      owner_uid: ownerUid, revision_id: revisionId, version,
      created_at: new Date(created).toISOString(), change_reason: reason,
      source_event_ids: Array.isArray(raw.source_event_ids)
        ? [...new Set(raw.source_event_ids.slice(0, MAX_EVENTS).map(id => clean(id, 120)).filter(Boolean))].slice(0, MAX_EVENTS).sort() : [],
      tasks
    });
  }
  valid.sort((a, b) => a.version - b.version || a.revision_id.localeCompare(b.revision_id));
  const seenVersions = new Set();
  const seenRevisionIds = new Set();
  const unique = [];
  for (const revision of valid) {
    if (seenVersions.has(revision.version) || seenRevisionIds.has(revision.revision_id)) {
      rejected.push({ revision_id: revision.revision_id, reason: "duplicate_revision_or_version" }); continue;
    }
    seenVersions.add(revision.version); seenRevisionIds.add(revision.revision_id);
    unique.push(revision);
  }
  const chronologyWarnings = [];
  for (let index = 1; index < unique.length; index++) {
    const previous = unique[index - 1], current = unique[index];
    if (current.version !== previous.version + 1) chronologyWarnings.push({
      from_version: previous.version, to_version: current.version, reason: "version_gap"
    });
    if (Date.parse(current.created_at) <= Date.parse(previous.created_at)) chronologyWarnings.push({
      from_version: previous.version, to_version: current.version, reason: "non_increasing_timestamp"
    });
  }
  let comparison = null;
  if (unique.length >= 2) {
    const previous = unique[unique.length - 2], current = unique[unique.length - 1];
    const before = taskMap(previous), after = taskMap(current);
    const added = [], removed = [], changed = [];
    for (const [id, task] of after) {
      if (!before.has(id)) { added.push({ task_id: id, task }); continue; }
      const old = before.get(id);
      const fields = ["title", "priority", "due_at", "task_state", "depends_on_task_ids"];
      const changes = fields.filter(field => stable(old[field]) !== stable(task[field]))
        .map(field => ({ field, from: old[field], to: task[field] }));
      if (changes.length) changed.push({ task_id: id, changes });
    }
    for (const [id, task] of before) if (!after.has(id)) removed.push({ task_id: id, task });
    const previousOrder = previous.tasks.map(task => task.task_id);
    const currentOrder = current.tasks.map(task => task.task_id);
    const orderChanged = stable(previousOrder.filter(id => after.has(id))) !== stable(currentOrder.filter(id => before.has(id)));
    comparison = {
      from_revision_id: previous.revision_id, to_revision_id: current.revision_id,
      from_version: previous.version, to_version: current.version,
      change_reason: current.change_reason,
      added, removed, changed, orderChanged,
      diagnostics: { versionGap: current.version !== previous.version + 1, timestampOrderValid: Date.parse(current.created_at) > Date.parse(previous.created_at) }
    };
  }
  const latest = unique.length ? unique[unique.length - 1] : null;
  const eventIds = new Set(latest?.source_event_ids || []);
  const outcomes = [];
  const seenEvents = new Set();
  for (const event of progressEvents.slice(0, MAX_EVENTS)) {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        event.owner_uid !== ownerUid || event.actor_uid !== ownerUid ||
        event.explicit_confirmation !== true || !eventIds.has(clean(event.event_id, 120)) ||
        !VALID_STATES.has(String(event.progress_state || "").toLowerCase()) ||
        !time(event.occurred_at) || !latest?.tasks.some(task => task.task_id === clean(event.task_id, 120))) continue;
    const id = clean(event.event_id, 120);
    if (!id || seenEvents.has(id)) continue;
    seenEvents.add(id);
    outcomes.push({
      event_id: id, task_id: clean(event.task_id, 120),
      state: String(event.progress_state).toLowerCase(),
      occurred_at: new Date(time(event.occurred_at)).toISOString(),
      owner_confirmed: true
    });
  }
  outcomes.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id));
  return {
    revisions: unique,
    comparison,
    outcomes,
    diagnostics: {
      ownerScoped: true, revisionsInspected: inspected.length, revisionsAccepted: unique.length,
      revisionsRejected: rejected.length, rejectedRevisions: rejected.slice(0, maxRevisions),
      chronologyWarnings, advisoryOnly: true, recordsChanged: false,
      historyWritten: false, approvalRequired: true,
      outcomeEventsInspected: Math.min(progressEvents.length, MAX_EVENTS),
      outcomeEventsAccepted: outcomes.length
    }
  };
}
