import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  INTELLIGENCE_ACTION_TYPES,
  PREAPPROVED_INTELLIGENCE_ACTION_TYPES
} from "./intelligence-capabilities.mjs";
import { createPatchArtifactRecord } from "./intelligence-patch-artifact.mjs";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../.github/workflows/mehran-intelligence-runner.yml", import.meta.url), "utf8");
const musicStudioSource = await readFile(new URL("../music-studio.html", import.meta.url), "utf8");
const capabilityImport = 'import { INTELLIGENCE_ACTION_TYPES, PREAPPROVED_INTELLIGENCE_ACTION_TYPES } from "./scripts/intelligence-capabilities.mjs";';
const patchStoreImport = 'import { storePrivatePatchArtifact, verifyPrivatePatchArtifactAtPath, getPrivatePatchArtifactPath, getVerifiedPrivatePatchArtifactAtPath } from "./scripts/intelligence-private-patch-store.mjs";';
const patchGenerationImport = 'import { generatePatchArtifact } from "./scripts/intelligence-patch-generation-service.mjs";';
const inboxSchemaImport = 'import { validatePrivateIntelligenceMission } from "./scripts/intelligence-inbox-schema.mjs";';
const routinePlannerImport = 'import { buildDeterministicRoutinePlan } from "./scripts/intelligence-routine-planner.mjs";';
if (!workerSource.includes(capabilityImport) || !workerSource.includes(patchStoreImport) ||
    !workerSource.includes(patchGenerationImport) || !workerSource.includes(inboxSchemaImport) ||
    !workerSource.includes(routinePlannerImport)) {
  throw new Error("Worker capability, patch storage, or private inbox schema imports were not found");
}
const policySource = await readFile(new URL("./intelligence-patch-policy.mjs", import.meta.url), "utf8");
const artifactSource = await readFile(new URL("./intelligence-patch-artifact.mjs", import.meta.url), "utf8");
const patchStoreSource = await readFile(new URL("./intelligence-private-patch-store.mjs", import.meta.url), "utf8");
const patchGenerationPromptSource = await readFile(new URL("./intelligence-patch-generation.mjs", import.meta.url), "utf8");
const patchGenerationServiceSource = await readFile(new URL("./intelligence-patch-generation-service.mjs", import.meta.url), "utf8");
const inboxSchemaSource = await readFile(new URL("./intelligence-inbox-schema.mjs", import.meta.url), "utf8");
const routinePlannerSource = (await readFile(new URL("./intelligence-routine-planner.mjs", import.meta.url), "utf8"))
  .replace("export function buildDeterministicRoutinePlan", "function buildDeterministicRoutinePlan");
const moduleUrl = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const inboxSchemaUrl = moduleUrl(inboxSchemaSource);
const policyUrl = moduleUrl(policySource);
const artifactUrl = moduleUrl(artifactSource.replace(
  'from "./intelligence-patch-policy.mjs"',
  `from "${policyUrl}"`
));
const patchStoreUrl = moduleUrl(patchStoreSource.replace(
  'from "./intelligence-patch-artifact.mjs"',
  `from "${artifactUrl}"`
));
const patchGenerationPromptUrl = moduleUrl(patchGenerationPromptSource.replace(
  'from "./intelligence-patch-policy.mjs"',
  `from "${policyUrl}"`
));
const patchGenerationServiceUrl = moduleUrl(patchGenerationServiceSource
  .replace('from "./intelligence-patch-generation.mjs"', `from "${patchGenerationPromptUrl}"`)
  .replace('from "./intelligence-patch-artifact.mjs"', `from "${artifactUrl}"`)
);
const patchStoreTestUrl = moduleUrl(`
import { getPrivatePatchArtifactPath } from "${patchStoreUrl}";
export { getPrivatePatchArtifactPath };
export async function storePrivatePatchArtifact(args) {
  const hook = globalThis.__MEHRAN_PATCH_TEST_HOOKS?.store;
  if (typeof hook !== "function") throw new Error("Patch storage test hook is not configured.");
  return hook(args);
}
export async function verifyPrivatePatchArtifactAtPath(args) {
  const hook = globalThis.__MEHRAN_PATCH_TEST_HOOKS?.verify;
  if (typeof hook !== "function") throw new Error("Patch verification test hook is not configured.");
  return hook(args);
}
export async function getVerifiedPrivatePatchArtifactAtPath(args) {
  const hook = globalThis.__MEHRAN_PATCH_TEST_HOOKS?.retrieve;
  if (typeof hook !== "function") throw new Error("Patch retrieval test hook is not configured.");
  return hook(args);
}
`);
const patchGenerationTestUrl = moduleUrl(`
export async function generatePatchArtifact(args) {
  const hook = globalThis.__MEHRAN_PATCH_TEST_HOOKS?.generate;
  if (typeof hook !== "function") return { ok: false, code: "test_generation_hook_missing" };
  return hook(args);
}
`);
const workerRest = workerSource.replace(capabilityImport, "")
  .replace(patchStoreImport, "")
  .replace(patchGenerationImport, "")
  .replace(inboxSchemaImport, "")
  .replace(routinePlannerImport, "");
const workerSourceForTest = routinePlannerSource + `\nimport { storePrivatePatchArtifact, verifyPrivatePatchArtifactAtPath, getPrivatePatchArtifactPath, getVerifiedPrivatePatchArtifactAtPath } from "${patchStoreTestUrl}";
import { generatePatchArtifact } from "${patchGenerationTestUrl}";
import { validatePrivateIntelligenceMission } from "${inboxSchemaUrl}";
const INTELLIGENCE_ACTION_TYPES = ${JSON.stringify(INTELLIGENCE_ACTION_TYPES)};
const PREAPPROVED_INTELLIGENCE_ACTION_TYPES = ${JSON.stringify(PREAPPROVED_INTELLIGENCE_ACTION_TYPES)};
` + workerRest;

let workerModule;
try {
  workerModule = await import("data:text/javascript;base64," + Buffer.from(workerSourceForTest).toString("base64"));
} catch (error) {
  throw new Error("Worker smoke harness import failed: " + String(error?.name || "Error") + ": " + String(error?.message || error).slice(0,1000));
}
const patchStoreModule = await import(patchStoreUrl);
const worker = workerModule.default;
const { verifyIntelligenceReport, validateIntelligenceWorkPackage, persistIntelligencePackageReport } = workerModule;

function mockDb() {
  return {
    prepare(sql) {
      return {
        async first() {
          if (sql.includes("SELECT 1 AS test")) return { test: 1 };
          if (sql.includes("FROM intelligence_scheduler_runs")) return null;
          throw new Error("Unexpected SQL in smoke test: " + sql);
        }
      };
    }
  };
}

async function request(path, { method = "GET", origin, headers = {}, body } = {}, env = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", origin);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  return worker.fetch(new Request("https://worker.test" + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

test("health endpoint reports online and confirms the database binding", async () => {
  const response = await request("/health", {}, { DB: mockDb() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
  const payload = await response.json();
  assert.equal(payload.status, "online");
  assert.equal(payload.database, true);
});

test("health endpoint exposes only a safe scheduler heartbeat summary", async () => {
  const db = {
    prepare(sql) {
      return {
        async first() {
          if (sql.includes("SELECT 1 AS test")) return { test: 1 };
          if (sql.includes("FROM intelligence_scheduler_runs")) return {
            started_at: "2026-11-18T04:00:00.000Z",
            finished_at: "2026-11-18T04:00:02.000Z",
            status: "completed", processed_count: 2,
            completed_count: 2, blocked_count: 0
          };
          throw new Error("Unexpected SQL: " + sql);
        }
      };
    }
  };
  const response = await request("/health", {}, { DB: db });
  const payload = await response.json();
  assert.equal(payload.version, "5.9");
  assert.deepEqual(payload.scheduler, {
    lastStartedAt: "2026-11-18T04:00:00.000Z",
    lastFinishedAt: "2026-11-18T04:00:02.000Z",
    lastStatus: "completed", processed: 2, completed: 2, blocked: 0
  });
  assert.equal("error" in payload.scheduler, false);
});


test("health endpoint exposes only bounded private inbox diagnostics", async () => {
  const db = {
    prepare(sql) {
      return {
        async first() {
          if (sql.includes("SELECT 1 AS test")) return { test: 1 };
          if (sql.includes("FROM intelligence_scheduler_runs")) return null;
          if (sql.includes("FROM intelligence_inbox_diagnostics")) return {
            last_checked_at: "2026-11-24T17:00:00.000Z",
            last_status: "rejected",
            scanned_count: 3,
            imported_count: 0,
            rejected_count: 1,
            last_rejection_code: "status_mismatch",
            last_error_code: ""
          };
          throw new Error("Unexpected SQL: " + sql);
        }
      };
    }
  };
  const response = await request("/health", {}, { DB: db });
  const payload = await response.json();
  assert.deepEqual(payload.privateInbox, {
    lastCheckedAt: "2026-11-24T17:00:00.000Z",
    lastStatus: "rejected",
    scanned: 3,
    imported: 0,
    rejected: 1,
    lastRejectionCode: "status_mismatch",
    lastErrorCode: null
  });
  assert.equal(JSON.stringify(payload.privateInbox).includes("mission_id"), false);
});

test("private inbox uses the shared schema validator and fair round-robin scanning", () => {
  assert.match(workerSource, /validatePrivateIntelligenceMission\(mission\)/);
  assert.match(workerSource, /INTELLIGENCE_PRIVATE_INBOX_REJECTED/);
  assert.match(workerSource, /orderedCandidates\.slice\(0, 20\)/);
  assert.match(workerSource, /last_entry_name/);
  assert.match(workerSource, /mission\?\.status === "ingested"/);
});

test("health endpoint remains diagnostic when database binding is absent", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.database, false);
});

test("foreign browser origins are rejected before route handling", async () => {
  const response = await request("/health", { origin: "https://attacker.example" });
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden");
});

test("allowed CORS preflight returns the expected methods and headers", async () => {
  const response = await request("/health", {
    method: "OPTIONS",
    origin: "https://mehranmsh.github.io"
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("database-backed routes fail closed when the DB binding is missing", async () => {
  for (const path of ["/projects", "/social/profile", "/admin/overview"]) {
    const response = await request(path);
    assert.equal(response.status, 503, path + " should return 503 without DB");
    const payload = await response.json();
    assert.match(payload.error, /Database binding is missing/);
  }
});

test("unknown routes return a structured 404 response", async () => {
  const response = await request("/this-route-does-not-exist");
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.success, false);
});

test("admin overview rejects requests without a verified admin session", async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async run() { return { success: true, meta: { changes: 0 } }; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("SELECT uid,username,expires_at FROM admin_sessions")) return null;
          return { total: 0 };
        }
      };
    }
  };
  const response = await request("/admin/overview", {}, { DB: db });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.match(payload.error, /Admin authentication required/);
});

test("MEHRAN INTELLIGENCE serves exact project and SOCIAL status queries without Workers AI", () => {
  const start = workerSource.indexOf('if (path === "/intelligence/chat" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/admin/overview"', start);
  assert.ok(start >= 0 && end > start, "Intelligence chat route must exist");
  const route = workerSource.slice(start, end);
  assert.ok(route.indexOf("deterministic_project_status") < route.indexOf("reserveSocialWorkersAIBudget"));
  assert.ok(route.indexOf("deterministic_social_metrics") < route.indexOf("reserveSocialWorkersAIBudget"));
  assert.ok(route.indexOf("deterministic_project_status") < route.indexOf('if (!env.AI || typeof env.AI.run'));
  assert.ok(route.indexOf("deterministic_social_metrics") < route.indexOf('if (!env.AI || typeof env.AI.run'));
  assert.match(route, /SELECT name,status FROM projects ORDER BY created_at DESC LIMIT 30/);
  assert.match(route, /SELECT COUNT\(\*\) AS total FROM social_users/);
  assert.match(route, /aiRequests:0,reason:"deterministic_project_status"/);
  assert.match(route, /aiRequests:0,reason:"deterministic_social_metrics"/);
  assert.ok(workerSource.includes(String.raw`replace(/[!؟?.،,\s\u200c]+/gu, "")`));
});

test("MEHRAN INTELLIGENCE chat uses one inference and formats safe tool results deterministically", () => {
  const start = workerSource.indexOf('if (path === "/intelligence/chat" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/admin/overview" && method === "GET")', start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  assert.ok(route.indexOf("deterministic_short_circuit") < route.indexOf("reserveSocialWorkersAIBudget"));
  assert.equal(route.split("env.AI.run(").length - 1, 1, "one user request may invoke Workers AI only once");
  assert.ok(route.includes("Array.isArray(result?.tool_calls) ? result.tool_calls.slice(0,2) : []"));
  assert.ok(route.includes("single_inference_tool_execution"));
  assert.ok(route.includes("get_project_status"));
  assert.ok(route.includes("get_social_metrics"));
  assert.ok(route.includes("list_collaboration_tasks"));
  assert.ok(route.includes("propose_collaboration_task"));
  assert.ok(!route.includes('messages.push({role:"tool"'));
  assert.equal(route.split("max_tokens:650").length - 1, 1);
});

test("security guardrails keep request bodies bounded and CORS restricted", () => {
  assert.match(workerSource, /const MAX_BODY_BYTES = 100000;/);
  assert.match(workerSource, /origin !== ALLOWED_ORIGIN/);
  assert.match(workerSource, /Access-Control-Allow-Origin": ALLOWED_ORIGIN/);
});

test("password hashing parameters remain explicit and compatible with the deployed history", () => {
  assert.match(workerSource, /const PBKDF2_ITERATIONS = 100000;/);
  assert.match(workerSource, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(workerSource, /hash: "SHA-256"/);
  assert.match(workerSource, /expected\.length !== 32/);
  assert.match(workerSource, /iterations !== PBKDF2_ITERATIONS/);
});

test("MEHRAN INTELLIGENCE MCP exposes authenticated collaboration task tools with bounded schemas", () => {
  assert.ok(indexSource.includes('path==="/mcp"'));
  assert.ok(indexSource.includes('id="testMcpBtn"'));
  const start = workerSource.indexOf('if (path === "/mcp" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/intelligence/chat" && method === "POST")', start);
  assert.ok(start >= 0 && end > start, "MCP route must exist before the AI chat route");
  const route = workerSource.slice(start, end);
  assert.match(route, /checkRateLimit\(env, request, "intelligence-mcp-auth", 120, 60, 60\)/);
  assert.ok(route.indexOf('"intelligence-mcp-auth"') < route.indexOf("verifyAdmin(request, env)"),
    "MCP source-IP throttling must run before credential verification");
  assert.match(route, /verifyAdmin\(request, env\)/);
  assert.match(route, /checkRateLimit\(env, request, "intelligence-mcp", 60, 60, 60, admin\.uid\)/);
  assert.match(route, /rpc\.method === "initialize"/);
  assert.match(route, /rpc\.method === "tools\/list"/);
  assert.match(route, /rpc\.method === "tools\/call"/);
  for (const tool of ["get_project_status","get_social_metrics","get_service_health","get_management_report","create_collaboration_task","list_collaboration_tasks","update_collaboration_task"]) {
    assert.ok(route.includes(tool), `missing MCP tool: ${tool}`);
  }
  assert.match(route, /additionalProperties:false/);
  assert.match(route, /ensureIntelligenceTaskTable\(env\)/);
  assert.match(route, /writeAdminAudit\(env,admin/);
  assert.match(workerSource, /CREATE TABLE IF NOT EXISTS intelligence_tasks/);
  assert.match(workerSource, /path === "\/intelligence\/tasks"/);
  assert.match(workerSource, /intelligenceTaskMatch/);
  assert.match(route, /No execution was performed/);
  assert.match(route, /const requiresApproval = bridgeAuthorized \? true : Boolean\(args\.requiresApproval\)/);
  assert.match(route, /actionType:\{type:"string",enum:\["project_status_report","social_metrics_report","service_health_report","repository_quality_check"\]\}/);
  assert.match(route, /action_type,action_payload/);
  assert.match(route, /Allowlisted report actions must be assigned to mehran_intelligence or shared/);
  assert.match(route, /bridgeAuthorized \? true : Boolean\(args\.requiresApproval\)/);
  assert.match(route, /requiresApproval\?'awaiting_approval':'queued'/);
  assert.match(route, /MEHRAN_MCP_TOKEN/);
  assert.match(route, /get_company_map/);
  assert.match(route, /get_module_status/);
  assert.match(route, /key:"studio",name:"STUDIO"/);
  assert.match(workerSource, /Object\.prototype\.hasOwnProperty\.call\(body,"result"\)/);
  assert.match(route, /const allowed=\["taskId","status"\]/);
  assert.match(route, /Object\.keys\(args\)\.some\(k=>!allowed\.includes\(k\)\)/);
  assert.match(indexSource, /task\.status==="awaiting_approval"\?"accepted"/);
});

test("Intelligence task listing repairs only stale approval labels on explicitly pre-authorized read-only tasks", () => {
  const start = workerSource.indexOf('if (path === "/intelligence/tasks" && ["GET","POST"].includes(method))');
  const end = workerSource.indexOf('const intelligenceTaskMatch=', start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  assert.match(route, /status='awaiting_approval' AND requires_approval=0/);
  assert.ok(route.includes("assigned_to IN ('mehran_intelligence','shared')"));
  assert.ok(route.includes("action_type IN ('project_status_report','social_metrics_report','service_health_report','repository_quality_check')"));
  assert.ok(route.indexOf("UPDATE intelligence_tasks") < route.indexOf("SELECT * FROM intelligence_tasks"));
});

test("work-package action types must stay within the declared per-package scope", () => {
  const base = {
    idempotencyKey: "scope-check-2026-11-25-a1",
    title: "Scoped capability validation",
    objective: "Ensure task actions cannot exceed the package scope.",
    scope: { mode: "read_only", allowedActions: ["service_health_report"] },
    tasks: [{ taskId: "health", title: "Check health", actionType: "service_health_report" }]
  };
  assert.equal(validateIntelligenceWorkPackage(base).ok, true);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, tasks: [{ ...base.tasks[0], actionType: "repository_quality_check" }]
  }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, scope: { ...base.scope, allowedActions: ["service_health_report", "service_health_report"] }
  }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, scope: { ...base.scope, allowedActions: ["shell_command"] }
  }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, scope: { ...base.scope, allowedActions: "service_health_report" }
  }).ok, false);
});

test("proposal-only work-package tasks require a bounded objective", () => {
  const base = {
    idempotencyKey: "patch-proposal-queue-001",
    title: "Prepare a bounded test proposal",
    objective: "Generate one private regression-test proposal",
    priority: "normal",
    scope: { modules: ["intelligence"], private: true },
    tasks: [{
      taskId: "patch", title: "Propose a regression test", description: "Create a narrow test-only proposal",
      actionType: "propose_code_patch", dependsOn: [], objective: "Add regression coverage for an identified validation edge case"
    }]
  };
  const valid = validateIntelligenceWorkPackage(base);
  assert.equal(valid.ok, true);
  assert.equal(valid.tasks[0].objective, base.tasks[0].objective);
  assert.equal(validateIntelligenceWorkPackage({ ...base, tasks: [{ ...base.tasks[0], objective: "short" }] }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({ ...base, tasks: [{ ...base.tasks[0], objective: undefined }] }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({ ...base, tasks: [{ ...base.tasks[0], actionType: "service_health_report" }] }).ok, false);
});

test("proposal queue is owner-authenticated and claims are bound to one runner", () => {
  const ownerGuard = workerSource.slice(workerSource.indexOf('const ownerOrchestrationRoute ='), workerSource.indexOf('const configuredToken =', workerSource.indexOf('const ownerOrchestrationRoute =')));
  assert.match(ownerGuard, /patch-proposals\/pending/);
  assert.match(ownerGuard, /patch-proposals\/claim/);
  assert.match(ownerGuard, /patch-proposals\/complete/);
  const start = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/pending" && method === "GET")');
  const end = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/artifact" && method === "GET")', start);
  assert.ok(start >= 0 && end > start);
  const routes = workerSource.slice(start, end);
  assert.match(routes, /WHERE status='stored'.*LIMIT 3/);
  assert.match(routes, /SET status='claimed',runner_run_id=\?/);
  assert.match(routes, /status='claimed' AND runner_run_id=\?/);
  assert.match(routes, /"pull_request_created","failed"/);
});

test("private patch retrieval is authenticated, rate-limited, digest-verified, and bound to D1 metadata", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/artifact" && method === "GET")');
  const end = workerSource.indexOf('if (path === "/agent/v1/repository/analyze" && method === "POST")', start);
  assert.ok(start >= 0 && end > start, "private artifact retrieval route must exist before repository analysis");
  const route = workerSource.slice(start, end);
  assert.match(route, /url\.searchParams\.get\("path"\)/);
  assert.match(route, /url\.searchParams\.get\("artifactSha256"\)/);
  assert.match(route, /ensureSocialTables\(env\)/);
  assert.match(route, /checkRateLimit\(env,request,"intelligence-patch-artifact-read",12,3600,3600\)/);
  assert.match(route, /getVerifiedPrivatePatchArtifactAtPath\(/);
  assert.match(route, /stored\.artifact_path !== artifactPath/);
  assert.match(route, /stored\.artifact_sha256 !== artifactSha256/);
  assert.match(route, /stored\.diff_sha256 !== artifact\.diffSha256/);
  assert.match(route, /stored\.status !== "claimed"/);
  assert.match(route, /stored\.runner_run_id !== runId/);
  assert.match(route, /artifact\.targetPath !== "scripts\/intelligence-capabilities\.test\.mjs"/);
  assert.match(route, /mode:"verified_proposal_data_only"/);
  assert.match(route, /diff:artifact\.diff/);
});

test("patch proposal task reports are independently verified and bound to private artifact metadata", () => {
  const proposalId = "123e4567-e89b-42d3-a456-426614174000";
  const report = {
    type: "propose_code_patch", generatedAt: "2026-11-23T12:00:00.000Z",
    requestId: "package-id:patch", requestHash: "A".repeat(43), proposalId,
    path: `patch-proposals/2026/11/${proposalId}.json`,
    artifactSha256: "a".repeat(64), diffSha256: "b".repeat(64), status: "stored",
    baseSha: "c".repeat(40), targetPath: "scripts/intelligence-capabilities.test.mjs",
    validationMode: "append_only_validate_only", summary: "Add a bounded regression test for a validation edge case"
  };
  assert.equal(verifyIntelligenceReport("propose_code_patch", report).passed, true);
  assert.equal(verifyIntelligenceReport("propose_code_patch", { ...report, path: "patch-proposals/2026/11/other.json" }).passed, false);
  assert.equal(verifyIntelligenceReport("propose_code_patch", { ...report, validationMode: "apply_patch" }).passed, false);
});

test("Agent patch proposal runner checkpoints an immutable base and submits a stable task request ID", () => {
  assert.match(runnerSource, /if \(task\.actionType === "propose_code_patch"\)/);
  assert.match(runnerSource, /\/agent\/v1\/patch-proposals\/generate/);
  assert.match(runnerSource, /requestId: task\.id/);
  assert.match(runnerSource, /checkpoint: \{ baseSha \}/);
  assert.match(runnerSource, /retryable = !isWorkersAIInferenceFailure && \(/);
  assert.match(runnerSource, /isWorkersAIInferenceFailure = error\?\.safeDiagnostic\?\.stage === "workers_ai_inference"/);
  assert.match(runnerSource, /JSON\.stringify\(\{ status, result, retryable, claimToken: task\.claimToken \}\)/);
  assert.match(workerSource, /parsedReport\.requestId !== id/);
  assert.match(workerSource, /checkpoint\.baseSha !== parsedReport\.baseSha/);
  assert.match(workerSource, /parsedReport\.requestHash !== expectedHash/);
});

test("Agent API stale-claim recovery includes package-bound allowlisted tasks", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/tasks/next" && method === "GET")');
  const end = workerSource.indexOf("const checkpointMatch", start);
  assert.ok(start >= 0 && end > start, "Agent task-claim route must exist");
  const route = workerSource.slice(start, end);
  assert.equal((route.match(/UPDATE intelligence_tasks SET status='blocked'/g) || []).length, 1);
  assert.equal((route.match(/UPDATE intelligence_tasks SET status='accepted'/g) || []).length, 1);
  assert.match(route, /datetime\(agent_claimed_at\) < datetime\('now','-15 minutes'\)/);
  assert.match(route, /action_type IN \('repository_quality_check','service_health_report','source_security_audit','inspect_repository','run_repository_tests','propose_code_patch'\)/);
  assert.match(route, /work_package_id IS NULL OR EXISTS \(SELECT 1 FROM intelligence_work_packages wp, json_each\(wp\.scope_json, '\$\.allowedActions'\) scoped WHERE wp\.id=t\.work_package_id AND scoped\.value=t\.action_type\)/,
    "claim selection must revalidate each package task against its persisted allowedActions");
  assert.match(route, /WHERE id=\? AND status IN \('queued','accepted','retry_wait'\).*work_package_id IS NULL OR EXISTS/s,
    "the atomic claim update must repeat the package scope guard");
  const checkpointStart = workerSource.indexOf("const checkpointMatch", start);
  const resultStart = workerSource.indexOf("const agentResultMatch", checkpointStart);
  const resultEnd = workerSource.indexOf('return error("Not found",404);', resultStart);
  assert.match(workerSource.slice(checkpointStart, resultStart), /json_each\(wp\.scope_json, '\$\.allowedActions'\)/,
    "checkpoint writes must reject tasks outside their package scope");
  assert.match(workerSource.slice(resultStart, resultEnd), /json_each\(wp\.scope_json, '\$\.allowedActions'\)/,
    "result commits must reject tasks outside their package scope");
});

test("owner task hub validates proposal-only payloads before queueing", () => {
  const start = workerSource.indexOf('if (path === "/intelligence/tasks" && ["GET","POST"].includes(method))');
  const end = workerSource.indexOf("const intelligenceTaskMatch=path.match", start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  assert.match(route, /actionType==="propose_code_patch"/);
  assert.match(route, /supplied\.objective\.trim\(\)\.length<12/);
  assert.match(route, /action_payload/);
});

test("MEHRAN collaboration task APIs reject unauthenticated access", async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async run() { return { success: true, meta: { changes: 0 } }; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("SELECT uid,username,expires_at FROM admin_sessions")) return null;
          return { total: 0 };
        }
      };
    }
  };
  const response = await request("/intelligence/tasks", {}, { DB: db });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.match(payload.error, /Admin authentication required/);
});


test("AI patch generation endpoint requires the dedicated agent bearer token", async () => {
  const response = await request("/agent/v1/patch-proposals/generate", {
    method: "POST",
    headers: { Authorization: "Bearer " + "x".repeat(48) },
    body: { baseSha: "a".repeat(40), objective: "Add a bounded regression test", requestId: "task-12345678" }
  }, { DB: mockDb(), MEHRAN_AGENT_TOKEN: "s".repeat(48) });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.match(payload.error, /Agent authentication required/);
});

test("AI patch generation endpoint has a strict bounded request and storage-only response", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/generate" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/agent/v1/patch-proposals" && method === "POST")', start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  assert.match(route, /Object\.keys\(body\)\.sort\(\)\.join\(","\) !== "baseSha,objective,requestId"/);
  assert.match(route, /checkRateLimit\(env,request,"intelligence-patch-generation",3,86400,86400\)/);
  assert.match(route, /reserveSocialWorkersAIBudget\(env,credits,"intelligence"\)/);
  assert.match(route, /storePrivatePatchArtifact/);
  assert.match(route, /intelligence_patch_generation_requests/);
  assert.match(route, /verifyPrivatePatchArtifactAtPath/);
  assert.match(route, /finalizePatchGenerationRequest/);
  assert.match(route, /reservation\?\.meta\?\.changes/);
  assert.ok(route.indexOf("await ensureSocialTables(env)") <
    route.indexOf("INSERT OR IGNORE INTO intelligence_patch_generation_requests"),
    "rate-limit storage initialization must finish before the request enters processing");
  assert.ok(route.indexOf("INSERT OR IGNORE INTO intelligence_patch_generation_requests") <
    route.indexOf('checkRateLimit(env,request,"intelligence-patch-generation",3,86400,86400)'),
    "only the atomic single-winner reservation may consume an IP rate-limit slot");
  assert.match(route, /failure_code='rate_limited'/);
  assert.ok(route.indexOf('checkRateLimit(env,request,"intelligence-patch-generation",3,86400,86400)') <
    route.indexOf("const generated = await generatePatchArtifact"),
    "rate limiting must still happen before any AI generation or budget reservation");
  assert.match(route, /existing\.status === "stored"/);
  assert.match(route, /status='prepared'/);
  assert.doesNotMatch(route, /diff\s*:/);
  assert.match(route, /validationMode:row\.validation_mode/);
  const generationFailure = route.slice(route.indexOf("if (!generated.ok)"), route.indexOf("const artifact = generated.artifact"));
  assert.match(generationFailure, /source_fetch_failed.*502/);
  assert.doesNotMatch(generationFailure, /\? 503/,
    "HTTP 503 is reserved for prepared-artifact recovery paths that are safe to retry with the same request ID");
});

test("stale processing patch requests fail closed without regenerating under the same idempotency key", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/generate" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/agent/v1/patch-proposals" && method === "POST")', start);
  const route = workerSource.slice(start, end);
  assert.match(route, /existing\.status === "processing"/);
  assert.match(route, /status='failed',failure_code='processing_timeout'/);
  assert.match(route, /datetime\(updated_at\)<datetime\('now','-10 minutes'\)/);
  assert.match(route, /previous generation attempt expired; submit a new request ID/);
  const processingBranch = route.slice(route.indexOf('if (existing.status === "processing")'), route.indexOf('return error("This generation request is terminal;'));
  assert.doesNotMatch(processingBranch, /generatePatchArtifact/,
    "an uncertain prior AI attempt must never be silently regenerated with the same request ID");
  assert.match(runnerSource, /already in progress\|concurrently reserved/);
  assert.match(runnerSource, /Number\(error\?\.status\) === 409/);
  assert.match(runnerSource, /agentHeaders, 90000/,
    "the runner's patch-generation request must stay within its explicit 90-second timeout");
  assert.match(route, /datetime\(updated_at\)<datetime\('now','-10 minutes'\)/,
    "the Worker must fail closed only after the bounded processing window expires");
});

test("simultaneous first delivery uses the atomic request reservation as the single-winner gate", async () => {
  const requestId = "simultaneous-first-delivery-0001";
  const baseSha = "f".repeat(40);
  const objective = "Verify the atomic reservation protects concurrent first delivery";
  const created = await createPatchArtifactRecord({
    proposalId: "123e4567-e89b-42d3-a456-426614174005",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha,
    summary: "Atomic reservation fixture",
    targetPaths: ["scripts/intelligence-capabilities.test.mjs"],
    diff: [
      "--- a/scripts/intelligence-capabilities.test.mjs",
      "+++ b/scripts/intelligence-capabilities.test.mjs",
      "@@ -0,0 +1 @@",
      "+// atomic reservation fixture",
      ""
    ].join("\n")
  });
  assert.equal(created.ok, true);
  const artifactPath = patchStoreModule.getPrivatePatchArtifactPath(created.artifact);
  const state = { request: null, proposal: null, initialReads: 0, generationCalls: 0, budgetReservations: 0, stores: 0 };
  let releaseInitialReads;
  const bothInitialReads = new Promise(resolve => { releaseInitialReads = resolve; });
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("FROM intelligence_patch_generation_requests WHERE request_id=?")) {
            if (state.initialReads < 2) {
              state.initialReads += 1;
              if (state.initialReads === 2) releaseInitialReads();
              await bothInitialReads;
              return null;
            }
            return state.request ? { ...state.request } : null;
          }
          if (sql.includes("FROM intelligence_patch_proposals WHERE proposal_id=?")) {
            return state.proposal ? { ...state.proposal } : null;
          }
          if (sql.includes("RETURNING attempts,blocked_until")) return { attempts: 1, blocked_until: null };
          if (sql.includes("RETURNING intelligence_reserved")) {
            state.budgetReservations += 1;
            return { product_reserved: 250, total_reserved: 250, request_count: state.budgetReservations };
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO intelligence_patch_generation_requests")) {
            if (state.request) return { meta: { changes: 0 } };
            state.request = {
              request_id: values[0], request_hash: values[1], base_sha: values[2],
              status: "processing", proposal_id: null, target_path: null, summary: null,
              artifact_path: null, artifact_sha256: null, diff_sha256: null,
              validation_mode: null, failure_code: "", created_at: "2026-11-23T00:00:00.000Z"
            };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE intelligence_patch_generation_requests SET status='prepared'")) {
            const [proposalId,targetPath,summary,path,artifactSha,diffSha,validationMode,id] = values;
            if (state.request?.request_id === id && state.request.status === "processing") {
              Object.assign(state.request,{status:"prepared",proposal_id:proposalId,target_path:targetPath,
                summary,artifact_path:path,artifact_sha256:artifactSha,diff_sha256:diffSha,
                validation_mode:validationMode});
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO intelligence_patch_proposals")) {
            const [proposalId,baseShaValue,targetPath,summary,path,artifactSha,diffSha,createdAt] = values;
            if (!state.proposal) state.proposal = {
              proposal_id:proposalId,base_sha:baseShaValue,target_path:targetPath,summary,
              artifact_path:path,artifact_sha256:artifactSha,diff_sha256:diffSha,status:"stored",created_at:createdAt
            };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE intelligence_patch_generation_requests SET status='stored'")) {
            const [id,artifactSha] = values;
            if (state.request?.request_id === id && state.request.status === "prepared" &&
                state.request.artifact_sha256 === artifactSha) state.request.status = "stored";
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        }
      };
    }
  };
  globalThis.__MEHRAN_PATCH_TEST_HOOKS = {
    async generate(args) {
      state.generationCalls += 1;
      const budget = await args.reserveBudget(250);
      assert.equal(budget.allowed, true);
      return { ok: true, artifact: created.artifact, artifactSha256: created.artifactSha256,
        validation: { mode: "bounded_static" } };
    },
    async store(args) {
      state.stores += 1;
      assert.equal(args.artifactSha256, created.artifactSha256);
      return { stored: true, path: artifactPath, artifactSha256: created.artifactSha256 };
    },
    async verify() {
      return { stored: true, alreadyExists: true, path: artifactPath, artifactSha256: created.artifactSha256 };
    }
  };
  try {
    const env = { DB: db, MEHRAN_AGENT_TOKEN: "s".repeat(48), MEHRAN_REPORTS_GITHUB_TOKEN: "r".repeat(48) };
    const payload = { baseSha, objective, requestId };
    const headers = { Authorization: "Bearer " + "s".repeat(48) };
    const responses = await Promise.all([
      request("/agent/v1/patch-proposals/generate", { method: "POST", headers, body: payload }, env),
      request("/agent/v1/patch-proposals/generate", { method: "POST", headers, body: payload }, env)
    ]);
    const statuses = responses.map(response => response.status).sort((a,b) => a-b);
    assert.deepEqual(statuses, [200,409]);
    assert.equal(state.initialReads, 2, "both callers must observe the initially absent request before racing to reserve it");
    assert.equal(state.generationCalls, 1, "the atomic primary-key reservation must elect exactly one generator");
    assert.equal(state.budgetReservations, 1, "only the reservation winner may spend the AI budget");
    assert.equal(state.stores, 1, "only one private artifact write is permitted");
    assert.equal(state.proposal.proposal_id, created.artifact.proposalId);
    assert.equal(state.request.status, "stored");
  } finally {
    delete globalThis.__MEHRAN_PATCH_TEST_HOOKS;
  }
});

test("concurrent duplicate delivery cannot regenerate or reserve AI budget twice", async () => {
  const requestId = "concurrent-duplicate-0001";
  const baseSha = "e".repeat(40);
  const objective = "Add a concurrency-safe duplicate delivery regression test";
  const created = await createPatchArtifactRecord({
    proposalId: "123e4567-e89b-42d3-a456-426614174004",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha,
    summary: "Concurrent delivery fixture",
    targetPaths: ["scripts/intelligence-capabilities.test.mjs"],
    diff: [
      "--- a/scripts/intelligence-capabilities.test.mjs",
      "+++ b/scripts/intelligence-capabilities.test.mjs",
      "@@ -0,0 +1 @@",
      "+// concurrent duplicate fixture",
      ""
    ].join("\n")
  });
  assert.equal(created.ok, true);
  const artifactPath = patchStoreModule.getPrivatePatchArtifactPath(created.artifact);
  const state = { request: null, proposal: null, generated: 0, budgetReservations: 0, stores: 0 };
  let releaseGeneration;
  let generationStarted;
  const started = new Promise(resolve => { generationStarted = resolve; });
  const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("FROM intelligence_patch_generation_requests WHERE request_id=?")) {
            return state.request ? { ...state.request } : null;
          }
          if (sql.includes("FROM intelligence_patch_proposals WHERE proposal_id=?")) {
            return state.proposal ? { ...state.proposal } : null;
          }
          if (sql.includes("RETURNING attempts,blocked_until")) return { attempts: 1, blocked_until: null };
          if (sql.includes("RETURNING intelligence_reserved")) {
            state.budgetReservations += 1;
            return { product_reserved: 250, total_reserved: 250, request_count: state.budgetReservations };
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO intelligence_patch_generation_requests")) {
            if (state.request) return { meta: { changes: 0 } };
            state.request = {
              request_id: values[0], request_hash: values[1], base_sha: values[2],
              status: "processing", proposal_id: null, target_path: null, summary: null,
              artifact_path: null, artifact_sha256: null, diff_sha256: null,
              validation_mode: null, failure_code: "", created_at: "2026-11-23T00:00:00.000Z"
            };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE intelligence_patch_generation_requests SET status='prepared'")) {
            const [proposalId,targetPath,summary,path,artifactSha,diffSha,validationMode,id] = values;
            if (state.request?.request_id === id && state.request.status === "processing") {
              Object.assign(state.request,{status:"prepared",proposal_id:proposalId,target_path:targetPath,
                summary,artifact_path:path,artifact_sha256:artifactSha,diff_sha256:diffSha,
                validation_mode:validationMode});
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO intelligence_patch_proposals")) {
            const [proposalId,baseShaValue,targetPath,summary,path,artifactSha,diffSha,createdAt] = values;
            if (!state.proposal) state.proposal = {
              proposal_id:proposalId,base_sha:baseShaValue,target_path:targetPath,summary,
              artifact_path:path,artifact_sha256:artifactSha,diff_sha256:diffSha,status:"stored",created_at:createdAt
            };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE intelligence_patch_generation_requests SET status='stored'")) {
            const [id,artifactSha] = values;
            if (state.request?.request_id === id && state.request.status === "prepared" &&
                state.request.artifact_sha256 === artifactSha) state.request.status = "stored";
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        }
      };
    }
  };
  globalThis.__MEHRAN_PATCH_TEST_HOOKS = {
    async generate(args) {
      state.generated += 1;
      generationStarted();
      await generationGate;
      const budget = await args.reserveBudget(250);
      assert.equal(budget.allowed, true);
      return { ok: true, artifact: created.artifact, artifactSha256: created.artifactSha256,
        validation: { mode: "bounded_static" } };
    },
    async store(args) {
      state.stores += 1;
      assert.equal(args.artifactSha256, created.artifactSha256);
      return { stored: true, path: artifactPath, artifactSha256: created.artifactSha256 };
    },
    async verify() {
      return { stored: true, alreadyExists: true, path: artifactPath, artifactSha256: created.artifactSha256 };
    }
  };
  try {
    const env = { DB: db, MEHRAN_AGENT_TOKEN: "s".repeat(48), MEHRAN_REPORTS_GITHUB_TOKEN: "r".repeat(48) };
    const payload = { baseSha, objective, requestId };
    const headers = { Authorization: "Bearer " + "s".repeat(48) };
    const firstPromise = request("/agent/v1/patch-proposals/generate", {
      method: "POST", headers, body: payload
    }, env);
    await started;
    const duplicate = await request("/agent/v1/patch-proposals/generate", {
      method: "POST", headers, body: payload
    }, env);
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /already in progress/);
    assert.equal(state.generated, 1, "the duplicate must not start a second AI generation");
    assert.equal(state.budgetReservations, 0, "the duplicate must not reserve AI budget while the first generation is active");
    assert.equal(state.stores, 0);
    releaseGeneration();
    const first = await firstPromise;
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.status, "stored");
    assert.equal(result.proposalId, created.artifact.proposalId);
    assert.equal(state.generated, 1);
    assert.equal(state.budgetReservations, 1);
    assert.equal(state.stores, 1);
    assert.equal(state.proposal.proposal_id, created.artifact.proposalId);
    assert.equal(state.request.status, "stored");
  } finally {
    releaseGeneration();
    delete globalThis.__MEHRAN_PATCH_TEST_HOOKS;
  }
});

test("prepared request recovers across storage response loss and partial D1 finalization without regenerating", async () => {
  const requestId = "recovery-crash-0001";
  const baseSha = "d".repeat(40);
  const objective = "Add a deterministic recovery regression test";
  const created = await createPatchArtifactRecord({
    proposalId: "123e4567-e89b-42d3-a456-426614174003",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha,
    summary: "Crash recovery fixture",
    targetPaths: ["scripts/intelligence-capabilities.test.mjs"],
    diff: [
      "--- a/scripts/intelligence-capabilities.test.mjs",
      "+++ b/scripts/intelligence-capabilities.test.mjs",
      "@@ -0,0 +1 @@",
      "+// recovered exactly once",
      ""
    ].join("\n")
  });
  assert.equal(created.ok, true);
  const artifactPath = patchStoreModule.getPrivatePatchArtifactPath(created.artifact);
  const persisted = new Map();
  const state = {
    request: null,
    proposal: null,
    generated: 0,
    store: 0,
    verify: 0,
    proposalInsertAttempts: 0,
    failNextFinalizeUpdate: true
  };
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("FROM intelligence_patch_generation_requests WHERE request_id=?")) {
            return state.request ? { ...state.request } : null;
          }
          if (sql.includes("FROM intelligence_patch_proposals WHERE proposal_id=?")) {
            return state.proposal ? { ...state.proposal } : null;
          }
          if (sql.includes("RETURNING attempts,blocked_until")) return { attempts: 1, blocked_until: null };
          if (sql.includes("RETURNING intelligence_reserved")) {
            return { product_reserved: 250, total_reserved: 250, request_count: 1 };
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO intelligence_patch_generation_requests")) {
            if (state.request) return { meta: { changes: 0 } };
            state.request = {
              request_id: values[0], request_hash: values[1], base_sha: values[2],
              status: "processing", proposal_id: null, target_path: null, summary: null,
              artifact_path: null, artifact_sha256: null, diff_sha256: null,
              validation_mode: null, failure_code: "", created_at: "2026-11-23T00:00:00.000Z"
            };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE intelligence_patch_generation_requests SET status='prepared'")) {
            const [proposalId,targetPath,summary,path,artifactSha,diffSha,validationMode,id] = values;
            if (state.request?.request_id === id && state.request.status === "processing") {
              Object.assign(state.request,{status:"prepared",proposal_id:proposalId,target_path:targetPath,
                summary,artifact_path:path,artifact_sha256:artifactSha,diff_sha256:diffSha,
                validation_mode:validationMode});
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO intelligence_patch_proposals")) {
            state.proposalInsertAttempts += 1;
            const [proposalId,baseShaValue,targetPath,summary,path,artifactSha,diffSha,createdAt] = values;
            if (!state.proposal) state.proposal = {
              proposal_id:proposalId,base_sha:baseShaValue,target_path:targetPath,summary,
              artifact_path:path,artifact_sha256:artifactSha,diff_sha256:diffSha,status:"stored",created_at:createdAt
            };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE intelligence_patch_generation_requests SET status='stored'")) {
            const [id,artifactSha] = values;
            if (state.failNextFinalizeUpdate) {
              state.failNextFinalizeUpdate = false;
              return { meta: { changes: 0 } };
            }
            if (state.request?.request_id === id && state.request.status === "prepared" &&
                state.request.artifact_sha256 === artifactSha) state.request.status = "stored";
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        }
      };
    }
  };
  globalThis.__MEHRAN_PATCH_TEST_HOOKS = {
    async generate(args) {
      state.generated += 1;
      const budget = await args.reserveBudget(250);
      assert.equal(budget.allowed, true);
      return { ok: true, artifact: created.artifact, artifactSha256: created.artifactSha256,
        validation: { mode: "bounded_static" } };
    },
    async store(args) {
      state.store += 1;
      assert.equal(args.artifactSha256, created.artifactSha256);
      // Simulate the remote private file being committed, followed by a lost response.
      persisted.set(artifactPath, { artifact: created.artifact, digest: created.artifactSha256 });
      return { stored: false, code: "artifact_write_failed" };
    },
    async verify(args) {
      state.verify += 1;
      const saved = persisted.get(args.path);
      return saved && saved.digest === args.artifactSha256
        ? { stored: true, alreadyExists: true, path: args.path, artifactSha256: saved.digest }
        : { stored: false, code: "artifact_not_found" };
    }
  };
  try {
    const env = { DB: db, MEHRAN_AGENT_TOKEN: "s".repeat(48), MEHRAN_REPORTS_GITHUB_TOKEN: "r".repeat(48) };
    const payload = { baseSha, objective, requestId };
    const first = await request("/agent/v1/patch-proposals/generate", {
      method: "POST", headers: { Authorization: "Bearer " + "s".repeat(48) }, body: payload
    }, env);
    assert.equal(first.status, 503);
    assert.equal((await first.json()).success, false);
    assert.equal(state.request.status, "prepared");
    assert.equal(state.proposal, null);
    assert.equal(state.generated, 1);
    assert.equal(state.store, 1);
    assert.equal(state.verify, 0);

    const finalizeInterrupted = await request("/agent/v1/patch-proposals/generate", {
      method: "POST", headers: { Authorization: "Bearer " + "s".repeat(48) }, body: payload
    }, env);
    assert.equal(finalizeInterrupted.status, 503);
    assert.equal(state.request.status, "prepared");
    assert.equal(state.proposal.proposal_id, created.artifact.proposalId);
    assert.equal(state.proposalInsertAttempts, 1);
    assert.equal(state.generated, 1);
    assert.equal(state.store, 1);
    assert.equal(state.verify, 1);

    const retry = await request("/agent/v1/patch-proposals/generate", {
      method: "POST", headers: { Authorization: "Bearer " + "s".repeat(48) }, body: payload
    }, env);
    assert.equal(retry.status, 200);
    const recovered = await retry.json();
    assert.equal(recovered.status, "stored");
    assert.equal(recovered.proposalId, created.artifact.proposalId);
    assert.equal(recovered.path, artifactPath);
    assert.equal(state.generated, 1, "recovery must not invoke AI generation a second time");
    assert.equal(state.store, 1, "recovery must not attempt another private artifact write");
    assert.equal(state.verify, 2, "each recovery must verify the already-persisted private artifact");
    assert.equal(state.proposalInsertAttempts, 2, "proposal insert must be safely repeatable");
    assert.equal(state.proposal.proposal_id, created.artifact.proposalId);
    assert.equal(state.request.status, "stored");
  } finally {
    delete globalThis.__MEHRAN_PATCH_TEST_HOOKS;
  }
});

test("prepared private patch artifact recovery verifies the exact path and full artifact digest", async () => {
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1 +1 @@",
    "-const original = 1;",
    "+const proposed = 2;",
    ""
  ].join("\n");
  const created = await createPatchArtifactRecord({
    proposalId: "123e4567-e89b-42d3-a456-426614174001",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha: "b".repeat(40),
    summary: "Recovery verification fixture",
    targetPaths: [targetPath],
    diff
  });
  const path = "patch-proposals/2026/11/123e4567-e89b-42d3-a456-426614174001.json";
  const fetchImpl = async () => new Response(JSON.stringify({
    path,
    encoding: "base64",
    content: Buffer.from(JSON.stringify(created.artifact), "utf8").toString("base64")
  }), { status: 200 });
  {
    const verified = await patchStoreModule.verifyPrivatePatchArtifactAtPath({
      token: "r".repeat(48), path, artifactSha256: created.artifactSha256, fetchImpl
    });
    assert.equal(verified.stored, true);
    assert.equal(verified.alreadyExists, true);
    assert.equal(verified.path, path);

    const wrongDigest = await patchStoreModule.verifyPrivatePatchArtifactAtPath({
      token: "r".repeat(48), path, artifactSha256: "f".repeat(64), fetchImpl
    });
    assert.equal(wrongDigest.stored, false);
    assert.equal(wrongDigest.code, "artifact_id_conflict");

    const unsafePath = await patchStoreModule.verifyPrivatePatchArtifactAtPath({
      token: "r".repeat(48), path: "../outside.json", artifactSha256: created.artifactSha256, fetchImpl
    });
    assert.equal(unsafePath.stored, false);
    assert.equal(unsafePath.code, "invalid_artifact_lookup");
    const mismatchedPath = "patch-proposals/2026/11/123e4567-e89b-42d3-a456-426614174099.json";
    const mismatched = await patchStoreModule.verifyPrivatePatchArtifactAtPath({
      token: "r".repeat(48), path: mismatchedPath,
      artifactSha256: created.artifactSha256,
      fetchImpl: async () => new Response(JSON.stringify({
        path: mismatchedPath,
        encoding: "base64",
        content: Buffer.from(JSON.stringify(created.artifact), "utf8").toString("base64")
      }), { status: 200 })
    });
    assert.equal(mismatched.stored, false);
    assert.equal(mismatched.code, "artifact_id_conflict");
    const malformedArtifact = { ...created.artifact, createdAt: "not-a-date" };
    const malformed = await patchStoreModule.verifyPrivatePatchArtifactAtPath({
      token: "r".repeat(48), path,
      artifactSha256: created.artifactSha256,
      fetchImpl: async () => new Response(JSON.stringify({
        path,
        encoding: "base64",
        content: Buffer.from(JSON.stringify(malformedArtifact), "utf8").toString("base64")
      }), { status: 200 })
    });
    assert.equal(malformed.stored, false);
    assert.equal(malformed.code, "artifact_id_conflict");
  }
});

test("private patch artifact storage treats a matching existing artifact as idempotent", async () => {
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -0,0 +1 @@",
    "+// deterministic recovery fixture",
    ""
  ].join("\n");
  const created = await createPatchArtifactRecord({
    proposalId: "123e4567-e89b-42d3-a456-426614174002",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha: "c".repeat(40),
    summary: "Idempotent storage fixture",
    targetPaths: [targetPath],
    diff
  });
  const path = "patch-proposals/2026/11/123e4567-e89b-42d3-a456-426614174002.json";
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.method, "GET", "matching artifact recovery must not issue a PUT");
    return new Response(JSON.stringify({
      path,
      encoding: "base64",
      content: Buffer.from(JSON.stringify(created.artifact), "utf8").toString("base64")
    }), { status: 200 });
  };
  const stored = await patchStoreModule.storePrivatePatchArtifact({
    token: "r".repeat(48), artifact: created.artifact,
    artifactSha256: created.artifactSha256, fetchImpl
  });
  assert.equal(stored.stored, true);
  assert.equal(stored.alreadyExists, true);
  assert.equal(stored.path, path);
  assert.equal(calls, 1);
});

test("authenticated patch proposal route is bound to the dedicated agent token", async () => {
  const response = await request("/agent/v1/patch-proposals", {
    method: "POST",
    headers: { Authorization: "Bearer " + "x".repeat(48) },
    body: { artifact: {}, artifactSha256: "a".repeat(64) }
  }, { DB: mockDb(), MEHRAN_AGENT_TOKEN: "s".repeat(48) });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.match(payload.error, /Agent authentication required/);
});

test("authenticated patch proposal route stores only verified metadata and returns no diff", async () => {
  const targetPath = "scripts/intelligence-capabilities.test.mjs";
  const diff = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1 +1 @@",
    "-const original = 1;",
    "+const proposed = 2;",
    ""
  ].join("\n");
  const created = await createPatchArtifactRecord({
    proposalId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-11-23T00:00:00.000Z",
    baseSha: "a".repeat(40),
    summary: "A verified patch proposal for authenticated route testing",
    targetPaths: [targetPath],
    diff
  });
  const metadata = new Map();
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO intelligence_patch_proposals")) {
            metadata.set(values[0], {
              proposal_id: values[0], base_sha: values[1], target_path: values[2],
              summary: values[3], artifact_path: values[4], artifact_sha256: values[5],
              diff_sha256: values[6], status: "stored", created_at: values[7]
            });
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (sql.includes("FROM intelligence_patch_proposals WHERE proposal_id=?")) {
            return metadata.get(values[0]) || null;
          }
          return null;
        },
        async all() { return { results: [] }; }
      };
    },
    async batch() { return []; }
  };
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (url, options) => {
    outbound.push({ url: String(url), method: options.method });
    if (options.method === "GET") return new Response("", { status: 404 });
    return new Response(JSON.stringify({ content: { path: "patch-proposals/2026/11/123e4567-e89b-42d3-a456-426614174000.json" } }), { status: 201 });
  };
  globalThis.__MEHRAN_PATCH_TEST_HOOKS = {
    store: args => patchStoreModule.storePrivatePatchArtifact(args),
    verify: args => patchStoreModule.verifyPrivatePatchArtifactAtPath(args)
  };
  try {
    const response = await request("/agent/v1/patch-proposals", {
      method: "POST",
      headers: { Authorization: "Bearer " + "s".repeat(48) },
      body: { artifact: created.artifact, artifactSha256: created.artifactSha256 }
    }, {
      DB: db,
      MEHRAN_AGENT_TOKEN: "s".repeat(48),
      MEHRAN_REPORTS_GITHUB_TOKEN: "r".repeat(48)
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.proposalId, created.artifact.proposalId);
    assert.equal(payload.artifactSha256, created.artifactSha256);
    assert.equal("diff" in payload, false);
    assert.equal(outbound.length, 2);
    assert.ok(outbound.every(item => item.url.includes("mehran-intelligence-reports")));
    assert.equal(metadata.size, 1);
    assert.equal(metadata.get(created.artifact.proposalId).diff_sha256, created.artifact.diffSha256);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__MEHRAN_PATCH_TEST_HOOKS;
  }
});

test("patch proposal API rejects unexpected request fields before storage", () => {
  const start = workerSource.indexOf('if (path === "/agent/v1/patch-proposals" && method === "POST")');
  const end = workerSource.indexOf('if (path === "/agent/v1/patch-proposals/artifact" && method === "GET")', start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  assert.match(route, /Object\.keys\(body\)\.sort\(\)\.join\(","\) !== "artifact,artifactSha256"/);
  assert.match(route, /ensureIntelligencePatchProposalTable\(env\)/);
  assert.match(route, /INSERT OR IGNORE INTO intelligence_patch_proposals/);
  assert.doesNotMatch(route, /diff\s*:/, "API response must not echo patch contents");
});
test("private report finalization recovery is owner-authenticated and re-discovers terminal packages", () => {
  const agentStart = workerSource.indexOf('if (path.startsWith("/agent/v1/"))');
  const agentEnd = workerSource.indexOf('if (path === "/health"', agentStart);
  const agentRoute = workerSource.slice(agentStart, agentEnd);
  assert.match(agentRoute, /path === "\/agent\/v1\/work-packages\/pending-finalization" && method === "GET"/);
  assert.match(agentRoute, /MEHRAN_ORCHESTRATOR_TOKEN/);
  assert.match(agentRoute, /status IN \('completed','attention_required'\).*report_stored_at IS NULL.*LIMIT 20/);
  assert.match(workerSource, /ALTER TABLE intelligence_work_packages ADD COLUMN report_stored_at TEXT/);
  const persistenceStart = workerSource.indexOf("export async function persistIntelligencePackageReport");
  const persistenceEnd = workerSource.indexOf("\n}\n\nasync function refreshIntelligenceWorkPackageSnapshot", persistenceStart);
  const persistence = workerSource.slice(persistenceStart, persistenceEnd);
  assert.match(persistence, /Another Runner may have won the create race/);
  assert.match(persistence, /if \(\[409, 422\]\.includes\(response\.status\)\)/);
  assert.match(persistence, /const raced = await verifyExistingReport\(\)/);
  assert.match(persistence, /Existing private report could not be verified/);
  assert.match(persistence, /Existing private report content does not match/);

  assert.match(workerSource, /if \(!\/duplicate column name\/i\.test\(String\(migrationError\?\.message \|\| migrationError\)\)\) \{\s*throw migrationError;/);
  assert.equal((workerSource.match(/SET report_stored_at=CURRENT_TIMESTAMP WHERE id=\?/g) || []).length, 2);
  assert.match(runnerSource, /pending-finalization/);
  assert.match(runnerSource, /for \(const id of \(Array\.isArray\(pending\.workPackageIds\)/);
  assert.match(runnerSource, /Re-discover terminal packages on every tick/);
});

test("MEHRAN Intelligence Agent API is enabled only behind its dedicated bearer secret", () => {
  const start = workerSource.indexOf('if (path.startsWith("/agent/v1/"))');
  const end = workerSource.indexOf('if (path === "/health"', start);
  assert.ok(start >= 0 && end > start, "Agent API route must exist before health route");
  const route = workerSource.slice(start, end);
  assert.doesNotMatch(route, /return error\("Production Intelligence Agent execution is disabled\.", 410\)/);
  const needsDbStart = workerSource.indexOf("const needsDB =");
  const needsDbEnd = workerSource.indexOf("if (needsDB && !env.DB)", needsDbStart);
  assert.ok(needsDbStart >= 0 && needsDbEnd > needsDbStart);
  assert.ok(workerSource.slice(needsDbStart, needsDbEnd).includes('path.startsWith("/agent/v1/")'));
  assert.match(route, /env\.MEHRAN_AGENT_TOKEN/);
  assert.match(route, /checkpointMatch/);
  assert.match(route, /checkpointJson\.length > 4000/);
  assert.match(route, /checkpoint_saved/);
  assert.match(route, /finalStatus = retryable \? "retry_wait" : requestedStatus/);
  assert.match(route, /Math\.min\(3600,30 \* \(2 \*\* Math\.max/);
  assert.match(route, /id\.length > 160/);
  assert.match(route, /Agent authentication required/);
  assert.match(route, /Agent service identity is not configured/);
  assert.match(route, /requires_approval=0/);
  assert.match(route, /assigned_to IN \('mehran_intelligence','shared'\)/);
  assert.match(route, /action_type IN \('repository_quality_check','service_health_report','source_security_audit','inspect_repository','run_repository_tests','propose_code_patch'\)/);
  assert.ok(route.includes("status IN ('queued','accepted','retry_wait')"), "agent claims must include retry_wait tasks");
  assert.ok(route.includes("ORDER BY CASE t.priority") && route.includes("prior.work_package_id=t.work_package_id") && route.includes("prior.status='completed'"),
    "after honoring priority, continue packages that have already completed a task before starting another package");
  assert.match(route, /status='awaiting_approval' AND requires_approval=0/);
  assert.match(route, /agent_claimed_at=CURRENT_TIMESTAMP/);
  assert.ok(route.includes("WHERE id=? AND status IN ('queued','accepted','retry_wait') AND requires_approval=0 AND assigned_to IN ('mehran_intelligence','shared') AND action_type IN ('repository_quality_check','service_health_report','source_security_audit','inspect_repository','run_repository_tests','propose_code_patch')"));
  assert.match(route, /agent_claimed_at IS NOT NULL AND datetime\(agent_claimed_at\) < datetime\('now','-15 minutes'\)/);
  assert.match(route, /agent_claimed_at IS NOT NULL AND datetime\(agent_claimed_at\)>=datetime\('now','-15 minutes'\)/);
  assert.doesNotMatch(route, /work_package_id IS NULL AND agent_claimed_at IS NOT NULL/,
    "agent API recovery must also release expired claims from durable work packages");
  assert.match(route, /datetime\(agent_claimed_at\)>=datetime\('now','-15 minutes'\) AND requires_approval=0 AND assigned_to IN \('mehran_intelligence','shared'\) AND action_type IN \('repository_quality_check','service_health_report','source_security_audit','inspect_repository','run_repository_tests','propose_code_patch'\)/);
  assert.match(route, /agent_claimed_at=NULL/);
  assert.match(route, /\["completed","blocked"\]/);
});

test("MEHRAN Intelligence Agent API rejects missing and incorrect credentials", async () => {
  const db = mockDb();
  const missing = await request("/agent/v1/tasks/next", {}, { DB: db });
  assert.equal(missing.status, 503);
  const incorrect = await request("/agent/v1/tasks/next", {
    headers: { Authorization: "Bearer " + "y".repeat(64) }
  }, { DB: db, MEHRAN_AGENT_TOKEN: "x".repeat(64) });
  assert.equal(incorrect.status, 401);
});

test("owner approval remains the only way to release approval-gated tasks", () => {
  assert.match(workerSource, /requires_approval=CASE WHEN \?='accepted' THEN 0 ELSE requires_approval END/);
  assert.match(workerSource, /status='in_progress' AND agent_claimed_at IS NOT NULL/);
});

test("scheduled Intelligence runner is single-flight, secret-backed and restricted to read-only reports", async () => {
  const runner = await readFile(new URL("../.github/workflows/mehran-intelligence-runner.yml", import.meta.url), "utf8");
  assert.match(runner, /schedule:/);
  assert.match(runner, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(runner, /concurrency:/);
  assert.match(runner, /cancel-in-progress:\s*false/,
    "an active runner must not be cancelled by a later scheduled tick");
  const timeoutMatch = runner.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(timeoutMatch, "runner job must have an explicit maximum runtime");
  assert.ok(Number(timeoutMatch[1]) < 15,
    "runner maximum runtime must remain below the 15-minute claim-expiry window");
  assert.match(runner, /const taskExecutionDeadline = tickStartedAt \+ 7 \* 60 \* 1000;/,
    "task execution must leave a safety margin for result submission and report finalization");
  assert.match(runner, /count < 5 && Date\.now\(\) < taskExecutionDeadline/,
    "each scheduled tick must bound both task count and execution time");
  assert.match(runner, /remaining eligible tasks stay queued for the next scheduled tick/,
    "unclaimed work must remain queued when the execution budget is reached");
  assert.match(workerSource, /datetime\(agent_claimed_at\) < datetime\('now','-15 minutes'\)/,
    "claim recovery must use the documented 15-minute ownership window");
  assert.match(runner, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(runner, /permissions:\s*contents:\s*read/,
    "the scheduled runner must keep its repository token read-only");
  assert.match(runner, /persist-credentials:\s*false/,
    "checkout must not leave a write-capable Git credential in the workspace");
  assert.match(runner, /timeout-minutes:\s*10/,
    "the runner job must retain its hard ten-minute ceiling");
  assert.doesNotMatch(runner, /\b(?:git\s+push|gh\s+pr\s+create|wrangler\s+deploy)\b/,
    "the autonomous runner must not push source, create PRs, or deploy");
  const runnerLines = runner.split(/\r?\n/);
  const runBlockLine = runnerLines.findIndex(line => /^\s*run:\s*\|\s*$/.test(line));
  assert.ok(runBlockLine >= 0, "runner inline script block must exist");
  const blockIndent = runnerLines[runBlockLine + 1].match(/^\s*/)[0].length;
  const heredocEnd = runnerLines.findIndex((line, index) => index > runBlockLine && line.trim() === "NODE");
  assert.ok(heredocEnd > runBlockLine, "runner heredoc terminator must exist");
  for (let index = runBlockLine + 1; index <= heredocEnd; index += 1) {
    if (runnerLines[index].trim()) {
      assert.ok(runnerLines[index].match(/^\s*/)[0].length >= blockIndent, `runner run block line ${index + 1} escapes YAML block indentation`);
    }
  }
  assert.match(runner, /task\.requiresApproval !== false/);
  assert.match(runner, /task\.status !== "in_progress"/);
  assert.match(runner, /task\.assignedTo/);
  assert.match(runner, /secrets\.MEHRAN_AGENT_TOKEN/);
  assert.match(runner, /service_health_report/);
  assert.match(runner, /repository_quality_check/);
  assert.match(runner, /status, result/);
  assert.match(runner, /Runner refused an action outside its read-only allowlist/);
  assert.doesNotMatch(runner, /process\.env\.CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_API_TOKEN|secrets\.MEHRAN_MCP_TOKEN|process\.env\.MEHRAN_MCP_TOKEN/);
});

test("Intelligence source audit cross-checks capability allowlists and owner safety boundaries", () => {
  for (const checkId of [
    "planner_validator_agent_mcp_and_runner_allowlists_aligned",
    "custom_owner_missions_remain_admin_gated_without_fallback",
    "mcp_package_intake_keeps_separate_bridge_and_owner_identities",
    "executor_rechecks_assignment_status_and_approval",
    "runner_has_no_deploy_or_repository_write_commands",
    "execution_protocol_still_marks_end_to_end_acceptance_as_required"
  ]) {
    assert.ok(runnerSource.includes('id: "' + checkId + '"'), "source audit must emit " + checkId);
  }
  assert.match(runnerSource, /const capabilityActions = \["service_health_report", "repository_quality_check", "source_security_audit", "inspect_repository", "propose_code_patch"\]/);
  assert.match(runnerSource, /capabilitySections\.every\(section/);
  assert.match(runnerSource, /docs\/INTELLIGENCE_EXECUTION_PROTOCOL\.md/);
});

test("MEHRAN Intelligence tool calling is limited to safe reads and owner-approved task proposals", () => {
  const start = workerSource.indexOf('const system = "You are MEHRAN INTELLIGENCE');
  const end = workerSource.indexOf('if (path === "/admin/overview"', start);
  assert.ok(start >= 0 && end > start, "tool-assisted Intelligence chat must exist");
  const chat = workerSource.slice(start, end);
  assert.match(chat, /get_project_status/);
  assert.match(chat, /get_social_metrics/);
  assert.match(chat, /list_collaboration_tasks/);
  assert.match(chat, /propose_collaboration_task/);
  assert.match(chat, /status,requires_approval,created_by/);
  assert.match(chat, /'awaiting_approval',1/);
  assert.match(chat, /cannot deploy code, alter user accounts, move funds/);
  assert.doesNotMatch(chat, /deploy_worker|transfer_pi|delete_social_user/);
});

// Intelligence has its own bounded reservation cap within the shared global ceiling.
test("Workers AI has separate Music, SOCIAL and MEHRAN INTELLIGENCE budgets under one fail-closed ceiling", () => {
  assert.match(workerSource, /WORKERS_AI_GLOBAL_DAILY_RESERVATION_CREDITS = 9000/);
  assert.match(workerSource, /WORKERS_AI_MUSIC_DAILY_RESERVATION_CREDITS = 6000/);
  assert.match(workerSource, /WORKERS_AI_SOCIAL_DAILY_RESERVATION_CREDITS = 3000/);
  assert.match(workerSource, /CREATE TABLE IF NOT EXISTS workers_ai_daily_budget/);
  assert.match(workerSource, /WORKERS_AI_INTELLIGENCE_DAILY_RESERVATION_CREDITS = 7000/);
  assert.match(workerSource, /intelligence: \{ column: "intelligence_reserved", cap: WORKERS_AI_INTELLIGENCE_DAILY_RESERVATION_CREDITS \}/);
  assert.match(workerSource, /ensureColumn\("workers_ai_daily_budget", "intelligence_reserved"/);
  assert.match(workerSource, /total_reserved/);
  assert.match(workerSource, /music_reserved/);
  assert.match(workerSource, /social_reserved/);
  assert.match(workerSource, /intelligence_reserved/);
  assert.match(workerSource, /reserveSocialWorkersAIBudget\(env, structure === "short" \? 250 : 500, "music"\)/);
  assert.match(workerSource, /reserveSocialWorkersAIBudget\(env, 500, "social"\)/);
  assert.match(workerSource, /reserveSocialWorkersAIBudget\(env, 300, "intelligence"\)/);
  assert.match(workerSource, /WORKERS_AI_GLOBAL_DAILY_RESERVATION_CREDITS,selected\.cap/);
  assert.doesNotMatch(workerSource, /intelligence_ai_daily_budget/);
});


test("Intelligence mission planner creates a bounded deterministic fallback when AI planning is unavailable", () => {
  const helperStart = workerSource.indexOf("async function createIntelligenceFallbackPackage");
  const helperEnd = workerSource.indexOf("async function planIntelligenceMission", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "deterministic fallback package helper must exist");
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.match(helper, /planner: "deterministic_fallback"/);
  assert.match(helper, /service_health_report/);
  assert.match(helper, /repository_quality_check/);
  assert.match(helper, /source_security_audit/);
  assert.match(helper, /createIntelligenceWorkPackage\(env/);
  assert.match(helper, /Fixed read-only action allowlist enforced server-side/);

  const plannerEnd = workerSource.indexOf("\nexport function verifyIntelligenceReport", helperEnd);
  const planner = workerSource.slice(helperEnd, plannerEnd);
  assert.match(planner, /ai_binding_unavailable/);
  assert.match(planner, /daily_ai_budget_unavailable/);
  assert.match(planner, /ai_inference_failed/);
  assert.match(planner, /ai_response_invalid_json/);
  assert.match(planner, /ai_plan_validation_failed/);
  assert.match(planner, /SELECT id,status FROM intelligence_work_packages WHERE idempotency_key=\?/);
});

test("owner mission intake is admin-gated and does not substitute a generic fallback for custom missions", () => {
  const routeStart = workerSource.indexOf('if (path === "/intelligence/missions" && method === "POST")');
  const routeEnd = workerSource.indexOf('if (path === "/intelligence/tasks" && ["GET","POST"].includes(method))', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "owner mission intake route must exist before the task hub route");
  const route = workerSource.slice(routeStart, routeEnd);
  assert.match(route, /verifyAdmin\(request, env\)/);
  assert.match(route, /intelligence-owner-mission-submit/);
  assert.match(route, /allowDeterministicFallback: false/);
  assert.match(route, /writeAdminAudit\(/);
  assert.match(route, /planIntelligenceMission\(env/);

  const plannerStart = workerSource.indexOf("async function planIntelligenceMission");
  const plannerEnd = workerSource.indexOf("export function verifyIntelligenceReport", plannerStart);
  const planner = workerSource.slice(plannerStart, plannerEnd);
  assert.match(planner, /input\?\.allowDeterministicFallback === false/);
  assert.match(planner, /AI planning is unavailable \(/);

  const formatterStart = workerSource.indexOf("function formatIntelligenceTask");
  const formatterEnd = workerSource.indexOf("async function writeAdminAudit", formatterStart);
  assert.ok(formatterStart >= 0 && formatterEnd > formatterStart);
  assert.match(workerSource.slice(formatterStart, formatterEnd), /workPackageId: row\.work_package_id \|\| null/);

  assert.match(indexSource, /id="intelMissionForm"/);
  assert.match(indexSource, /api\("\/intelligence\/missions"/);
  assert.match(runnerSource, /const packageIds = new Set\(\)/);
  assert.match(runnerSource, /task\?\.workPackageId/);
  assert.match(runnerSource, /for \(const workPackageId of packageIds\)/);
  assert.match(runnerSource, /work-packages\/\$\{encodeURIComponent\(workPackageId\)\}/);
});

test("social feed excludes private-account public posts and blocked relationships", () => {
  const start = workerSource.indexOf("async function socialFeed");
  const end = workerSource.indexOf("async function socialUserPosts", start);
  assert.ok(start >= 0 && end > start, "socialFeed implementation must exist");
  const feed = workerSource.slice(start, end);
  assert.match(feed, /NOT EXISTS\s*\(\s*SELECT 1 FROM social_user_settings privacy\s*WHERE privacy\.user_id=p\.user_id AND privacy\.is_private=1/);
  assert.match(feed, /p\.visibility='followers'[\s\S]*?social_follows WHERE follower_id=\?/);
  assert.equal((feed.match(/SELECT blocked_id FROM social_blocks WHERE blocker_id=\?/g) || []).length, 2);
  assert.equal((feed.match(/SELECT blocker_id FROM social_blocks WHERE blocked_id=\?/g) || []).length, 2);
  assert.match(feed, /\.bind\(user\.id, user\.id, user\.id, user\.id, user\.id, user\.id, limit\)/);
});


test("SOCIAL post interactions enforce the same visibility policy", () => {
  assert.match(workerSource, /async function canViewSocialPost\(env, viewerId, post\)/);
  const helperStart = workerSource.indexOf("async function canViewSocialPost");
  const helperEnd = workerSource.indexOf("\n}\n", helperStart) + 3;
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.match(helper, /await isBlocked\(env, viewerId, post\.user_id\)/);
  assert.match(helper, /settings\?\.is_private && !follows/);
  assert.match(helper, /post\.visibility === "followers" && !follows/);
  for (const name of ["socialLikePost", "socialBookmark", "socialViewPost", "socialListComments", "socialCreateComment"]) {
    const start = workerSource.indexOf("async function " + name);
    const end = workerSource.indexOf("\nasync function ", start + 20);
    assert.ok(start >= 0 && end > start, name + " must exist");
    assert.match(workerSource.slice(start, end), /canViewSocialPost/);
  }
  const searchStart = workerSource.indexOf("async function socialSearch");
  const searchEnd = workerSource.indexOf("\nasync function ", searchStart + 20);
  const search = workerSource.slice(searchStart, searchEnd);
  assert.match(search, /privacy\.is_private=1/);
  assert.equal((search.match(/SELECT blocker_id FROM social_blocks WHERE blocked_id=\?/g) || []).length, 2);
});


test("private SOCIAL profile gallery and posts respect privacy and blocks", () => {
  const profileStart = workerSource.indexOf("async function getProfileByUsername");
  const profileEnd = workerSource.indexOf("\nasync function ", profileStart + 20);
  const profile = workerSource.slice(profileStart, profileEnd);
  assert.match(profile, /const canViewGallery = !settings\?\.is_private \|\| viewerId === profile\.id \|\| Boolean\(counts\?\.is_following\)/);
  assert.match(profile, /canViewGallery\s*\?\s*await env\.DB\.prepare/);

  const postsStart = workerSource.indexOf("async function socialUserPosts");
  const postsEnd = workerSource.indexOf("\nasync function ", postsStart + 20);
  const posts = workerSource.slice(postsStart, postsEnd);
  assert.match(posts, /await isBlocked\(env, viewer\.id, target\.id\)/);
  assert.match(posts, /canViewSocialPost\(env, viewer\.id, row\)/);
  assert.match(posts, /settings\?\.is_private && !following/);
});


test("blocked SOCIAL profiles are not returned to either side", () => {
  const start = workerSource.indexOf("async function socialGetProfile");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const profile = workerSource.slice(start, end);
  assert.match(profile, /profile\.id !== viewer\.id && await isBlocked\(env, viewer\.id, profile\.id\)/);
  assert.match(profile, /return error\("User not found", 404\)/);
});


test("message edit and delete require current conversation membership", () => {
  const editStart = workerSource.indexOf("async function socialEditMessage");
  const editEnd = workerSource.indexOf("\nasync function ", editStart + 20);
  const edit = workerSource.slice(editStart, editEnd);
  assert.match(edit, /EXISTS\s*\(\s*SELECT 1 FROM social_conversation_members cm/);
  assert.match(edit, /cm\.conversation_id=social_messages\.conversation_id/);
  assert.match(edit, /cm\.user_id=\?/);
  assert.match(edit, /\.bind\(content, messageId, user\.id, user\.id\)/);

  const deleteStart = workerSource.indexOf("async function socialDeleteMessage");
  const deleteEnd = workerSource.indexOf("\nasync function ", deleteStart + 20);
  const remove = workerSource.slice(deleteStart, deleteEnd);
  assert.match(remove, /EXISTS\s*\(\s*SELECT 1 FROM social_conversation_members cm/);
  assert.match(remove, /cm\.conversation_id=social_messages\.conversation_id/);
  assert.match(remove, /cm\.user_id=\?/);
  assert.match(remove, /\.bind\(messageId, user\.id, user\.id\)/);
});


test("group and channel joins enforce owner block relationships", () => {
  const channelStart = workerSource.indexOf("async function socialJoinChannel");
  const channelEnd = workerSource.indexOf("\nasync function ", channelStart + 20);
  const channel = workerSource.slice(channelStart, channelEnd);
  assert.match(channel, /SELECT id,owner_id,is_private,invite_code FROM social_channels/);
  assert.match(channel, /isBlocked\(env, user\.id, channel\.owner_id\)/);

  const groupStart = workerSource.indexOf("async function socialJoinGroup");
  const groupEnd = workerSource.indexOf("\nasync function ", groupStart + 20);
  const group = workerSource.slice(groupStart, groupEnd);
  assert.match(group, /JOIN social_conversations c ON c\.id=i\.conversation_id/);
  assert.match(group, /invite\.type !== "group"/);
  assert.match(group, /isBlocked\(env, user\.id, invite\.owner_id\)/);
  assert.match(group, /isBlocked\(env, user\.id, invite\.created_by\)/);
});


test("conversation list exposes per-member unread counts without counting own or deleted messages", () => {
  const start = workerSource.indexOf("async function socialListConversations");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /unread\.sender_id<>\?/);
  assert.match(handler, /unread\.deleted_at IS NULL/);
  assert.ok(handler.includes("unread.rowid>COALESCE(cm.last_read_message_rowid"));
  assert.match(handler, /unreadCount: Math\.max\(0, Number\(row\.unread_count \|\| 0\)\)/);
  assert.match(handler, /\.bind\(user\.id, user\.id, user\.id, user\.id\)\.all\(\)/);
});

test("notification API returns the complete unread total independently of page limit", () => {
  const start = workerSource.indexOf("async function socialNotifications");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT COUNT\(\*\) AS total FROM social_notifications WHERE user_id=\? AND is_read=0/);
  assert.match(handler, /unreadCount: Math\.max\(0, Number\(unreadRow\?\.total \|\| 0\)\)/);
});

test("direct message sending stops when either participant blocks the other", () => {
  const helperStart = workerSource.indexOf("async function isDirectConversationBlocked");
  const helperEnd = workerSource.indexOf("\nasync function ", helperStart + 20);
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.match(helper, /c\.type,cm\.user_id/);
  assert.match(helper, /\["direct", "private"\]/);
  assert.match(helper, /isBlocked\(env, userId, row\.user_id\)/);

  const sendStart = workerSource.indexOf("async function socialSendMessage");
  const sendEnd = workerSource.indexOf("\nasync function ", sendStart + 20);
  const send = workerSource.slice(sendStart, sendEnd);
  assert.match(send, /isDirectConversationBlocked\(env, conversationId, user\.id\)/);
  assert.match(send, /Messaging is unavailable for this conversation/);
});


test("group invite creation is restricted to actual group conversations", () => {
  const start = workerSource.indexOf("async function socialGroupInvite");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT type FROM social_conversations WHERE id=\?/);
  assert.match(handler, /conversation\?\.type !== "group"/);
  assert.match(handler, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
  assert.match(handler, /previousInvitesRevoked: true/);
  const manageStart = workerSource.indexOf("async function socialManageGroupMember");
  const manageEnd = workerSource.indexOf("\nasync function ", manageStart + 20);
  const manage = workerSource.slice(manageStart, manageEnd);
  assert.match(manage, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
});

test("channel pins can only reference posts belonging to that channel", () => {
  const start = workerSource.indexOf("async function socialPinChannelPost");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT id FROM social_channel_posts WHERE id=\? AND channel_id=\?/);
  assert.match(handler, /Channel post not found/);
});


test("group leave and member management enforce owner and admin hierarchy", () => {
  const leaveStart = workerSource.indexOf("async function socialLeaveGroup");
  const leaveEnd = workerSource.indexOf("\nasync function ", leaveStart + 20);
  const leave = workerSource.slice(leaveStart, leaveEnd);
  assert.match(leave, /conversation\.owner_id === user\.id/);
  assert.match(leave, /transfer ownership before leaving/);
  assert.match(leave, /DELETE FROM social_conversation_members WHERE conversation_id=\? AND user_id=\?/);

  const manageStart = workerSource.indexOf("async function socialManageGroupMember");
  const manageEnd = workerSource.indexOf("\nasync function ", manageStart + 20);
  const manage = workerSource.slice(manageStart, manageEnd);
  assert.match(manage, /role!='owner'/);
  assert.match(manage, /actor\.role='owner' OR \(actor\.role='admin' AND social_conversation_members\.role='member'\)/);
  assert.match(manage, /\["admin", "member"\]/);
  assert.match(manage, /Use the leave-group action to remove yourself/);
});

test("group ownership transfer is owner-only and restricted to existing members", () => {
  assert.ok(workerSource.includes("async function socialTransferGroupOwnership"));
  assert.ok(workerSource.includes("group.owner_id !== user.id"));
  assert.ok(workerSource.includes("Only the group owner can transfer ownership"));
  assert.ok(workerSource.includes("The new owner must already be a group member"));
  assert.ok(workerSource.includes("UPDATE social_conversations SET owner_id=?"));
  assert.ok(workerSource.includes("SET role='admin'"));
  assert.ok(workerSource.includes("SET role='owner'"));
  assert.ok(workerSource.includes("transferGroupMatch"));
  assert.ok(workerSource.includes("/transfer-ownership"));
  const transferStart = workerSource.indexOf("async function socialTransferGroupOwnership");
  const transferEnd = workerSource.indexOf("\nasync function ", transferStart + 20);
  const transfer = workerSource.slice(transferStart, transferEnd);
  assert.match(transfer, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
  const manageStart = workerSource.indexOf("async function socialManageGroupMember");
  const manageEnd = workerSource.indexOf("\nasync function ", manageStart + 20);
  const manage = workerSource.slice(manageStart, manageEnd);
  assert.match(manage, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
  assert.match(manage, /previousInvitesRevoked: true/);
});

test("group member management routes expose only leave, remove, and role updates", () => {
  assert.ok(workerSource.includes("groupLeaveMatch = path.match"));
  assert.ok(workerSource.includes("groupMemberMatch = path.match"));
});



test("channel leave requires membership and prevents owner orphaning", () => {
  const start = workerSource.indexOf("async function socialLeaveChannel");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT owner_id FROM social_channels WHERE id=\?/);
  assert.match(handler, /channel\.owner_id === user\.id/);
  assert.match(handler, /transfer ownership before leaving/);
  assert.match(handler, /DELETE FROM social_channel_members WHERE channel_id=\? AND user_id=\?/);
  assert.match(handler, /You are not a channel member/);
  assert.ok(workerSource.includes("leaveChannelMatch = path.match"));
});



test("channel media upload IDs must belong to the publishing admin and be ready public files", () => {
  const start = workerSource.indexOf("async function socialChannelPost(");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT id,name,mime_type,acl,status,url FROM social_uploads WHERE id=\? AND user_id=\? LIMIT 1/);
  assert.match(handler, /upload\.status !== "ready"/);
  assert.match(handler, /upload\.acl !== "public"/);
  assert.match(handler, /!upload\.url \|\| !validHttpsUrl\(upload\.url\)/);
  assert.match(handler, /Channel media must be a ready public upload owned by your account/);
});



test("channel ownership transfer is owner-only and restricted to existing members", () => {
  const start = workerSource.indexOf("async function socialTransferChannelOwnership(");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /channel\.owner_id !== user\.id/);
  assert.match(handler, /SELECT role FROM social_channel_members WHERE channel_id=\? AND user_id=\?/);
  assert.match(handler, /The new owner must already be a channel member/);
  assert.match(handler, /UPDATE social_channels SET owner_id=\?/);
  assert.match(handler, /UPDATE social_channel_members SET role='subscriber'/);
  assert.match(handler, /UPDATE social_channel_members SET role='owner'/);
  assert.match(handler, /await env\.DB\.batch\(/);
  assert.ok(workerSource.includes("transferChannelMatch = path.match"));
});


test("channel administration is owner-only and cannot alter the owner", () => {
  const start = workerSource.indexOf("async function socialManageChannelMember");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /channel\.owner_id !== user\.id/);
  assert.match(handler, /Only the channel owner can manage administrators/);
  assert.match(handler, /target\.role === "owner"/);
  assert.match(handler, /\["admin", "subscriber"\]/);
  assert.match(handler, /role!='owner'/);
  assert.match(handler, /DELETE FROM social_channel_members/);
  assert.ok(workerSource.includes("channelMemberMatch = path.match"));
});

test("private channel invite rotation revokes the previous code and is owner-only", () => {
  const start = workerSource.indexOf("async function socialRotateChannelInvite");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /UPDATE social_channels SET invite_code=\?/);
  assert.match(handler, /owner_id=\? AND is_private=1/);
  assert.match(handler, /previousInvitesRevoked: true/);
  assert.match(handler, /Invite rotation is available only for private channels/);
  assert.ok(workerSource.includes("rotateChannelInviteMatch = path.match"));
});


test("channel member directory is visible only to current channel members", () => {
  const start = workerSource.indexOf("async function socialListChannelMembers");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /getAccessibleChannelMembership\(env, channelId, user\.id\)/);
  assert.match(handler, /if \(!membership\) return error\("Channel not found", 404\)/);
  assert.match(handler, /JOIN social_users u ON u\.id=m\.user_id/);
  assert.match(handler, /LIMIT 500/);
  assert.ok(workerSource.includes("channelMembersMatch = path.match"));
});


test("channel post edits and deletion require admin membership and stay scoped to the channel", () => {
  const editStart = workerSource.indexOf("async function socialEditChannelPost");
  const editEnd = workerSource.indexOf("\nasync function ", editStart + 30);
  const edit = workerSource.slice(editStart, editEnd);
  assert.match(edit, /!\["owner", "admin"\]\.includes\(member\.role\)/);
  assert.match(edit, /WHERE id=\? AND channel_id=\?/);
  assert.match(edit, /edited_at=CURRENT_TIMESTAMP/);
  assert.match(edit, /UPDATE social_channel_posts SET content=/);

  const deleteStart = workerSource.indexOf("async function socialDeleteChannelPost");
  const deleteEnd = workerSource.indexOf("\nasync function ", deleteStart + 30);
  const remove = workerSource.slice(deleteStart, deleteEnd);
  assert.match(remove, /!\["owner", "admin"\]\.includes\(member\.role\)/);
  assert.match(remove, /DELETE FROM social_channel_pins WHERE channel_id=\? AND post_id=\?/);
  assert.match(remove, /DELETE FROM social_channel_posts WHERE id=\? AND channel_id=\?/);
  assert.match(remove, /Uploaded media files are intentionally retained/);
  assert.ok(workerSource.includes("channelPostItemMatch = path.match"));
});


test("group member management enforces owner and admin hierarchy", () => {
  const start = workerSource.indexOf("async function socialManageGroupMember");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const manage = workerSource.slice(start, end);
  assert.match(manage, /actor\.role='owner' OR \(actor\.role='admin' AND social_conversation_members\.role='member'\)/);
  assert.match(manage, /role!='owner'/);
  assert.match(manage, /Use the leave-group action to remove yourself/);
  assert.ok(workerSource.includes('groupMemberMatch && method === "PATCH"'));
  assert.ok(workerSource.includes('groupMemberMatch && method === "DELETE"'));
});


test("presence heartbeat requires authentication and updates only the authenticated active user", () => {
  assert.ok(workerSource.includes("async function socialPresenceHeartbeat(request, env)"));
  assert.ok(workerSource.includes("const user = await getSocialUser(request, env);"));
  assert.ok(workerSource.includes("UPDATE social_users SET last_seen_at=CURRENT_TIMESTAMP WHERE id=? AND is_active=1"));
  assert.ok(workerSource.includes(".bind(user.id).run();"));
  assert.ok(workerSource.includes('path === "/social/presence" && method === "POST"'));
});

test("conversation presence respects each member's online-status privacy setting", () => {
  assert.ok(workerSource.includes("show_online_status"));
  assert.ok(workerSource.includes("last_seen_at ELSE NULL"));
  assert.ok(workerSource.includes("lastSeenAt: member.last_seen_at"));
});




test("chat read cursors always advance while read-receipt visibility respects each member preference", () => {
  const start = workerSource.indexOf("async function socialConversationMessages");
  const end = workerSource.indexOf("\nasync function socialSendMessage", start);
  assert.ok(start >= 0 && end > start, "conversation messages handler must exist");
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("SET last_read_at=?,") && handler.includes("last_read_message_rowid=?"));
  assert.doesNotMatch(handler, /if \(viewerPrefs\.chat\?\.readReceipts/);
  const listStart = workerSource.indexOf("async function socialListConversations");
  const listEnd = workerSource.indexOf("\nasync function ", listStart + 30);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /readprefs\.preferences_json AS read_preferences_json/);
  assert.match(list, /prefs\.chat\?\.readReceipts === false \? null/);
});


test("SOCIAL notification badge refresh is bounded, authenticated, and skips hidden or offline tabs", () => {
  assert.match(indexSource, /async function socialRefreshNotificationCount\(\)/);
  assert.match(indexSource, /if\(!socialUser\|\|!navigator\.onLine\|\|document\.hidden\|\|socialNotificationRefreshBusy\)return/);
  assert.match(indexSource, /socialRequest\("\/notifications\?limit=1"\)/);
  assert.match(indexSource, /setInterval\(socialRefreshNotificationCount,30000\)/);
  assert.match(indexSource, /socialNotificationRefreshBusy=false/);
});

test("SOCIAL reconnect recovery refreshes notification counts and only reloads the open notification view", () => {
  assert.match(indexSource, /window\.addEventListener\("online",recover\)/);
  assert.match(indexSource, /socialRefreshNotificationCount\(\)/);
  assert.match(indexSource, /\$\("social-notifications"\)\?\.classList\.contains\("active"\)\)loadNotifications\(\)/);
});


test("open SOCIAL notification feed refreshes silently without overlapping requests", () => {
  assert.match(indexSource, /let socialNotificationListBusy=false/);
  assert.match(indexSource, /async function loadNotifications\(silent=false\)/);
  assert.match(indexSource, /if\(socialNotificationListBusy\)return/);
  assert.match(indexSource, /socialNotificationListBusy=false/);
  assert.match(indexSource, /await loadNotifications\(true\)/);
  assert.match(indexSource, /if\(!silent\)\{/);
});


test("SOCIAL notifications remain recipient-scoped and respect notification preferences", () => {
  const start = workerSource.indexOf("async function socialNotifications");
  const end = workerSource.indexOf("\nasync function socialReadNotifications", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /WHERE n\.user_id=\?/);
  assert.match(handler, /\.bind\(user\.id, limit\)/);
  const readStart = workerSource.indexOf("async function socialReadNotifications");
  const readEnd = workerSource.indexOf("\nasync function ", readStart + 30);
  const readHandler = workerSource.slice(readStart, readEnd);
  assert.match(readHandler, /WHERE id=\? AND user_id=\?/);
  assert.match(readHandler, /WHERE user_id=\?/);
  const notifyStart = workerSource.indexOf("async function notify");
  const notifyEnd = workerSource.indexOf("\nasync function ", notifyStart + 30);
  const notifyHandler = workerSource.slice(notifyStart, notifyEnd);
  assert.match(notifyHandler, /if \(!userId \|\| userId === actorId\) return/);
  assert.match(notifyHandler, /prefs\.notifications\[key\] === false/);
});


test("SOCIAL blocked direct conversations are hidden from lists and message history", () => {
  const messageStart = workerSource.indexOf("async function socialConversationMessages");
  const messageEnd = workerSource.indexOf("async function socialSendMessage", messageStart + 30);
  assert.ok(messageStart >= 0 && messageEnd > messageStart);
  const messages = workerSource.slice(messageStart, messageEnd);
  assert.ok(messages.includes("isDirectConversationBlocked(env, conversationId, user.id)"));
  assert.ok(messages.includes('return error("Conversation not found", 404)'));

  const listStart = workerSource.indexOf("async function socialListConversations");
  const listEnd = workerSource.indexOf("async function ", listStart + 30);
  const list = workerSource.slice(listStart, listEnd);
  assert.ok(list.includes("c.type IN ('direct','private')"));
  assert.ok(list.includes("JOIN social_blocks block_edge"));
  assert.ok(list.includes("block_edge.blocker_id=? AND block_edge.blocked_id=other_member.user_id"));
  assert.ok(list.includes("block_edge.blocker_id=other_member.user_id AND block_edge.blocked_id=?"));
});

test("SOCIAL direct messages, group messages, and channel posts notify other members without failing the content write", () => {
  const sendStart = workerSource.indexOf("async function socialSendMessage");
  const sendEnd = workerSource.indexOf("async function socialEditMessage", sendStart);
  const send = workerSource.slice(sendStart, sendEnd);
  assert.match(send, /SELECT user_id FROM social_conversation_members WHERE conversation_id=\? AND user_id!=\?/);
  assert.match(send, /conversation\?\.type === "group" \? "group_message" : "message"/);
  assert.match(send, /await notify\(env, row\.user_id, user\.id, notificationType/);
  assert.match(send, /SOCIAL_MESSAGE_NOTIFICATION_FAILURE/);

  const channelStart = workerSource.indexOf("async function socialChannelPost");
  const channelEnd = workerSource.indexOf("async function socialEditChannelPost", channelStart);
  const channel = workerSource.slice(channelStart, channelEnd);
  assert.match(channel, /SELECT user_id FROM social_channel_members WHERE channel_id=\? AND user_id!=\?/);
  assert.match(channel, /await notify\(env, subscriber\.user_id, user\.id, "channel_post"/);
  assert.match(channel, /SOCIAL_CHANNEL_NOTIFICATION_FAILURE/);
  assert.match(channel, /new post in a channel you follow/);
});

test("SOCIAL group creation sends preference-aware invitation notifications after membership succeeds", () => {
  const start = workerSource.indexOf("async function socialCreateGroup");
  const end = workerSource.indexOf("async function socialGroupInvite", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /for \(const target of targets\)/);
  assert.match(handler, /await notify\(env, target\.id, user\.id, "group_invite", id, "added you to a group"\)/);
  assert.match(handler, /SOCIAL_GROUP_INVITATION_NOTIFICATION_FAILURE/);
  const notifyStart = workerSource.indexOf("async function notify");
  const notifyEnd = workerSource.indexOf("\nasync function ", notifyStart + 30);
  const notifyHandler = workerSource.slice(notifyStart, notifyEnd);
  assert.match(notifyHandler, /prefs\.community\?\.groupInvites === false/);
  assert.match(notifyHandler, /prefs\.notifications\[key\] === false/);
});

test("SOCIAL chat unread cursors are rowid-based to avoid same-second message loss", () => {
  assert.ok(workerSource.includes('ensureColumn("social_conversation_members", "last_read_message_rowid", "INTEGER")'));
  assert.ok(workerSource.includes("unread.rowid>COALESCE(cm.last_read_message_rowid"));
  assert.ok(workerSource.includes("read_cursor.created_at<=COALESCE(NULLIF(cm.last_read_at,''),NULLIF(cm.joined_at,''),"));
  assert.ok(workerSource.includes("const newestDelivered = (result.results || [])[0]"));
  assert.ok(workerSource.includes("ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?"));
  assert.ok(workerSource.includes("ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1"));
});
test("SOCIAL repeated like requests do not create duplicate notifications", () => {
  const start = workerSource.indexOf("async function socialLikePost");
  const end = workerSource.indexOf("async function socialBookmark", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /INSERT OR IGNORE INTO social_post_likes/);
  assert.match(handler, /Number\(likeResult\?\.meta\?\.changes \|\| 0\) > 0/);
  assert.match(handler, /SOCIAL_LIKE_NOTIFICATION_FAILURE/);
});

test("SOCIAL read cursor advances only to the newest message actually delivered in the response", () => {
  const start = workerSource.indexOf("async function socialConversationMessages");
  const end = workerSource.indexOf("async function socialSendMessage", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("const newestDelivered = (result.results || [])[0]"));
  assert.ok(handler.includes("SET last_read_at=?,"));
  assert.ok(handler.includes("last_read_message_rowid=?"));
  assert.ok(handler.includes("Number(newestDelivered.message_rowid)"));
  assert.ok(handler.includes("if (newestDelivered?.message_rowid != null)"));
  assert.ok(!handler.includes("SELECT MAX(read_cursor.rowid)"));
});

test("SOCIAL read receipts use message sequence cursors to avoid same-second false Seen states", () => {
  assert.ok(workerSource.includes("cm.last_read_at,cm.last_read_message_rowid"));
  assert.ok(workerSource.includes("m.rowid AS message_rowid"));
  assert.ok(workerSource.includes("messageRowId: Number(row.message_rowid)"));
  assert.ok(workerSource.includes("lastReadMessageRowId:"));
  assert.ok(indexSource.includes("member.lastReadMessageRowId"));
  assert.ok(indexSource.includes("readSequence>=messageSequence"));
  assert.ok(indexSource.includes("member.lastReadMessageRowId??null"));
});

test("SOCIAL repeated follow and private follow-request calls do not duplicate notifications", () => {
  const start = workerSource.indexOf("async function socialFollow");
  const end = workerSource.indexOf("async function ", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("Number(requestResult?.meta?.changes || 0) > 0"));
  assert.ok(handler.includes("Number(followResult?.meta?.changes || 0) > 0"));
  assert.ok(handler.includes("SOCIAL_FOLLOW_REQUEST_NOTIFICATION_FAILURE"));
  assert.ok(handler.includes("SOCIAL_FOLLOW_NOTIFICATION_FAILURE"));
});

test("SOCIAL new conversation members receive a read cursor at their join boundary", () => {
  assert.ok(workerSource.includes("INSERT INTO social_conversation_members(conversation_id,user_id,role,last_read_message_rowid)"));
  assert.ok(workerSource.includes("VALUES(?,?,'member',0)"));
  const groupStart = workerSource.indexOf("async function socialCreateGroup");
  const groupEnd = workerSource.indexOf("async function socialGroupInvite", groupStart);
  const group = workerSource.slice(groupStart, groupEnd);
  assert.ok(group.includes("VALUES(?,?,'owner',0)"));
  assert.ok(group.includes("VALUES(?,?,'member',0)"));
  const joinStart = workerSource.indexOf("async function socialJoinGroup");
  const joinEnd = workerSource.indexOf("async function ", joinStart + 30);
  const join = workerSource.slice(joinStart, joinEnd);
  assert.ok(join.includes("last_read_at,last_read_message_rowid"));
  assert.ok(join.includes("SELECT MAX(rowid) FROM social_messages WHERE conversation_id=?"));
  assert.ok(join.includes("COALESCE("));
});

test("SOCIAL repeated story reactions do not generate duplicate notifications", () => {
  assert.ok(workerSource.includes("async function socialReactStory"));
  assert.ok(workerSource.includes("WHERE social_story_reactions.reaction<>excluded.reaction"));
  assert.ok(workerSource.includes("Number(reactionResult?.meta?.changes || 0) > 0"));
  assert.ok(workerSource.includes("SOCIAL_STORY_REACTION_NOTIFICATION_FAILURE"));
});

test("SOCIAL unread counters have indexes for recipient and conversation lookups", () => {
  assert.ok(workerSource.includes("idx_social_notifications_unread"));
  assert.ok(workerSource.includes("ON social_notifications(user_id,is_read,created_at DESC)"));
  assert.ok(workerSource.includes("idx_social_messages_unread"));
  assert.ok(workerSource.includes("ON social_messages(conversation_id,sender_id,deleted_at)"));
});

test("SOCIAL comment and follow approval writes survive notification delivery failures", () => {
  assert.ok(workerSource.includes("SOCIAL_COMMENT_NOTIFICATION_FAILURE"));
  assert.ok(workerSource.includes("SOCIAL_FOLLOW_ACCEPTED_NOTIFICATION_FAILURE"));
  const commentStart = workerSource.indexOf("async function socialCreateComment");
  const commentEnd = workerSource.indexOf("async function ", commentStart + 30);
  assert.ok(commentStart >= 0 && commentEnd > commentStart);
  assert.ok(workerSource.slice(commentStart, commentEnd).includes("try {"));
  const acceptStart = workerSource.indexOf("async function socialFollowRequestAction");
  assert.ok(acceptStart >= 0);
  assert.ok(workerSource.includes('await notify(env, row.requester_id, user.id, "follow_accepted"'));
});

test("SOCIAL uploads enforce per-user ownership and verify storage metadata before completion", () => {
  const completeStart = workerSource.indexOf("async function socialCompleteUpload");
  const completeEnd = workerSource.indexOf("async function socialListUploads", completeStart);
  assert.ok(completeStart >= 0 && completeEnd > completeStart);
  const complete = workerSource.slice(completeStart, completeEnd);
  assert.match(complete, /SELECT \* FROM social_uploads WHERE id=\? AND user_id=\?/);
  assert.match(complete, /file\.metadata\?\.userId !== user\.id/);
  assert.match(complete, /file\.status !== "ready"/);
  assert.match(complete, /row\.acl === "public" \? \(file\.url \|\| null\) : null/);

  const getStart = workerSource.indexOf("async function socialGetUploadUrl");
  const getEnd = workerSource.indexOf("async function socialDeleteUpload", getStart);
  assert.ok(getStart >= 0 && getEnd > getStart);
  const getUrl = workerSource.slice(getStart, getEnd);
  assert.match(getUrl, /SELECT \* FROM social_uploads WHERE id=\? AND user_id=\?/);
  assert.match(getUrl, /if \(row\.status !== "ready"\)/);
  assert.match(getUrl, /expiresIn: 3600/);
  assert.match(getUrl, /validHttpsUrl\(result\.url\)/);

  const deleteStart = workerSource.indexOf("async function socialDeleteUpload");
  const deleteEnd = workerSource.indexOf("async function fetchPiUser", deleteStart);
  const remove = workerSource.slice(deleteStart, deleteEnd);
  assert.match(remove, /SELECT id FROM social_uploads WHERE id=\? AND user_id=\?/);
  assert.match(remove, /DELETE FROM social_uploads WHERE id=\? AND user_id=\?/);
});

test("SOCIAL channel content and membership are hidden across block relationships", () => {
  assert.match(workerSource, /async function getAccessibleChannelMembership\(env, channelId, userId\)/);
  assert.match(workerSource, /if \(!member \|\| await isBlocked\(env, userId, member\.owner_id\)\) return null/);
  const listStart = workerSource.indexOf("async function socialListChannels");
  const listEnd = workerSource.indexOf("async function socialCreateChannel", listStart);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /NOT EXISTS \([\s\S]*social_blocks[\s\S]*b\.blocker_id=c\.owner_id/);
  for (const name of ["socialListChannelMembers", "socialChannelPosts", "socialChannelPost"]) {
    const start = workerSource.indexOf("async function " + name);
    assert.ok(start >= 0, name + " should exist");
    const end = workerSource.indexOf("async function ", start + 1);
    assert.match(workerSource.slice(start, end), /getAccessibleChannelMembership\(env, channelId, user\.id\)/, name + " must enforce block privacy");
  }
});


test("SOCIAL group creation rejects blocked relationships between invited members", () => {
  const start = workerSource.indexOf("async function socialCreateGroup");
  const end = workerSource.indexOf("async function socialGroupInvite", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /for \(let i = 0; i < targets\.length; i\+\+\)/);
  assert.match(handler, /for \(let j = i \+ 1; j < targets\.length; j\+\+\)/);
  assert.match(handler, /isBlocked\(env, targets\[i\]\.id, targets\[j\]\.id\)/);
  assert.match(handler, /cannot be placed in the same group/);
});

test("SOCIAL group invite joins check block relationships with every existing participant", () => {
  const start = workerSource.indexOf("async function socialJoinGroup");
  const end = workerSource.indexOf("async function socialCreateChannel", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT user_id FROM social_conversation_members WHERE conversation_id=\?/);
  assert.match(handler, /for \(const existing of existingMembers\.results \|\| \[\]\)/);
  assert.match(handler, /isBlocked\(env, user\.id, existing\.user_id\)/);
  assert.match(handler, /Group access is unavailable because of a block relationship/);
});


test("SOCIAL story visibility respects block relationships in both directions", () => {
  assert.match(workerSource, /async function canViewSocialStory\(env, viewerId, story\)/);
  const listStart = workerSource.indexOf("async function socialStories");
  const listEnd = workerSource.indexOf("async function socialCreateStory", listStart);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /NOT EXISTS \([\s\S]*social_blocks[\s\S]*b\.blocker_id=s\.user_id AND b\.blocked_id=\?/);
  for (const name of ["socialViewStory", "socialReactStory"]) {
    const start = workerSource.indexOf("async function " + name);
    const end = workerSource.indexOf("async function ", start + 1);
    assert.ok(start >= 0 && end > start);
    assert.match(workerSource.slice(start, end), /canViewSocialStory\(env, user\.id, story\)/, name + " must enforce story visibility");
  }
});

test("SOCIAL stories can only publish ready public media uploaded by the story owner", () => {
  const start = workerSource.indexOf("async function socialCreateStory");
  const end = workerSource.indexOf("async function socialDeleteStory", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /WHERE user_id=\? AND url=\? LIMIT 1/);
  assert.match(handler, /upload\.status !== "ready"/);
  assert.match(handler, /upload\.acl !== "public"/);
  assert.match(handler, /startsWith\(expectedMime\)/);
});


test("MEHRAN MUSIC STUDIO is linked from Services as an independent workspace", () => {
  assert.match(indexSource, /href="music-studio\.html"/);
  assert.match(indexSource, /MEHRAN MUSIC STUDIO/);
  assert.match(musicStudioSource, /<title>MEHRAN MUSIC STUDIO<\/title>/);
  assert.match(musicStudioSource, /Independent creative workspace/);
});

test("MEHRAN MUSIC STUDIO keeps drafts local and separates free lyric AI from disabled audio generation", () => {
  assert.match(musicStudioSource, /mehran_music_studio_drafts_v1/);
  assert.match(musicStudioSource, /localStorage\.setItem\(KEY,JSON\.stringify\(projects\)\)/);
  assert.match(musicStudioSource, /LOCAL AUDIO ENGINE/);
  assert.match(musicStudioSource, /QUALITY TESTING/);
  assert.match(musicStudioSource, /Audio generation is not active yet/);
  assert.match(musicStudioSource, /AI Songwriter/);
  assert.match(musicStudioSource, /music\/lyrics\/generate/);
  assert.match(musicStudioSource, /No automatic paid fallback/);
  assert.match(workerSource, /async function musicGenerateLyrics\(/);
  assert.match(workerSource, /path === "\/music\/lyrics\/generate"/);
  assert.match(workerSource, /reserveSocialWorkersAIBudget\(env, structure === "short" \? 250 : 500, "music"\)/);
  assert.match(workerSource, /Paid external AI providers are disabled/);
  assert.match(workerSource, /WORKERS_AI_GLOBAL_DAILY_RESERVATION_CREDITS = 9000/);
});

test("MEHRAN MUSIC STUDIO supports new projects without overwriting the previously edited draft", () => {
  assert.match(musicStudioSource, /function newProject\(\)/);
  assert.match(musicStudioSource, /delete \$\("saveProject"\)\.dataset\.edit/);
  assert.ok(musicStudioSource.includes('document.querySelectorAll(".nav [data-view]")'));
  assert.ok(musicStudioSource.includes('if(view==="create"){newProject();return;}'));
  assert.match(musicStudioSource, /if\(go\.dataset\.go==="create"\)newProject\(\)/);
});

test("SOCIAL AI account identity is preserved and can only be assigned by the Pi admin", () => {
  assert.match(workerSource, /function normalizeAccountType\(value\)/);
  assert.match(workerSource, /\["human", "business", "ai"\]\.includes\(value\) \? value : "human"/);
  assert.match(workerSource, /accountType: normalizeAccountType\(user\.account_type\)/);
  assert.match(workerSource, /accountType: normalizeAccountType\(profile\.account_type\)/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)/);
  const start = workerSource.indexOf("const adminUserAccountTypeMatch");
  const end = workerSource.indexOf("const adminUserStatusMatch", start);
  assert.ok(start >= 0 && end > start, "admin account type route must exist");
  const route = workerSource.slice(start, end);
  assert.match(route, /verifyAdmin\(request, env\)/);
  assert.match(route, /\["human", "business", "ai"\]\.includes\(body\.accountType\)/);
  assert.match(route, /primary administrator identity must remain a human account/);
  assert.match(route, /writeAdminAudit\(env, admin, "account_type_changed"/);
  assert.match(workerSource, /const requestedAccountType = body\.accountType === "business" \? "business" : "human"/);
  assert.match(indexSource, /accountType==="ai"\?"🤖 AI account"/);
});

test("SOCIAL legacy registration cannot bypass verified email identity", () => {
  assert.match(workerSource, /path === "\/social\/register" && method === "POST"[\s\S]*?Legacy password registration is disabled[\s\S]*?410/);
  const sessionStart = workerSource.indexOf("async function getSocialUser");
  const sessionEnd = workerSource.indexOf("async function createSocialSession", sessionStart);
  const sessionLookup = workerSource.slice(sessionStart, sessionEnd);
  assert.match(sessionLookup, /u\.is_active=1 AND \(u\.email_verified=1 OR \(u\.pi_uid IS NOT NULL AND u\.pi_verified=1\)\)/);
  const loginStart = workerSource.indexOf("async function socialLogin");
  const loginEnd = workerSource.indexOf("async function socialMe", loginStart);
  const login = workerSource.slice(loginStart, loginEnd);
  assert.match(login, /if \(!user\.email_verified\)/);
  assert.match(login, /Email verification is required/);
  assert.match(login, /verified email identity/);
});

test("SOCIAL AI never falls back to paid external providers", () => {
  const readyStart = workerSource.indexOf("function socialAIProviderReady");
  const readyEnd = workerSource.indexOf("\nfunction socialAIProviderList", readyStart);
  const ready = workerSource.slice(readyStart, readyEnd);
  assert.match(ready, /return key === "cloudflare"/);
  assert.doesNotMatch(ready, /OPENAI_API_KEY|GEMINI_API_KEY|GROQ_API_KEY/);
  const requestStart = workerSource.indexOf("function socialAIRequest");
  const requestEnd = workerSource.indexOf("\nasync function ", requestStart);
  const request = workerSource.slice(requestStart, requestEnd);
  assert.match(request, /provider !== "cloudflare"/);
  assert.match(request, /Paid external AI providers are disabled/);
  assert.match(workerSource, /const WORKERS_AI_GLOBAL_DAILY_RESERVATION_CREDITS = 9000/);
  assert.match(workerSource, /Only the capped Cloudflare free allowance is available/);
  assert.match(workerSource, /Free image analysis currently supports one image per message/);
});

test("SOCIAL admin UI can manage Human, Business and AI identity types", () => {
  assert.match(workerSource, /SELECT id,username,email,display_name,pi_username,pi_verified,account_type/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)/);
  assert.match(indexSource, /data-account-type=/);
  assert.match(indexSource, /option value="human"/);
  assert.match(indexSource, /option value="business"/);
  assert.match(indexSource, /option value="ai"/);
  assert.match(indexSource, /\/account-type/);
  assert.match(indexSource, /Human · protected/);
});

test("SOCIAL marks AI and Business identities in feed, stories, notifications and chat data", () => {
  assert.match(workerSource, /accountType: normalizeAccountType\(author\?\.account_type\)/);
  assert.match(workerSource, /u\.username,u\.display_name,u\.avatar_url,u\.account_type\s+FROM social_messages/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)\s+\},\s+isMine/);
  assert.match(workerSource, /u\.username,u\.display_name,u\.avatar_url,u\.account_type\s+FROM social_notifications/);
  assert.match(workerSource, /u\.username,u\.display_name,u\.avatar_url,u\.account_type,\s+EXISTS/);
  assert.match(workerSource, /accountType: normalizeAccountType\(member\.account_type\)/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)/);
  assert.match(indexSource, /function socialAccountTypeLabel/);
  assert.match(indexSource, /socialAccountTypeLabel\(post\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(m\.author\?\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(s\.author\?\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(item\.actor\?\.accountType\)/);
});

test("SOCIAL AI accounts cannot inflate likes, follows or view/reaction counts", () => {
  const followStart = workerSource.indexOf("async function socialFollow(");
  const followEnd = workerSource.indexOf("\nasync function ", followStart + 20);
  assert.match(workerSource.slice(followStart, followEnd), /user\.accountType === "ai" && follow/);
  const likeStart = workerSource.indexOf("async function socialLikePost");
  const likeEnd = workerSource.indexOf("\nasync function ", likeStart + 20);
  assert.match(workerSource.slice(likeStart, likeEnd), /shouldLike && user\.accountType === "ai"/);
  const viewStart = workerSource.indexOf("async function socialViewPost");
  const viewEnd = workerSource.indexOf("\nasync function ", viewStart + 20);
  assert.match(workerSource.slice(viewStart, viewEnd), /user\.accountType === "ai"/);
  const storyReactStart = workerSource.indexOf("async function socialReactStory");
  const storyReactEnd = workerSource.indexOf("\nasync function ", storyReactStart + 20);
  assert.match(workerSource.slice(storyReactStart, storyReactEnd), /user\.accountType === "ai"/);
  const storyViewStart = workerSource.indexOf("async function socialViewStory");
  const storyViewEnd = workerSource.indexOf("\nasync function ", storyViewStart + 20);
  assert.match(workerSource.slice(storyViewStart, storyViewEnd), /user\.accountType === "ai"/);
  const adminStart = workerSource.indexOf("const adminUserAccountTypeMatch");
  const adminEnd = workerSource.indexOf("const adminUserStatusMatch", adminStart);
  const adminRoute = workerSource.slice(adminStart, adminEnd);
  for (const table of ["social_post_likes", "social_follows", "social_follow_requests", "social_post_views", "social_story_views", "social_story_reactions"]) {
    assert.ok(adminRoute.includes("DELETE FROM " + table), "AI conversion must clean " + table);
  }
});

test("SOCIAL public profile visibly labels verified AI and Business account types", () => {
  assert.match(workerSource, /accountType: normalizeAccountType\(profile\.account_type\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(p\.accountType\)/);
  assert.match(indexSource, /profile-name-line/);
});

test("SOCIAL comments preserve and display the author's verified account type", () => {
  const listStart = workerSource.indexOf("async function socialListComments");
  const listEnd = workerSource.indexOf("\nasync function ", listStart + 20);
  const listRoute = workerSource.slice(listStart, listEnd);
  assert.match(listRoute, /u\.avatar_url,u\.account_type/);
  assert.match(listRoute, /accountType: normalizeAccountType\(row\.account_type\)/);
  const createStart = workerSource.indexOf("async function socialCreateComment");
  const createEnd = workerSource.indexOf("\nasync function ", createStart + 20);
  assert.match(workerSource.slice(createStart, createEnd), /accountType: normalizeAccountType\(user\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(c\.accountType\|\|c\.author\?\.accountType\)/);
  assert.match(indexSource, /accountType:c\.author\?\.accountType\|\|"human"/);
});

test("SOCIAL follow requests expose account type and acceptance revalidates privacy and active accounts", () => {
  const listStart = workerSource.indexOf("async function socialFollowRequests");
  const listEnd = workerSource.indexOf("async function ", listStart + 30);
  assert.ok(listStart >= 0 && listEnd > listStart);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /u\.account_type/);
  assert.match(list, /accountType: normalizeAccountType\(row\.account_type\)/);
  assert.match(list, /u\.is_active=1/);

  const actionStart = workerSource.indexOf("async function socialFollowRequestAction");
  const actionEnd = workerSource.indexOf("async function ", actionStart + 30);
  const action = workerSource.slice(actionStart, actionEnd);
  assert.match(action, /requester\.is_active=1/);
  assert.match(action, /target\.is_active=1/);
  assert.match(action, /await isBlocked\(env, row\.requester_id, user\.id\)/);
  assert.match(action, /NOT EXISTS \([\s\S]*FROM social_blocks/);
  assert.match(action, /results\?\.\[0\]\?\.meta\?\.changes/);
  assert.match(indexSource, /socialAccountTypeLabel\(r\.user\.accountType\)/);
});

test("SOCIAL privacy settings reject non-boolean visibility flags instead of coercing strings", () => {
  const start = workerSource.indexOf("async function socialPrivacy");
  const end = workerSource.indexOf("async function ", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /\["isPrivate", "showOnlineStatus", "showActivityStatus"\]/);
  assert.match(handler, /typeof body\[key\] !== "boolean"/);
  assert.match(handler, /body\.isPrivate === true \? 1 : 0/);
  assert.match(handler, /body\.showOnlineStatus === true \? 1 : 0/);
  assert.match(handler, /body\.showActivityStatus === true \? 1 : 0/);
});

test("SOCIAL existing direct chats recheck the recipient's current message privacy before sending", () => {
  const start = workerSource.indexOf("async function socialSendMessage");
  const end = workerSource.indexOf("async function ", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /directRecipient = await env\.DB\.prepare/);
  assert.match(handler, /c\.type IN \('direct','private'\)/);
  assert.match(handler, /recipientSettings\?\.allow_messages === "none"/);
  assert.match(handler, /recipientSettings\?\.allow_messages === "followers"/);
  assert.match(handler, /follower_id=\? AND following_id=\?/);
  assert.ok(handler.indexOf("recipientSettings") < handler.indexOf("const body = await readBody(request)"));
});



test("SOCIAL direct-call discovery, joining and signaling enforce current block relationships", () => {
  const section = (name, next) => {
    const start = workerSource.indexOf("async function " + name);
    const end = workerSource.indexOf("\nasync function " + next, start);
    assert.ok(start >= 0 && end > start, name + " handler must exist");
    return workerSource.slice(start, end);
  };
  assert.ok(section("socialCallStart", "socialCallActive").includes("isDirectConversationBlocked(env, conversationId, user.id)"));
  assert.ok(section("socialCallActive", "socialCallJoin").includes("isDirectConversationBlocked(env, conversationId, user.id)"));
  assert.ok(section("socialCallJoin", "socialCallSignal").includes("isDirectConversationBlocked(env, call.conversation_id, user.id)"));
  const signal = section("socialCallSignal", "socialCallLeave");
  assert.ok(signal.includes("isDirectConversationBlocked(env, call.conversation_id, user.id)"));
  assert.ok(signal.includes("isDirectConversationBlocked(env, call.conversation_id, toUserId)"));
});


test("SOCIAL call signaling rejects users removed from the conversation", () => {
  const start = workerSource.indexOf("async function socialCallSignal");
  const end = workerSource.indexOf("\nasync function socialCallLeave", start);
  assert.ok(start >= 0 && end > start, "socialCallSignal handler must exist");
  const handler = workerSource.slice(start, end);
  assert.match(handler, /isConversationMember\(env, call\.conversation_id, user\.id\)/);
  assert.match(handler, /isConversationMember\(env, call\.conversation_id, toUserId\)/);
  assert.match(handler, /if \(!senderMembership \|\| !targetMembership\)/);
  assert.match(handler, /social-call-signal/);
  assert.match(handler, /300, 60, 60/);
  assert.match(handler, /Array\.isArray\(body\.payload\)/);
});

test("SOCIAL call polling enforces current membership and block state", () => {
  const start = workerSource.indexOf("async function socialCallPoll");
  const end = workerSource.indexOf("\nasync function socialCallSignal", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /isConversationMember\(env,call\.conversation_id,user\.id\)/);
  assert.match(handler, /isDirectConversationBlocked\(env, call\.conversation_id, user\.id\)/);
  assert.match(handler, /JOIN social_conversation_members cm ON cm\.conversation_id=\? AND cm\.user_id=p\.user_id/);
  assert.match(handler, /\.bind\(call\.conversation_id,callId\)\.all\(\)/);
  assert.match(handler, /social-call-poll/);
  assert.match(handler, /100, 60, 60/);
  assert.match(handler, /Number\.isSafeInteger\(rawAfter\)/);
});

test("SOCIAL call creation and joining have abuse limits", () => {
  const start = workerSource.indexOf("async function socialCallStart");
  const active = workerSource.indexOf("async function socialCallActive", start);
  const join = workerSource.indexOf("async function socialCallJoin");
  const poll = workerSource.indexOf("async function socialCallPoll", join);
  assert.ok(start >= 0 && active > start && join >= 0 && poll > join);
  assert.match(workerSource.slice(start, active), /social-call-start/);
  assert.match(workerSource.slice(start, active), /5, 600, 600/);
  assert.match(workerSource.slice(join, poll), /social-call-join/);
  assert.match(workerSource.slice(join, poll), /20, 60, 60/);
});

test("SOCIAL active call participant lists exclude users removed from the conversation", () => {
  const start = workerSource.indexOf("async function socialCallActive");
  const end = workerSource.indexOf("\nasync function socialCallJoin", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /JOIN social_conversation_members cm ON cm\.conversation_id=\? AND cm\.user_id=p\.user_id/);
  assert.match(handler, /\.bind\(call\.conversation_id,call\.id\)\.all\(\)/);
});

test("SOCIAL bot owners can rotate active credentials and delete only their own bots", () => {
  const rotateStart = workerSource.indexOf("async function socialRotateBotToken");
  const deleteStart = workerSource.indexOf("async function socialDeleteBot");
  const listStart = workerSource.indexOf("async function socialListBots");
  const aiStart = workerSource.indexOf("const SOCIAL_AI_PROVIDERS");
  assert.ok(rotateStart > listStart && deleteStart > rotateStart && aiStart > deleteStart);
  const rotate = workerSource.slice(rotateStart, deleteStart);
  const remove = workerSource.slice(deleteStart, aiStart);
  const createStart = workerSource.indexOf("async function socialCreateBot");
  const createEnd = workerSource.indexOf("\nasync function socialListBots", createStart);
  const create = workerSource.slice(createStart, createEnd);
  assert.match(create, /social-bot-create/);
  assert.match(create, /SELECT COUNT\(\*\) AS total FROM social_bots WHERE owner_id=\?/);
  assert.match(create, /ownedBots\?\.total \|\| 0\) >= 25/);
  assert.match(rotate, /social-bot-rotate/);
  assert.match(rotate, /UPDATE social_bots SET token_hash=\? WHERE id=\? AND owner_id=\? AND is_active=1/);
  assert.match(rotate, /return json\(\{ success: true, token, rotated: true \}\)/);
  assert.match(remove, /DELETE FROM social_bots WHERE id=\? AND owner_id=\?/);
  assert.match(remove, /return json\(\{ success: true, deleted: true \}\)/);
  assert.match(workerSource, /rotate-token/);
  const listFnStart = workerSource.indexOf("async function socialListBots");
  const listEnd = workerSource.indexOf("\nasync function socialRotateBotToken", listFnStart);
  const list = workerSource.slice(listFnStart, listEnd);
  assert.match(list, /SELECT id,name,username,description,is_active,created_at/);
  assert.match(list, /FROM social_bots WHERE owner_id=\?/);
  assert.doesNotMatch(list, /token_hash/);
});

test("SOCIAL account deletion reauthenticates, removes external media and cleans account-owned data", () => {
  const start = workerSource.indexOf("async function socialDeleteAccount");
  const end = workerSource.indexOf("\n}\n\nexport default", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start, "socialDeleteAccount implementation must exist");
  for (const marker of [
    "identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
    "identitytoolkit.googleapis.com/v1/accounts:lookup",
    "identity.localId === row.firebase_uid",
    "rapidfileRequest(env, `/files/",
    "DELETE FROM social_uploads WHERE user_id=?",
    "DELETE FROM social_posts WHERE user_id=?",
    "DELETE FROM social_stories WHERE user_id=?",
    "DELETE FROM social_sessions WHERE user_id=?",
    "DELETE FROM social_users WHERE id=?",
    "Could not remove all account media from storage",
    "ownershipTransferred: true",
    "identitytoolkit.googleapis.com/v1/accounts:delete",
    "providerIdentityDeleted"
  ]) assert.ok(handler.includes(marker), "Missing account deletion safeguard: " + marker);
  assert.doesNotMatch(handler, /deactivated: true/);
});

test("SOCIAL deletion transfers owned communities only to active existing members", () => {
  const start = workerSource.indexOf("async function socialDeleteAccount");
  const end = workerSource.indexOf("\n}\n\nexport default", start);
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("JOIN social_users u ON u.id=cm.user_id") && handler.includes("u.is_active=1"));
  assert.ok(handler.includes("UPDATE social_conversation_members SET role='owner'") && handler.includes("c.owner_id=social_conversation_members.user_id"));
  assert.ok(handler.includes("UPDATE social_channel_members SET role='owner'") && handler.includes("c.owner_id=social_channel_members.user_id"));
});


test("authenticated SOCIAL rate limits are account-scoped while pre-auth limits remain IP-scoped", () => {
  const helperStart = workerSource.indexOf("async function checkRateLimit");
  const helperEnd = workerSource.indexOf("\\n}", helperStart);
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.ok(helper.includes("account:${accountId}"));
  assert.ok(helper.includes("ip:${ip}"));
  assert.ok(helper.includes("accountId = null"));
  for (const [fn, scope] of [
    ["socialCallStart", "social-call-start"],
    ["socialCallJoin", "social-call-join"],
    ["socialCallPoll", "social-call-poll"],
    ["socialCallSignal", "social-call-signal"],
    ["socialAssistantChat", "social-ai-chat"],
    ["socialDeleteAccount", "account-delete"]
  ]) {
    const start = workerSource.indexOf("async function " + fn);
    assert.ok(start >= 0, fn + " must exist");
    const next = workerSource.indexOf("\\nasync function ", start + 1);
    const body = workerSource.slice(start, next > start ? next : undefined);
    assert.ok(body.includes(scope), fn + " must retain its rate-limit scope");
    assert.ok(body.includes("user.id"), fn + " must pass the authenticated account ID");
  }
  const registerStart = workerSource.indexOf("async function socialRegister");
  const registerEnd = workerSource.indexOf("async function socialFirebaseSession", registerStart);
  assert.ok(workerSource.slice(registerStart, registerEnd).includes(
    'checkRateLimit(env, request, "register-v3", 20, 3600, 600)'
  ), "pre-auth registration must remain IP-scoped");
});


test("SOCIAL call leave requires active participation and is rate limited", () => {
  const start = workerSource.indexOf("async function socialCallLeave");
  const end = workerSource.indexOf("\nasync function socialStartConversation", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes('"social-call-leave", 30, 60, 60, user.id'));
  assert.ok(handler.includes("SELECT left_at FROM social_call_participants WHERE call_id=? AND user_id=?"));
  assert.ok(handler.includes("if (!participant || participant.left_at)"));
  assert.ok(handler.indexOf("if (!participant || participant.left_at)") < handler.indexOf("UPDATE social_call_participants"));
});


test("SOCIAL active-call status polling is account rate limited", () => {
  const start = workerSource.indexOf("async function socialCallActive");
  const end = workerSource.indexOf("\nasync function socialCallJoin", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes('"social-call-active", 60, 60, 60, user.id'));
  assert.ok(handler.includes("Call status checks are temporarily rate limited"));
});


test("SOCIAL call participant capacity is enforced atomically in the join write", () => {
  const start = workerSource.indexOf("async function socialCallJoin");
  const end = workerSource.indexOf("\nasync function socialCallPoll", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes("INSERT INTO social_call_participants"));
  assert.ok(handler.includes("SELECT ?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL"));
  assert.ok(handler.includes("p.user_id<>?"));
  assert.ok(handler.includes("p.last_seen_at>=datetime('now','-25 seconds')"));
  assert.ok(handler.includes("ON CONFLICT(call_id,user_id) DO UPDATE"));
  assert.ok(handler.includes("joined?.meta?.changes"));
  assert.ok(!handler.includes("const existing ="));
  assert.ok(!handler.includes("const count ="));
});


test("SOCIAL permits only one active call per conversation, including concurrent starts", () => {
  assert.ok(workerSource.includes("idx_social_call_one_active_per_conversation"));
  assert.ok(workerSource.includes("ON social_call_sessions(conversation_id) WHERE status='active'"));
  assert.ok(workerSource.includes("newer.created_at DESC,newer.id DESC LIMIT 1"));
  const start = workerSource.indexOf("async function socialCallStart");
  const end = workerSource.indexOf("\nasync function socialCallActive", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes("try {"));
  assert.ok(handler.includes("catch (creationError)"));
  assert.ok(handler.includes("alreadyActive:true"));
  assert.ok(handler.includes("throw creationError"));
});


test("generated lyrics return transparent language and section-structure review warnings", () => {
  assert.match(workerSource, /const qualityWarnings = \[\]/);
  assert.match(workerSource, /\[A-Za-z\]\{2,\}/);
  assert.match(workerSource, /بخش‌بندی استاندارد آهنگ پیدا نشد/);
  assert.match(workerSource, /بخش Verse یا بند در متن مشخص نشده/);
  assert.match(workerSource, /بخش Chorus یا ترجیع‌بند مشخص نشده/);
  assert.match(workerSource, /بخش عنوان‌گذاری شده اما بدون متن است/);
  assert.match(workerSource, /qualityWarnings, provider: "cloudflare"/);
});

test("Production Intelligence scheduler runs only approved read-only reports and imports GitHub tasks for owner approval", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(controller, env, ctx)");
  const scheduledBody = workerSource.slice(scheduledStart, scheduledStart + 9000);
  assert.ok(scheduledStart >= 0, "scheduled handler remains present");
  assert.ok(scheduledBody.indexOf("const run = async") >= 0, "scheduler has a background runner");
  assert.match(scheduledBody, /await ingestGitHubIntelligenceInbox\(env\)/);
  assert.ok(scheduledBody.includes("t.status IN ('queued','accepted','retry_wait') AND t.action_type IN ('service_health_report','repository_quality_check')"), "scheduler must claim dependency-ready package tasks with retry support");
  assert.ok(scheduledBody.includes("Recover abandoned package claims"), "scheduler must recover expired executor claims");
  assert.match(workerSource, /refreshIntelligenceWorkPackageSnapshot\(env,candidate\.work_package_id\)/);
  assert.match(workerSource, /refreshIntelligenceWorkPackageSnapshot\(env,stale\.work_package_id\)/);
  assert.match(workerSource, /HTTP 5\\d\\d/);
  assert.doesNotMatch(workerSource, /HTTP 5\\\\d\\\\d/);
  assert.ok(scheduledBody.includes("action_type IN ('project_status_report','social_metrics_report')"), "scheduler claim must use the same action allowlist as candidate selection");
  assert.ok(scheduledBody.includes("status='awaiting_approval' AND requires_approval=0"));
  const agentClaimStart = workerSource.indexOf('if (path === "/agent/v1/tasks/next" && method === "GET")');
  const agentClaimEnd = workerSource.indexOf("const checkpointMatch", agentClaimStart);
  const agentClaimRoute = workerSource.slice(agentClaimStart, agentClaimEnd);
  assert.match(agentClaimRoute, /action_type IN \('repository_quality_check','service_health_report','source_security_audit','inspect_repository','run_repository_tests','propose_code_patch'\)/);
  assert.doesNotMatch(scheduledBody, /inspect_repository/, "Worker scheduled executor must not claim the GitHub-only inspection capability.");
  assert.match(workerSource, /INSERT OR IGNORE INTO intelligence_tasks/);
  assert.match(workerSource, /'github-inbox',\?,'\{\}'/);
  assert.match(workerSource, /Visibility:\\s\*public-safe/);
  assert.match(workerSource, /if \(!\/\^Visibility:/);
  assert.match(workerSource, /const actionMatch = body\.match\(\/\^Action:/);
  assert.match(workerSource, /const allowedActions = \["project_status_report","social_metrics_report","service_health_report","repository_quality_check"\]/);
  assert.match(workerSource, /issue\.user\?\.login/);
  assert.match(workerSource, /const autoApproved = actionType === "service_health_report"/);
  assert.match(workerSource, /publicBridgeResultMatch = path\.match/);
  assert.match(workerSource, /created_by='github-inbox' AND action_type='service_health_report'/);
  assert.match(workerSource, /result:task\.status === "completed"/);
  assert.ok(workerSource.includes("t.status IN ('queued','accepted','retry_wait')"), "package scheduler must include retry-wait tasks");
  assert.doesNotMatch(workerSource, /Production Intelligence Agent execution is disabled\./);
  assert.match(workerSource, /github\.com\/repos\/Mehranmsh\/mehranmsh\.github\.io\/issues\?state=open&per_page=100/);
});
test("Intelligence scheduler history is private, bounded and stores execution counters", () => {
  assert.match(workerSource, /CREATE TABLE IF NOT EXISTS intelligence_scheduler_runs/);
  assert.match(workerSource, /idx_intelligence_scheduler_runs_started/);
  assert.match(workerSource, /path === "\/intelligence\/scheduler\/runs" && method === "GET"/);
  const routeStart = workerSource.indexOf('path === "/intelligence/scheduler/runs"');
  const routeEnd = workerSource.indexOf('path === "/intelligence/tasks"', routeStart);
  const route = workerSource.slice(routeStart, routeEnd);
  assert.ok(route.includes("verifyAdmin(request, env)"));
  assert.ok(route.includes("safeLimit(url.searchParams.get(\"limit\"), 20, 50)"));
  assert.ok(route.includes("ORDER BY started_at DESC LIMIT ?"));
  assert.match(workerSource, /INSERT INTO intelligence_scheduler_runs\(id,started_at,status\)/);
  assert.match(workerSource, /processed_count=\?,completed_count=\?,blocked_count=\?/);
  assert.match(workerSource, /status='failed'/);
});

test("Intelligence scheduler history endpoint rejects unauthenticated requests", async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() { return null; },
        async run() { return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; }
      };
    }
  };
  const response = await request("/intelligence/scheduler/runs", {}, { DB: db });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error, "Admin authentication required");
});


test("Task Hub can create and label only owner-approved allowlisted actions", () => {
  const html = indexSource;
  const worker = workerSource;
  for (const action of ["project_status_report", "social_metrics_report", "service_health_report", "repository_quality_check"]) {
    assert.ok(html.includes(action), `Task Hub exposes ${action}`);
    assert.ok(worker.includes(`"${action}"`), `Worker allowlists ${action}`);
  }
  assert.match(worker, /const autoApproved=preapprovedActions\.includes\(actionType\)&&\["mehran_intelligence","shared"\]\.includes\(assignedTo\)&&body\.requiresApproval!==true/);
  assert.match(worker, /const requiresApproval=Boolean\(body\.requiresApproval\|\|\s*\(actionType&&!autoApproved\)\)/);
  assert.match(worker, /action_type,action_payload\) VALUES\(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/);
  assert.match(html, /actionTypes\[task\.actionType\]/);
});




test("automated Intelligence task transitions are owner-approval-only and execution results cannot be forged", () => {
  const routeStart = workerSource.indexOf('if(intelligenceTaskMatch&&method==="PATCH")');
  const routeEnd = workerSource.indexOf('if (path === "/intelligence/chat" && method === "POST")', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "Intelligence task PATCH route must exist");
  const route = workerSource.slice(routeStart, routeEnd);
  assert.match(route, /approvalTransition=body\.status==="accepted"&&existing\.status==="awaiting_approval"&&Number\(existing\.requires_approval\)===1/);
  assert.match(route, /cancelTransition=body\.status==="cancelled"&&\["awaiting_approval","queued","accepted"\]\.includes\(existing\.status\)/);
  assert.match(route, /if\(!approvalTransition&&!cancelTransition\)return error\([\s\S]*?409\)/);
  assert.match(route, /hasOwnProperty\.call\(body,"result"\)[\s\S]*?execution service\.[\s\S]*?409/);
  assert.match(route, /requires_approval=CASE WHEN \?=\x27accepted\x27 THEN 0 ELSE requires_approval END/);
  assert.match(route, /writeAdminAudit\(env,admin,"collaboration_task_updated"/);
  assert.match(route, /const allowedFields=\["status"\]/);
  assert.match(route, /Object\.keys\(body\)\.some/);
  assert.match(route, /WHERE id=\? AND status=\? AND requires_approval=\? AND action_type=\?/);
  assert.match(route, /Task changed concurrently\. Refresh the task before retrying/);
  assert.match(route, /if\(!Number\(update\?\.meta\?\.changes\|\|0\)\)/);
  assert.match(route, /WHERE id=\? AND status=\? AND requires_approval=\?/);
});



test("MEHRAN Intelligence auto-approves only pre-authorized bounded tasks", () => {
  assert.ok(workerSource.includes('import { INTELLIGENCE_ACTION_TYPES, PREAPPROVED_INTELLIGENCE_ACTION_TYPES } from "./scripts/intelligence-capabilities.mjs";'));
  assert.ok(workerSource.includes("const allowedActionTypes=INTELLIGENCE_ACTION_TYPES"));
  const start = workerSource.indexOf('const preapprovedActions=PREAPPROVED_INTELLIGENCE_ACTION_TYPES;');
  const end = workerSource.indexOf('const id=crypto.randomUUID()', start);
  assert.ok(start >= 0 && end > start, "task creation must use the canonical pre-approval policy");
  const policy = workerSource.slice(start, end);
  assert.ok(policy.includes('["mehran_intelligence","shared"].includes(assignedTo)'));
  assert.ok(policy.includes("body.requiresApproval!==true"));
  assert.ok(policy.includes("Boolean(body.requiresApproval|| (actionType&&!autoApproved))"));
  assert.ok(workerSource.includes("Automated task execution status is controlled by MEHRAN INTELLIGENCE"));
});


test("Intelligence task creation rejects automated reports assigned to ChatGPT without an executor", () => {
  const start = workerSource.indexOf('if (path === "/intelligence/tasks" && ["GET","POST"].includes(method))');
  const end = workerSource.indexOf('const intelligenceTaskMatch=', start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  assert.match(route, /if\(actionType&&assignedTo==="chatgpt"\)/);
  assert.match(route, /Allowlisted report actions must be assigned to mehran_intelligence or shared/);
  const mcpStart = workerSource.indexOf('if (path === "/mcp" && method === "POST")');
  const mcpEnd = workerSource.indexOf('if (path === "/intelligence/chat" && method === "POST")', mcpStart);
  assert.ok(mcpStart >= 0 && mcpEnd > mcpStart);
  assert.match(workerSource.slice(mcpStart, mcpEnd), /if\(actionType&&assignedTo==="chatgpt"\)/);
});


test("MCP task updates permit only owner approval or cancellation and cannot forge execution results", () => {
  const start = workerSource.indexOf('if (name === "update_collaboration_task")');
  const end = workerSource.indexOf('return rpcError(-32602,"Unknown tool.")', start);
  assert.ok(start >= 0 && end > start);
  const route = workerSource.slice(start, end);
  assert.match(route, /const allowed=\["taskId","status"\]/);
  assert.match(route, /!\["accepted","cancelled"\]\.includes\(args\.status\)/);
  assert.match(route, /approvalTransition=args\.status==="accepted"&&existing\.status==="awaiting_approval"&&Number\(existing\.requires_approval\)===1/);
  assert.match(route, /cancelTransition=args\.status==="cancelled"&&\["awaiting_approval","queued","accepted"\]\.includes\(existing\.status\)/);
  assert.match(route, /Execution results are controlled by the execution service/);
  assert.match(route, /requires_approval=CASE WHEN \?='accepted' THEN 0 ELSE requires_approval END/);
  assert.doesNotMatch(route, /result_text=/);
});


test("MEHRAN INTELLIGENCE private work packages are idempotent, bounded, dependency-aware, and read-only", () => {
  const start = workerSource.indexOf('if (path.startsWith("/agent/v1/"))');
  const end = workerSource.indexOf('if (path === "/health"', start);
  assert.ok(start >= 0 && end > start, "authenticated agent API must exist");
  const route = workerSource.slice(start, end);
  const checks = [
    [route, 'path === "/agent/v1/work-packages" && method === "POST"'],
    [route, 'path.startsWith("/agent/v1/work-packages/")'],
    [route, "idempotencyKey"],
    [route, "requestHash = await sha256(JSON.stringify({title,objective,priority,scope,tasks:normalized}))"],
    [route, "Idempotency key was already used with a different work package payload."],
    [route, "new Set(dependencies).size !== dependencies.length"],
    [route, "scopeJson.length > 4000"],
    [route, "const packageAllowedActions = scope.allowedActions"],
    [route, "tasks.some(task => !packageAllowedActions.includes(cleanText(task?.actionType,80)))"],
    [route, "Work package scope.allowedActions must explicitly authorize every task"],
    [workerSource, "request_hash TEXT NOT NULL DEFAULT ''"],
    [workerSource, "idempotency_key TEXT NOT NULL UNIQUE"],
    [route, "tasks.length > 20"],
    [route, '"service_health_report","repository_quality_check"'],
    [route, "Dependencies must be unique and reference earlier tasks in this package"],
    [route, "env.DB.batch(statements)"],
    [route, "intelligence_task_dependencies"],
    [route, "intelligence_work_packages"],
    [route, "intelligence_task_events"],
    [route, "NOT EXISTS (SELECT 1 FROM intelligence_task_dependencies"],
    [route, 'bind(packageId + ":" + item.taskId,packageId + ":" + dependency)'],
    [route, "p.status<>'completed'"],
    [route, "COALESCE(t.attempts,0)<COALESCE(t.max_attempts,3)"],
    [route, "attention_required"],
    [route, "retryWaiting:0"],
    [route, 'task.status === "retry_wait"'],
    [route, "waiting_retry"],
    [route, "checkpoint_json,last_error_code"],
    [route, "blockedDependencies"],
    [route, "report_json=?"],
    [route, "UPDATE intelligence_work_packages SET status="],
    [route, "work_package_status_changed"],
    [route, "fromStatus:pkg.status,toStatus:status"],
    [route, 'path.startsWith("/agent/v1/")'],
    [route, "env.MEHRAN_AGENT_TOKEN"],
    [route, "ownerOrchestrationRoute"],
    [route, "env.MEHRAN_ORCHESTRATOR_TOKEN"],
    [route, "Owner orchestration authentication required."],
    [route, "requires_approval=0"]
  ];
  for (const [source, expected] of checks) assert.ok(source.includes(expected), "Missing protocol invariant: " + expected);
});


test("MEHRAN INTELLIGENCE owner notification outbox is authenticated and lease-based", () => {
  const start = workerSource.indexOf('if (path.startsWith("/agent/v1/"))');
  const end = workerSource.indexOf('if (path === "/health"', start);
  const route = workerSource.slice(start, end);
  assert.ok(route.includes('path === "/agent/v1/notifications/next" && method === "GET"'));
  assert.ok(route.includes('path === "/agent/v1/notifications/status" && method === "GET"'));
  assert.ok(route.includes('recentFailures:failures.results||[]'));
  assert.ok(route.includes('path.startsWith("/agent/v1/notifications/") && method === "POST"'));
  assert.ok(route.includes('const ownerOrchestrationRoute ='), "owner orchestration routes must be explicitly separated");
  assert.ok(route.includes('path === "/agent/v1/missions/plan" && method === "POST"'), "mission planning must require the separate owner orchestration identity");
  assert.ok(route.includes('path === "/agent/v1/work-packages" && method === "POST"'));
  assert.ok(route.includes('path === "/agent/v1/work-packages/scope-diagnostics" && method === "GET"'), "scope diagnostics must be an explicit owner-only GET route");
  assert.ok(route.includes('packages: {') && route.includes('aggregateOnly: true') && route.includes('reviewRequiredCount'), "scope diagnostics must return bounded aggregate counts only");
  assert.ok(route.includes("json_each(CASE WHEN json_valid(scope_json) THEN scope_json ELSE '{}' END,'$.allowedActions')"), "scope diagnostics must safely classify malformed or missing legacy scope JSON");
  assert.ok(route.includes("GROUP BY status ORDER BY status LIMIT 20"), "scope diagnostics must bound grouped output");
  assert.ok(route.includes("const ownerOrchestrationRoute =") && route.includes('path === "/agent/v1/work-packages/scope-diagnostics" && method === "GET"'), "scope diagnostics must use owner orchestration authentication");

  assert.ok(route.includes('path.startsWith("/agent/v1/work-packages/") && method === "GET"'));
  assert.ok(route.includes('path.startsWith("/agent/v1/notifications/") && method === "POST"'), "notification delivery must require the separate owner orchestration identity");
  assert.ok(route.includes('status IN (\'pending\',\'retry_wait\')'));
  assert.ok(route.includes("status='processing' AND lease_token=? AND next_attempt_at IS NOT NULL AND datetime(next_attempt_at)>=datetime('now')"), "only the current delivery lease can be acknowledged");
  assert.ok(route.includes("CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry_wait' END"), "abandoned delivery leases must have bounded retries");
  assert.ok(route.includes("min(3600,30 * (1 << max(0,attempts-1)))"), "delivery lease retry delay must use capped exponential backoff");
  assert.ok(route.includes("status='processing'"));
  assert.ok(route.includes("leaseExpiresAt"));
  assert.ok(route.includes("leaseToken"));
  assert.ok(route.includes("const leaseToken = typeof body?.leaseToken === \"string\" ? body.leaseToken : \"\""));
  assert.ok(route.includes("A valid notification lease token is required."));
  assert.ok(route.includes("lease_token=?"));
  assert.ok(route.includes("lease_token=''"));
  assert.ok(workerSource.includes("ALTER TABLE intelligence_notification_outbox ADD COLUMN lease_token TEXT NOT NULL DEFAULT ''"));
  assert.ok(route.includes('["delivered","retry","failed"]'));
  assert.ok(route.includes("notification lease changed before acknowledgement") || route.includes("Notification lease changed before acknowledgement."));
  assert.ok((workerSource.match(/INSERT OR IGNORE INTO intelligence_notification_outbox/g) || []).length >= 2, "both scheduler and package-report transitions must enqueue notifications");
  assert.ok(workerSource.includes("channel,payload_json,status) VALUES(?,?, 'owner_private',?,'pending')"));
  assert.ok(!workerSource.includes("package_status:"), "each package status transition must receive a fresh event ID");
  assert.ok(workerSource.includes("JSON.stringify({eventId,type:\"work_package_status_changed\""), "notification payload must carry its deduplication event ID");
  assert.ok(route.includes('path === "/agent/v1/notifications/next" && method === "GET"'));
});

test("MEHRAN INTELLIGENCE scheduler executes only dependency-ready package tasks with bounded retries", () => {
  const start = workerSource.indexOf("async scheduled(controller, env, ctx)");
  const end = workerSource.indexOf("async fetch(request, env)", start);
  assert.ok(start >= 0 && end > start, "scheduled runner must exist");
  const scheduler = workerSource.slice(start, end);
  const required = [
    "t.work_package_id IS NOT NULL",
    "t.status IN ('queued','accepted','retry_wait')",
    "t.action_type IN ('service_health_report','repository_quality_check')",
    "t.next_attempt_at",
    "NOT EXISTS (SELECT 1 FROM intelligence_task_dependencies",
    "p.status<>'completed'",
    "attempts=CASE WHEN work_package_id IS NOT NULL THEN COALESCE(attempts,0)+1",
    "agent_claimed_at=CURRENT_TIMESTAMP",
    "candidate.work_package_id || null",
    "task_verified",
    'const nextStatus = retryable ? "retry_wait" : "blocked"',
    "task_retry_scheduled",
    "Math.min(3600,30 * (2 ** Math.max(0,Number(candidate.attempts || 0))))"
  ];
  for (const expected of required) assert.ok(scheduler.includes(expected), "Missing scheduler invariant: " + expected);
});


test("INTELLIGENCE completion requires action-specific acceptance checks and commits evidence with status", () => {
  assert.match(workerSource, /function verifyIntelligenceReport\(actionType, report\)/);
  assert.match(workerSource, /report\.repository !== "Mehranmsh\/mehranmsh\.github\.io"/);
  assert.match(workerSource, /report\.activeUsers > report\.registeredUsers/);
  assert.match(workerSource, /const acceptance = verifyIntelligenceReport\(candidate\.action_type, report\)/);
  assert.match(workerSource, /if \(!acceptance\.passed\) throw new Error\("Acceptance verification failed:/);
  assert.match(workerSource, /acceptanceChecks:acceptance\.checks/);
  assert.match(workerSource, /const completion = await env\.DB\.batch\(\[/);
  assert.match(workerSource, /WHERE id=\? AND status='in_progress'/);
});


test("INTELLIGENCE acceptance verifier accepts valid action-specific reports", () => {
  const valid = [
    ["service_health_report", {type:"service_health_report",worker:"online",database:true}],
    ["service_health_report", {type:"service_health_report",database:"healthy",projectRecords:4}],
    ["source_security_audit", {type:"source_security_audit",mode:"deterministic_read_only_static_audit",files:{"worker.js":{sha:"a",bytes:10},".github/workflows/mehran-intelligence-runner.yml":{sha:"b",bytes:10}},summary:{checks:1,passed:1,failed:0,status:"passed"},checks:[{id:"cors",passed:true,detail:"ok"}]}],
    ["repository_quality_check", {type:"repository_quality_check",repository:"Mehranmsh/mehranmsh.github.io",defaultBranch:"main",openIssues:2,lastPushedAt:"2026-11-22T10:00:00Z",latestCommit:"abcdef123456",latestCommitAt:"2026-11-22T09:00:00Z"}],
    ["project_status_report", {type:"project_status_report",projects:[{name:"SOCIAL",status:"active",description:"Module"}]}],
    ["social_metrics_report", {type:"social_metrics_report",registeredUsers:10,activeUsers:7,posts:12,openReports:1}]
  ];
  for (const [action, report] of valid) {
    const result = verifyIntelligenceReport(action, report);
    assert.equal(result.passed, true, action);
    assert.ok(result.checks.length >= 2, action);
  }
});

test("INTELLIGENCE acceptance verifier rejects malformed, mismatched, and unsafe reports", () => {
  assert.equal(verifyIntelligenceReport("service_health_report", {type:"repository_quality_check"}).passed, false);
  assert.equal(verifyIntelligenceReport("service_health_report", {type:"service_health_report",database:"down",projectRecords:1}).passed, false);
  assert.equal(verifyIntelligenceReport("service_health_report", {type:"service_health_report",worker:"offline",database:false}).passed, false);
  assert.equal(verifyIntelligenceReport("source_security_audit", {type:"source_security_audit",mode:"deterministic_read_only_static_audit",summary:{checks:1,passed:1,failed:0,status:"passed"},checks:[]}).passed, false);
  assert.equal(verifyIntelligenceReport("repository_quality_check", {type:"repository_quality_check",repository:"attacker/repo",defaultBranch:"main",openIssues:0,lastPushedAt:"2026-11-22",latestCommit:"abcdef123456",latestCommitAt:"2026-11-22"}).passed, false);
  assert.equal(verifyIntelligenceReport("project_status_report", {type:"project_status_report",projects:Array(51).fill({name:"x",status:"x",description:"x"})}).passed, false);
  assert.equal(verifyIntelligenceReport("social_metrics_report", {type:"social_metrics_report",registeredUsers:2,activeUsers:3,posts:0,openReports:0}).passed, false);
  assert.equal(verifyIntelligenceReport("arbitrary_code", {type:"arbitrary_code"}).passed, false);
});


test("INTELLIGENCE package status transitions use compare-and-set and enqueue at most one notification", () => {
  const start = workerSource.indexOf('if (pkg.status !== status)');
  const end = workerSource.indexOf('return json({success:true,workPackage:', start);
  assert.ok(start >= 0 && end > start, "work-package report status block must exist");
  const block = workerSource.slice(start, end);
  assert.match(block, /WHERE id=\? AND status=\?/);
  assert.match(block, /SELECT .*WHERE changes\(\)>0/);
  assert.match(block, /WHERE EXISTS \(SELECT 1 FROM intelligence_task_events WHERE id=\?\)/);
  assert.match(block, /if \(Number\(transition\?\.\[0\]\?\.meta\?\.changes \|\| 0\)\)/);
});


test("routine read-only missions are classified before any AI memory or inference work", () => {
  const helperStart = routinePlannerSource.indexOf("function buildDeterministicRoutinePlan");
  const helperEnd = routinePlannerSource.length;
  const plannerStart = workerSource.indexOf("async function planIntelligenceMission");
  const plannerEnd = workerSource.indexOf("export function verifyIntelligenceReport", plannerStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "deterministic classifier must exist");
  assert.ok(plannerStart >= 0 && plannerEnd > plannerStart, "mission planner must exist");
  const classifier = routinePlannerSource.slice(helperStart, helperEnd);
  const planner = workerSource.slice(plannerStart, plannerEnd);
  assert.match(classifier, /service_health_report/);
  assert.match(classifier, /repository_quality_check/);
  assert.match(classifier, /source_security_audit/);
  assert.match(classifier, /بررسی سلامت/);
  assert.match(classifier, /بررسی امنیت/);
  assert.match(planner, /const deterministicPlan = buildDeterministicRoutinePlan\(mission\)/);
  assert.match(planner, /return createDeterministicRoutinePackage\(env, mission, idempotencyKey, input\?\.ownerUid, deterministicPlan\)/);
  assert.ok(planner.indexOf("buildDeterministicRoutinePlan(mission)") < planner.indexOf("await ensureIntelligenceMemoryTables(env)"), "routine tasks must bypass memory reads and AI planning");
  assert.match(workerSource, /aiInferenceUsed: false/);
  assert.match(workerSource, /deterministic_rules_v1/);
});

test("MEHRAN INTELLIGENCE mission planner uses Workers AI JSON Mode and accepts structured object responses", () => {
  const start = workerSource.indexOf("async function planIntelligenceMission");
  const end = workerSource.indexOf("export function verifyIntelligenceReport", start);
  assert.ok(start >= 0 && end > start, "mission planner must exist");
  const planner = workerSource.slice(start, end);
  assert.match(planner, /jsonMode: true, temperature: 0, maxTokens: 1000/);
  assert.match(planner, /runIntelligenceAI\(env/);
  assert.match(planner, /extractIntelligenceJsonObject\(modelResponse\)/);
  assert.doesNotMatch(planner, /json_schema:/);
  assert.match(planner, /const modelResponse = modelResult && modelResult\.response != null/);
  assert.match(planner, /typeof modelResponse === "object" && !Array\.isArray\(modelResponse\)/);
  assert.match(planner, /typeof modelResponse === "string"/);
  assert.match(planner, /plan\.tasks\.length > 5/);
  assert.match(planner, /createIntelligenceWorkPackage\(env/);
});

test("MCP work-package validation accepts bounded read-only task plans", () => {
  const result = validateIntelligenceWorkPackage({
    idempotencyKey: "owner-plan-2026-11-22-a1",
    title: "Protocol acceptance checks",
    objective: "Verify the private bridge foundation.",
    priority: "high",
    scope: { modules: ["intelligence"], private: true },
    tasks: [
      { taskId: "health", title: "Check service health", actionType: "service_health_report" },
      { taskId: "repo", title: "Check repository metadata", actionType: "repository_quality_check", dependsOn: ["health"] }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks[1].dependencies, ["health"]);
});

test("MCP work-package validation rejects arbitrary actions, forward dependencies, and oversized plans", () => {
  const base = {
    idempotencyKey: "owner-plan-2026-11-22-b1",
    title: "Bounded plan",
    tasks: [{ taskId: "one", title: "Safe report", actionType: "service_health_report" }]
  };
  assert.equal(validateIntelligenceWorkPackage({ ...base, tasks: [{ ...base.tasks[0], actionType: "shell_command" }] }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({ ...base, tasks: [{ ...base.tasks[0], dependsOn: ["later"] }, { taskId: "later", title: "Later", actionType: "repository_quality_check" }] }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({ ...base, tasks: Array.from({ length: 21 }, (_, index) => ({ taskId: "task-" + index, title: "Task " + index, actionType: "service_health_report" })) }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({ ...base, idempotencyKey: "short" }).ok, false);
});

test("private Intelligence runner inline JavaScript parses as an ES module", () => {
  const marker = "node --input-type=module <<'NODE'";
  const markerAt = runnerSource.indexOf(marker);
  assert.ok(markerAt >= 0, "private runner heredoc must exist");
  const scriptStart = runnerSource.indexOf("\n", markerAt) + 1;
  const scriptEnd = runnerSource.indexOf("\n          NODE", scriptStart);
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart, "runner heredoc boundaries must be valid");
  const script = runnerSource.slice(scriptStart, scriptEnd)
    .split("\n")
    .map(line => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
  const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: script,
    encoding: "utf8"
  });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout || "Runner inline JavaScript syntax check failed.");
});

test("repository inspection work packages enforce exact bounded paths and persist them", () => {
  const base = {
    idempotencyKey: "inspect-plan-2026-11-23-a1",
    title: "Inspect Intelligence source",
    objective: "Read selected source files safely.",
    tasks: [{
      taskId: "inspect-core",
      title: "Inspect core source",
      actionType: "inspect_repository",
      paths: ["worker.js", "scripts/intelligence-capabilities.mjs"]
    }]
  };
  const accepted = validateIntelligenceWorkPackage(base);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.tasks[0].paths, base.tasks[0].paths);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, tasks: [{ ...base.tasks[0], paths: ["../../secrets"] }]
  }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, tasks: [{ ...base.tasks[0], paths: ["worker.js", "worker.js"] }]
  }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, tasks: [{ ...base.tasks[0], paths: [] }]
  }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, tasks: [{ ...base.tasks[0], paths: ["worker.js", "scripts/intelligence-agent.mjs", "scripts/intelligence-capabilities.mjs", "scripts/intelligence-capabilities.test.mjs", ".github/workflows/mehran-intelligence-runner.yml", "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md", "worker.js"] }]
  }).ok, false);
  assert.equal(validateIntelligenceWorkPackage({
    ...base, tasks: [{ taskId: "health", title: "Health", actionType: "service_health_report", paths: ["worker.js"] }]
  }).ok, false);
});

test("repository inspection result verifier requires immutable commit and bounded file evidence", () => {
  const report = {
    type: "inspect_repository",
    generatedAt: "2026-11-23T00:00:00.000Z",
    mode: "bounded_read_only_repository_inspection",
    repository: "Mehranmsh/mehranmsh.github.io",
    commitSha: "a".repeat(40),
    summary: { filesInspected: 2, totalBytes: 15 },
    analysis: { summary: "Inspected supplied source excerpts.", findings: [], limitations: [] },
    files: [
      { path: "worker.js", blobSha: "b".repeat(40), bytes: 10, lineCount: 2, symbols: ["fetch"] },
      { path: "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md", blobSha: "c".repeat(40), bytes: 5, lineCount: 1, symbols: [] }
    ]
  };
  assert.equal(verifyIntelligenceReport("inspect_repository", report).passed, true);
  assert.equal(verifyIntelligenceReport("inspect_repository", {
    ...report, files: [{ ...report.files[0], path: "../../secrets" }, report.files[1]]
  }).passed, false);
  assert.equal(verifyIntelligenceReport("inspect_repository", {
    ...report, files: [{ ...report.files[0], bytes: 500001 }, report.files[1]]
  }).passed, false);
  assert.equal(verifyIntelligenceReport("inspect_repository", {
    ...report, summary: { filesInspected: 1, totalBytes: 15 }
  }).passed, false);
});

test("MCP work-package tools are exposed only to the bridge when owner orchestration is enabled", () => {
  const start = workerSource.indexOf('if (path === "/mcp" && method === "POST")');
  const end = workerSource.indexOf("const publicBridgeResultMatch", start);
  const mcp = workerSource.slice(start, end);
  assert.ok(mcp.includes("const packageIntakeEnabled = bridgeAuthorized && orchestratorSecret.length >= 40 && orchestratorSecret.length <= 200"));
  assert.ok(mcp.includes('name:"create_intelligence_work_package"'));
  assert.ok(mcp.includes('name:"get_intelligence_work_package"'));
  assert.ok(mcp.includes('if (!packageIntakeEnabled) return rpcError(-32003'));
  assert.ok(mcp.includes('["service_health_report","repository_quality_check","source_security_audit","inspect_repository","run_repository_tests","propose_code_patch"]'));
});


test("MCP Streamable HTTP transport explicitly handles GET probes and negotiated protocol headers", () => {
  const getRoute = workerSource.indexOf('if (path === "/mcp" && method === "GET")');
  const postRoute = workerSource.indexOf('if (path === "/mcp" && method === "POST")');
  assert.ok(getRoute >= 0 && postRoute > getRoute, "MCP GET probe handling must precede the POST handler");
  const getHandler = workerSource.slice(getRoute, postRoute);
  assert.match(getHandler, /status:\s*405/);
  assert.match(getHandler, /"Allow":\s*"POST"/);

  const chatRoute = workerSource.slice(postRoute, workerSource.indexOf('if (path === "/intelligence/chat" && method === "POST")', postRoute));
  assert.match(chatRoute, /MCP-Protocol-Version/);
  assert.match(chatRoute, /Unsupported MCP protocol version/);
  assert.match(chatRoute, /2025-11-25/);
  assert.doesNotMatch(chatRoute, /2024-11-05/);
});


test("private report persistence writes a minimized JSON report to the dedicated private repository", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "PUT") return new Response(JSON.stringify({ content: { path: "reports/2026/11/package-1.json" } }), { status: 201 });
    return new Response("Not Found", { status: 404 });
  };
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (sql.includes("SELECT id,created_at,report_stored_at FROM intelligence_work_packages")) return { id: "package-1", created_at: "2026-11-22T20:00:00.000Z", report_stored_at: null };
          throw new Error("Unexpected first query: " + sql);
        },
        async all() {
          if (sql.includes("FROM intelligence_tasks WHERE work_package_id")) return {
            results: [{ id: "task-1", status: "completed", action_type: "service_health_report", attempts: 1, max_attempts: 3, last_error_code: "" }]
          };
          throw new Error("Unexpected all query: " + sql);
        },
        async run() { return { success: true, meta: { changes: 1 } }; }
      };
    }
  };
  try {
    const result = await persistIntelligencePackageReport(
      { DB: db, MEHRAN_REPORTS_GITHUB_TOKEN: "x".repeat(48) },
      "package-1",
      { status: "completed", generatedAt: "2026-11-22T20:00:00.000Z", counts: { total: 1, completed: 1 } }
    );
    assert.equal(result.stored, true);
    assert.equal(result.alreadyExists, false);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /Mehranmsh\/mehran-intelligence-reports/);
    assert.equal(calls[1].init.method, "PUT");
    assert.match(calls[1].init.headers.Authorization, /^Bearer /);
    const payload = JSON.parse(calls[1].init.body);
    const report = JSON.parse(Buffer.from(payload.content, "base64").toString("utf8"));
    assert.equal(report.schema_version, 1);
    assert.equal(report.report_id, "package-1");
    assert.equal(report.status, "success");
    assert.equal(report.data.tasks[0].action_type, "service_health_report");
    assert.equal("title" in report.data, false);
    assert.equal("result_text" in report.data.tasks[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private report finalization verifies existing artifact bytes before marking them stored", async () => {
  const originalFetch = globalThis.fetch;
  let storedContent = "";
  let mode = "missing";
  let markerWrites = 0;
  let reportStoredAt = null;
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === "PUT") {
      storedContent = JSON.parse(init.body).content;
      return new Response(JSON.stringify({ content: { path: "reports/2026/11/package-verify.json" } }), { status: 201 });
    }
    if (mode === "missing") return new Response("Not Found", { status: 404 });
    const content = mode === "matching" ? storedContent : btoa("tampered report");
    return new Response(JSON.stringify({ encoding: "base64", content }), { status: 200 });
  };
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("SELECT id,created_at,report_stored_at FROM intelligence_work_packages")) {
            return { id: "package-verify", created_at: "2026-11-22T20:00:00.000Z", report_stored_at: reportStoredAt };
          }
          throw new Error("Unexpected first query: " + sql);
        },
        async all() {
          if (sql.includes("FROM intelligence_tasks WHERE work_package_id")) {
            return { results: [{ id: "task-verify", status: "completed", action_type: "service_health_report",
              attempts: 1, max_attempts: 3, last_error_code: "", result_text: "{}" }] };
          }
          throw new Error("Unexpected all query: " + sql);
        },
        async run() { markerWrites += 1; reportStoredAt = "2026-11-23T00:00:00.000Z"; return { success: true, meta: { changes: 1 } }; }
      };
    }
  };
  const env = { DB: db, MEHRAN_REPORTS_GITHUB_TOKEN: "x".repeat(48) };
  const snapshot = { status: "completed", generatedAt: "2026-11-22T20:00:00.000Z", counts: { total: 1, completed: 1 } };
  try {
    const first = await persistIntelligencePackageReport(env, "package-verify", snapshot);
    assert.equal(first.stored, true);
    assert.equal(first.alreadyExists, false);
    assert.equal(markerWrites, 1);

    mode = "matching";
    const recovered = await persistIntelligencePackageReport(env, "package-verify", snapshot);
    assert.equal(recovered.stored, true);
    assert.equal(recovered.alreadyExists, true);
    assert.equal(markerWrites, 1, "a durable marker must prevent redundant report regeneration");

    reportStoredAt = null;
    mode = "tampered";
    await assert.rejects(
      persistIntelligencePackageReport(env, "package-verify", snapshot),
      /does not match the current package snapshot/
    );
    assert.equal(markerWrites, 1, "a conflicting artifact must never be marked as finalized");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private report retries accept only legacy generated_at drift and keep report evidence immutable", async () => {
  const originalFetch = globalThis.fetch;
  let storedContent = "";
  let mode = "missing";
  let markerWrites = 0;
  let reportStoredAt = null;
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === "PUT") {
      storedContent = JSON.parse(init.body).content;
      return new Response(JSON.stringify({ content: { path: "reports/2026/11/package-stable.json" } }), { status: 201 });
    }
    if (mode === "missing") return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify({ encoding: "base64", content: storedContent }), { status: 200 });
  };
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("SELECT id,created_at,report_stored_at FROM intelligence_work_packages")) {
            return { id: "package-stable", created_at: "2026-11-22T20:00:00.000Z", report_stored_at: reportStoredAt };
          }
          throw new Error("Unexpected first query: " + sql);
        },
        async all() {
          if (sql.includes("FROM intelligence_tasks WHERE work_package_id")) {
            return { results: [{ id: "task-stable", status: "completed", action_type: "service_health_report",
              attempts: 1, max_attempts: 3, last_error_code: "", result_text: "{}" }] };
          }
          throw new Error("Unexpected all query: " + sql);
        },
        async run() { markerWrites += 1; reportStoredAt = "2026-11-23T00:00:00.000Z"; return { success: true, meta: { changes: 1 } }; }
      };
    }
  };
  const env = { DB: db, MEHRAN_REPORTS_GITHUB_TOKEN: "x".repeat(48) };
  try {
    const first = await persistIntelligencePackageReport(env, "package-stable", {
      status: "completed", generatedAt: "2026-11-23T21:00:00.000Z", counts: { total: 1, completed: 1 }
    });
    assert.equal(first.stored, true);
    const originalReport = JSON.parse(Buffer.from(storedContent, "base64").toString("utf8"));
    assert.equal(originalReport.generated_at, "2026-11-22T20:00:00.000Z");

    const legacyReport = { ...originalReport, generated_at: "2026-11-23T21:00:00.000Z" };
    storedContent = Buffer.from(JSON.stringify(legacyReport, null, 2) + "\n").toString("base64");
    mode = "matching";
    reportStoredAt = null;
    const recovered = await persistIntelligencePackageReport(env, "package-stable", {
      status: "completed", generatedAt: "2026-11-24T01:00:00.000Z", counts: { total: 1, completed: 1 }
    });
    assert.equal(recovered.stored, true);
    assert.equal(recovered.alreadyExists, true);
    assert.equal(markerWrites, 2);

    const tampered = { ...legacyReport, data: { ...legacyReport.data, tasks: [{ ...legacyReport.data.tasks[0], status: "blocked" }] } };
    storedContent = Buffer.from(JSON.stringify(tampered, null, 2) + "\n").toString("base64");
    reportStoredAt = null;
    await assert.rejects(
      persistIntelligencePackageReport(env, "package-stable", {
        status: "completed", generatedAt: "2026-11-24T01:00:00.000Z", counts: { total: 1, completed: 1 }
      }),
      /does not match the current package snapshot/
    );
    assert.equal(markerWrites, 2, "changed task evidence must never be marked as stored");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private report persistence is a no-op until its dedicated Worker secret is configured", async () => {
  const result = await persistIntelligencePackageReport(
    { DB: {} },
    "package-1",
    { status: "completed", generatedAt: "2026-11-22T20:00:00.000Z", counts: {} }
  );
  assert.deepEqual(result, { stored: false, reason: "not_configured_or_not_final" });
});


test("Agent task claim tokens fence checkpoint and result commits to the current runner", () => {
  assert.match(workerSource, /agent_claim_token_hash TEXT NOT NULL DEFAULT ''/);
  assert.ok(workerSource.includes('const claimTokenHash = claimToken ? await sha256(claimToken) : "";'));
  const claimStart = workerSource.indexOf('if (path === "/agent/v1/tasks/next" && method === "GET")');
  const checkpointStart = workerSource.indexOf('const checkpointMatch', claimStart);
  const claimRoute = workerSource.slice(claimStart, checkpointStart);
  assert.match(claimRoute, /UPDATE intelligence_tasks SET status='in_progress'.*agent_claim_token_hash=\?/s);
  assert.match(claimRoute, /WHERE id=\? AND status IN \('queued','accepted','retry_wait'\)/);
  assert.match(claimRoute, /if \(!Number\(claimed\?\.meta\?\.changes \|\| 0\)\) return json\(\{success:true,task:null,retry:true\}\)/);
  assert.match(claimRoute, /formatIntelligenceTask\(row\),claimToken/);
  const resultStart = workerSource.indexOf('const agentResultMatch', checkpointStart);
  const resultEnd = workerSource.indexOf('return error("Not found",404);', resultStart);
  const checkpointRoute = workerSource.slice(checkpointStart, resultStart);
  const resultRoute = workerSource.slice(resultStart, resultEnd);
  assert.match(checkpointRoute, /agent_claim_token_hash=\?/);
  assert.match(checkpointRoute, /if \(!Number\(update\?\.meta\?\.changes \|\| 0\)\)/);
  assert.match(resultRoute, /agent_claim_token_hash=\?/);
  assert.match(resultRoute, /agent_claim_token_hash='',next_attempt_at/);
  assert.match(resultRoute, /if \(!Number\(update\?\.meta\?\.changes \|\| 0\)\)/);
  assert.match(workerSource, /Task claim not found, superseded, or expired/);
  assert.match(workerSource, /agent_claim_token_hash='',last_error_code='claim_expired_max_attempts'/);
  assert.match(workerSource, /agent_claim_token_hash='',last_error_code='claim_expired_retry'/);
  const schedulerRecoveryStart = workerSource.indexOf('const staleClaims = await env.DB.prepare(');
  const schedulerRecoveryEnd = workerSource.indexOf('// Repair only stale approval labels', schedulerRecoveryStart);
  const schedulerRecovery = workerSource.slice(schedulerRecoveryStart, schedulerRecoveryEnd);
  assert.match(schedulerRecovery, /SET status=\?,agent_claimed_at=NULL,agent_claim_token_hash=''/);
  assert.match(schedulerRecovery, /WHERE id=\? AND status='in_progress' AND agent_claimed_at IS NOT NULL AND datetime\(agent_claimed_at\)<datetime\('now','-15 minutes'\)/,
    "scheduler recovery must re-check stale ownership atomically before revoking a claim");
  assert.ok(schedulerRecovery.includes("json_each(wp.scope_json, '$.allowedActions')"),
    "scheduled recovery must exclude package tasks without explicit action authorization");
  const schedulerClaimStart = workerSource.indexOf('const claimed = await env.DB.prepare(', schedulerRecoveryEnd);
  const schedulerClaimEnd = workerSource.indexOf('if (!Number(claimed?.meta?.changes || 0)) continue;', schedulerClaimStart);
  const schedulerClaim = workerSource.slice(schedulerClaimStart, schedulerClaimEnd);
  assert.ok(schedulerClaim.includes("json_each(wp.scope_json, '$.allowedActions')"),
    "scheduled claim must atomically enforce the package action scope");
  assert.ok(claimRoute.includes("work_package_id IS NULL OR EXISTS (SELECT 1 FROM intelligence_work_packages wp, json_each(wp.scope_json, '$.allowedActions')"),
    "agent claim and stale-retry recovery must reject package tasks without explicit action authorization");
  assert.match(claimRoute, /agent_claim_token_hash='',last_error_code='claim_expired_max_attempts'/);
  assert.match(claimRoute, /agent_claim_token_hash='',last_error_code='claim_expired_retry'/);
  assert.match(schedulerClaim, /agent_claim_token_hash=''/);
  assert.match(runnerSource, /claimToken: task\.claimToken/);
  const runnerLogLines = runnerSource.split("\n").filter(line => /console\.(?:log|error|warn)\(/.test(line));
  assert.ok(runnerLogLines.length > 0, "runner should retain bounded operational diagnostics");
  assert.doesNotMatch(runnerLogLines.join("\n"), /claimToken|agentHeaders|ownerHeaders|Authorization|Bearer/,
    "runner logs must not expose claim credentials or authorization headers");
});


// Route-level claim lifecycle test using a deliberately narrow in-memory D1 fake.
// This exercises the real Worker fetch/auth/claim/checkpoint/result handlers; it is
// not a Cloudflare D1 integration test.
function makeClaimLifecycleDb({ synchronizeCandidateReads = false, expireDuringCheckpointCommit = false, expireDuringResultCommit = false } = {}) {
  const state = {
    row: {
      id: "claim-lifecycle-task",
      status: "queued",
      assigned_to: "mehran_intelligence",
      action_type: "repository_quality_check",
      action_payload: "{}",
      checkpoint_json: "{}",
      attempts: 0,
      max_attempts: 3,
      requires_approval: 0,
      work_package_id: null,
      agent_claim_token_hash: "",
      agent_claimed_at: null,
      next_attempt_at: null,
      priority: "normal",
      created_at: "2026-11-23T00:00:00.000Z"
    },
    expired: false,
    candidateReads: 0,
    releaseCandidates: null
  };
  if (synchronizeCandidateReads) {
    state.releaseCandidates = (() => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      return { gate, release };
    })();
  }
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes("SELECT t.id,t.status FROM intelligence_tasks t")) {
            if (state.releaseCandidates) {
              state.candidateReads++;
              if (state.candidateReads === 2) state.releaseCandidates.release();
              await state.releaseCandidates.gate;
            }
            const r = state.row;
            const retryIsDue = r.status !== "retry_wait" ||
              !r.next_attempt_at || Date.parse(r.next_attempt_at) <= Date.now();
            if (["queued", "accepted", "retry_wait"].includes(r.status) && retryIsDue &&
                Number(r.attempts) < Number(r.max_attempts)) return { id: r.id, status: r.status };
            return null;
          }
          if (sql.includes("SELECT * FROM intelligence_tasks WHERE id=?")) {
            return args[0] === state.row.id ? { ...state.row } : null;
          }
          if (sql.includes("SELECT id,work_package_id,status,attempts,max_attempts")) {
            const r = state.row;
            return args[0] === r.id && r.status === "in_progress" &&
              r.agent_claim_token_hash === args[1] && !state.expired
              ? { ...r } : null;
          }
          if (sql.includes("SELECT id,work_package_id FROM intelligence_tasks")) {
            const r = state.row;
            return args[0] === r.id && r.status === "in_progress" &&
              r.agent_claim_token_hash === args[1] && !state.expired
              ? { id: r.id, work_package_id: r.work_package_id } : null;
          }
          throw new Error("Unexpected claim lifecycle first(): " + sql);
        },
        async run() {
          // Schema setup is intentionally a no-op in this in-memory fake.
          if (/^\s*(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(sql)) return { meta: { changes: 0 } };
          if (sql.includes("claim_expired_max_attempts")) {
            if (state.expired && state.row.status === "in_progress" &&
                Number(state.row.attempts) >= Number(state.row.max_attempts)) {
              state.row.status = "blocked";
              state.row.agent_claimed_at = null;
              state.row.agent_claim_token_hash = "";
              state.row.last_error_code = "claim_expired_max_attempts";
              state.expired = false;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("claim_expired_retry")) {
            if (state.expired && state.row.status === "in_progress") {
              state.row.status = "accepted";
              state.row.agent_claimed_at = null;
              state.row.agent_claim_token_hash = "";
              state.expired = false;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("UPDATE intelligence_tasks SET status='queued'")) return { meta: { changes: 0 } };
          if (sql.includes("SET status='in_progress'") && sql.includes("agent_claim_token_hash=?")) {
            const [hash, id] = args;
            if (id === state.row.id && ["queued", "accepted", "retry_wait"].includes(state.row.status)) {
              state.row.status = "in_progress";
              state.row.attempts++;
              state.row.agent_claimed_at = new Date().toISOString();
              state.row.agent_claim_token_hash = hash;
              state.expired = false;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("SET checkpoint_json=?")) {
            const [checkpoint, id, hash] = args;
            // Model expiry recovery winning after the route's ownership SELECT
            // but before its conditional checkpoint UPDATE commits.
            if (expireDuringCheckpointCommit) {
              state.expired = true;
              state.row.status = "accepted";
              state.row.agent_claimed_at = null;
              state.row.agent_claim_token_hash = "";
            }
            if (id === state.row.id && state.row.status === "in_progress" &&
                state.row.agent_claim_token_hash === hash && !state.expired) {
              state.row.checkpoint_json = checkpoint;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("SET status=?,result_text=?")) {
            const [status, resultText, nextAttemptAt, , id, hash] = args;
            // Model expiry recovery winning after result validation but before its conditional UPDATE.
            if (expireDuringResultCommit) {
              state.expired = true;
              state.row.status = "accepted";
              state.row.agent_claimed_at = null;
              state.row.agent_claim_token_hash = "";
            }
            if (id === state.row.id && state.row.status === "in_progress" &&
                state.row.agent_claim_token_hash === hash && !state.expired) {
              state.row.status = status;
              state.row.result_text = resultText;
              state.row.next_attempt_at = nextAttemptAt;
              state.row.agent_claimed_at = null;
              state.row.agent_claim_token_hash = "";
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("INSERT INTO intelligence_task_events")) return { meta: { changes: 1 } };
          throw new Error("Unexpected claim lifecycle run(): " + sql);
        }
      };
    }
  };
  return { db, state };
}

test("real Worker task route blocks an expired claim after the retry budget is exhausted", async () => {
  const token = "test-agent-token-".padEnd(48, "x");
  const { db, state } = makeClaimLifecycleDb();
  state.row.status = "in_progress";
  state.row.attempts = state.row.max_attempts;
  state.row.agent_claimed_at = "2000-01-01T00:00:00.000Z";
  state.row.agent_claim_token_hash = "a".repeat(43);
  state.expired = true;

  const response = await request("/agent/v1/tasks/next", {
    method: "GET", headers: { Authorization: "Bearer " + token }
  }, { DB: db, MEHRAN_AGENT_TOKEN: token });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).task, null);
  assert.equal(state.row.status, "blocked", "an expired final attempt must become terminally blocked");
  assert.equal(state.row.agent_claimed_at, null);
  assert.equal(state.row.agent_claim_token_hash, "", "expired final claims must be revoked");
  assert.equal(state.row.last_error_code, "claim_expired_max_attempts");
  assert.equal(state.row.attempts, state.row.max_attempts, "expiry recovery must not exceed the attempt budget");
});

test("real Worker task routes fence concurrent, expired, superseded, and replayed runner claims", async () => {
  const token = "test-agent-token-".padEnd(48, "x");
  const { db, state } = makeClaimLifecycleDb({ synchronizeCandidateReads: true });
  const env = { DB: db, MEHRAN_AGENT_TOKEN: token };
  const auth = { Authorization: "Bearer " + token };

  const [firstResponse, secondResponse] = await Promise.all([
    request("/agent/v1/tasks/next", { method: "GET", headers: auth }, env),
    request("/agent/v1/tasks/next", { method: "GET", headers: auth }, env)
  ]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const firstPayload = await firstResponse.json();
  const secondPayload = await secondResponse.json();
  const winners = [firstPayload.task, secondPayload.task].filter(Boolean);
  assert.equal(winners.length, 1, "only one concurrent claimant may receive the task");
  const oldToken = winners[0].claimToken;
  assert.match(oldToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(state.row.agent_claim_token_hash, /^[A-Za-z0-9_-]{43}$/);

  // Simulate passage beyond the 15-minute claim window, then let the real route
  // recover and issue a fresh claim to the next runner.
  state.expired = true;
  const replacementResponse = await request("/agent/v1/tasks/next", {
    method: "GET", headers: auth
  }, env);
  assert.equal(replacementResponse.status, 200);
  const replacement = (await replacementResponse.json()).task;
  assert.ok(replacement);
  assert.notEqual(replacement.claimToken, oldToken);

  const staleCheckpoint = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: { claimToken: oldToken, checkpoint: { stale: true } }
  }, env);
  assert.equal(staleCheckpoint.status, 409, "expired runner must not checkpoint after ownership changes");

  const currentCheckpoint = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: { claimToken: replacement.claimToken, checkpoint: { baseSha: "a".repeat(40) } }
  }, env);
  assert.equal(currentCheckpoint.status, 200);

  const staleResult = await request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: { claimToken: oldToken, status: "blocked", result: "stale runner result" }
  }, env);
  assert.equal(staleResult.status, 409, "expired runner must not commit a result");

  const retryResult = await request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: { claimToken: replacement.claimToken, status: "blocked", retryable: true, result: "transient runner interruption" }
  }, env);
  assert.equal(retryResult.status, 200);
  assert.equal(state.row.status, "retry_wait", "recoverable failures must enter bounded retry wait");
  assert.equal(state.row.agent_claim_token_hash, "", "retry scheduling must revoke the previous claim");
  assert.equal(state.row.agent_claimed_at, null);
  const scheduledRetryAt = Date.parse(state.row.next_attempt_at);
  assert.ok(Number.isFinite(scheduledRetryAt), "retry must persist a valid next-attempt timestamp");
  assert.ok(scheduledRetryAt > Date.now(), "retry must not be claimable before its backoff expires");
  const expectedRetryDelaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, Number(state.row.attempts || 1) - 1)));
  assert.ok(scheduledRetryAt <= Date.now() + (expectedRetryDelaySeconds + 2) * 1000,
    "retry must respect the exponential backoff derived from the consumed attempt count");
  assert.ok(scheduledRetryAt >= Date.now() + (expectedRetryDelaySeconds - 2) * 1000,
    "retry must not shorten the configured exponential backoff");

  // Simulate the bounded backoff window elapsing before the next runner claims.
  state.row.next_attempt_at = "2000-01-01T00:00:00.000Z";
  const retryClaimResponse = await request("/agent/v1/tasks/next", {
    method: "GET", headers: auth
  }, env);
  assert.equal(retryClaimResponse.status, 200);
  const retryClaim = (await retryClaimResponse.json()).task;
  assert.ok(retryClaim);
  assert.notEqual(retryClaim.claimToken, replacement.claimToken);
  assert.equal(state.row.attempts, 3, "the final permitted attempt must consume the configured attempt budget");
  assert.equal(state.row.max_attempts, 3);
  assert.match(state.row.agent_claim_token_hash, /^[A-Za-z0-9_-]{43}$/);

  const supersededCheckpoint = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: { claimToken: replacement.claimToken, checkpoint: { staleAfterRetry: true } }
  }, env);
  assert.equal(supersededCheckpoint.status, 409, "pre-retry runner must not checkpoint after a fresh claim");

  const terminalResult = await request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: { claimToken: retryClaim.claimToken, status: "blocked", retryable: true, result: "controlled lifecycle test complete" }
  }, env);
  assert.equal(terminalResult.status, 200);
  assert.equal(state.row.status, "blocked", "retryable=true must not schedule an attempt beyond max_attempts");
  assert.equal(state.row.next_attempt_at, null, "exhausted tasks must not retain a future retry time");
  assert.equal(state.row.attempts, state.row.max_attempts, "attempt count must never exceed its configured cap");
  assert.equal(state.row.agent_claim_token_hash, "", "terminal result must revoke the claim token");

  const replay = await request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: { claimToken: retryClaim.claimToken, status: "blocked", result: "replayed result" }
  }, env);
  assert.equal(replay.status, 409, "terminal claim token must not be replayable");
});


test("real Worker checkpoint route rejects a commit when expiry recovery wins the update race", async () => {
  const token = "test-agent-token-".padEnd(48, "x");
  const { db, state } = makeClaimLifecycleDb({ expireDuringCheckpointCommit: true });
  const env = { DB: db, MEHRAN_AGENT_TOKEN: token };
  const auth = { Authorization: "Bearer " + token };

  const claimResponse = await request("/agent/v1/tasks/next", {
    method: "GET", headers: auth
  }, env);
  assert.equal(claimResponse.status, 200);
  const claim = (await claimResponse.json()).task;
  assert.ok(claim);
  const originalCheckpoint = JSON.parse(state.row.checkpoint_json);

  const checkpointResponse = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: { claimToken: claim.claimToken, checkpoint: { mustNotCommit: true } }
  }, env);

  assert.equal(checkpointResponse.status, 409,
    "checkpoint UPDATE must fail when ownership expires after the initial SELECT");
  assert.deepEqual(JSON.parse(state.row.checkpoint_json), originalCheckpoint,
    "a losing stale checkpoint must not overwrite the durable checkpoint");
  assert.equal(state.row.status, "accepted");
  assert.equal(state.row.agent_claimed_at, null);
  assert.equal(state.row.agent_claim_token_hash, "");
});


test("real Worker result route rejects a terminal commit when expiry recovery wins the update race", async () => {
  const token = "test-agent-token-".padEnd(48, "x");
  const { db, state } = makeClaimLifecycleDb({ expireDuringResultCommit: true });
  const env = { DB: db, MEHRAN_AGENT_TOKEN: token };
  const auth = { Authorization: "Bearer " + token };

  const claimResponse = await request("/agent/v1/tasks/next", {
    method: "GET", headers: auth
  }, env);
  assert.equal(claimResponse.status, 200);
  const claim = (await claimResponse.json()).task;
  assert.ok(claim);
  const oldResult = state.row.result_text || "";

  const resultResponse = await request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: { claimToken: claim.claimToken, status: "blocked", retryable: false, result: "must not commit after claim expiry" }
  }, env);

  assert.equal(resultResponse.status, 409,
    "terminal result UPDATE must fail when claim expiry wins after the initial ownership SELECT");
  assert.equal(state.row.status, "accepted");
  assert.equal(state.row.result_text || "", oldResult,
    "a losing stale result must not overwrite the durable task result");
  assert.equal(state.row.agent_claimed_at, null);
  assert.equal(state.row.agent_claim_token_hash, "");
});


test("real Worker result route accepts only one concurrent terminal commit for a claim", async () => {
  const token = "test-agent-token-".padEnd(48, "x");
  const { db, state } = makeClaimLifecycleDb();
  const env = { DB: db, MEHRAN_AGENT_TOKEN: token };
  const auth = { Authorization: "Bearer " + token };

  const claimResponse = await request("/agent/v1/tasks/next", {
    method: "GET", headers: auth
  }, env);
  assert.equal(claimResponse.status, 200);
  const claim = (await claimResponse.json()).task;
  assert.ok(claim);

  const submit = result => request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: { claimToken: claim.claimToken, status: "blocked", retryable: false, result }
  }, env);
  const responses = await Promise.all([
    submit("first terminal result"),
    submit("competing terminal result")
  ]);

  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409],
    "only one concurrent terminal result may consume the active claim");
  assert.ok(
    ["first terminal result", "competing terminal result"].includes(state.row.result_text),
    "the accepted result must be one of the two submitted values"
  );
  assert.equal(state.row.agent_claimed_at, null);
  assert.equal(state.row.agent_claim_token_hash, "",
    "the winning terminal result must revoke the shared claim token");
});


test("real Worker task recovery preserves durable checkpoints and fences the crashed runner", async () => {
  const token = "test-agent-token-".padEnd(48, "x");
  const { db, state } = makeClaimLifecycleDb();
  const env = { DB: db, MEHRAN_AGENT_TOKEN: token };
  const auth = { Authorization: "Bearer " + token };

  const firstClaimResponse = await request("/agent/v1/tasks/next", {
    method: "GET", headers: auth
  }, env);
  assert.equal(firstClaimResponse.status, 200);
  const firstClaim = (await firstClaimResponse.json()).task;
  assert.ok(firstClaim);
  const firstToken = firstClaim.claimToken;

  const durableCheckpoint = {
    baseSha: "b".repeat(40),
    phase: "proposal_generation_pending",
    durableMarker: "preserve-on-reclaim"
  };
  const checkpointResponse = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: { claimToken: firstToken, checkpoint: durableCheckpoint }
  }, env);
  assert.equal(checkpointResponse.status, 200);
  assert.deepEqual(JSON.parse(state.row.checkpoint_json), durableCheckpoint);

  // Simulate a runner crash and expiry. Recovery must revoke ownership but
  // leave the last durable checkpoint untouched for the replacement runner.
  state.expired = true;
  const replacementResponse = await request("/agent/v1/tasks/next", {
    method: "GET", headers: auth
  }, env);
  assert.equal(replacementResponse.status, 200);
  const replacement = (await replacementResponse.json()).task;
  assert.ok(replacement);
  assert.notEqual(replacement.claimToken, firstToken);
  assert.equal(replacement.checkpoint, JSON.stringify(durableCheckpoint));
  assert.deepEqual(JSON.parse(state.row.checkpoint_json), durableCheckpoint);
  assert.equal(state.row.status, "in_progress");
  assert.match(state.row.agent_claim_token_hash, /^[A-Za-z0-9_-]{43}$/);

  const staleCheckpoint = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: { claimToken: firstToken, checkpoint: { corruptedByOldRunner: true } }
  }, env);
  assert.equal(staleCheckpoint.status, 409);
  assert.deepEqual(JSON.parse(state.row.checkpoint_json), durableCheckpoint);

  const staleResult = await request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: { claimToken: firstToken, status: "blocked", result: "stale runner must not finish task" }
  }, env);
  assert.equal(staleResult.status, 409);
  assert.equal(state.row.status, "in_progress");

  const resumedCheckpoint = {
    ...durableCheckpoint,
    phase: "proposal_generation_resumed"
  };
  const resumed = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: { claimToken: replacement.claimToken, checkpoint: resumedCheckpoint }
  }, env);
  assert.equal(resumed.status, 200);
  assert.deepEqual(JSON.parse(state.row.checkpoint_json), resumedCheckpoint);

  const replacementResult = await request("/agent/v1/tasks/" + state.row.id + "/result", {
    method: "POST", headers: auth,
    body: {
      claimToken: replacement.claimToken,
      status: "blocked",
      retryable: false,
      result: "replacement runner completed its bounded recovery check"
    }
  }, env);
  assert.equal(replacementResult.status, 200);
  assert.equal(state.row.status, "blocked");
  assert.equal(state.row.agent_claimed_at, null);
  assert.equal(state.row.agent_claim_token_hash, "", "replacement terminal result must revoke its claim");
  assert.deepEqual(JSON.parse(state.row.checkpoint_json), resumedCheckpoint,
    "terminal result must not discard the latest durable checkpoint");

  const lateCheckpoint = await request("/agent/v1/tasks/" + state.row.id + "/checkpoint", {
    method: "POST", headers: auth,
    body: {
      claimToken: replacement.claimToken,
      checkpoint: { corruptedAfterTerminalCommit: true }
    }
  }, env);
  assert.equal(lateCheckpoint.status, 409,
    "a checkpoint arriving after terminal result commit must be rejected");
  assert.deepEqual(JSON.parse(state.row.checkpoint_json), resumedCheckpoint,
    "a late checkpoint must not mutate terminal task state");
});


test("private package report failures expose only bounded stage codes", () => {
  assert.match(workerSource, /report_package_lookup_failed/);
  assert.match(workerSource, /report_tasks_lookup_failed/);
  assert.match(workerSource, /reportStage\("hash"/);
  assert.match(workerSource, /reportStage\("github_lookup"/);
  assert.match(workerSource, /reportStage\("github_verify"/);
  assert.match(workerSource, /reportStage\("github_write"/);
  assert.match(workerSource, /reportStage\("marker_write"/);
  assert.match(workerSource, /report_github_lookup_http_/);
  assert.match(workerSource, /report_github_write_http_/);
  assert.match(workerSource, /\^report_\[a-z0-9_\]\{1,64\}\$/);
  assert.match(workerSource, /INTELLIGENCE_PRIVATE_REPORT_STORE_FAILURE/);
  assert.doesNotMatch(workerSource, /console\.error\("INTELLIGENCE_PRIVATE_REPORT_STORE_FAILURE",\s*storeError\)/);
});


test("Intelligence OpenRouter default uses dynamic free-only routing and rejects paid model overrides", () => {
  assert.match(workerSource, /cleanText\(env\.MEHRAN_OPENROUTER_MODEL, 160\) \|\| "openrouter\/free"/);
  assert.match(workerSource, /model !== "openrouter\/free" && !model\.endsWith\(":free"\)/);
  assert.match(workerSource, /non_free_model_blocked/);
  assert.match(workerSource, /MEHRAN_AI_FREE_PROVIDERS/);
});


test("deterministic routine planner returns only fixed read-only actions for explicit intents", async () => {
  const { buildDeterministicRoutinePlan } = await import("./intelligence-routine-planner.mjs");
  const health = buildDeterministicRoutinePlan("بررسی سلامت سرویس و D1");
  assert.deepEqual(health.tasks.map(task => task.actionType), ["service_health_report"]);
  const security = buildDeterministicRoutinePlan("لطفاً ممیزی امنیتی سورس را انجام بده");
  assert.deepEqual(security.tasks.map(task => task.actionType), ["source_security_audit"]);
  const combined = buildDeterministicRoutinePlan("worker health, repository status, and security audit");
  assert.deepEqual(combined.tasks.map(task => task.actionType), [
    "service_health_report", "repository_quality_check", "source_security_audit"
  ]);
  assert.equal(buildDeterministicRoutinePlan("Please improve the whole project and make it smarter"), null);
  assert.equal(buildDeterministicRoutinePlan("check the project"), null);
  for (const task of combined.tasks) {
    assert.deepEqual(task.dependsOn, []);
    assert.equal(task.requiresApproval, undefined);
    assert.ok(["service_health_report", "repository_quality_check", "source_security_audit"].includes(task.actionType));
  }
});


test("deterministic routine planner refuses to downgrade change requests into read-only checks", async () => {
  const { buildDeterministicRoutinePlan } = await import("./intelligence-routine-planner.mjs");
  const missions = [
    "Check repository status and fix the failing workflow",
    "Run a security check and improve the security controls",
    "بررسی سلامت سرویس و اصلاح مشکل دیتابیس",
    "ممیزی امنیتی سورس را انجام بده و آسیب‌پذیری‌ها را برطرف کن",
    "Update the repository health dashboard",
    "پیاده‌سازی بررسی سلامت خودکار",
    "Run a security audit and remediate the vulnerabilities",
    "Check repository health and resolve the issue",
    "ممیزی امنیتی را انجام بده و سیستم را ایمن‌سازی کن",
    "بررسی سلامت سرویس و مشکل را حل کن",
    "به‌روزرسانی داشبورد سلامت مخزن"
  ];
  for (const mission of missions) {
    assert.equal(buildDeterministicRoutinePlan(mission), null, `change intent must not be downgraded: ${mission}`);
  }
});
