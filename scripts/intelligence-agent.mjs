import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readBoundedResponse } from "./intelligence-bounded-response.mjs";

const run = promisify(execFile);
const WORKER = "https://mehran-msh-auth.mehran79mehran.workers.dev";
const APP = "https://mehranmsh.github.io";
const token = process.env.MEHRAN_AGENT_TOKEN;
const REPOSITORY = "Mehranmsh/mehranmsh.github.io";
const INSPECTION_PATHS = Object.freeze([
  "worker.js",
  "scripts/intelligence-agent.mjs",
  "scripts/intelligence-capabilities.mjs",
  "scripts/intelligence-capabilities.test.mjs",
  ".github/workflows/mehran-intelligence-runner.yml",
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
]);

function bounded(value, max = 2500) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, WORKER), {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const text = await readBoundedResponse(response, 65536);
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Worker returned non-JSON response (${response.status}).`); }
  if (!response.ok) throw new Error(bounded(data.error || `Worker request failed: ${response.status}`));
  return data;
}

function readTaskPayload(task) {
  const value = task?.action_payload ?? task?.actionPayload ?? task?.payload;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.length <= 12000) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

async function runQualityChecks() {
  const steps = [
    ["Python and HTML/JavaScript quality checks", "python", ["scripts/quality-check.py"]],
    ["Worker API smoke tests", "node", ["--test", "scripts/worker-smoke.test.mjs"]],
    ["Music Studio control-plane tests", "python", ["-m", "unittest", "discover", "-s", "engine", "-p", "test_*.py", "-v"]]
  ];
  const output = [];
  for (const [label, executable, args] of steps) {
    try {
      const result = await run(executable, args, { timeout: 120000, maxBuffer: 1024 * 1024 });
      output.push(`PASS: ${label}\n${bounded(result.stdout, 450)}`);
      if (result.stderr) output.push(bounded(result.stderr, 250));
    } catch (error) {
      output.push(`FAIL: ${label}\n${bounded(error.stdout, 500)}\n${bounded(error.stderr, 700)}`);
      return { status: "blocked", result: output.join("\n\n") };
    }
  }
  return { status: "completed", result: output.join("\n\n") };
}

async function runRepositoryTests(payload) {
  const requestedSha = typeof payload.baseSha === "string" ? payload.baseSha.toLowerCase() : "";
  const targetPath = typeof payload.targetPath === "string" ? payload.targetPath : "";
  const checkedOutSha = String(process.env.GITHUB_SHA || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(requestedSha) || !/^[a-f0-9]{40}$/.test(checkedOutSha) ||
      requestedSha !== checkedOutSha) {
    return { status: "blocked", result: "Repository tests require an exact baseSha matching this immutable runner checkout. No tests were started." };
  }
  return runQualityChecks();
}

async function generatePatchProposal(taskId, payload) {
  const objective = typeof payload.objective === "string" ? payload.objective.trim() : "";
  const requestedSha = typeof payload.baseSha === "string" ? payload.baseSha.toLowerCase() : "";
  const checkedOutSha = String(process.env.GITHUB_SHA || "").toLowerCase();
  if (objective.length < 12 || objective.length > 800 || !/^(?:worker\\.js|index\\.html|social\\.html|nexus\\.html|ai\\.html|services\\.html|music-studio\\.html|(?:scripts|src|social|nexus|ai|music-studio|studio|assets\\/(?:js|css))\\/[A-Za-z0-9_./-]+\\.(?:mjs|js|jsx|ts|tsx|html|css|json))$/.test(targetPath) || targetPath.split("/").some(part => part === ".." || part === "." || part === "") || /(?:^|\\/)(?:\\.env|secrets?|credentials?|wallet|private|node_modules)(?:\\.|\\/|$)/i.test(targetPath) ||
      !/^[a-f0-9]{40}$/.test(requestedSha) ||
      !/^[a-f0-9]{40}$/.test(checkedOutSha) || requestedSha !== checkedOutSha) {
    return { status: "blocked", result: "Patch generation requires a bounded objective and an exact immutable baseSha matching this runner checkout. No AI request was made." };
  }
  const requestId = "intelligence-" + taskId;
  const proposal = await request("/agent/v1/patch-proposals/generate", {
    method: "POST",
    body: JSON.stringify({ baseSha: requestedSha, objective, targetPath, requestId })
  });
  const safe = {
    requestId: bounded(proposal.requestId, 160),
    proposalId: bounded(proposal.proposalId, 80),
    status: bounded(proposal.status, 40),
    targetPath: bounded(proposal.targetPath, 160),
    validationMode: bounded(proposal.validationMode, 80)
  };
  if (proposal.success !== true || proposal.status !== "stored" ||
      !safe.proposalId || safe.targetPath !== "scripts/intelligence-capabilities.test.mjs") {
    return { status: "blocked", result: "Patch generation did not produce a verified stored proposal: " + JSON.stringify(safe) };
  }
  return { status: "completed", result: "Verified append-only regression-test proposal stored. No source code was applied and no branch or pull request was created by this action. " + JSON.stringify(safe) };
}
function inspectRepository(payload) {
  const paths = payload.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > INSPECTION_PATHS.length ||
      new Set(paths).size !== paths.length ||
      paths.some(path => typeof path !== "string" || !INSPECTION_PATHS.includes(path))) {
    return { status: "blocked", result: "Repository inspection paths must be a unique subset of the fixed allowlist. No file was read." };
  }
  const files = [];
  for (const path of paths) {
    try {
      const source = readFileSync(path, "utf8");
      files.push({
        path,
        bytes: Buffer.byteLength(source, "utf8"),
        lines: source.split("\n").length - (source.endsWith("\n") ? 1 : 0),
        sha256: createHash("sha256").update(source, "utf8").digest("hex")
      });
    } catch {
      return { status: "blocked", result: "A requested allowlisted source file could not be read. No additional paths were inspected." };
    }
  }
  return {
    status: "completed",
    result: JSON.stringify({
      repository: REPOSITORY,
      commitSha: String(process.env.GITHUB_SHA || "").toLowerCase(),
      summary: { filesInspected: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) },
      files
    })
  };
}

async function runServiceHealth() {
  const response = await fetch(new URL("/health", WORKER), { signal: AbortSignal.timeout(15000) });
  const healthText = await readBoundedResponse(response, 8192);
  const health = JSON.parse(healthText);
  const pageResponse = await fetch(APP, { signal: AbortSignal.timeout(15000), redirect: "follow" });
  const details = [
    `Worker HTTP: ${response.status}`,
    `Worker status: ${health.status || "unknown"}`,
    `Database: ${health.database === true ? "connected" : "not confirmed"}`,
    `App HTTP: ${pageResponse.status}`
  ];
  const ok = response.ok && health.status === "online" && health.database === true && pageResponse.ok;
  return { status: ok ? "completed" : "blocked", result: details.join("\n") };
}

async function main() {
  if (!token || token.length < 40) throw new Error("MEHRAN_AGENT_TOKEN is missing or too short.");
  const claimed = await request("/agent/v1/tasks/next");
  const task = claimed.task;
  if (!task) {
    console.log("No approved Intelligence task is waiting.");
    return;
  }

  const taskId = typeof task.id === "string" ? task.id : "";
  const claimToken = typeof task.claimToken === "string" ? task.claimToken : "";
  const allowedActions = new Set([
    "repository_quality_check", "service_health_report", "source_security_audit",
    "inspect_repository", "run_repository_tests", "propose_code_patch"
  ]);
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(taskId) || !/^[A-Za-z0-9_-]{43}$/.test(claimToken) ||
      typeof task.actionType !== "string" || !allowedActions.has(task.actionType)) {
    throw new Error("Claimed task envelope is invalid; no task action was executed.");
  }

  console.log(`Claimed task ${bounded(taskId, 80)}: ${bounded(task.title, 160)}`);
  const payload = readTaskPayload(task);
  let outcome;
  try {
    if (task.actionType === "repository_quality_check") {
      outcome = await runQualityChecks();
    } else if (task.actionType === "service_health_report") {
      outcome = await runServiceHealth();
    } else if (task.actionType === "inspect_repository") {
      outcome = inspectRepository(payload);
    } else if (task.actionType === "run_repository_tests") {
      outcome = await runRepositoryTests(payload);
    } else if (task.actionType === "propose_code_patch") {
      outcome = await generatePatchProposal(taskId, payload);
    } else {
      outcome = {
        status: "blocked",
        result: `This runner does not yet support action type "${bounded(task.actionType || "(empty)", 100)}". No external change was made.`
      };
    }
  } catch (error) {
    outcome = { status: "blocked", result: bounded(error.message || error) };
  }

  await request(`/agent/v1/tasks/${encodeURIComponent(taskId)}/result`, {
    method: "POST",
    body: JSON.stringify({ claimToken, status: outcome.status, result: bounded(outcome.result, 2900) })
  });
  console.log(`Task ${bounded(taskId, 80)} finished with status: ${outcome.status}`);
}

main().catch(error => {
  console.error(bounded(error.message || error, 1000));
  process.exitCode = 1;
});
