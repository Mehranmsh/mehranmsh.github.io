import test from "node:test";
import assert from "node:assert/strict";
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
