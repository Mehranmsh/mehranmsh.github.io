import test from "node:test";
import assert from "node:assert/strict";
import {
  INTELLIGENCE_CAPABILITIES,
  INTELLIGENCE_ACTION_TYPES,
  PREAPPROVED_INTELLIGENCE_ACTION_TYPES,
  getIntelligenceCapability,
  validateIntelligenceCapabilityRequest
} from "./intelligence-capabilities.mjs";

test("executor routing matches the real Worker scheduler and GitHub Actions runner", () => {
  assert.deepEqual(INTELLIGENCE_ACTION_TYPES, [
    "service_health_report",
    "repository_quality_check",
    "source_security_audit"
  ]);
  assert.deepEqual(PREAPPROVED_INTELLIGENCE_ACTION_TYPES, [
    "project_status_report",
    "social_metrics_report",
    "service_health_report",
    "repository_quality_check",
    "source_security_audit"
  ]);

  const expectedExecutors = {
    project_status_report: "worker_scheduler",
    social_metrics_report: "worker_scheduler",
    service_health_report: "worker_scheduler_and_github_actions_runner",
    repository_quality_check: "worker_scheduler_and_github_actions_runner",
    source_security_audit: "github_actions_runner"
  };
  for (const [id, executor] of Object.entries(expectedExecutors)) {
    const item = getIntelligenceCapability(id);
    assert.equal(item.status, "active");
    assert.equal(item.permissionTier, "read_only");
    assert.equal(item.executor, executor);
    assert.equal(item.requiresApproval, false);
  }
});

test("runner capability validation accepts only actions routed to GitHub Actions", () => {
  for (const id of INTELLIGENCE_ACTION_TYPES) {
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).ok, true);
  }
  for (const id of ["project_status_report", "social_metrics_report"]) {
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).code, "capability_not_implemented");
  }
});

test("future self-improvement capabilities are explicitly planned, not executable", () => {
  for (const id of ["inspect_repository", "run_repository_tests", "propose_code_patch", "create_pull_request"]) {
    assert.equal(getIntelligenceCapability(id).status, "planned");
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).ok, false);
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).code, "capability_not_implemented");
  }
});

test("merge, deployment, secrets, wallet and arbitrary shell capabilities remain blocked", () => {
  for (const id of ["merge_pull_request", "deploy", "read_secrets", "wallet_operations", "arbitrary_shell"]) {
    assert.equal(getIntelligenceCapability(id).status, "blocked");
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).ok, false);
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).code, "capability_blocked");
  }
});

test("unknown capabilities and malformed inputs fail closed", () => {
  assert.equal(validateIntelligenceCapabilityRequest("unknown", {}).code, "unknown_capability");
  assert.equal(validateIntelligenceCapabilityRequest("project_status_report", null).code, "invalid_input");
  assert.equal(validateIntelligenceCapabilityRequest("project_status_report", { command: "echo unsafe" }).code, "unknown_input_field");
});

test("patch proposals enforce bounded typed inputs without applying changes", () => {
  const good = {
    summary: "Add a bounded validation helper for repository metadata",
    targetPaths: ["scripts/intelligence/example.mjs"],
    diff: "--- a/example\n+++ b/example\n@@ -1 +1 @@\n-old\n+new"
  };
  const schema = getIntelligenceCapability("propose_code_patch").inputSchema;
  assert.equal(schema.properties.summary.maxLength, 500);
  assert.equal(schema.properties.targetPaths.maxItems, 10);
  assert.equal(schema.properties.diff.maxLength, 20000);
  assert.equal(validateIntelligenceCapabilityRequest("propose_code_patch", good).code, "capability_not_implemented");
  assert.equal(getIntelligenceCapability("propose_code_patch").executor, "proposal_store");
});

test("PR creation schema requires a scoped proposal branch and immutable head SHA", () => {
  const capability = getIntelligenceCapability("create_pull_request");
  assert.equal(capability.inputSchema.properties.branch.pattern, "^intelligence/proposal-[a-f0-9-]{8,64}$");
  assert.equal(capability.inputSchema.properties.headSha.pattern, "^[a-f0-9]{40}$");
  assert.equal(capability.requiresApproval, true);
});
