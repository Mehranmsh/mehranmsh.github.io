const planLearningMAX_REVISIONS = 50;
const planLearningMAX_EVENTS = 500;
const planLearningMAX_PATTERNS = 40;
const planLearningVALID_STATES = new Set(["completed", "failed", "blocked"]);
const planLearningSENSITIVE = new Set(["secret", "credential", "wallet", "financial", "private_social", "health", "identity"]);
const planLearningClean = (value, limit = 160) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const planLearningParseTime = value => {
  if (typeof value !== "string" || !value.trim()) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
};
const planLearningSafePriority = value => ["low", "normal", "medium", "high"].includes(String(value || "").toLowerCase())
  ? String(value).toLowerCase() : "unspecified";
const planLearningSignatureFor = (before, after) => {
  if (!before) return "task_added";
  const changes = [];
  if (planLearningSafePriority(before.priority) !== planLearningSafePriority(after.priority)) changes.push("priority_changed");
  if (planLearningClean(before.due_at, 40) !== planLearningClean(after.due_at, 40)) changes.push("due_date_changed");
  const oldDeps = Array.isArray(before.depends_on_task_ids) ? [...before.depends_on_task_ids].map(String).sort() : [];
  const newDeps = Array.isArray(after.depends_on_task_ids) ? [...after.depends_on_task_ids].map(String).sort() : [];
  if (JSON.stringify(oldDeps) !== JSON.stringify(newDeps)) changes.push("dependencies_changed");
  if (planLearningClean(before.title, 200) !== planLearningClean(after.title, 200)) changes.push("title_changed");
  return changes.length ? changes.sort().join("+") : "unchanged";
};

/**
 * Summarize repeated associations between plan-change signatures and explicitly
 * owner-confirmed outcomes. These are observations, not causal findings.
 * No memory, preferences, plans, or source records are changed.
 */
export function learnFromIntelligencePlanOutcomes(revisions, progressEvents, options = {}) {
  const ownerUid = planLearningClean(options.ownerUid, 256);
  const actorUid = planLearningClean(options.actorUid, 256);
  const empty = {
    patterns: [], observations: [],
    diagnostics: { ownerScoped: false, advisoryOnly: true, causalClaims: false,
      recordsChanged: false, preferencesChanged: false, approvalRequired: true }
  };
  if (!ownerUid || actorUid !== ownerUid || !Array.isArray(revisions) || !Array.isArray(progressEvents)) return empty;
  const minObservations = Number.isInteger(options.minObservations) && options.minObservations >= 2
    ? Math.min(options.minObservations, 20) : 3;
  const maxRevisions = Number.isInteger(options.maxRevisions) && options.maxRevisions > 0
    ? Math.min(options.maxRevisions, planLearningMAX_REVISIONS) : 20;
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0
    ? Math.min(options.maxEvents, planLearningMAX_EVENTS) : planLearningMAX_EVENTS;
  const acceptedRevisions = revisions.slice(0, maxRevisions)
    .filter(item => item && item.owner_uid === ownerUid && Number.isInteger(item.version) &&
      item.version > 0 && planLearningParseTime(item.created_at) !== null && Array.isArray(item.tasks))
    .sort((a, b) => a.version - b.version || planLearningClean(a.revision_id).localeCompare(planLearningClean(b.revision_id)));
  const uniqueRevisions = [];
  const versions = new Set(), revisionIds = new Set();
  for (const revision of acceptedRevisions) {
    const id = planLearningClean(revision.revision_id, 120);
    if (!id || versions.has(revision.version) || revisionIds.has(id)) continue;
    versions.add(revision.version); revisionIds.add(id); uniqueRevisions.push(revision);
  }
  const latestEvents = new Map();
  for (const event of progressEvents.slice(0, maxEvents)) {
    if (!event || event.owner_uid !== ownerUid || event.actor_uid !== ownerUid ||
        event.explicit_confirmation !== true || !planLearningVALID_STATES.has(String(event.progress_state || "").toLowerCase())) continue;
    const eventId = planLearningClean(event.event_id, 120), revisionId = planLearningClean(event.revision_id, 120);
    const taskId = planLearningClean(event.task_id, 120), occurred = planLearningParseTime(event.occurred_at);
    if (!eventId || !revisionId || !taskId || occurred === null) continue;
    const key = revisionId + "\u0000" + taskId;
    const prior = latestEvents.get(key);
    if (!prior || occurred > prior.time || (occurred === prior.time && eventId > prior.event_id)) {
      latestEvents.set(key, { event_id: eventId, revision_id: revisionId, task_id: taskId,
        state: String(event.progress_state).toLowerCase(), occurred_at: new Date(occurred).toISOString(), time: occurred });
    }
  }
  const counts = new Map();
  const observations = [];
  for (let index = 0; index < uniqueRevisions.length; index++) {
    const revision = uniqueRevisions[index];
    const previous = index ? uniqueRevisions[index - 1] : null;
    const before = new Map((previous?.tasks || []).filter(task => task && typeof task === "object")
      .map(task => [planLearningClean(task.task_id, 120), task]));
    for (const task of revision.tasks.slice(0, 200)) {
      if (!task || typeof task !== "object" || planLearningSENSITIVE.has(String(task.sensitivity || "").toLowerCase())) continue;
      const taskId = planLearningClean(task.task_id, 120);
      if (!taskId) continue;
      const outcome = latestEvents.get(revision.revision_id + "\u0000" + taskId);
      if (!outcome) continue;
      const signature = planLearningSignatureFor(before.get(taskId), task);
      const item = { signature, outcome: outcome.state, revision_version: revision.version,
        task_id: taskId, event_id: outcome.event_id, occurred_at: outcome.occurred_at };
      observations.push(item);
      const key = signature + "\u0000" + outcome.state;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const totals = new Map();
  for (const [key, count] of counts) {
    const signature = key.split("\u0000")[0];
    totals.set(signature, (totals.get(signature) || 0) + count);
  }
  const patterns = [];
  for (const [signature, total] of [...totals].sort((a, b) => a[0].localeCompare(b[0])).slice(0, planLearningMAX_PATTERNS)) {
    const outcomes = ["completed", "failed", "blocked"].map(state => ({
      state, count: counts.get(signature + "\u0000" + state) || 0
    }));
    const dominant = [...outcomes].sort((a, b) => b.count - a.count || a.state.localeCompare(b.state))[0];
    const confidence = total ? dominant.count / total : 0;
    patterns.push({
      signature, observations: total, outcomes,
      status: total < minObservations ? "insufficient_observations" :
        confidence >= 0.67 ? "repeated_association" : "mixed_outcomes",
      note: total < minObservations
        ? "Not enough owner-confirmed observations to suggest a pattern."
        : confidence >= 0.67
          ? "A repeated association was observed; this does not establish causation."
          : "Observed outcomes are mixed; no directional suggestion is supported."
    });
  }
  observations.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id));
  return {
    patterns, observations: observations.slice(-100),
    diagnostics: {
      ownerScoped: true, revisionsInspected: Math.min(revisions.length, maxRevisions),
      revisionsAccepted: uniqueRevisions.length, eventsInspected: Math.min(progressEvents.length, maxEvents),
      observationsAccepted: observations.length, minObservations,
      advisoryOnly: true, causalClaims: false, recordsChanged: false,
      preferencesChanged: false, approvalRequired: true
    }
  };
}
