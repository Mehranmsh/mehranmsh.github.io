import test from "node:test";
import assert from "node:assert/strict";
import { buildIntelligenceGoalLifecycle } from "./intelligence-goal-lifecycle.mjs";

const goal = (goal_id = "goal-a", extra = {}) => ({
  owner_uid: "owner-a", memory_type: "goal", goal_id, title: "Ship the platform", ...extra
});
const task = (task_id, extra = {}) => ({
  owner_uid: "owner-a", goal_id: "goal-a", task_id, title: task_id, ...extra
});
const event = (event_id, task_id, progress_state, extra = {}) => ({
  owner_uid: "owner-a", actor_uid: "owner-a", explicit_confirmation: true,
  event_id, task_id, progress_state, occurred_at: "2026-11-25T10:00:00.000Z", ...extra
});

test("validates task proposals against an owner-scoped goal and rejects duplicates", () => {
  const result = buildIntelligenceGoalLifecycle([goal()], [
    task("design"), task("design"), task("foreign", { owner_uid: "owner-b" }),
    task("orphan", { goal_id: "other" }), task("no-title", { title: "" })
  ], [], { ownerUid: "owner-a", actorUid: "owner-a" });
  assert.deepEqual(result.acceptedTaskProposals.map(item => item.task_id), ["design"]);
  assert.deepEqual(result.rejectedTaskProposals.map(item => item.reason), [
    "duplicate_task_id", "owner_scope_mismatch", "goal_missing_or_out_of_scope", "task_title_required"
  ]);
  assert.equal(result.diagnostics.tasksCreated, false);
});

test("uses only explicitly owner-confirmed progress and latest valid event per task", () => {
  const result = buildIntelligenceGoalLifecycle([goal()], [task("build")], [
    event("e1", "build", "in_progress"),
    event("e2", "build", "completed", { occurred_at: "2026-11-25T12:00:00.000Z" }),
    event("spoof", "build", "failed", { actor_uid: "owner-b", occurred_at: "2026-11-25T13:00:00.000Z" }),
    event("implicit", "build", "failed", { explicit_confirmation: false, occurred_at: "2026-11-25T14:00:00.000Z" })
  ], { ownerUid: "owner-a", actorUid: "owner-a" });
  assert.equal(result.progress.acceptedEvents, 2);
  assert.equal(result.progress.taskStates[0].state, "completed");
  assert.equal(result.progress.ignoredEvents, 2);
});

test("creates advisory replanning suggestions after an owner-confirmed failure", () => {
  const result = buildIntelligenceGoalLifecycle([goal()], [
    task("research"), task("build", { depends_on_task_ids: ["research"], dependencies_confirmed: true, dependencies_confirmed_by: "owner-a" })
  ], [event("fail-1", "research", "failed")], { ownerUid: "owner-a", actorUid: "owner-a" });
  assert.ok(result.replanningSuggestions.some(item => item.task_id === "research" && item.reason === "owner_confirmed_failure"));
  assert.equal(result.diagnostics.recordsChanged, false);
  assert.equal(result.diagnostics.tasksExecuted, false);
  assert.equal(result.diagnostics.approvalRequired, true);
});

test("does not trust unconfirmed dependencies or cross-owner goals", () => {
  const result = buildIntelligenceGoalLifecycle([goal("goal-a"), goal("goal-b", { owner_uid: "owner-b" })], [
    task("publish", { depends_on_task_ids: ["test"] }), task("test")
  ], [], { ownerUid: "owner-a", actorUid: "owner-a" });
  const plan = result.executionPlans.find(item => item.goal_id === "goal-a");
  assert.equal(plan.orderedTasks.length, 2);
  assert.equal(plan.unresolvedTasks[0].reason, "dependencies_not_owner_confirmed");
  assert.equal(result.goals.some(item => item.goal_id === "goal-b"), false);
});

test("is deterministic, bounded, and leaves all input records unchanged", () => {
  const records = [goal()];
  const proposals = [task("a"), task("b")];
  const events = [event("done", "a", "completed")];
  const before = structuredClone({ records, proposals, events });
  const options = { ownerUid: "owner-a", maxItems: 1 };
  const first = buildIntelligenceGoalLifecycle(records, proposals, events, options);
  const second = buildIntelligenceGoalLifecycle(records, proposals, events, options);
  assert.deepEqual(first, second);
  assert.deepEqual({ records, proposals, events }, before);
  assert.equal(first.acceptedTaskProposals.length, 1);
  assert.equal(first.diagnostics.advisoryOnly, true);
});

test("fails closed without owner scope or required input arrays", () => {
  const result = buildIntelligenceGoalLifecycle([goal()], [task("a")], [], {});
  assert.equal(result.diagnostics.ownerScoped, false);
  assert.equal(result.acceptedTaskProposals.length, 0);
  assert.equal(result.diagnostics.tasksExecuted, false);
});
