import test from "node:test";
import { applyValidatedPatchInMemory } from "./intelligence-patch-apply.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePatchProposal, PATCH_PROPOSAL_POLICY } from "./intelligence-patch-policy.mjs";
import { createPatchArtifactRecord, verifyPatchArtifactRecord } from "./intelligence-patch-artifact.mjs";
import { storePrivatePatchArtifact, verifyPrivatePatchArtifactAtPath, getVerifiedPrivatePatchArtifactAtPath, getPrivatePatchArtifactPath, PRIVATE_PATCH_ARTIFACT_STORE_POLICY } from "./intelligence-private-patch-store.mjs";
import { buildPatchGenerationPrompt, validateGeneratedPatch, PATCH_GENERATION_POLICY } from "./intelligence-patch-generation.mjs";
import { generatePatchArtifact, PATCH_GENERATION_SERVICE_POLICY, canonicalizeAppendOnlyHunkHeader } from "./intelligence-patch-generation-service.mjs";
import {
  INTELLIGENCE_CAPABILITIES,
  INTELLIGENCE_ACTION_TYPES,
  PREAPPROVED_INTELLIGENCE_ACTION_TYPES,
  getIntelligenceCapability,
  validateIntelligenceCapabilityRequest
} from "./intelligence-capabilities.mjs";

const workerSource = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const runnerSource = readFileSync(new URL("../.github/workflows/mehran-intelligence-runner.yml", import.meta.url), "utf8");
const scheduledStart = workerSource.indexOf("async scheduled(controller, env, ctx)");
const scheduledEnd = workerSource.indexOf("async fetch(request, env)", scheduledStart);
assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart, "Worker scheduled handler must be locatable");
const workerSchedulerSource = workerSource.slice(scheduledStart, scheduledEnd);

test("Workers AI inference failures expose only bounded sanitized diagnostics to the private runner", () => {
  assert.match(workerSource, /const diagnostic = safeWorkersAIErrorDetails\(err\)/);
  assert.match(workerSource, /stage:"workers_ai_inference"/);
  assert.match(workerSource, /fallback\(failureReason, detail\)/);
  assert.match(workerSource, /noProviderConfigured \? "ai_binding_unavailable"/);
  assert.match(workerSource, /onlyQuotaBlocked \? "daily_ai_budget_unavailable"/);
  assert.match(runnerSource, /payload\.diagnostic\.stage === "workers_ai_inference"/);
  assert.match(runnerSource, /causeMessage: String\(diagnostic\.causeMessage \|\| ""\)\.slice\(0, 180\)/);
  assert.match(runnerSource, /Bounded safe diagnostic:/);
  assert.doesNotMatch(runnerSource, /console\.log\([^\n]*payload\.diagnostic[^\n]*requestBody/);
});

test("bounded inspection serialization preserves a schema-valid semantic analysis", () => {
  const serializerStart = runnerSource.indexOf("function serializeBoundedResult");
  const serializerEnd = runnerSource.indexOf('for (let count = 0;', serializerStart);
  const serializer = runnerSource.slice(serializerStart, serializerEnd);
  assert.match(serializer, /analysis: compactAnalysis/);
  assert.match(serializer, /findings: \[\]/);
  assert.match(serializer, /Semantic findings were compacted/);
  assert.match(serializer, /bounded\.length > maxChars/);
  assert.match(serializer, /item\?\.rootCause/);
});

test("runner resumes a durable completed result checkpoint without repeating execution", () => {
  assert.ok(runnerSource.includes('savedCheckpoint.phase === "result_ready"'));
  assert.ok(runnerSource.includes('savedCheckpoint.actionType === task.actionType'));
  assert.ok(runnerSource.includes('savedCheckpoint.result.length <= 3000'));
  assert.ok(runnerSource.includes('resumedFromCheckpoint = true'));
  assert.ok(runnerSource.includes('task will not be repeated') || runnerSource.includes('execution will not be repeated'));
  assert.ok(runnerSource.includes('phase: "result_ready"'));
  assert.ok(runnerSource.includes('resultSha256: createHash("sha256").update(result).digest("hex")'));
  assert.ok(runnerSource.includes('saved.checkpointSaved !== true'));
  assert.ok(workerSource.includes('checkpointJson.length > 4000'));
});

test("all eight active capabilities are registered with their permission tiers", () => {
  const expected = [
    "project_status_report",
    "social_metrics_report",
    "service_health_report",
    "repository_quality_check",
    "source_security_audit",
    "inspect_repository",
    "run_repository_tests",
    "propose_code_patch"
  ];
  assert.deepEqual(INTELLIGENCE_ACTION_TYPES, expected);
  assert.deepEqual(PREAPPROVED_INTELLIGENCE_ACTION_TYPES, expected);
  for (const id of expected) {
    const item = getIntelligenceCapability(id);
    const isolated = id === "run_repository_tests";
    const proposal = id === "propose_code_patch";
    assert.equal(item.status, "active");
    assert.equal(item.permissionTier, proposal ? "proposal_only" : isolated ? "isolated_ci" : "read_only");
    assert.equal(item.requiresApproval, false);
    assert.ok(Object.isFrozen(item.executors));
    const input = id === "inspect_repository"
      ? { paths: ["worker.js"] }
      : isolated ? { baseSha: "a".repeat(40) }
      : proposal ? { objective: "Add a regression test for a safe parser boundary" } : {};
    assert.equal(validateIntelligenceCapabilityRequest(id, input).ok, true);
  }
});

test("fixed repository tests are active only through the isolated GitHub runner", () => {
  const capability = getIntelligenceCapability("run_repository_tests");
  assert.equal(capability.status, "active");
  assert.equal(capability.permissionTier, "isolated_ci");
  assert.equal(capability.requiresApproval, false);
  assert.equal(capability.autonomous, true);
  assert.deepEqual(capability.executors, ["github_actions_runner"]);
  assert.equal(validateIntelligenceCapabilityRequest("run_repository_tests", { baseSha: "b".repeat(40) }).ok, true);
  assert.equal(validateIntelligenceCapabilityRequest("run_repository_tests", { baseSha: "not-a-commit" }).ok, false);
  assert.equal(validateIntelligenceCapabilityRequest("run_repository_tests", { baseSha: "b".repeat(40), command: "echo unsafe" }).code, "unknown_input_field");
  assert.match(workerSource, /actionType === "run_repository_tests"/);
  assert.match(workerSource, /report\.mode !== "isolated_fixed_repository_test"/);
  assert.match(workerSource, /before\.action_payload/);
  assert.match(workerSource, /expectedPayload\.baseSha !== parsedReport\.baseSha/);
  assert.match(runnerSource, /if \(task\.actionType === "run_repository_tests"\)/);
  assert.match(runnerSource, /function runFixedRepositoryTests\(task\)/);
  assert.match(runnerSource, /node --check worker\.js/);
  assert.match(runnerSource, /"--network", "none"/);
  assert.match(runnerSource, /"--read-only"/);
  assert.match(runnerSource, /"--cap-drop", "ALL"/);
  assert.match(runnerSource, /"--security-opt", "no-new-privileges"/);
  assert.match(runnerSource, /"--memory", "768m"/);
  assert.match(runnerSource, /"--cpus", "1"/);
  assert.match(runnerSource, /"--pids-limit", "64"/);
  const dockerArgsStart = runnerSource.indexOf("const args = [", runnerSource.indexOf("function runFixedRepositoryTests"));
  const dockerArgsEnd = runnerSource.indexOf('spawnSync("docker", args', dockerArgsStart);
  assert.ok(dockerArgsStart >= 0 && dockerArgsEnd > dockerArgsStart);
  assert.doesNotMatch(runnerSource.slice(dockerArgsStart, dockerArgsEnd), /--env|["']-e["']/);
  assert.doesNotMatch(runnerSource, /"--network", "host"/);
});

test("executor metadata matches the actual Worker and GitHub Actions routing", () => {
  const expected = {
    project_status_report: ["cloudflare_worker_scheduler"],
    social_metrics_report: ["cloudflare_worker_scheduler"],
    service_health_report: ["cloudflare_worker_scheduler", "github_actions_runner"],
    repository_quality_check: ["cloudflare_worker_scheduler", "github_actions_runner"],
    source_security_audit: ["github_actions_runner"],
    inspect_repository: ["github_actions_runner"],
    run_repository_tests: ["github_actions_runner"],
    propose_code_patch: ["github_actions_runner"]
  };
  for (const [id, executors] of Object.entries(expected)) {
    assert.deepEqual(getIntelligenceCapability(id).executors, executors, id);
  }

  assert.match(workerSchedulerSource, /action_type IN \('project_status_report','social_metrics_report'\)/);
  assert.match(workerSchedulerSource, /action_type IN \('service_health_report','repository_quality_check'\)/);
  assert.doesNotMatch(workerSchedulerSource, /source_security_audit|inspect_repository|propose_code_patch/);
  assert.match(workerSource, /action_type IN \('repository_quality_check','service_health_report','source_security_audit','inspect_repository','run_repository_tests','propose_code_patch'\)/);
  assert.match(runnerSource, /if \(task\.actionType === "inspect_repository"\)/);
  assert.match(runnerSource, /if \(task\.actionType === "run_repository_tests"\)/);
  assert.match(runnerSource, /function runFixedRepositoryTests\(task\)/);

  const runnerActions = runnerSource.match(/const capabilityActions = \[([^\]]+)\]/);
  assert.ok(runnerActions, "GitHub runner must declare its action allowlist");
  assert.deepEqual(
    [...runnerActions[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1]),
    ["service_health_report", "repository_quality_check", "source_security_audit", "inspect_repository", "propose_code_patch"]
  );
});

test("security audit gathers bounded evidence from fixed official research sources", () => {
  for (const url of [
    "https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions",
    "https://developers.cloudflare.com/workers-ai/",
    "https://owasp.org/www-project-top-10-for-large-language-model-applications/"
  ]) assert.ok(runnerSource.includes(url), `missing official source: ${url}`);
  assert.match(runnerSource, /redirect: "error"/);
  assert.match(runnerSource, /AbortSignal\.timeout\(12000\)/);
  assert.match(runnerSource, /totalBytes > 500000/);
  assert.match(runnerSource, /contentTreatedAsUntrustedData: true/);
  assert.match(runnerSource, /Promise\.all\(officialGuidanceSources\.map\(readOfficialGuidance\)\)/);
  assert.match(runnerSource, /research: \{ sourceCount: researchSources\.length/);
  assert.match(runnerSource, /fixed official documentation URLs/);
});

test("completed self-assessment creates one idempotent evidence-driven terminal follow-up", () => {
  assert.match(runnerSource, /workPackageId === selfImprovementPackageId && finalState\.workPackage\?\.status === "completed" && finalState\.reportStorage\?\.stored === true/);
  assert.match(runnerSource, /\.slice\(0, 6\)[\s\S]*?result_text[\s\S]*?\.slice\(0, 420\)/);
  assert.match(runnerSource, /JSON\.stringify\([\s\S]*?tasks: taskEvidence[\s\S]*?\.slice\(0, 1150\)/);
  assert.match(runnerSource, /idempotencyKey: "mehran-intelligence-self-improvement-evidence-review-v1"/);
  assert.match(runnerSource, /allowDeterministicFallback: false/);
  assert.match(runnerSource, /CYCLE 2 \(FINAL, NON-RECURSIVE\)/);
  assert.match(runnerSource, /Do not create another self-improvement mission or recursive follow-up/);
});

test("AI mission planner uses JSON mode and extracts one complete balanced object", () => {
  const start = workerSource.indexOf("function extractIntelligenceJsonObject(raw)");
  const plannerStart = workerSource.indexOf("async function planIntelligenceMission(env, input)");
  const plannerEnd = workerSource.indexOf("export function verifyIntelligenceReport", plannerStart);
  assert.ok(start >= 0 && plannerStart > start && plannerEnd > plannerStart);
  const planner = workerSource.slice(plannerStart, plannerEnd);
  assert.match(planner, /jsonMode: true, temperature: 0, maxTokens: 1600/);
  assert.match(planner, /runIntelligenceAI\(env/);
  assert.match(planner, /extractIntelligenceJsonObject\(modelResponse\)/);
  assert.match(workerSource.slice(start, plannerStart), /if \(depth === 0 && start >= 0\) return text\.slice\(start, index \+ 1\)/);
  assert.match(workerSource.slice(start, plannerStart), /if \(escaped\) escaped = false/);
  assert.match(workerSource.slice(start, plannerStart), /raw.length > 12000/);
});

test("AI planner strips schema-optional fields that are invalid for another action", () => {
  assert.match(workerSource, /const normalizedTasks = plan\.tasks\.map\(item =>/);
  assert.match(workerSource, /if \(normalized\.actionType !== "inspect_repository"\) delete normalized\.paths/);
  assert.match(workerSource, /if \(normalized\.actionType !== "run_repository_tests"\) delete normalized\.baseSha/);
  assert.match(workerSource, /if \(normalized\.actionType !== "propose_code_patch"\) delete normalized\.objective/);
  assert.match(workerSource, /const acceptedTaskIds = new Set\(\)/);
  assert.match(workerSource, /acceptedTaskIds\.has\(dep\)/);
  assert.match(workerSource, /seenDependencies\.has\(dep\)/);
  assert.match(workerSource, /acceptedTaskIds\.add\(normalized\.taskId\)/);
  assert.match(workerSource, /tasks: normalizedTasks/);
});

test("pull request creation remains planned and non-executable", () => {
  const capability = getIntelligenceCapability("create_pull_request");
  assert.equal(capability.status, "planned");
  assert.equal(validateIntelligenceCapabilityRequest("create_pull_request", {}).ok, false);
  assert.equal(validateIntelligenceCapabilityRequest("create_pull_request", {}).code, "capability_not_implemented");
  assert.deepEqual(capability.executors, ["github_actions_runner"]);
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

test("patch proposal capability is active only for bounded private proposal generation", () => {
  const good = { objective: "Add a regression test for a safe parser boundary" };
  const capability = getIntelligenceCapability("propose_code_patch");
  assert.equal(capability.status, "active");
  assert.equal(capability.permissionTier, "proposal_only");
  assert.equal(capability.inputSchema.properties.objective.minLength, 12);
  assert.equal(capability.inputSchema.properties.objective.maxLength, 800);
  assert.equal(capability.requiresApproval, false);
  assert.equal(capability.autonomous, true);
  assert.equal(validateIntelligenceCapabilityRequest("propose_code_patch", good).ok, true);
  assert.equal(validateIntelligenceCapabilityRequest("propose_code_patch", { ...good, command: "unsafe" }).code, "unknown_input_field");
  assert.deepEqual(capability.executors, ["github_actions_runner"]);
});

test("PR creation schema requires a scoped proposal branch and immutable head SHA", () => {
  const capability = getIntelligenceCapability("create_pull_request");
  assert.equal(capability.inputSchema.properties.branch.pattern, "^intelligence/proposal-[a-f0-9-]{8,64}$");
  assert.equal(capability.inputSchema.properties.headSha.pattern, "^[a-f0-9]{40}$");
  assert.equal(capability.requiresApproval, false);
  assert.equal(capability.autonomous, true);
});


// Autonomous metadata is policy only; planned capabilities remain non-executable until an executor ships.
test("bounded patch proposals are pre-authorized while PR creation and privileged actions remain gated", () => {
  const proposal = getIntelligenceCapability("propose_code_patch");
  assert.equal(proposal.requiresApproval, false);
  assert.equal(proposal.autonomous, true);
  assert.equal(proposal.status, "active");
  assert.equal(proposal.permissionTier, "proposal_only");
  assert.equal(validateIntelligenceCapabilityRequest("propose_code_patch", {
    objective: "Add a regression test for a safe parser boundary"
  }).ok, true);
  const pullRequest = getIntelligenceCapability("create_pull_request");
  assert.equal(pullRequest.status, "planned");
  assert.equal(validateIntelligenceCapabilityRequest("create_pull_request", {}).code, "capability_not_implemented");
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
  assert.match(runnerSource, /mehran-intelligence-repo-inspection-v2-\$\{baseSha\}/);
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
  assert.match(isolatedTestWorkflowSource, /pull_request:/);
  assert.match(isolatedTestWorkflowSource, /github\.event\.pull_request\.head\.sha/);
  assert.match(isolatedTestWorkflowSource, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(isolatedTestWorkflowSource, /uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(isolatedTestWorkflowSource, /node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a/);
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
  assert.match(isolatedTestWorkflowSource, /node --check worker\.js/);
  assert.doesNotMatch(isolatedTestWorkflowSource, /secrets\.|GITHUB_TOKEN|MEHRAN_AGENT_TOKEN|MEHRAN_ORCHESTRATOR_TOKEN|actions:\s*write/);
  assert.doesNotMatch(isolatedTestWorkflowSource, /npm\s+(?:install|run)|pnpm\s+(?:install|run)|yarn\s+(?:install|run)/);

  const isolatedTestSource = readFileSync(
    new URL("./intelligence-capabilities.test.mjs", import.meta.url),
    "utf8"
  );
  const importedModules = [...isolatedTestSource.matchAll(/from ["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.deepEqual(importedModules, [
    "node:test",
    "./intelligence-patch-apply.mjs",
    "node:assert/strict",
    "node:fs",
    "./intelligence-patch-policy.mjs",
    "./intelligence-patch-artifact.mjs",
    "./intelligence-private-patch-store.mjs",
    "./intelligence-patch-generation.mjs",
    "./intelligence-patch-generation-service.mjs",
    "./intelligence-capabilities.mjs"
  ]);
  for (const forbidden of [
    ["process", ".", "env"].join(""),
    ["require", "("].join(""),
    ["import", "("].join("")
  ]) {
    assert.equal(isolatedTestSource.includes(forbidden), false, forbidden);
  }
});


test("patch proposal validator accepts only a bounded single-file test diff and never applies it", () => {
  const baseSha = "c".repeat(40);
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1 +1 @@",
    "-const before = true;",
    "+const after = true;",
    ""
  ].join("\n");
  const result = validatePatchProposal({
    baseSha,
    summary: "Add a regression assertion for a bounded proposal policy",
    targetPaths: [targetPath],
    diff
  });
  assert.deepEqual(result, {
    ok: true,
    baseSha,
    targetPath,
    bytes: new TextEncoder().encode(diff).byteLength,
    additions: 1,
    deletions: 1,
    hunkCount: 1,
    mode: "validate_only"
  });
  assert.equal(PATCH_PROPOSAL_POLICY.appliesChanges, false);
  assert.equal(PATCH_PROPOSAL_POLICY.createsBranches, false);
  assert.equal(PATCH_PROPOSAL_POLICY.createsPullRequests, false);
  assert.deepEqual(PATCH_PROPOSAL_POLICY.allowedPaths, [targetPath]);
});

test("patch proposal validator rejects paths, multi-file input, malformed hunks, and oversized diffs", () => {
  const base = {
    baseSha: "d".repeat(40),
    summary: "A sufficiently descriptive patch proposal",
    targetPaths: ["scripts/intelligence-capabilities.test.mjs"],
    diff: "--- a/scripts/intelligence-capabilities.test.mjs\n+++ b/scripts/intelligence-capabilities.test.mjs\n@@ -1 +1 @@\n-old\n+new\n"
  };
  assert.equal(validatePatchProposal({ ...base, targetPaths: ["worker.js"] }).code, "path_not_allowed");
  assert.equal(validatePatchProposal({ ...base, targetPaths: [base.targetPaths[0], base.targetPaths[0]] }).code, "invalid_target_count");
  assert.equal(validatePatchProposal({ ...base, baseSha: "not-a-sha" }).code, "invalid_base_sha");
  assert.equal(validatePatchProposal({ ...base, diff: base.diff.replace("+++ b/scripts/", "+++ b/worker.js\n--- a/scripts/") }).code, "patch_path_mismatch");
  assert.equal(validatePatchProposal({ ...base, diff: base.diff.replace("@@ -1 +1 @@", "@@ -2,4 +2,4 @@") }).code, "truncated_hunk");
  assert.equal(validatePatchProposal({ ...base, diff: base.diff.replace("+new", "GIT binary patch") }).code, "unsupported_patch_feature");
  assert.equal(validatePatchProposal({ ...base, diff: base.diff + "x".repeat(8200) }).code, "patch_size_invalid");
});


test("patch artifact envelope binds exact diff bytes to immutable metadata", async () => {
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1 +1 @@",
    "-const previous = 1;",
    "+const current = 2;",
    ""
  ].join("\n");
  const input = {
    proposalId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha: "e".repeat(40),
    summary: "Add a deterministic artifact integrity regression test",
    targetPaths: [targetPath],
    diff
  };
  const created = await createPatchArtifactRecord(input);
  assert.equal(created.ok, true);
  assert.equal(created.artifact.schemaVersion, 1);
  assert.equal(created.artifact.diff, diff);
  assert.equal(created.artifact.diffSha256.length, 64);
  assert.equal(created.artifactSha256.length, 64);
  const verified = await verifyPatchArtifactRecord(created.artifact, created.artifactSha256);
  assert.equal(verified.ok, true);
  assert.equal(verified.proposalId, input.proposalId);
  assert.equal(verified.mode, "verify_only");
});

test("patch artifact envelope detects altered diffs, metadata, and artifact hashes", async () => {
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1 +1 @@",
    "-const a = 1;",
    "+const a = 2;",
    ""
  ].join("\n");
  const created = await createPatchArtifactRecord({
    proposalId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha: "f".repeat(40),
    summary: "A valid patch proposal artifact test",
    targetPaths: [targetPath],
    diff
  });
  assert.equal(created.ok, true);
  assert.equal((await verifyPatchArtifactRecord({ ...created.artifact, diff: diff.replace("a = 2", "a = 3") }, created.artifactSha256)).code, "diff_digest_mismatch");
  assert.equal((await verifyPatchArtifactRecord(created.artifact, "0".repeat(64))).code, "artifact_digest_mismatch");
  assert.equal((await verifyPatchArtifactRecord({ ...created.artifact, summary: "tampered metadata" }, created.artifactSha256)).code, "artifact_digest_mismatch");
  assert.equal((await verifyPatchArtifactRecord({ ...created.artifact, unexpected: true }, created.artifactSha256)).code, "artifact_schema_mismatch");
});


async function makeTestPatchArtifact(proposalId = "123e4567-e89b-42d3-a456-426614174000") {
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1 +1 @@",
    "-const original = 1;",
    "+const proposed = 2;",
    ""
  ].join("\n");
  return createPatchArtifactRecord({
    proposalId,
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha: "a".repeat(40),
    summary: "A deterministic private patch storage test artifact",
    targetPaths: [targetPath],
    diff
  });
}

function githubContentResponse(artifact, path) {
  const bytes = new TextEncoder().encode(JSON.stringify(artifact, null, 2) + "\n");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return new Response(JSON.stringify({
    path,
    encoding: "base64",
    content: btoa(binary)
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("private patch store creates an immutable artifact only in the reports repository", async () => {
  const created = await makeTestPatchArtifact();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") return new Response("", { status: 404 });
    return new Response(JSON.stringify({ content: { path: "patch-proposals/2026/11/123e4567-e89b-42d3-a456-426614174000.json" } }), { status: 201 });
  };
  const result = await storePrivatePatchArtifact({
    token: "t".repeat(48),
    artifact: created.artifact,
    artifactSha256: created.artifactSha256,
    fetchImpl
  });
  assert.equal(result.stored, true);
  assert.equal(result.alreadyExists, false);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /repos\/Mehranmsh\/mehran-intelligence-reports\/contents\/patch-proposals\/2026\/11\//);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${"t".repeat(48)}`);
  const payload = JSON.parse(calls[1].options.body);
  assert.match(payload.message, /Store INTELLIGENCE patch proposal/);
  assert.equal(PRIVATE_PATCH_ARTIFACT_STORE_POLICY.createOnly, true);
  assert.equal(PRIVATE_PATCH_ARTIFACT_STORE_POLICY.overwritesExisting, false);
});

test("private patch store treats an identical existing artifact as idempotent", async () => {
  const created = await makeTestPatchArtifact();
  const path = "patch-proposals/2026/11/123e4567-e89b-42d3-a456-426614174000.json";
  let calls = 0;
  const result = await storePrivatePatchArtifact({
    token: "t".repeat(48),
    artifact: created.artifact,
    artifactSha256: created.artifactSha256,
    fetchImpl: async () => { calls++; return githubContentResponse(created.artifact, path); }
  });
  assert.equal(result.stored, true);
  assert.equal(result.alreadyExists, true);
  assert.equal(calls, 1);
});

test("private patch artifact recovery verifies an exact stored path and digest", async () => {
  const created = await makeTestPatchArtifact();
  const path = getPrivatePatchArtifactPath(created.artifact);
  assert.match(path, /^patch-proposals\/\d{4}\/\d{2}\/[a-f0-9-]{36}\.json$/);
  let calls = 0;
  const verified = await verifyPrivatePatchArtifactAtPath({
    token: "t".repeat(48), path, artifactSha256: created.artifactSha256,
    fetchImpl: async () => { calls++; return githubContentResponse(created.artifact, path); }
  });
  assert.equal(verified.stored, true);
  assert.equal(verified.path, path);
  assert.equal(calls, 1);
  const invalid = await verifyPrivatePatchArtifactAtPath({
    token: "t".repeat(48), path: "../public.json", artifactSha256: created.artifactSha256,
    fetchImpl: async () => { calls++; throw new Error("invalid path must not fetch"); }
  });
  assert.equal(invalid.code, "invalid_artifact_lookup");
  assert.equal(calls, 1);
});


test("private patch retrieval returns content only after exact path and digest verification", async () => {
  const created = await makeTestPatchArtifact();
  const path = getPrivatePatchArtifactPath(created.artifact);
  const recovered = await getVerifiedPrivatePatchArtifactAtPath({
    token: "t".repeat(48), path, artifactSha256: created.artifactSha256,
    fetchImpl: async () => githubContentResponse(created.artifact, path)
  });
  assert.equal(recovered.retrieved, true);
  assert.deepEqual(recovered.artifact, created.artifact);
  const rejected = await getVerifiedPrivatePatchArtifactAtPath({
    token: "t".repeat(48), path, artifactSha256: "0".repeat(64),
    fetchImpl: async () => githubContentResponse(created.artifact, path)
  });
  assert.equal(rejected.retrieved, false);
  assert.equal(rejected.code, "artifact_digest_mismatch");
});

test("private patch artifact recovery returns a retryable lookup error on transient network failure", async () => {
  const created = await makeTestPatchArtifact();
  const path = getPrivatePatchArtifactPath(created.artifact);
  const result = await verifyPrivatePatchArtifactAtPath({
    token: "t".repeat(48), path, artifactSha256: created.artifactSha256,
    fetchImpl: async () => { throw new Error("temporary network interruption"); }
  });
  assert.equal(result.stored, false);
  assert.equal(result.code, "artifact_lookup_failed");
});

test("private patch store rejects a conflicting artifact ID and invalid credentials without writing", async () => {
  const created = await makeTestPatchArtifact();
  const altered = { ...created.artifact, summary: "A different proposal with the same ID" };
  let calls = 0;
  const conflict = await storePrivatePatchArtifact({
    token: "t".repeat(48),
    artifact: created.artifact,
    artifactSha256: created.artifactSha256,
    fetchImpl: async () => { calls++; return githubContentResponse(altered, "patch-proposals/2026/11/conflict.json"); }
  });
  assert.equal(conflict.code, "artifact_id_conflict");
  const before = calls;
  const invalid = await storePrivatePatchArtifact({
    token: "short",
    artifact: created.artifact,
    artifactSha256: created.artifactSha256,
    fetchImpl: async () => { calls++; throw new Error("must not fetch"); }
  });
  assert.equal(invalid.code, "store_not_configured");
  assert.equal(calls, before);
});

test("patch generation prompt treats source as untrusted and fixes the narrow output contract", () => {
  const source = "const example = true;";
  const prompt = buildPatchGenerationPrompt({
    baseSha: "a".repeat(40),
    objective: "Add regression coverage for a bounded policy helper",
    source
  });
  assert.equal(prompt.ok, true);
  assert.match(prompt.system, /untrusted data/);
  assert.match(prompt.system, /testLines/);
  assert.match(prompt.system, /executor constructs the unified diff itself/);
  assert.match(prompt.system, /no carriage return or newline characters/);
  assert.match(prompt.system, /Do not return a diff, file headers, hunk headers/);
  assert.ok(prompt.system.includes("scripts/intelligence-capabilities.test.mjs"));
  assert.match(prompt.user, /Immutable base commit/);
  assert.match(prompt.user, /const example = true/);
  assert.equal(buildPatchGenerationPrompt({ baseSha: "bad", objective: "A valid objective here", source }).code, "invalid_base_sha");
  assert.equal(buildPatchGenerationPrompt({ baseSha: "a".repeat(40), objective: "short", source }).code, "invalid_objective");
  assert.equal(PATCH_GENERATION_POLICY.appendOnly, true);
  assert.equal(PATCH_GENERATION_POLICY.appliesChanges, false);
});

test("generated patches accept only pure additions at exact end-of-file", () => {
  const path = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -100,0 +101,2 @@",
    "+test(\"new bounded regression\", () => {});",
    "+",
    ""
  ].join("\n");
  const result = validateGeneratedPatch({
    baseSha: "b".repeat(40),
    sourceLineCount: 100,
    summary: "Add a bounded regression test at end of file",
    diff
  });
  assert.equal(result.ok, true);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 0);
  assert.equal(result.mode, "append_only_validate_only");
});

test("append-only hunk canonicalizer removes unchanged model context and rebuilds exact counts", () => {
  const path = "scripts/intelligence-capabilities.test.mjs";
  const generated = [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -98,4 +98,5 @@",
    " const before = true;",
    " const unchanged = 1;",
    "+test(\"context-heavy model output is canonicalized\", () => {});",
    " const after = false;",
    " const final = true;",
    ""
  ].join("\n");
  const canonical = canonicalizeAppendOnlyHunkHeader(generated, 100);
  assert.equal(canonical, [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -100,0 +101,1 @@",
    "+test(\"context-heavy model output is canonicalized\", () => {});",
    ""
  ].join("\n"));
  const validated = validateGeneratedPatch({
    baseSha: "d".repeat(40),
    sourceLineCount: 100,
    summary: "Canonicalize a context-heavy append-only model patch",
    diff: canonical
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.additions, 1);
  assert.equal(validated.deletions, 0);
  const unsafe = generated.replace(" const unchanged = 1;", "-const deleted = 1;");
  assert.equal(canonicalizeAppendOnlyHunkHeader(unsafe, 100), unsafe);
});

test("generated patch validator rejects replacements, non-EOF hunks, and extra files", () => {
  const path = "scripts/intelligence-capabilities.test.mjs";
  const replacement = [
    `--- a/${path}`, `+++ b/${path}`, "@@ -100,1 +100,1 @@",
    "-const original = 1;", "+const replacement = 2;", ""
  ].join("\n");
  const nonEof = [
    `--- a/${path}`, `+++ b/${path}`, "@@ -99,0 +100,1 @@", "+test(\"x\",()=>{});", ""
  ].join("\n");
  const base = { baseSha: "c".repeat(40), sourceLineCount: 100, summary: "Reject unsafe generated patch mutations" };
  assert.equal(validateGeneratedPatch({ ...base, diff: replacement }).code, "patch_not_append_only");
  assert.equal(validateGeneratedPatch({ ...base, diff: nonEof }).code, "patch_not_appended_at_eof");
  assert.equal(validateGeneratedPatch({ ...base, diff: nonEof.replace(path, "worker.js") }).code, "patch_path_mismatch");
});

test("Workers AI patch generation rejects stale bases before budget or model use", async () => {
  let budgetCalls = 0;
  let modelCalls = 0;
  const result = await generatePatchArtifact({
    env: { AI: { async run() { modelCalls++; return {}; } } },
    baseSha: "a".repeat(40),
    objective: "Add a regression test for a bounded parser",
    reserveBudget: async () => { budgetCalls++; return { allowed: true }; },
    fetchImpl: async () => new Response(JSON.stringify({ sha: "b".repeat(40) }), { status: 200 })
  });
  assert.equal(result.code, "stale_base_sha");
  assert.equal(budgetCalls, 0);
  assert.equal(modelCalls, 0);
});

test("Workers AI patch generation bounds streamed source before budget or model use", async () => {
  const baseSha = "e".repeat(40);
  let budgetCalls = 0;
  let modelCalls = 0;
  const fetchImpl = async url => String(url).includes("/commits/main")
    ? new Response(JSON.stringify({ sha: baseSha }), { status: 200 })
    : new Response("x".repeat(128 * 1024 + 1), { status: 200 });
  const result = await generatePatchArtifact({
    env: { AI: { async run() { modelCalls++; return {}; } } },
    baseSha,
    objective: "Add a regression test for bounded source loading",
    reserveBudget: async () => { budgetCalls++; return { allowed: true }; },
    fetchImpl
  });
  assert.equal(result.code, "source_size_invalid");
  assert.equal(budgetCalls, 0);
  assert.equal(modelCalls, 0);
});

test("Workers AI patch generation validates and envelopes only an append-only diff", async () => {
  const source = "const original = true;\n";
  const baseSha = "d".repeat(40);
  let budgetAmount = 0;
  let modelName = "";
  const calls = [];
  const fetchImpl = async url => {
    const value = String(url);
    calls.push(value);
    if (value.startsWith("https://api.github.com/")) {
      return value.endsWith("/git/ref/heads/main")
        ? Response.json({ object: { sha: baseSha } })
        : Response.json({ sha: baseSha });
    }
    if (value.endsWith("/commits/main.atom")) {
      return new Response("<feed><entry><id>tag:github.com,2008:Grit::Commit/" + baseSha + "</id></entry></feed>", { status: 200 });
    }
    return new Response(source, { status: 200 });
  };
  const env = {
    AI: {
      async run(model, input) {
        modelName = model;
        assert.equal(input.max_tokens, 2200);
        return { response: String.fromCharCode(96).repeat(3) + "json\n" + JSON.stringify({
          summary: "Add a regression test for the generation boundary",
          testLines: ['test("generated boundary", () => {});']
        }) + "\n" + String.fromCharCode(96).repeat(3) };
      }
    }
  };
  const result = await generatePatchArtifact({
    env, baseSha,
    objective: "Add a regression test for the generation boundary",
    reserveBudget: async amount => { budgetAmount = amount; return { allowed: true }; },
    fetchImpl,
    now: () => "2026-11-23T12:00:00.000Z",
    proposalId: () => "12345678-1234-4234-8234-123456789abc"
  });
  assert.equal(result.ok, true);
  assert.equal(result.validation.deletions, 0);
  assert.equal(result.artifact.baseSha, baseSha);
  assert.equal(result.artifact.targetPath, "scripts/intelligence-capabilities.test.mjs");
  assert.equal(result.artifactSha256.length, 64);
  assert.equal(budgetAmount, 100);
  assert.equal(modelName, PATCH_GENERATION_SERVICE_POLICY.model);
  assert.equal(calls.length, 7);
  assert.equal(result.mode, "generate_validate_only");
  assert.equal(PATCH_GENERATION_SERVICE_POLICY.appliesPatch, false);
});

test("Workers AI patch generation rejects a main-branch race after the model returns", async () => {
  const baseSha = "f".repeat(40);
  let mainRefCalls = 0;
  let modelCalls = 0;
  const fetchImpl = async url => {
    const value = String(url);
    if (value.startsWith("https://api.github.com/") || value.endsWith("/commits/main.atom")) {
      mainRefCalls++;
      const sha = mainRefCalls <= 3 ? baseSha : "9".repeat(40);
      if (value.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha } });
      if (value.endsWith("/commits/main.atom")) {
        return new Response("<feed><entry><id>tag:github.com,2008:Grit::Commit/" + sha + "</id></entry></feed>", { status: 200 });
      }
      return Response.json({ sha });
    }
    return new Response("const original = true;\n", { status: 200 });
  };
  const result = await generatePatchArtifact({
    baseSha,
    objective: "Add a regression test for the final main SHA race",
    env: { AI: { async run() {
      modelCalls++;
      return { response: JSON.stringify({
        summary: "Add a regression test for the final main SHA race",
        testLines: ['test("race guard", () => {});']
      }) };
    } } },
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl
  });
  assert.equal(result.code, "stale_base_sha");
  assert.equal(mainRefCalls, 6);
  assert.equal(modelCalls, 1);
});
test("Workers AI patch generation fails closed on budget denial and unsafe model output", async () => {
  const baseSha = "e".repeat(40);
  const fetchImpl = async url => String(url).includes("/commits/main")
    ? new Response(JSON.stringify({ sha: baseSha }), { status: 200 })
    : new Response("const original = true;\n", { status: 200 });
  const base = {
    baseSha,
    objective: "Add a regression test for unsafe model output",
    fetchImpl
  };
  const denied = await generatePatchArtifact({
    ...base, env: { AI: { async run() { throw new Error("must not run"); } } },
    reserveBudget: async () => ({ allowed: false })
  });
  assert.equal(denied.code, "ai_budget_exhausted");
  const unsafe = await generatePatchArtifact({
    ...base,
    env: { AI: { async run() { return { response: JSON.stringify({
      summary: "Reject a malformed generated source line",
      testLines: ["const first = true;\nconst second = false;"]
    }) }; } } },
    reserveBudget: async () => ({ allowed: true })
  });
  assert.equal(unsafe.code, "model_output_schema_invalid");
});


test("Intelligence mission planning uses a bounded, more efficient daily reservation", () => {
  assert.match(workerSource, /WORKERS_AI_INTELLIGENCE_DAILY_RESERVATION_CREDITS = 7000/);
  assert.match(workerSource, /intelligence: \{ column: "intelligence_reserved", cap: WORKERS_AI_INTELLIGENCE_DAILY_RESERVATION_CREDITS \}/);
  assert.match(workerSource, /WORKERS_AI_GLOBAL_DAILY_RESERVATION_CREDITS = 9000/);
  assert.match(workerSource, /cloudflareReservation: 25/);
  assert.match(workerSource, /maxTokens: 1600/);
});

test("scheduled Intelligence runner serializes ticks and bounds per-tick task execution", () => {
  assert.ok(runnerSource.includes("group: mehran-intelligence-private-runner-${{ github.run_id }}"));
  assert.ok(runnerSource.includes("cancel-in-progress: false"));
  assert.match(runnerSource, /for \(let count = 0; count < 5 && Date\.now\(\) < taskExecutionDeadline; count\+\+\)/);
  assert.match(runnerSource, /const taskExecutionDeadline = tickStartedAt \+ 7 \* 60 \* 1000/);
});

test("mission planner checks its idempotency key before routing to an AI provider", () => {
  const start = workerSource.indexOf("async function planIntelligenceMission(env, input)");
  const end = workerSource.indexOf("export function verifyIntelligenceReport", start);
  assert.ok(start >= 0 && end > start);
  const planner = workerSource.slice(start, end);
  const existingCheck = planner.indexOf("SELECT id,status FROM intelligence_work_packages WHERE idempotency_key=?");
  const inference = planner.indexOf("await runIntelligenceAI(env");
  assert.ok(existingCheck >= 0 && inference > existingCheck);
  assert.match(planner, /if \(existing\) return \{ success: true, duplicate: true/);
});

test("Intelligence runner retries only explicitly safe patch-generation interruptions", () => {
  const retryStart = runnerSource.indexOf("retryable = Number(error?.status) === 503 ||");
  const retryEnd = runnerSource.indexOf("const diagnostic =", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retryPolicy = runnerSource.slice(retryStart, retryEnd);
  assert.match(retryPolicy, /Number\(error\?\.status\) === 503/);
  assert.match(retryPolicy, /Number\(error\?\.status\) === 409 && \/already in progress\|concurrently reserved\//);
  assert.match(retryPolicy, /error\?\.name === "TimeoutError" \|\| error\?\.name === "AbortError"/);
  assert.doesNotMatch(retryPolicy, /Number\(error\?\.status\) === 409\s*\|\|/);
  assert.doesNotMatch(retryPolicy, /Number\(error\?\.status\) === 502/);
});

test("Patch generation timeout and model failures remain terminal instead of triggering duplicate inference", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/generate" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/agent/v1/patch-proposals" && method === "POST")', start);
  assert.ok(start >= 0 && end > start);
  const generationRoute = workerSource.slice(start, end);
  assert.match(generationRoute, /status='failed',failure_code='processing_timeout'/);
  assert.match(generationRoute, /The previous generation attempt expired; submit a new request ID/);
  assert.match(generationRoute, /model_request_failed/);
  assert.match(generationRoute, /includes\(generated\.code\) \? 502/);
  assert.match(generationRoute, /Generation failures are persisted as terminal "failed" requests/);
  assert.match(generationRoute, /HTTP 503 is reserved[\s\S]*?prepared-artifact recovery\/storage interruptions/);
});

test("Intelligence task recovery is claim-token scoped, bounded, and attempt limited", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/tasks/next" && method === "GET")');
  const end = workerSource.indexOf('const checkpointMatch = path.match', start);
  assert.ok(start >= 0 && end > start);
  const claimRoute = workerSource.slice(start, end);
  assert.match(claimRoute, /datetime\(agent_claimed_at\) < datetime\('now','-15 minutes'\)/);
  assert.match(claimRoute, /COALESCE\(attempts,0\)>=COALESCE\(max_attempts,3\)/);
  assert.match(claimRoute, /COALESCE\(attempts,0\)<COALESCE\(max_attempts,3\)/);
  assert.match(claimRoute, /attempts=COALESCE\(attempts,0\)\+1/);
  assert.match(claimRoute, /agent_claim_token_hash=\?/);
  assert.match(claimRoute, /WHERE id=\? AND status IN \('queued','accepted','retry_wait'\)/);
});

test("Intelligence task result commits require the live claim and apply bounded exponential retry", () => {
  const start = workerSource.indexOf('const agentResultMatch = path.match(');
  const end = workerSource.indexOf('return error("Not found",404);', start);
  assert.ok(start >= 0 && end > start);
  const resultRoute = workerSource.slice(start, end);
  assert.match(resultRoute, /status='in_progress' AND agent_claim_token_hash=\?/);
  assert.match(resultRoute, /datetime\(agent_claimed_at\)>=datetime\('now','-15 minutes'\)/);
  assert.match(resultRoute, /body\.retryable === true && Number\(before\.attempts \|\| 0\) < Number\(before\.max_attempts \|\| 3\)/);
  assert.match(resultRoute, /Math\.min\(3600,30 \* \(2 \*\* Math\.max\(0,Number\(before\.attempts \|\| 1\)-1\)\)\)/);
  assert.match(resultRoute, /const finalStatus = retryable \? "retry_wait" : requestedStatus/);
  assert.match(resultRoute, /agent_claim_token_hash='',next_attempt_at=\?/);
  assert.match(resultRoute, /Task claim expired or changed before result commit/);
});

test("Patch generation replay is idempotent across stored, prepared, processing, and terminal states", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/generate" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/agent/v1/patch-proposals" && method === "POST")', start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  const storedReplay = route.indexOf('if (existing.status === "stored") return responseFor(existing)');
  const preparedRecovery = route.indexOf('if (existing.status === "prepared")');
  const processingGuard = route.indexOf('if (existing.status === "processing")');
  const terminalGuard = route.indexOf('return error("This generation request is terminal; submit a new request ID to retry.",409)');
  const freshReservation = route.indexOf("INSERT OR IGNORE INTO intelligence_patch_generation_requests");
  const inference = route.indexOf("const generated = await generatePatchArtifact");
  assert.ok(storedReplay >= 0 && preparedRecovery > storedReplay);
  assert.ok(processingGuard > preparedRecovery && terminalGuard > processingGuard);
  assert.ok(freshReservation > terminalGuard && inference > freshReservation);
  assert.match(route, /if \(existing\.status === "stored"\) return responseFor\(existing\)/);
  assert.match(route, /if \(existing\.status === "prepared"\)[\s\S]*?verifyPrivatePatchArtifactAtPath/);
  assert.match(route, /if \(current\?\.status === "processing"\) return error\("This generation request is already in progress; retry the same request ID later\.",409\)/);
  assert.match(route, /status='failed',failure_code='processing_timeout'/);
  assert.match(route, /The previous generation attempt expired; submit a new request ID/);
  assert.match(route, /if \(existing\.status === "processing"\)[\s\S]*?return error\("The previous generation attempt expired; submit a new request ID\.",409\)/);
  assert.match(route, /if \(existing\.status === "prepared"\)[\s\S]*?finalizePatchGenerationRequest/);
});

test("Private package reports are verified before the durable stored marker is set", () => {
  const start = workerSource.indexOf("export async function persistIntelligencePackageReport");
  const end = workerSource.indexOf("async function refreshIntelligenceWorkPackageSnapshot", start);
  assert.ok(start >= 0 && end > start);
  const persist = workerSource.slice(start, end);
  const storedMarkerGuard = persist.indexOf("if (pkg.report_stored_at)");
  const alreadyRecorded = persist.indexOf('reason: "already_recorded"');
  const taskRead = persist.indexOf('SELECT id,status,action_type,attempts,max_attempts,last_error_code,result_text');
  assert.ok(storedMarkerGuard >= 0 && alreadyRecorded > storedMarkerGuard && taskRead > alreadyRecorded,
    "already-verified reports must bypass regeneration and immutable-content comparison");
  const verify = persist.indexOf("async function verifyExistingReport()");
  const hashCheck = persist.indexOf("await sha256(existingReportText) !== expectedReportHash");
  const markStored = persist.indexOf("SET report_stored_at=CURRENT_TIMESTAMP");
  const upload = persist.indexOf("method: \"PUT\"");
  assert.ok(verify >= 0 && hashCheck > verify && markStored > hashCheck && upload > verify);
  assert.match(persist, /priorReport\.report_id === packageId/);
  assert.match(persist, /priorReport\.data\.work_package_id === packageId/);
  assert.match(persist, /priorReport\.data\.tasks\)/);
  assert.match(persist, /report_payload/);
  assert.match(persist, /SET report_payload=\? WHERE id=\? AND report_payload=\?/);
  assert.match(persist, /hadStoredReportPayload/);
  assert.match(persist, /report_content_conflict/);
  assert.match(workerSource, /"report_content_conflict"/);
  assert.match(persist, /refusing to mark it stored/);
  assert.match(persist, /if \(\[409, 422\]\.includes\(response\.status\)\)[\s\S]*?verifyExistingReport\(\)/);
  assert.match(persist, /UPDATE intelligence_work_packages SET report_stored_at=CURRENT_TIMESTAMP WHERE id=\? AND report_stored_at IS NULL/);
});

test("Terminal work packages with unstored reports are rediscovered for later finalization", () => {
  const pendingRoute = workerSource.indexOf('if (path === "/agent/v1/work-packages/pending-finalization" && method === "GET")');
  const pendingRouteEnd = workerSource.indexOf("const packageMatch", pendingRoute);
  assert.ok(pendingRoute >= 0 && pendingRouteEnd > pendingRoute);
  const route = workerSource.slice(pendingRoute, pendingRouteEnd);
  assert.match(route, /status IN \('completed','attention_required'\) AND report_stored_at IS NULL/);
  assert.match(route, /ORDER BY created_at ASC LIMIT 20/);

  const runnerStart = runnerSource.indexOf("// Re-discover terminal packages on every tick");
  const runnerEnd = runnerSource.indexOf("// Finalize every package touched by this tick", runnerStart);
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart);
  const recovery = runnerSource.slice(runnerStart, runnerEnd);
  assert.match(recovery, /work-packages\/pending-finalization/);
  assert.match(recovery, /packageIds\.add\(id\)/);
});

test("Work-package audit events and notification outbox rows share one stable event identity", () => {
  const start = workerSource.indexOf("async function refreshIntelligenceWorkPackageSnapshot");
  const end = workerSource.indexOf("async function ensureIntelligenceSchedulerRunsTable", start);
  assert.ok(start >= 0 && end > start);
  const refresh = workerSource.slice(start, end);
  assert.match(refresh, /const eventId = crypto\.randomUUID\(\)/);
  assert.match(refresh, /INSERT INTO intelligence_task_events\(id,work_package_id,task_id,event_type,from_status,to_status,actor,details_json\)[\s\S]*?\.bind\(eventId,packageId/);
  assert.match(refresh, /INSERT OR IGNORE INTO intelligence_notification_outbox\(id,event_id,channel,payload_json,status\)[\s\S]*?\.bind\(crypto\.randomUUID\(\),eventId/);
  const schemaStart = workerSource.indexOf("CREATE TABLE IF NOT EXISTS intelligence_notification_outbox");
  const schemaEnd = workerSource.indexOf("async function ensureIntelligencePatchGenerationRequestsTable", schemaStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  assert.match(workerSource.slice(schemaStart, schemaEnd), /UNIQUE\(event_id,channel\)/);
});

test("Notification delivery leases are bounded, acknowledged with the lease token, and stop after five attempts", () => {
  const routeStart = workerSource.indexOf('if (path === "/agent/v1/notifications/next" && method === "GET")');
  const routeEnd = workerSource.indexOf('const notificationMatch', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const claim = workerSource.slice(routeStart, routeEnd);
  assert.match(claim, /attempts>=5 THEN 'failed' ELSE 'retry_wait'/);
  assert.match(claim, /attempts=attempts\+1/);
  assert.match(claim, /leaseToken/);
  assert.match(claim, /5\*60\*1000/);

  const ackStart = routeEnd;
  const ackEnd = workerSource.indexOf('if (path === "/agent/v1/work-packages/pending-finalization"', ackStart);
  const ack = workerSource.slice(ackStart, ackEnd);
  assert.match(ack, /WHERE id=\? AND status='processing' AND lease_token=\?/);
  assert.match(ack, /outcome === "retry" && Number\(row\.attempts\|\|0\) < 5/);
  assert.match(ack, /"delivered","retry","failed"/);
});

test("Owner notifications are archived idempotently in the private reports repository before delivery acknowledgement", () => {
  const helperStart = workerSource.indexOf("async function persistIntelligenceNotification");
  const helperEnd = workerSource.indexOf("export async function persistIntelligencePackageReport", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.match(helper, /MEHRAN_REPORTS_GITHUB_TOKEN/);
  assert.match(helper, /Mehranmsh\/mehran-intelligence-reports/);
  assert.match(helper, /notifications\//);
  assert.match(helper, /method:"GET"/);
  assert.match(helper, /method:"PUT"/);
  assert.match(helper, /await sha256\(existingText\) !== expectedHash/);
  assert.match(helper, /\[409,422\]\.includes\(response\.status\)/);
  assert.doesNotMatch(helper, /return \{[^}]*token/);

  const routeStart = workerSource.indexOf("const notificationMatch = path.startsWith");
  const routeEnd = workerSource.indexOf('if (path === "/agent/v1/work-packages/pending-finalization"', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = workerSource.slice(routeStart, routeEnd);
  assert.match(route, /SELECT id,event_id,channel,payload_json,created_at,attempts,status FROM intelligence_notification_outbox/);
  assert.ok(route.indexOf("persistIntelligenceNotification(env, row)") < route.indexOf("UPDATE intelligence_notification_outbox SET status=?"));
  assert.match(route, /Private notification archive failed:[\s\S]*?,503/);
});

test("Runner archives owner notifications only through the authenticated Worker and never exposes the private archive token", () => {
  const start = runnerSource.indexOf("// Archive owner-private notifications through the Worker");
  const end = runnerSource.indexOf("`[performance] tick_total:", start);
  assert.ok(start >= 0 && end > start);
  const delivery = runnerSource.slice(start, end);
  assert.match(delivery, /notifications\/next/);
  assert.match(delivery, /status: "delivered"/);
  assert.match(delivery, /status: "retry"/);
  assert.match(delivery, /count < 10/);
  assert.match(delivery, /notification\.channel !== "owner_private"/);
  assert.doesNotMatch(delivery, /MEHRAN_REPORTS_GITHUB_TOKEN|secrets\./);
  assert.doesNotMatch(delivery, /payload\.counts|payload\.workPackageId/);
});

test("Private notification archive strips base64 whitespace before verification", () => {
  const start = workerSource.indexOf("async function persistIntelligenceNotification");
  const end = workerSource.indexOf("export async function persistIntelligencePackageReport", start);
  const helper = workerSource.slice(start, end);
  assert.match(helper, /body\.content\.replace\(\/\\s\+\/g,""\)/);
});

test("Private notification archive enforces the exact status schema and bounded numeric counters", () => {
  const start = workerSource.indexOf("async function persistIntelligenceNotification");
  const end = workerSource.indexOf("export async function persistIntelligencePackageReport", start);
  const helper = workerSource.slice(start, end);
  assert.match(helper, /payload\.type !== "work_package_status_changed"/);
  assert.match(helper, /payload\.workPackageId\.length > 160/);
  assert.match(helper, /const countKeys = \["total","completed","blocked","failed","awaitingApproval","inProgress","queued","retryWaiting","blockedDependencies"\]/);
  assert.match(helper, /Object\.keys\(payload\.counts\)\.some\(key => !countKeys\.includes\(key\)\)/);
  assert.match(helper, /Number\.isSafeInteger\(value\)/);
  assert.match(helper, /value < 0 \|\| value > 1000000000/);
  assert.match(helper, /date\.toISOString\(\) !== payload\.generatedAt/);
  assert.doesNotMatch(helper, /counts: payload\.counts/);
});

test("Malformed private notification JSON is quarantined before a delivery lease is created", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/notifications/next"');
  const end = workerSource.indexOf("const notificationMatch = path.startsWith", start);
  const route = workerSource.slice(start, end);
  assert.match(route, /channel='owner_private'/);
  assert.ok(route.indexOf("JSON.parse(candidate.payload_json)") < route.indexOf("SET status='processing'"));
  assert.match(route, /status='failed',next_attempt_at=NULL,lease_token='',last_error='invalid_payload_json'/);
  assert.match(route, /Notification payload is invalid and was quarantined/);
  assert.ok(route.indexOf("invalid_payload_json") < route.indexOf("SET status='processing'"));
});


test("private report storage preserves safe HTTP status diagnostics", () => {
  const diagnosticStart = workerSource.indexOf("const safeStoreReason");
  const diagnosticEnd = workerSource.indexOf('console.error("INTELLIGENCE_PRIVATE_REPORT_STORE_FAILURE"', diagnosticStart);
  assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart, "private report storage diagnostic must be locatable");
  const diagnostic = workerSource.slice(diagnosticStart, diagnosticEnd);
  assert.ok(diagnostic.includes("status \\d{3}\\."), "HTTP status regex must match a three-digit status code");
  assert.equal(diagnostic.includes("status \\\\d{3}\\\\."), false, "regex must not search for a literal backslash-d sequence");
});


test("Intelligence retains owner-scoped durable memory and recent conversation context across requests", () => {
  assert.match(workerSource, /CREATE TABLE IF NOT EXISTS intelligence_memory_items/);
  assert.match(workerSource, /UNIQUE\(owner_uid,memory_key\)/);
  assert.match(workerSource, /CREATE TABLE IF NOT EXISTS intelligence_chat_turns/);
  assert.match(workerSource, /LIMIT 100\)"/);
  assert.match(workerSource, /ORDER BY created_at DESC,rowid DESC LIMIT 16/);
  assert.match(workerSource, /PERSISTENT PROJECT MEMORY/);
  assert.match(workerSource, /RECENT CONVERSATION/);
  assert.match(workerSource, /name:"remember_context"/);
  assert.match(workerSource, /ON CONFLICT\(owner_uid,memory_key\) DO UPDATE/);
  assert.match(workerSource, /Credentials and wallet secrets cannot be stored in memory/);
  assert.match(workerSource, /seedIntelligenceOwnerMemory\(env,admin\.uid\)/);
  assert.match(workerSource, /path.match\(\/\^\\\/intelligence\\\/memory\\\/\(\[\^\/\]\+\)\$\//);
  assert.match(workerSource, /DELETE FROM intelligence_memory_items WHERE owner_uid=\? AND memory_key=\?/);
  assert.match(workerSource, /JSON\.stringify\(durableMemoryContext\)/);
  assert.match(workerSource, /Use the durable owner-confirmed project memory included in the mission context/);
  assert.match(workerSource, /seedIntelligenceOwnerMemory\(env,"mehran_intelligence"\)/);
  assert.match(workerSource, /appendIntelligenceChatTurn\(env,admin\.uid,sessionKey,"user",question\)/);
  assert.match(workerSource, /appendIntelligenceChatTurn\(env,admin\.uid,sessionKey,"assistant"/);
  const chatHandlerStart = workerSource.indexOf("const executeTool = async (name,args) =>", workerSource.indexOf('if (path === "/intelligence/chat" && method === "POST")'));
  const chatHandlerEnd = workerSource.indexOf('if (name === "get_project_status")', chatHandlerStart);
  const chatHandler = workerSource.slice(chatHandlerStart, chatHandlerEnd);
  assert.ok(chatHandler.includes('if (name === "remember_context")'));
  assert.ok(chatHandler.includes(".bind(crypto.randomUUID(),admin.uid,key,category,content,importance)"));
  assert.ok(workerSource.includes('FROM intelligence_memory_items WHERE owner_uid=? ORDER BY importance DESC,updated_at DESC LIMIT 100").bind(admin.uid).all()'));
  assert.ok(workerSource.includes('FROM intelligence_memory_items WHERE owner_uid=? ORDER BY updated_at DESC,importance DESC LIMIT 24").bind(admin.uid).all()'));
  assert.ok(workerSource.includes("ACTIVE MISSION STATE (authoritative live task records; resume existing work before proposing duplicates)"));
  assert.ok(workerSource.includes('if (path === "/intelligence/chat/history" && method === "GET")'));
  assert.ok(workerSource.includes('WHERE owner_uid=? AND session_key=? ORDER BY created_at DESC,rowid DESC LIMIT 100'));
  assert.ok(workerSource.includes('return json({success:true,turns:'));
  assert.ok(indexSource.includes('id="intelConversation"'));
  assert.ok(indexSource.includes('async function loadIntelligenceChatHistory()'));
  assert.ok(indexSource.includes('api("/intelligence/chat/history")'));
  assert.match(workerSource, /ALTER TABLE intelligence_work_packages ADD COLUMN owner_uid TEXT/);
  assert.match(workerSource, /ownerUid: input\?\.ownerUid/);
  assert.match(workerSource, /ownerUid: admin\.uid/);
  assert.match(workerSource, /LEFT JOIN intelligence_work_packages wp ON wp\.id=t\.work_package_id/);
  assert.match(workerSource, /wp\.owner_uid=\? AND t\.work_package_id IS NOT NULL/);
  assert.match(workerSource, /t\.work_package_id IS NULL AND t\.created_by=\?/);
  assert.ok(workerSource.includes("t.checkpoint_json,t.attempts,t.max_attempts,t.next_attempt_at,t.last_error_code,t.updated_at"));
  assert.ok(workerSource.includes("const activeMissions = (activeTaskResult.results || []).map"));
  assert.ok(workerSource.includes("wp.title AS package_title,wp.objective AS package_objective,wp.status AS package_status"));
  assert.ok(workerSource.includes('packageObjective:String(task.package_objective || "").slice(0,900)'));
  assert.ok(workerSource.includes("If an active mission exists, continue from its recorded objective, status, and checkpoint before suggesting new work"));
  assert.ok(workerSource.includes("never create a duplicate task just because the conversation session changed"));

});


test("private report base64 verification strips actual whitespace before decoding", () => {
  const start = workerSource.indexOf("export async function persistIntelligencePackageReport");
  const end = workerSource.indexOf("async function refreshIntelligenceWorkPackageSnapshot", start);
  assert.ok(start >= 0 && end > start);
  const persist = workerSource.slice(start, end);
  assert.ok(persist.includes('existingPayload.content.replace(/\\s+/g, "")'),
    "GitHub Contents API base64 must remove real whitespace, not literal backslash-s sequences");
});


test("repository inspection checkpoints are revalidated against the current Worker report contract before resume", () => {
  assert.match(runnerSource, /savedCheckpoint\.phase === "result_ready" && task\.actionType === "inspect_repository"/);
  assert.match(runnerSource, /report\?\.type === "inspect_repository"/);
  assert.match(runnerSource, /bounded_read_only_repository_inspection/);
  assert.match(runnerSource, /analysisValid/);
  assert.match(runnerSource, /Ignoring stale repository-inspection checkpoint/);
  assert.ok(runnerSource.indexOf("Ignoring stale repository-inspection checkpoint") < runnerSource.indexOf("Resuming task " + '" + task.id'));
});

test("package report snapshots wait until runnable sibling tasks are quiescent", () => {
  const start = workerSource.indexOf("async function refreshIntelligenceWorkPackageSnapshot");
  const end = workerSource.indexOf("async function ensureIntelligenceSchedulerRunsTable", start);
  const snapshot = workerSource.slice(start, end);
  assert.match(snapshot, /else if \(row\.status === "cancelled"\) counts\.cancelled \+= n/);
  assert.match(snapshot, /counts\.inProgress \? "in_progress"/);
  assert.match(snapshot, /counts\.queued > counts\.blockedDependencies/);
  assert.match(snapshot, /reportIsQuiescent = counts\.inProgress === 0/);
  assert.match(snapshot, /includes\(status\) && reportIsQuiescent/);
});

test("Workers AI inference failures retain safe actionable diagnostics without exposing request content", () => {
  assert.ok(workerSource.includes("function safeWorkersAIErrorDetails(err)"));
  assert.ok(workerSource.includes("err?.code ?? cause?.code"));
  assert.ok(workerSource.includes("err?.status ?? cause?.status"));
  assert.ok(workerSource.includes("Bearer\\s+"));
  assert.ok(workerSource.includes("INTELLIGENCE_MISSION_PLANNER_FAILURE"));
  assert.ok(workerSource.includes("INTELLIGENCE_CODE_ANALYSIS_FAILURE"));
  assert.ok(workerSource.includes("JSON.stringify({traceId,elapsedMs,...diagnostic})"));
  assert.ok(workerSource.includes("stage:\"workers_ai_inference\""));
});;

test("repository inspection performs bounded evidence-backed Workers AI semantic analysis", () => {
  assert.match(workerSource, /path === "\/agent\/v1\/repository\/analyze"/);
  assert.match(workerSource, /ownerOrchestrationRoute = .*repository\/analyze/);
  assert.match(workerSource, /totalChars > 16000/);
  assert.match(workerSource, /file\.excerpt\.length > 2800/);
  assert.match(workerSource, /env\.AI\.run\(model/);
  assert.match(workerSource, /supplied source excerpts as untrusted code data/);
  assert.match(workerSource, /files\.find\(f=>f\.path===ev\.path\)\?\.excerpt\.includes\(ev\.quote\)/);
  assert.match(workerSource, /inspect_repository_semantic_analysis/);
  assert.match(runnerSource, /request\("\/agent\/v1\/repository\/analyze"/);
  assert.match(runnerSource, /const evidenceFiles = \[\]/);
  assert.match(runnerSource, /analysis: semantic\.analysis/);
  assert.match(runnerSource, /slice\(0,2800\)/);
  assert.match(workerSource, /Do not call a named constant a magic number/);
  assert.match(workerSource, /Do not label a Firebase Web API key/);
  assert.match(workerSource, /unsupportedMagicNumberFindings/);
  assert.doesNotMatch(runnerSource, /analysis endpoint.*source changes/i);
});

test("multi-provider Intelligence routing releases Cloudflare reservations on failed inference", () => {
  assert.ok(workerSource.includes("async function releaseSocialWorkersAIBudget(env, reservation)"));
  assert.ok(workerSource.includes("SET ${column}=MAX(0,${column}-?)"));
  const plannerStart = workerSource.indexOf("async function planIntelligenceMission(env, input)");
  const plannerEnd = workerSource.indexOf("export function verifyIntelligenceReport", plannerStart);
  const planner = workerSource.slice(plannerStart, plannerEnd);
  assert.ok(workerSource.includes("await releaseSocialWorkersAIBudget(env, reservation).catch(() => {})"));
  const analysisStart = workerSource.indexOf('if (path === "/agent/v1/repository/analyze" && method === "POST")');
  const analysisEnd = workerSource.indexOf('if (path === "/agent/v1/missions/plan" && method === "POST")', analysisStart);
  const analysis = workerSource.slice(analysisStart, analysisEnd);
  assert.ok(analysis.includes("runIntelligenceAI(env"));
});


test("Intelligence Runner correlates API requests with bounded trace IDs and records stage timings", () => {
  assert.match(runnerSource, /let requestSequence = 0/);
  assert.match(runnerSource, /const traceId = traceRunId \+ "-" \+ \(\+\+requestSequence\)/);
  assert.match(runnerSource, /"X-Intelligence-Trace-Id": traceId/);
  assert.match(runnerSource, /\[trace\].*elapsed_ms=/);
  assert.match(runnerSource, /repository_analyze/);
  assert.match(runnerSource, /diagnostic\.traceId/);
  assert.match(workerSource, /INTELLIGENCE_CODE_ANALYSIS_START/);
  assert.match(workerSource, /INTELLIGENCE_CODE_ANALYSIS_SUCCESS/);
  assert.match(workerSource, /INTELLIGENCE_MISSION_PLANNER_START/);
  assert.match(workerSource, /INTELLIGENCE_MISSION_PLANNER_INFERENCE_SUCCESS/);
  assert.match(workerSource, /operation:"repository_analyze",traceId,elapsedMs/);
  assert.match(workerSource, /operation:"mission_plan",traceId,elapsedMs/);
});


test("Intelligence AI router fails over across free providers and blocks paid OpenRouter models", () => {
  assert.match(workerSource, /INTELLIGENCE_AI_PROVIDER_ORDER = Object\.freeze\(\["cloudflare", "groq", "gemini", "openrouter"\]\)/);
  assert.match(workerSource, /MEHRAN_AI_FREE_PROVIDERS/);
  assert.match(workerSource, /\|\| "cloudflare,openrouter"/);
  assert.match(workerSource, /allowedProviders\.includes\(item\)/);
  assert.match(workerSource, /GROQ_API_KEY/);
  assert.match(workerSource, /GEMINI_API_KEY/);
  assert.match(workerSource, /OPENROUTER_API_KEY/);
  assert.match(workerSource, /model !== "openrouter\/free" && !model\.endsWith\(":free"\)/);
  assert.match(workerSource, /quota_or_rate_limit/);
  assert.match(workerSource, /No configured free AI provider completed the request/);
  assert.match(workerSource, /runIntelligenceAI\(env/);
});

test("Intelligence mission planning and repository semantic analysis use the provider router", () => {
  const plannerStart = workerSource.indexOf("async function planIntelligenceMission(env, input)");
  const plannerEnd = workerSource.indexOf("export function verifyIntelligenceReport", plannerStart);
  const planner = workerSource.slice(plannerStart, plannerEnd);
  assert.match(planner, /await runIntelligenceAI\(env/);
  const analysisStart = workerSource.indexOf('if (path === "/agent/v1/repository/analyze" && method === "POST")');
  const analysisEnd = workerSource.indexOf('if (path === "/agent/v1/missions/plan" && method === "POST")', analysisStart);
  const analysis = workerSource.slice(analysisStart, analysisEnd);
  assert.match(analysis, /await runIntelligenceAI\(env/);
  assert.doesNotMatch(analysis, /await env\.AI\.run\(model/);
});

test("repository inspection and source audit accept worker.js while preserving strict byte and SHA bounds", () => {
  assert.match(runnerSource, /file\.size > 600000/);
  assert.match(runnerSource, /file\.bytes > 600000/);
  assert.match(runnerSource, /totalBytes > 750000/);
  assert.match(runnerSource, /totalBytes <= 750000/);
  assert.match(runnerSource, /file\.path !== path/);
  assert.match(runnerSource, /Buffer\.byteLength\(text, "utf8"\) !== file\.size/);
  assert.match(runnerSource, /file\.sha !== "string"/);
});


test("proposal PR runner imports the patch applier from its own scripts directory", () => {
  const runnerSource = readFileSync(new URL("./intelligence-proposal-pr-runner.mjs", import.meta.url), "utf8");
  assert.ok(runnerSource.includes(["from", '"./intelligence-patch-apply.mjs"'].join(" ")));
  assert.ok(!runnerSource.includes(["from", '"./scripts/intelligence-patch-apply.mjs"'].join(" ")));
});

test("patch application is in-memory only and rejects stale or non-append-only patches", () => {
  const baseSha = "a".repeat(40);
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const source = "const existing = true;\n";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1,0 +2,1 @@",
    "+const appended = true;"
  ].join("\n") + "\n";
  const result = applyValidatedPatchInMemory({
    baseSha,
    expectedBaseSha: baseSha,
    source,
    targetPath,
    summary: "Append one bounded test fixture safely",
    diff
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, source + "const appended = true;\n");
  assert.equal(result.mode, "in_memory_only");

  const stale = applyValidatedPatchInMemory({
    baseSha,
    expectedBaseSha: "b".repeat(40),
    source,
    targetPath,
    summary: "Append one bounded test fixture safely",
    diff
  });
  assert.equal(stale.code, "stale_base_sha");

  const replacement = diff.replace("@@ -1,0 +2,1 @@", "@@ -1,1 +1,1 @@")
    .replace("+const appended = true;", "-const existing = true;\n+const replaced = true;");
  const rejected = applyValidatedPatchInMemory({
    baseSha,
    expectedBaseSha: baseSha,
    source,
    targetPath,
    summary: "Attempt to replace an existing line",
    diff: replacement
  });
  assert.equal(rejected.ok, false);
});
