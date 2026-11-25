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
  const options = { ownerUid: "owner-a", maxMemoryItems: 1, maxGraphNodes: 1, maxTasks: 1 };
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
