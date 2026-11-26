import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveIntelligenceTaskLane,
  canClaimIntelligenceTask
} from "./intelligence-queue-policy.mjs";

test("owner lane requires task and package owner identity to match", () => {
  const task = { queue_lane: "owner", owner_uid: "owner-A", assigned_to: "mehran_intelligence" };
  assert.equal(resolveIntelligenceTaskLane(task, "owner-A"), "owner");
  assert.equal(canClaimIntelligenceTask(task, { lane: "owner", ownerUid: "owner-A", packageOwnerUid: "owner-A" }), true);
  assert.equal(canClaimIntelligenceTask(task, { lane: "owner", ownerUid: "owner-B", packageOwnerUid: "owner-A" }), false);
  assert.equal(canClaimIntelligenceTask(task, { lane: "owner", ownerUid: "owner-A", packageOwnerUid: "owner-B" }), false);
});

test("shared lane cannot contain owner-scoped tasks", () => {
  const shared = { queue_lane: "shared", owner_uid: null, assigned_to: "shared" };
  assert.equal(resolveIntelligenceTaskLane(shared, null), "shared");
  assert.equal(canClaimIntelligenceTask(shared, { lane: "shared" }), true);
  assert.equal(canClaimIntelligenceTask(shared, { lane: "owner", ownerUid: "owner-A" }), false);
  assert.equal(resolveIntelligenceTaskLane({ ...shared, owner_uid: "owner-A" }, null), "quarantine");
});

test("legacy rows fail closed regardless of symbolic assignment", () => {
  for (const assigned_to of ["mehran_intelligence", "shared"]) {
    const legacy = { assigned_to, owner_uid: null };
    assert.equal(resolveIntelligenceTaskLane(legacy, "owner-A"), "quarantine");
    assert.equal(canClaimIntelligenceTask(legacy, { lane: "owner", ownerUid: "owner-A", packageOwnerUid: "owner-A" }), false);
    assert.equal(canClaimIntelligenceTask(legacy, { lane: "shared" }), false);
  }
});

test("unknown lanes, missing owners, and malformed tasks fail closed", () => {
  assert.equal(resolveIntelligenceTaskLane(null), "quarantine");
  assert.equal(resolveIntelligenceTaskLane({ queue_lane: "owner", owner_uid: "", assigned_to: "mehran_intelligence" }, "owner-A"), "quarantine");
  assert.equal(canClaimIntelligenceTask({ queue_lane: "mystery" }, { lane: "owner", ownerUid: "owner-A" }), false);
  assert.equal(canClaimIntelligenceTask({ queue_lane: "owner", owner_uid: "owner-A" }, { lane: "owner", ownerUid: "" , packageOwnerUid: "owner-A" }), false);
});

import { readFile } from "node:fs/promises";

test("D1 task schema adds explicit owner and quarantine-by-default lane", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  assert.match(worker, /ALTER TABLE intelligence_tasks ADD COLUMN owner_uid TEXT/);
  assert.match(worker, /ALTER TABLE intelligence_tasks ADD COLUMN queue_lane TEXT NOT NULL DEFAULT 'quarantine'/);
  assert.match(worker, /idx_intelligence_tasks_lane_queue ON intelligence_tasks\(queue_lane,status,priority,created_at\)/);
  assert.match(worker, /Existing rows remain quarantined/);
});
