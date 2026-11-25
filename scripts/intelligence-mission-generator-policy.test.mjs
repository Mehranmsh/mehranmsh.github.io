import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerSource = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
import {
  MISSION_GENERATOR_POLICY,
  getMissionGeneratorDecision,
  buildMissionGeneratorIdempotencyKey
} from "./intelligence-mission-generator-policy.mjs";

test("generator policy permits at most one mission per cycle", () => {
  assert.equal(MISSION_GENERATOR_POLICY.maxNewMissionsPerCycle, 1);
  assert.deepEqual(getMissionGeneratorDecision({ createdThisCycle: 1 }).reason, "cycle_limit_reached");
});

test("generator pauses when any nonterminal package is active", () => {
  const result = getMissionGeneratorDecision({
    packages: [{ id: "pkg-1", status: "queued" }, { id: "pkg-2", status: "completed" }]
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "active_work_package_exists");
  assert.deepEqual(result.activePackageIds, ["pkg-1"]);
});

test("completed, failed, and cancelled packages do not block a new cycle", () => {
  const result = getMissionGeneratorDecision({
    packages: ["completed", "failed", "cancelled"].map(status => ({ status }))
  });
  assert.equal(result.allowed, true);
});

test("invalid package input fails closed", () => {
  assert.equal(getMissionGeneratorDecision({ packages: null }).allowed, false);
  assert.equal(getMissionGeneratorDecision({ createdThisCycle: -1 }).allowed, false);
});

test("autonomous scope excludes every write-capable action", () => {
  assert.deepEqual(MISSION_GENERATOR_POLICY.allowedActions, [
    "service_health_report", "repository_quality_check", "source_security_audit", "inspect_repository"
  ]);
  assert.ok(MISSION_GENERATOR_POLICY.forbiddenActions.includes("deployment"));
  assert.ok(MISSION_GENERATOR_POLICY.forbiddenActions.includes("secret_access"));
  assert.ok(!MISSION_GENERATOR_POLICY.allowedActions.includes("propose_code_patch"));
});

test("idempotency key is stable inside a 15-minute UTC bucket", () => {
  const a = buildMissionGeneratorIdempotencyKey(new Date("2026-11-25T10:02:00.000Z"));
  const b = buildMissionGeneratorIdempotencyKey(new Date("2026-11-25T10:14:59.000Z"));
  const c = buildMissionGeneratorIdempotencyKey(new Date("2026-11-25T10:15:00.000Z"));
  assert.equal(a, b);
  assert.notEqual(b, c);
});

test("idempotency key rejects invalid intervals", () => {
  assert.throws(() => buildMissionGeneratorIdempotencyKey(new Date(), 0), TypeError);
});


test("Worker generator endpoint is owner-protected and accepts only a bounded UTC cycle key", () => {
  assert.ok(workerSource.includes('path === "/agent/v1/missions/generate" && method === "POST"'));
  assert.ok(workerSource.includes('missions/generate'));
  assert.ok(workerSource.includes("cycleKey, 32"));
  assert.ok(workerSource.includes(String.raw\`!/^\d{8}T\d{4}$/.test(cycleKey)\`));
  assert.ok(workerSource.includes(String.raw`Number(cycleMatch[5]) % 15 !== 0`));
  assert.ok(workerSource.includes("cycleKey)) return error"));
  assert.ok(workerSource.includes('const mission = "service health check, repository quality check, and source security audit"'));
  assert.ok(workerSource.includes("allowDeterministicFallback: false"));
  assert.ok(workerSource.includes("aiInferenceUsed: false"));
});

test("D1 reservation is serialized, leased, and prevents competing package inserts", () => {
  assert.ok(workerSource.includes("CREATE TABLE IF NOT EXISTS intelligence_mission_generator_lock"));
  assert.ok(workerSource.includes("CREATE TRIGGER IF NOT EXISTS intelligence_mission_generator_lock_guard"));
  assert.ok(workerSource.includes("CREATE TABLE IF NOT EXISTS intelligence_work_packages"));
  assert.ok(workerSource.indexOf("CREATE TABLE IF NOT EXISTS intelligence_work_packages") <
    workerSource.indexOf("CREATE TRIGGER IF NOT EXISTS intelligence_mission_generator_lock_guard"));
  assert.ok(workerSource.includes("BEFORE INSERT ON intelligence_work_packages"));
  assert.ok(workerSource.includes("package_id <> NEW.id"));
  assert.ok(workerSource.includes("expires_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"));
  assert.ok(workerSource.includes("datetime(expires_at) > datetime('now')"));
  assert.ok(workerSource.includes("datetime('now','+2 minutes')"));
  assert.ok(workerSource.includes("INSERT INTO intelligence_mission_generator_lock(id,cycle_key,package_id,status,expires_at,updated_at)"));
  assert.ok(workerSource.includes("WHERE status IN ('queued','in_progress','waiting_retry','attention_required')"));
  assert.ok(workerSource.includes("active_work_or_generator_reservation_exists"));
  assert.ok(workerSource.includes("finally {\n    if (generatorSlotReserved)"));
  assert.ok(workerSource.includes("releaseIntelligenceMissionGeneratorSlot(env, packageId)"));
});
