import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIntelligenceAcceptanceCriteria, verifyIntelligenceObjective } from "./intelligence-objective-verification.mjs";

const tasks = [
  { taskId: "health", status: "completed", result_text: JSON.stringify({ type: "service_health_report", worker: "online", database: true }) },
  { taskId: "quality", status: "completed", result_text: JSON.stringify({ type: "repository_quality_check", openIssues: 0 }) }
];

test("objective completion requires explicit criteria backed by completed task evidence", () => {
  const criteria = [
    { id: "worker-online", description: "Worker is online", evidence: [{ taskId: "health", path: "worker", operator: "equals", expected: "online" }] },
    { id: "database-connected", description: "Database is connected", evidence: [{ taskId: "health", path: "database", operator: "equals", expected: true }] }
  ];
  assert.equal(verifyIntelligenceObjective(criteria, tasks).verified, true);
});

test("completed generic tasks do not prove an objective without acceptance criteria", () => {
  const result = verifyIntelligenceObjective([], tasks);
  assert.equal(result.verified, false);
  assert.equal(result.status, "attention_required");
  assert.equal(result.reason, "acceptance_criteria_required");
});

test("criteria remain unverified when task is completed but evidence does not match", () => {
  const result = verifyIntelligenceObjective([
    { id: "no-open-issues", description: "No open issues", evidence: [{ taskId: "quality", path: "openIssues", operator: "equals", expected: 0 }] }
  ], [{ ...tasks[1], result_text: JSON.stringify({ type: "repository_quality_check", openIssues: 2 }) }]);
  assert.equal(result.verified, false);
  assert.equal(result.status, "attention_required");
});

test("criteria cannot cite tasks outside the package or arbitrary paths", () => {
  assert.equal(normalizeIntelligenceAcceptanceCriteria([
    { id: "x", description: "x", evidence: [{ taskId: "other", path: "secret.token", operator: "exists" }] }
  ], tasks).valid, false);
});

test("all evidence checks must pass before an objective is completed", () => {
  const result = verifyIntelligenceObjective([
    { id: "health", description: "Health is good", evidence: [
      { taskId: "health", path: "worker", operator: "equals", expected: "online" },
      { taskId: "health", path: "database", operator: "equals", expected: false }
    ] }
  ], tasks);
  assert.equal(result.verified, false);
  assert.equal(result.criteria[0].verified, false);
});
