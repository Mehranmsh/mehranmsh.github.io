import test from "node:test";
import assert from "node:assert/strict";
import { buildIntelligenceContextSnapshot } from "./intelligence-context-orchestrator.mjs";

const base = (memory_key, extra={}) => ({
  owner_uid: "owner-a", memory_key, memory_type: "semantic", content: memory_key + " project context",
  source: "owner_confirmed", importance: 4, confidence: 1, updated_at: "2026-11-20T00:00:00.000Z",
  status: "active", ...extra
});

test("coordinates memory, graph, project diagnostics and task planning in one owner scope", () => {
  const records = [
    base("project_alpha", { category: "project", memory_type: "project", depends_on_keys: ["project_beta"], project_state: "active", relation_confirmed: true, relation_confirmed_by: "owner-a" }),
    base("project_beta", { category: "project", memory_type: "project", project_state: "blocked" }),
    base("task_build", { memory_type: "task", task_id: "task_build", task_state: "pending", title: "Build" }),
    base("task_ship", { memory_type: "task", task_id: "task_ship", task_state: "pending", title: "Ship", depends_on_task_ids: ["task_build"], dependencies_confirmed: true, dependencies_confirmed_by: "owner-a" }),
    base("foreign", { owner_uid: "owner-b" })
  ];
  const result = buildIntelligenceContextSnapshot(records, { ownerUid: "owner-a" });
  assert.equal(result.diagnostics.ownerScoped, true);
  assert.ok(result.graph.nodes.some(node => node.id === "project_alpha"));
  assert.equal(result.projectDiagnostics.blockedProjects[0].memory_key, "project_alpha");
  assert.deepEqual(result.executionPlan.orderedTasks.map(task => task.task_id), ["task_build", "task_ship"]);
  assert.equal(result.diagnostics.memoryChanged, false);
  assert.equal(result.diagnostics.executionPerformed, false);
  assert.equal(result.diagnostics.decisionMade, false);
});


test("coordinates authenticated goal decomposition and confirmed progress without mutation", () => {
  const records = [
    base("goal_launch", { memory_type: "goal", goal_id: "goal_launch", title: "Launch MEHRAN MSH" })
  ];
  const goalTaskProposals = [
    { owner_uid: "owner-a", goal_id: "goal_launch", task_id: "prepare", title: "Prepare release" }
  ];
  const progressEvents = [{
    owner_uid: "owner-a", actor_uid: "owner-a", explicit_confirmation: true,
    event_id: "progress-1", task_id: "prepare", progress_state: "failed",
    occurred_at: "2026-11-25T10:00:00.000Z"
  }];
  const result = buildIntelligenceContextSnapshot(records, {
    ownerUid: "owner-a", actorUid: "owner-a", goalTaskProposals, progressEvents
  });
  assert.equal(result.goalLifecycle.acceptedTaskProposals.length, 1);
  assert.equal(result.goalLifecycle.progress.taskStates[0].state, "failed");
  assert.ok(result.goalLifecycle.replanningSuggestions.some(item => item.reason === "owner_confirmed_failure"));
  assert.equal(result.goalLifecycle.diagnostics.tasksCreated, false);
  assert.equal(result.goalLifecycle.diagnostics.tasksExecuted, false);
});

test("excludes foreign and sensitive records before coordinating subsystems", () => {
  const records = [
    base("safe"),
    base("foreign", { owner_uid: "owner-b" }),
    base("private", { sensitivity: "wallet" }),
    base("deleted", { deleted_at: "2026-11-01T00:00:00Z" })
  ];
  const result = buildIntelligenceContextSnapshot(records, { ownerUid: "owner-a" });
  assert.deepEqual(result.memories.map(item => item.memory_key), ["safe"]);
  assert.deepEqual(result.graph.nodes.map(item => item.id), ["safe"]);
  assert.equal(result.diagnostics.inspectedOwnerRecords, 1);
});

test("exports approved preferences as read-only context, without applying them", () => {
  const ledger = [{
    record_type: "intelligence_preference_decision", decision_id: "d1", owner_uid: "owner-a",
    actor_uid: "owner-a", explicit_confirmation: true, decision: "accepted",
    recommendation: "increase_preference", target_key: "owner_work_style",
    proposal_key: JSON.stringify(["owner_work_style", "increase_preference"]),
    decided_at: "2026-11-20T00:00:00.000Z"
  }];
  const result = buildIntelligenceContextSnapshot([base("safe")], { ownerUid: "owner-a", preferenceLedger: ledger });
  assert.equal(result.preferenceProfile.approvedPreferences.length, 1);
  assert.equal(result.diagnostics.preferencesChanged, false);
  assert.equal(result.preferenceProfile.diagnostics.applied, false);
});

test("fails closed without owner scope and stays deterministic, bounded and read-only", () => {
  const records = [base("b"), base("a")], before = structuredClone(records);
  const missingOwner = buildIntelligenceContextSnapshot(records);
  assert.equal(missingOwner.diagnostics.ownerScoped, false);
  const options = { ownerUid: "owner-a", now: "2026-11-26T00:00:00.000Z", maxMemoryItems: 1, maxGraphNodes: 1, maxTasks: 1 };
  const first = buildIntelligenceContextSnapshot(records, options);
  const second = buildIntelligenceContextSnapshot(records, options);
  assert.deepEqual(first, second);
  assert.deepEqual(records, before);
  assert.ok(first.memories.length <= 1);
  assert.ok(first.graph.nodes.length <= 1);
  assert.equal(first.diagnostics.advisoryOnly, true);
});

test("enforces the serialized output budget even for dense owner records", () => {
  const records = Array.from({length: 80}, (_, index) =>
    base("memory_" + index, { content: "long context ".repeat(100) + index })
  );
  const result = buildIntelligenceContextSnapshot(records, {
    ownerUid: "owner-a", maxOutputChars: 512, maxMemoryItems: 50, maxMemoryChars: 20000,
    maxGraphNodes: 100, maxGraphEdges: 200
  });
  assert.ok(JSON.stringify(result).length <= 512);
  assert.equal(result.diagnostics.outputTrimmed, true);
});

test("clamps tiny requested output budgets to a safe metadata floor", () => {
  const result = buildIntelligenceContextSnapshot([], { ownerUid: "owner-a", maxOutputChars: 1 });
  assert.ok(JSON.stringify(result).length <= 512);
  assert.equal(result.diagnostics.ownerScoped, true);
});

test("evaluates alternatives only as advisory and applies approved overlays only with owner opt-in", () => {
  const ledger = [{
    record_type: "intelligence_preference_decision", decision_id: "d2", owner_uid: "owner-a",
    actor_uid: "owner-a", explicit_confirmation: true, decision: "accepted",
    recommendation: "increase_preference", target_key: "owner_work_style",
    proposal_key: JSON.stringify(["owner_work_style", "increase_preference"]),
    decided_at: "2026-11-20T00:00:00.000Z"
  }];
  const input = {
    ownerUid: "owner-a",
    preferenceLedger: ledger,
    decisionCriteria: [{ key: "owner_work_style", weight: 10, direction: "higher" }],
    decisionOptions: [{ id: "option-a", title: "Option A", scores: { owner_work_style: 4 } }]
  };
  const noOptIn = buildIntelligenceContextSnapshot([base("safe")], input);
  assert.equal(noOptIn.decisionEvaluation.diagnostics.preferencesApplied, false);
  const optedIn = buildIntelligenceContextSnapshot([base("safe")], {
    ...input, actorUid: "owner-a", allowApprovedPreferences: true
  });
  assert.equal(optedIn.decisionEvaluation.diagnostics.preferencesApplied, true);
  assert.equal(optedIn.decisionEvaluation.diagnostics.decisionMade, false);
  assert.equal(optedIn.diagnostics.decisionMade, false);
  const spoofed = buildIntelligenceContextSnapshot([base("safe")], {
    ...input, actorUid: "attacker", allowApprovedPreferences: true
  });
  assert.equal(spoofed.decisionEvaluation.diagnostics.preferencesApplied, false);
});

test("coordinates owner-authenticated plan history and keeps it read-only", () => {
  const revisions = [
    { owner_uid: "owner-a", revision_id: "r1", version: 1, created_at: "2026-11-20T10:00:00Z", change_reason: "initial", tasks: [{ task_id: "build", title: "Build" }] },
    { owner_uid: "owner-a", revision_id: "r2", version: 2, created_at: "2026-11-21T10:00:00Z", change_reason: "owner reprioritized", tasks: [{ task_id: "build", title: "Build", priority: "high" }] }
  ];
  const before = structuredClone(revisions);
  const result = buildIntelligenceContextSnapshot([base("safe")], {
    ownerUid: "owner-a", actorUid: "owner-a", planRevisions: revisions
  });
  assert.equal(result.planHistory.comparison.changed[0].task_id, "build");
  assert.equal(result.planHistory.comparison.change_reason, "owner reprioritized");
  assert.equal(result.planHistory.diagnostics.historyWritten, false);
  assert.equal(result.diagnostics.planHistoryRevisions, 2);
  assert.deepEqual(revisions, before);
});


test("coordinates plan outcome learning only from explicitly owner-confirmed observations", () => {
  const revisions = [
    { owner_uid: "owner-a", revision_id: "r1", version: 1, created_at: "2026-11-20T10:00:00Z", change_reason: "initial", tasks: [{ task_id: "build", title: "Build", priority: "normal" }] },
    { owner_uid: "owner-a", revision_id: "r2", version: 2, created_at: "2026-11-21T10:00:00Z", change_reason: "priority raised", tasks: [{ task_id: "build", title: "Build", priority: "high" }] },
    { owner_uid: "owner-a", revision_id: "r3", version: 3, created_at: "2026-11-22T10:00:00Z", change_reason: "priority lowered", tasks: [{ task_id: "build", title: "Build", priority: "low" }] },
    { owner_uid: "owner-a", revision_id: "r4", version: 4, created_at: "2026-11-23T10:00:00Z", change_reason: "priority raised again", tasks: [{ task_id: "build", title: "Build", priority: "high" }] }
  ];
  const planProgressEvents = [2, 3, 4].map((version, index) => ({
    owner_uid: "owner-a", actor_uid: "owner-a", explicit_confirmation: true,
    event_id: "event-" + version, revision_id: "r" + version, task_id: "build",
    progress_state: "completed", occurred_at: "2026-11-2" + (version + 2) + "T12:00:00Z"
  }));
  const result = buildIntelligenceContextSnapshot([base("safe")], {
    ownerUid: "owner-a", actorUid: "owner-a", planRevisions: revisions, planProgressEvents
  });
  const pattern = result.planLearning.patterns.find(item => item.signature === "priority_changed");
  assert.equal(pattern.status, "repeated_association");
  assert.equal(pattern.observations, 3);
  assert.equal(result.planLearning.diagnostics.causalClaims, false);
  assert.equal(result.planLearning.diagnostics.preferencesChanged, false);
  assert.equal(result.diagnostics.planLearningObservations, 3);
  const unauthenticated = buildIntelligenceContextSnapshot([base("safe")], {
    ownerUid: "owner-a", actorUid: "attacker", planRevisions: revisions, planProgressEvents
  });
  assert.equal(unauthenticated.planLearning.diagnostics.ownerScoped, false);
  assert.equal(unauthenticated.planLearning.observations.length, 0);
});


test("bounds raw context scans before owner filtering and reports omitted input", () => {
  const records = [
    base("safe-1"), base("safe-2"), base("safe-3"),
    base("safe-4"), base("safe-5")
  ];
  const before = structuredClone(records);
  const result = buildIntelligenceContextSnapshot(records, {
    ownerUid: "owner-a", maxInputRecords: 3
  });
  assert.equal(result.diagnostics.inputRecords, 5);
  assert.equal(result.diagnostics.inspectedInputRecords, 3);
  assert.equal(result.diagnostics.omittedInputRecords, 2);
  assert.deepEqual(result.memories.map(item => item.memory_key), ["safe-1", "safe-2", "safe-3"]);
  assert.deepEqual(records, before);
});

test("caps caller input-scan limits at the hard maximum", () => {
  const records = [base("safe")];
  const result = buildIntelligenceContextSnapshot(records, {
    ownerUid: "owner-a", maxInputRecords: 1000000
  });
  assert.equal(result.diagnostics.inspectedInputRecords, 1);
  assert.equal(result.diagnostics.omittedInputRecords, 0);
});


test("bounds every auxiliary input collection before subsystem processing", () => {
  const decisionCriteria = Array.from({length: 31}, (_, index) => ({
    key: "criterion_" + index, weight: 1, direction: "higher"
  }));
  const decisionOptions = Array.from({length: 55}, (_, index) => ({
    id: "option_" + index, scores: Object.fromEntries(decisionCriteria.map(item => [item.key, 3]))
  }));
  const result = buildIntelligenceContextSnapshot([base("safe")], {
    ownerUid: "owner-a",
    actorUid: "owner-a",
    preferenceLedger: Array.from({length: 1002}, (_, index) => ({ decision_id: "invalid-" + index })),
    decisionOptions,
    decisionCriteria,
    goalTaskProposals: Array.from({length: 105}, (_, index) => ({ task_id: "proposal-" + index })),
    progressEvents: Array.from({length: 501}, (_, index) => ({ event_id: "progress-" + index })),
    planRevisions: Array.from({length: 52}, (_, index) => ({ revision_id: "revision-" + index })),
    planProgressEvents: Array.from({length: 505}, (_, index) => ({ event_id: "event-" + index }))
  });

  assert.deepEqual(result.diagnostics.auxiliaryInputBounds, {
    preferenceLedgerOmitted: 2,
    decisionOptionsOmitted: 5,
    decisionCriteriaOmitted: 1,
    goalTaskProposalsOmitted: 5,
    progressEventsOmitted: 1,
    planRevisionsOmitted: 2,
    planProgressEventsOmitted: 5
  });
  assert.equal(result.decisionEvaluation.diagnostics.inspectedOptions, 50);
  assert.equal(result.decisionEvaluation.diagnostics.criteriaUsed, 30);
  assert.equal(result.planHistory.diagnostics.revisionsInspected, 50);
  assert.equal(result.planLearning.diagnostics.revisionsInspected, 50);
  assert.equal(result.planLearning.diagnostics.eventsInspected, 500);
});
