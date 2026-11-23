import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePatchProposal, PATCH_PROPOSAL_POLICY } from "./intelligence-patch-policy.mjs";
import { createPatchArtifactRecord, verifyPatchArtifactRecord } from "./intelligence-patch-artifact.mjs";
import { storePrivatePatchArtifact, PRIVATE_PATCH_ARTIFACT_STORE_POLICY } from "./intelligence-private-patch-store.mjs";
import { buildPatchGenerationMessages, validateAppendOnlyPatchGeneration } from "./intelligence-patch-generator.mjs";
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
    assert.equal(item.status, "active");
    const expectedTier = isolated ? "isolated_ci" : id === "propose_code_patch" ? "proposal_only" : "read_only";
    assert.equal(item.permissionTier, expectedTier);
    assert.equal(item.requiresApproval, false);
    assert.ok(Object.isFrozen(item.executors));
    const input = id === "inspect_repository"
      ? { paths: ["worker.js"] }
      : isolated ? { baseSha: "a".repeat(40) }
      : id === "propose_code_patch" ? { objective: "Add one focused regression test for an uncovered parser boundary." } : {};
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
    run_repository_tests: ["github_actions_runner"]
  };
  for (const [id, executors] of Object.entries(expected)) {
    assert.deepEqual(getIntelligenceCapability(id).executors, executors, id);
  }

  assert.match(workerSchedulerSource, /action_type IN \('project_status_report','social_metrics_report'\)/);
  assert.match(workerSchedulerSource, /action_type IN \('service_health_report','repository_quality_check'\)/);
  assert.doesNotMatch(workerSchedulerSource, /source_security_audit|inspect_repository/);
  assert.match(workerSource, /action_type IN \('repository_quality_check','service_health_report','source_security_audit','inspect_repository','run_repository_tests'\)/);
  assert.match(runnerSource, /if \(task\.actionType === "inspect_repository"\)/);
  assert.match(runnerSource, /if \(task\.actionType === "run_repository_tests"\)/);
  assert.match(runnerSource, /function runFixedRepositoryTests\(task\)/);

  const runnerActions = runnerSource.match(/const capabilityActions = \[([^\]]+)\]/);
  assert.ok(runnerActions, "GitHub runner must declare its action allowlist");
  assert.deepEqual(
    [...runnerActions[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1]),
    ["service_health_report", "repository_quality_check", "source_security_audit", "inspect_repository"]
  );
});

test("future self-improvement capabilities remain planned and non-executable", () => {
  for (const id of ["propose_code_patch", "create_pull_request"]) {
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
  for (const id of ["propose_code_patch", "create_pull_request"]) {
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
    "node:assert/strict",
    "node:fs",
    "./intelligence-patch-policy.mjs",
    "./intelligence-patch-artifact.mjs",
    "./intelligence-private-patch-store.mjs",
    "./intelligence-patch-generator.mjs",
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


test("AI patch generation accepts only additions appended at the exact end of the allowlisted test file", () => {
  const source = "import test from \"node:test\";\nconst existing = true;\n";
  const baseSha = "a".repeat(40);
  const objective = "Add a regression test for a bounded parser edge case.";
  const summary = "Add a focused parser regression test at the end of the suite.";
  const diff = [
    "--- a/scripts/intelligence-capabilities.test.mjs",
    "+++ b/scripts/intelligence-capabilities.test.mjs",
    "@@ -2,0 +3,2 @@",
    "+test(\"new regression\", () => {",
    "+  assert.equal(existing, true);",
    ""
  ].join("\n");
  const result = validateAppendOnlyPatchGeneration({ baseSha, objective, source, summary, diff });
  assert.equal(result.ok, true);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 0);
  assert.equal(result.mode, "append_only_test_proposal");
});

test("AI patch generation rejects deletions, misplaced hunks, and invalid source metadata", () => {
  const source = "one\ntwo\nthree\n";
  const baseSha = "b".repeat(40);
  const objective = "Add one focused regression test without changing existing assertions.";
  const summary = "Add a narrow regression test.";
  const deleted = [
    "--- a/scripts/intelligence-capabilities.test.mjs",
    "+++ b/scripts/intelligence-capabilities.test.mjs",
    "@@ -3,1 +3,1 @@",
    "-three",
    "+four",
    ""
  ].join("\n");
  const misplaced = [
    "--- a/scripts/intelligence-capabilities.test.mjs",
    "+++ b/scripts/intelligence-capabilities.test.mjs",
    "@@ -1,0 +2,1 @@",
    "+test(\"bad location\", () => {});",
    ""
  ].join("\n");
  assert.equal(validateAppendOnlyPatchGeneration({ baseSha, objective, source, summary, diff:deleted }).code,
    "generated_patch_not_append_only");
  assert.equal(validateAppendOnlyPatchGeneration({ baseSha, objective, source, summary, diff:misplaced }).code,
    "generated_patch_not_append_only");
  assert.equal(buildPatchGenerationMessages({ baseSha:"bad", objective, source }).code,
    "invalid_generation_input");
});

test("AI patch generation endpoint remains fixed-path, budgeted, and non-applying", () => {
  assert.ok(workerSource.includes('path === "/agent/v1/patch-proposals/generate"'));
  assert.ok(workerSource.includes('reserveSocialWorkersAIBudget(env,250,"intelligence")'));
  assert.ok(workerSource.includes("https://raw.githubusercontent.com/Mehranmsh/mehranmsh.github.io/"));
  assert.ok(workerSource.includes("validateAppendOnlyPatchGeneration"));
  assert.ok(workerSource.includes("sourceReader.cancel()"));
  assert.ok(workerSource.includes("applied:false,branchCreated:false,pullRequestCreated:false,deployed:false"));
});
