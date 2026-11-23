import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePatchProposal, PATCH_PROPOSAL_POLICY } from "./intelligence-patch-policy.mjs";
import { createPatchArtifactRecord, verifyPatchArtifactRecord } from "./intelligence-patch-artifact.mjs";
import { storePrivatePatchArtifact, verifyPrivatePatchArtifactAtPath, getPrivatePatchArtifactPath, PRIVATE_PATCH_ARTIFACT_STORE_POLICY } from "./intelligence-private-patch-store.mjs";
import { buildPatchGenerationPrompt, validateGeneratedPatch, PATCH_GENERATION_POLICY } from "./intelligence-patch-generation.mjs";
import { generatePatchArtifact, PATCH_GENERATION_SERVICE_POLICY } from "./intelligence-patch-generation-service.mjs";
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
  assert.match(prompt.system, /zero deletions/);
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
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/commits/main")) {
      return new Response(JSON.stringify({ sha: baseSha }), { status: 200 });
    }
    return new Response(source, { status: 200 });
  };
  const env = {
    AI: {
      async run(model, input) {
        modelName = model;
        assert.equal(input.max_tokens, 2200);
        return { response: JSON.stringify({
          summary: "Add a regression test for the generation boundary",
          diff: [
            "--- a/scripts/intelligence-capabilities.test.mjs",
            "+++ b/scripts/intelligence-capabilities.test.mjs",
            "@@ -1,0 +2,1 @@",
            "+test(\"generated boundary\", () => {});",
            ""
          ].join("\n")
        }) };
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
  assert.equal(budgetAmount, 250);
  assert.equal(modelName, PATCH_GENERATION_SERVICE_POLICY.model);
  assert.equal(calls.length, 3);
  assert.equal(result.mode, "generate_validate_only");
  assert.equal(PATCH_GENERATION_SERVICE_POLICY.appliesPatch, false);
});

test("Workers AI patch generation rejects a main-branch race after the model returns", async () => {
  const baseSha = "f".repeat(40);
  let mainLookups = 0;
  let modelCalls = 0;
  const fetchImpl = async url => {
    if (String(url).includes("/commits/main")) {
      mainLookups++;
      return new Response(JSON.stringify({ sha: mainLookups === 1 ? baseSha : "9".repeat(40) }), { status: 200 });
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
        diff: [
          "--- a/scripts/intelligence-capabilities.test.mjs",
          "+++ b/scripts/intelligence-capabilities.test.mjs",
          "@@ -1,0 +2,1 @@",
          "+test(\"race guard\", () => {});",
          ""
        ].join("\n")
      }) };
    } } },
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl
  });
  assert.equal(result.code, "stale_base_sha");
  assert.equal(mainLookups, 2);
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
      summary: "Replace an existing assertion with a different behavior",
      diff: [
        "--- a/scripts/intelligence-capabilities.test.mjs",
        "+++ b/scripts/intelligence-capabilities.test.mjs",
        "@@ -1,1 +1,1 @@",
        "-const original = true;",
        "+const original = false;",
        ""
      ].join("\n")
    }) }; } } },
    reserveBudget: async () => ({ allowed: true })
  });
  assert.equal(unsafe.code, "patch_not_append_only");
});


test("Intelligence mission planning uses a bounded, more efficient daily reservation", () => {
  assert.match(workerSource, /intelligence: \{ column: "intelligence_reserved", cap: 3000 \}/);
  assert.match(workerSource, /reserveSocialWorkersAIBudget\(env, 150, "intelligence"\)/);
  assert.match(workerSource, /max_tokens: 1000/);
});
