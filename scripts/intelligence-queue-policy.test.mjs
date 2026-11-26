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

test("new owner-created tasks persist the authenticated orchestration principal", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  assert.match(worker, /action_payload,owner_uid,queue_lane\) VALUES\(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/);
  assert.match(worker, /assignedTo==="mehran_intelligence"\?"mehran_owner_orchestrator":null/);
  assert.match(worker, /assignedTo==="mehran_intelligence"\?"owner":assignedTo==="shared"\?"shared":"quarantine"/);
  assert.match(worker, /typeof input\.ownerUid === "string" && input\.ownerUid\.trim\(\) \? input\.ownerUid\.trim\(\) : null/);
  assert.match(worker, /packageOwnerUid \? "owner" : "quarantine"/);
});


test("owner and shared task APIs are authenticated and lane-isolated end to end", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../.github/workflows/mehran-intelligence-runner.yml", import.meta.url), "utf8");
  assert.match(worker, /path === "\/agent\/v1\/owner\/tasks\/next"[\s\S]*?MEHRAN_ORCHESTRATOR_TOKEN/);
  assert.match(worker, /queue_lane='owner' AND owner_uid='mehran_owner_orchestrator'/);
  assert.match(worker, /queue_lane='shared' AND owner_uid IS NULL/);
  assert.match(worker, /const taskRouteLane = path\.startsWith\("\/agent\/v1\/owner\/tasks\/"\) \? "owner" : "shared"/);
  assert.match(runner, /request\("\/agent\/v1\/owner\/tasks\/next", \{\}, ownerHeaders\)/);
  assert.match(runner, /\/agent\/v1\/owner\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/checkpoint/);
  assert.match(runner, /\/agent\/v1\/owner\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/result/);
  assert.match(runner, /task\.queueLane !== "owner"/);
  assert.doesNotMatch(runner, /request\("\/agent\/v1\/tasks\/next"/);
});

test("owner work packages use the dedicated orchestration principal", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  assert.match(worker, /const packageOwnerPrincipal = "mehran_owner_orchestrator"/);
  assert.match(worker, /scope_json,priority,status,created_by,owner_uid\) VALUES/);
  assert.match(worker, /work_package_id,max_attempts,owner_uid,queue_lane\).*'owner'/);
});


test("shared runner uses only the shared bearer and an isolated execution slot", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../scripts/intelligence-agent.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/mehran-intelligence-shared-runner.yml", import.meta.url), "utf8");
  assert.match(worker, /: "action_type IN \('repository_quality_check','service_health_report'\)"/);
  assert.match(runner, /task\.assignedTo !== "shared" \|\| task\.queueLane !== "shared"/);
  assert.match(runner, /PATH: process\.env\.PATH/);
  assert.match(runner, /env: childEnv/);
  assert.match(workflow, /MEHRAN_AGENT_TOKEN: \$\{\{ secrets\.MEHRAN_AGENT_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /MEHRAN_ORCHESTRATOR_TOKEN|MEHRAN_REPORTS_GITHUB_TOKEN/);
  assert.match(workflow, /group: mehran-intelligence-shared-runner\n/);
  const ownerWorkflow = await readFile(new URL("../.github/workflows/mehran-intelligence-runner.yml", import.meta.url), "utf8");
  assert.match(ownerWorkflow, /group: mehran-intelligence-owner-runner\n/);
  assert.doesNotMatch(ownerWorkflow, /group: mehran-intelligence-shared-runner/);
});
