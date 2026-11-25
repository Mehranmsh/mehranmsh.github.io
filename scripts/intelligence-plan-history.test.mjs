import test from "node:test";
import assert from "node:assert/strict";
import { compareIntelligencePlanVersions } from "./intelligence-plan-history.mjs";

const revision = (version, tasks, extra = {}) => ({
  owner_uid: "owner-a", revision_id: "rev-" + version, version,
  created_at: `2026-11-${String(20 + version).padStart(2, "0")}T10:00:00.000Z`,
  change_reason: version === 1 ? "initial plan" : "owner requested adjustment",
  tasks, ...extra
});
const task = (task_id, extra = {}) => ({ task_id, title: task_id, priority: "medium", due_at: "", depends_on_task_ids: [], task_state: "pending", ...extra });
const options = { ownerUid: "owner-a", actorUid: "owner-a" };

test("compares task additions, removals, field changes and ordering", () => {
  const result = compareIntelligencePlanVersions([
    revision(1, [task("a"), task("b")]),
    revision(2, [task("b", { priority: "high" }), task("c")])
  ], [], options);
  assert.deepEqual(result.comparison.added.map(x => x.task_id), ["c"]);
  assert.deepEqual(result.comparison.removed.map(x => x.task_id), ["a"]);
  assert.equal(result.comparison.changed[0].task_id, "b");
  assert.equal(result.comparison.orderChanged, true);
  assert.equal(result.comparison.change_reason, "owner requested adjustment");
});

test("fails closed without matching authenticated owner context", () => {
  const result = compareIntelligencePlanVersions([revision(1, [task("a")])], [], { ownerUid: "owner-a", actorUid: "attacker" });
  assert.equal(result.diagnostics.ownerScoped, false);
  assert.equal(result.revisions.length, 0);
});

test("rejects cross-owner revisions and malformed or reasonless revisions", () => {
  const result = compareIntelligencePlanVersions([
    revision(1, [task("a")]),
    revision(2, [task("b")], { owner_uid: "owner-b" }),
    revision(3, [task("c")], { change_reason: "" })
  ], [], options);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.diagnostics.revisionsRejected, 2);
});

test("reports version gaps, duplicate versions and non-increasing timestamps", () => {
  const result = compareIntelligencePlanVersions([
    revision(1, [task("a")]),
    revision(3, [task("b")], { created_at: "2026-11-20T09:00:00.000Z" }),
    revision(3, [task("c")], { revision_id: "duplicate-version" })
  ], [], options);
  assert.equal(result.revisions.length, 2);
  assert.ok(result.diagnostics.chronologyWarnings.some(x => x.reason === "version_gap"));
  assert.ok(result.diagnostics.chronologyWarnings.some(x => x.reason === "non_increasing_timestamp"));
  assert.ok(result.diagnostics.rejectedRevisions.some(x => x.reason === "duplicate_revision_or_version"));
});

test("uses only owner-confirmed progress events explicitly linked to latest revision", () => {
  const revisions = [
    revision(1, [task("a")]),
    revision(2, [task("a")], { source_event_ids: ["accepted-1"] })
  ];
  const events = [
    { owner_uid: "owner-a", actor_uid: "owner-a", explicit_confirmation: true, event_id: "accepted-1", task_id: "a", progress_state: "completed", occurred_at: "2026-11-25T12:00:00Z" },
    { owner_uid: "owner-a", actor_uid: "owner-b", explicit_confirmation: true, event_id: "spoof", task_id: "a", progress_state: "failed", occurred_at: "2026-11-25T12:01:00Z" },
    { owner_uid: "owner-a", actor_uid: "owner-a", explicit_confirmation: false, event_id: "implicit", task_id: "a", progress_state: "failed", occurred_at: "2026-11-25T12:02:00Z" },
    { owner_uid: "owner-a", actor_uid: "owner-a", explicit_confirmation: true, event_id: "unlinked", task_id: "a", progress_state: "failed", occurred_at: "2026-11-25T12:03:00Z" }
  ];
  const result = compareIntelligencePlanVersions(revisions, events, options);
  assert.deepEqual(result.outcomes.map(x => x.event_id), ["accepted-1"]);
  assert.equal(result.outcomes[0].state, "completed");
});

test("is deterministic, bounded and does not mutate supplied history", () => {
  const history = [revision(1, [task("a")]), revision(2, [task("a", { title: "updated" })])];
  const before = structuredClone(history);
  const first = compareIntelligencePlanVersions(history, [], { ...options, maxRevisions: 1 });
  const second = compareIntelligencePlanVersions(history, [], { ...options, maxRevisions: 1 });
  assert.deepEqual(first, second);
  assert.deepEqual(history, before);
  assert.equal(first.revisions.length, 1);
  assert.equal(first.diagnostics.historyWritten, false);
});

test("rejects duplicate task identifiers within a revision", () => {
  const result = compareIntelligencePlanVersions([revision(1, [task("a"), task("a")])], [], options);
  assert.equal(result.revisions.length, 0);
  assert.equal(result.diagnostics.rejectedRevisions[0].reason, "invalid_or_duplicate_task");
});
