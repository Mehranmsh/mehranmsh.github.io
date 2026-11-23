import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INTELLIGENCE_CAPABILITIES,
  INTELLIGENCE_ACTION_TYPES,
  PREAPPROVED_INTELLIGENCE_ACTION_TYPES,
  getIntelligenceCapability,
  validateIntelligenceCapabilityRequest
} from "./intelligence-capabilities.mjs";

const workerSource = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const runnerSource = readFileSync(new URL("../.github/workflows/mehran-intelligence-runner.yml", import.meta.url), "utf8");
const scheduledStart = workerSource.indexOf("async scheduled(controller, env, ctx)");
const scheduledEnd = workerSource.indexOf("async fetch(request, env)", scheduledStart);
assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart, "Worker scheduled handler must be locatable");
const workerSchedulerSource = workerSource.slice(scheduledStart, scheduledEnd);

test("all six active read-only capabilities are registered independent of executor type", () => {
  const expected = [
    "project_status_report",
    "social_metrics_report",
    "service_health_report",
    "repository_quality_check",
    "source_security_audit",
    "inspect_repository"
  ];
  assert.deepEqual(INTELLIGENCE_ACTION_TYPES, expected);
  assert.deepEqual(PREAPPROVED_INTELLIGENCE_ACTION_TYPES, expected);
  for (const id of expected) {
    const item = getIntelligenceCapability(id);
    assert.equal(item.status, "active");
    assert.equal(item.permissionTier, "read_only");
    assert.equal(item.requiresApproval, false);
    assert.ok(Object.isFrozen(item.executors));
    const input = id === "inspect_repository" ? { paths: ["worker.js"] } : {};
    assert.equal(validateIntelligenceCapabilityRequest(id, input).ok, true);
  }
});

test("executor metadata matches the actual Worker and GitHub Actions routing", () => {
  const expected = {
    project_status_report: ["cloudflare_worker_scheduler"],
    social_metrics_report: ["cloudflare_worker_scheduler"],
    service_health_report: ["cloudflare_worker_scheduler", "github_actions_runner"],
    repository_quality_check: ["cloudflare_worker_scheduler", "github_actions_runner"],
    source_security_audit: ["github_actions_runner"],
    inspect_repository: ["github_actions_runner"]
  };
  for (const [id, executors] of Object.entries(expected)) {
    assert.deepEqual(getIntelligenceCapability(id).executors, executors, id);
  }

  assert.match(workerSchedulerSource, /action_type IN \('project_status_report','social_metrics_report'\)/);
  assert.match(workerSchedulerSource, /action_type IN \('service_health_report','repository_quality_check'\)/);
  assert.doesNotMatch(workerSchedulerSource, /source_security_audit|inspect_repository/);
  assert.match(workerSource, /action_type IN \('repository_quality_check','service_health_report','source_security_audit','inspect_repository'\)/);
  assert.match(runnerSource, /if \(task\.actionType === "inspect_repository"\)/);

  const runnerActions = runnerSource.match(/const capabilityActions = \[([^\]]+)\]/);
  assert.ok(runnerActions, "GitHub runner must declare its action allowlist");
  assert.deepEqual(
    [...runnerActions[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1]),
    ["service_health_report", "repository_quality_check", "source_security_audit", "inspect_repository"]
  );
});

test("future self-improvement capabilities remain planned and non-executable", () => {
  for (const id of ["run_repository_tests", "propose_code_patch", "create_pull_request"]) {
    assert.equal(getIntelligenceCapability(id).status, "planned");
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).ok, false);
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).code, "capability_not_implemented");
    assert.ok(getIntelligenceCapability(id).executors.length > 0);
  }
});

test("merge, deployment, secrets, wallet and arbitrary shell capabilities remain blocked", () => {
  for (const id of ["merge_pull_request", "deploy", "read_secrets", "wallet_operations", "arbitrary_shell"]) {
    assert.equal(getIntelligenceCapability(id).status, "blocked");
    assert.deepEqual(getIntelligenceCapability(id).executors, []);
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
  assert.equal(getIntelligenceCapability("propose_code_patch").requiresApproval, false);
  assert.equal(getIntelligenceCapability("propose_code_patch").autonomous, true);
  assert.equal(validateIntelligenceCapabilityRequest("propose_code_patch", good).code, "capability_not_implemented");
  assert.deepEqual(getIntelligenceCapability("propose_code_patch").executors, ["proposal_store"]);
});

test("PR creation schema requires a scoped proposal branch and immutable head SHA", () => {
  const capability = getIntelligenceCapability("create_pull_request");
  assert.equal(capability.inputSchema.properties.branch.pattern, "^intelligence/proposal-[a-f0-9-]{8,64}$");
  assert.equal(capability.inputSchema.properties.headSha.pattern, "^[a-f0-9]{40}$");
  assert.equal(capability.requiresApproval, false);
  assert.equal(capability.autonomous, true);
});


// Autonomous metadata is policy only; planned capabilities remain non-executable until an executor ships.
test("safe self-improvement work is pre-authorized without activating missing executors", () => {
  for (const id of ["run_repository_tests", "propose_code_patch", "create_pull_request"]) {
    const capability = getIntelligenceCapability(id);
    assert.equal(capability.requiresApproval, false, id);
    assert.equal(capability.autonomous, true, id);
    assert.equal(capability.status, "planned", id);
    assert.equal(validateIntelligenceCapabilityRequest(id, {}).code, "capability_not_implemented", id);
  }
  for (const id of ["merge_pull_request", "deploy", "read_secrets", "wallet_operations", "arbitrary_shell"]) {
    assert.equal(getIntelligenceCapability(id).requiresApproval, true, id);
    assert.equal(getIntelligenceCapability(id).autonomous, undefined, id);
  }
});

test("repository inspection is active, pre-authorized, exact-path allowlisted, and read-only", () => {
  const capability = getIntelligenceCapability("inspect_repository");
  assert.equal(capability.status, "active");
  assert.equal(capability.permissionTier, "read_only");
  assert.equal(capability.requiresApproval, false);
  assert.equal(capability.autonomous, true);
  assert.deepEqual(capability.executors, ["github_actions_runner"]);
  assert.equal(validateIntelligenceCapabilityRequest("inspect_repository", {
    paths: ["worker.js", "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"]
  }).ok, true);
  assert.equal(validateIntelligenceCapabilityRequest("inspect_repository", { paths: ["../../secrets"] }).ok, false);
  assert.equal(validateIntelligenceCapabilityRequest("inspect_repository", { paths: [] }).ok, false);
  assert.equal(validateIntelligenceCapabilityRequest("inspect_repository", {
    paths: ["worker.js", "worker.js"]
  }).ok, false);
});

test("private runner seeds one idempotent, bounded repository inspection task", () => {
  assert.match(runnerSource, /request\("\/agent\/v1\/work-packages"/);
  assert.match(runnerSource, /mehran-intelligence-repo-inspection-v1-/);
  assert.match(runnerSource, /actionType: "inspect_repository"/);
  assert.match(runnerSource, /"scripts\/intelligence-agent\.mjs"/);
  assert.match(runnerSource, /"docs\/INTELLIGENCE_EXECUTION_PROTOCOL\.md"/);
  assert.doesNotMatch(runnerSource, /mehran-intelligence-owner-mission-v1-/);
  assert.match(runnerSource, /Inspection exceeded the 750 KB aggregate source limit\./);
});


const isolatedTestWorkflowSource = readFileSync(
  new URL("../.github/workflows/mehran-intelligence-tests.yml", import.meta.url),
  "utf8"
);

test("isolated test workflow runs one fixed suite without secrets or network access", () => {
  assert.match(isolatedTestWorkflowSource, /workflow_dispatch:/);
  assert.match(isolatedTestWorkflowSource, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(isolatedTestWorkflowSource, /persist-credentials:\s*false/);
  assert.match(isolatedTestWorkflowSource, /git merge-base --is-ancestor/);
  assert.match(isolatedTestWorkflowSource, /--network none/);
  assert.match(isolatedTestWorkflowSource, /--read-only/);
  assert.match(isolatedTestWorkflowSource, /--cap-drop ALL/);
  assert.match(isolatedTestWorkflowSource, /--security-opt no-new-privileges/);
  assert.match(isolatedTestWorkflowSource, /--pids-limit 64/);
  assert.match(isolatedTestWorkflowSource, /--memory 768m/);
  assert.match(isolatedTestWorkflowSource, /--cpus 1/);
  assert.match(isolatedTestWorkflowSource, /--tmpfs \/tmp:rw,noexec,nosuid,nodev,size=64m/);
  assert.match(isolatedTestWorkflowSource, /dst=\/workspace,readonly/);
  assert.match(isolatedTestWorkflowSource, /node --test scripts\/intelligence-capabilities\.test\.mjs/);
  assert.doesNotMatch(isolatedTestWorkflowSource, /secrets\.|GITHUB_TOKEN|MEHRAN_AGENT_TOKEN|MEHRAN_ORCHESTRATOR_TOKEN|actions:\s*write/);
  assert.doesNotMatch(isolatedTestWorkflowSource, /npm\s+(?:install|run)|pnpm\s+(?:install|run)|yarn\s+(?:install|run)/);

  assert.doesNotMatch(
    readFileSync(new URL("./intelligence-capabilities.test.mjs", import.meta.url), "utf8"),
    /node:child_process|node:net|node:http|node:https|node:worker_threads|spawnSync|execFile|process\.env|fetch\(/
  );
});
