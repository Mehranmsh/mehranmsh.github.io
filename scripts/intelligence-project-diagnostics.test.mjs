import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseIntelligenceProjectState } from "./intelligence-project-diagnostics.mjs";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const record = (memory_key, extra = {}) => ({
  owner_uid: "owner-a", memory_key, memory_type: "project",
  content: "project context", source: "owner_confirmed",
  updated_at: new Date(NOW - 2 * 86_400_000).toISOString(), ...extra
});

test("reports stale records using explicit timestamps and configurable threshold", () => {
  const result = diagnoseIntelligenceProjectState([
    record("old", { updated_at: "2026-09-01T00:00:00.000Z" }),
    record("fresh")
  ], { ownerUid: "owner-a", now: NOW, staleAfterDays: 30 });
  assert.deepEqual(result.staleRecords.map(item => item.memory_key), ["old"]);
  assert.equal(result.staleRecords[0].advisory, "possibly_stale");
});

test("flags blocked dependencies only from explicit owner-scoped states", () => {
  const result = diagnoseIntelligenceProjectState([
    record("app", { depends_on_keys: ["api", "design", "unknown"] }),
    record("api", { project_state: "blocked" }),
    record("design", { project_state: "complete" }),
    record("foreign", { owner_uid: "owner-b", project_state: "blocked" })
  ], { ownerUid: "owner-a", now: NOW });
  assert.deepEqual(result.blockedProjects[0].blocked_by, [{ memory_key: "api", state: "blocked" }]);
  assert.deepEqual(result.unknownDependencyStates[0].dependencies, [
    { memory_key: "design", reason: "missing_or_out_of_scope" },
    { memory_key: "unknown", reason: "missing_or_out_of_scope" }
  ]);
});

test("does not treat unspecified dependency states as blocked", () => {
  const result = diagnoseIntelligenceProjectState([
    record("app", { depends_on_keys: ["api"] }), record("api")
  ], { ownerUid: "owner-a", now: NOW });
  assert.equal(result.blockedProjects.length, 0);
  assert.equal(result.unknownDependencyStates.length, 1);
});

test("filters other owners, deleted, inactive, and sensitive records", () => {
  const result = diagnoseIntelligenceProjectState([
    record("foreign", { owner_uid: "owner-b" }),
    record("deleted", { deleted_at: "2026-11-01T00:00:00Z" }),
    record("inactive", { status: "archived" }),
    record("secret", { sensitivity: "credential" })
  ], { ownerUid: "owner-a", now: NOW });
  assert.equal(result.diagnostics.inspectedRecords, 0);
});

test("reports missing project metadata without inventing a timestamp", () => {
  const result = diagnoseIntelligenceProjectState([
    record("missing", { updated_at: "not-a-date", source: "" })
  ], { ownerUid: "owner-a", now: NOW });
  assert.deepEqual(result.projectsMissingMetadata[0].missing, ["valid_updated_at", "source"]);
  assert.equal(result.staleRecords.length, 0);
});

test("is bounded, deterministic, and does not mutate input", () => {
  const input = [record("z"), record("b"), record("a")];
  const before = structuredClone(input);
  const first = diagnoseIntelligenceProjectState(input, { ownerUid: "owner-a", now: NOW, maxRecords: 2 });
  const second = diagnoseIntelligenceProjectState(input, { ownerUid: "owner-a", now: NOW, maxRecords: 2 });
  assert.deepEqual(first, second);
  assert.equal(first.diagnostics.inspectedRecords, 2);
  assert.equal(first.diagnostics.omittedRecords, 1);
  assert.deepEqual(input, before);
  assert.equal(first.diagnostics.advisoryOnly, true);
});

test("returns empty diagnostics without an owner scope", () => {
  const result = diagnoseIntelligenceProjectState([record("a")], { now: NOW });
  assert.equal(result.staleRecords.length, 0);
  assert.equal(result.diagnostics.advisoryOnly, true);
});
