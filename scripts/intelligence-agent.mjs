import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { createHash } from "node:crypto";
import { isAllowedPatchPath, isAllowedInspectionPath } from "./intelligence-patch-policy.mjs";
import { filterRepositoryInventoryPaths, getRepositoryModuleKey } from "./intelligence-repository-inventory.mjs";
import { readBoundedResponse } from "./intelligence-bounded-response.mjs";

const run = promisify(execFile);
const WORKER = "https://mehran-msh-auth.mehran79mehran.workers.dev";
const APP = "https://mehranmsh.github.io";
const token = process.env.MEHRAN_AGENT_TOKEN;
const REPOSITORY = "Mehranmsh/mehranmsh.github.io";
const INSPECTION_PATHS = Object.freeze(["@app-inventory"]);

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
    ["Dynamic repository inventory tests", "node", ["--test", "scripts/intelligence-repository-inventory.test.mjs"]],
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
  const checkedOutSha = String(process.env.GITHUB_SHA || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(requestedSha) || !/^[a-f0-9]{40}$/.test(checkedOutSha) ||
      requestedSha !== checkedOutSha) {
    return { status: "blocked", result: "Repository tests require an exact baseSha matching this immutable runner checkout. No tests were started." };
  }
  return runQualityChecks();
}

async function generatePatchProposal(taskId, payload) {
  const objective = typeof payload.objective === "string" ? payload.objective.trim() : "";
  const targetPath = typeof payload.targetPath === "string" ? payload.targetPath : "";
  const requestedSha = typeof payload.baseSha === "string" ? payload.baseSha.toLowerCase() : "";
  const checkedOutSha = String(process.env.GITHUB_SHA || "").toLowerCase();
  if (objective.length < 12 || objective.length > 800 || !isAllowedPatchPath(targetPath) ||
      !/^[a-f0-9]{40}$/.test(requestedSha) ||
      !/^[a-f0-9]{40}$/.test(checkedOutSha) || requestedSha !== checkedOutSha) {
    return { status: "blocked", result: "Patch generation requires a bounded objective and an exact immutable baseSha matching this runner checkout. No AI request was made." };
  }
  const requestId = taskId;
  const proposal = await request("/agent/v1/patch-proposals/generate", {
    method: "POST",
    body: JSON.stringify({ baseSha: requestedSha, objective, targetPath, requestId })
  });
  const safe = {
    type: "propose_code_patch",
    applied: false,
    requestId: bounded(proposal.requestId, 160),
    requestHash: bounded(proposal.requestHash, 64),
    path: bounded(proposal.path, 240),
    artifactSha256: bounded(proposal.artifactSha256, 64),
    diffSha256: bounded(proposal.diffSha256, 64),
    baseSha: bounded(proposal.baseSha, 40),
    summary: bounded(proposal.summary, 500),
    generatedAt: bounded(proposal.generatedAt, 40),
    proposalId: bounded(proposal.proposalId, 80),
    status: bounded(proposal.status, 40),
    targetPath: bounded(proposal.targetPath, 160),
    validationMode: bounded(proposal.validationMode, 80)
  };
  if (proposal.success !== true || proposal.status !== "stored" ||
      !safe.proposalId || safe.targetPath !== targetPath) {
    return { status: "blocked", result: "Patch generation did not produce a verified stored proposal: " + JSON.stringify(safe) };
  }
  return { status: "completed", result: JSON.stringify(safe) };
}
function inspectRepository(payload) {
  const paths = payload.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 6 ||
      new Set(paths).size !== paths.length ||
      paths.some(path => !isAllowedInspectionPath(path))) {
    return { status: "blocked", result: "Repository inspection paths must be unique allowlisted application source files. No file was read." };
  }
  const inventoryMode = paths.length === 1 && INSPECTION_PATHS.includes(paths[0]);
  let inspectionPaths = paths;
  if (inventoryMode) {
    try {
      const tracked = execFileSync("git", ["ls-files", "-z"], {
        encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15000
      }).split("\0").filter(Boolean);
      inspectionPaths = filterRepositoryInventoryPaths(tracked);
    } catch {
      return { status: "blocked", result: "The tracked application source inventory could not be enumerated. No fallback path scan was attempted." };
    }
  }
  if (!inspectionPaths.length || inspectionPaths.length > 5000) {
    return { status: "blocked", result: "The application source inventory is empty or exceeds the 5,000-file safety bound." };
  }
  const files = [];
  let totalBytes = 0;
  const moduleCounts = {};
  const inventoryHasher = createHash("sha256");
  for (const path of inspectionPaths) {
    try {
      const workspaceRoot = realpathSync(".");
      const targetPath = realpathSync(path);
      const targetStat = lstatSync(path);
      if (!targetPath.startsWith(workspaceRoot + sep) || !targetStat.isFile() || targetStat.isSymbolicLink() ||
          targetStat.size > 1024 * 1024 || totalBytes + targetStat.size > 32 * 1024 * 1024) {
        throw new Error("Inspection target exceeded the regular-file or byte bound.");
      }
      const source = readFileSync(targetPath, "utf8");
      const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
      const entry = { path, bytes: Buffer.byteLength(source, "utf8"), sha256 };
      files.push(entry);
      totalBytes += entry.bytes;
      const module = getRepositoryModuleKey(path);
      moduleCounts[module] = (moduleCounts[module] || 0) + 1;
      inventoryHasher.update(path + ":" + sha256 + "\n");
    } catch {
      return { status: "blocked", result: "An inventory source file could not be safely read within the configured bounds. No partial inventory was reported." };
    }
  }
  return {
    status: "completed",
    result: JSON.stringify({
      repository: REPOSITORY,
      commitSha: String(process.env.GITHUB_SHA || "").toLowerCase(),
      inventory: inventoryMode,
      summary: {
        filesInspected: files.length,
        totalBytes,
        moduleCounts,
        inventorySha256: inventoryHasher.digest("hex")
      },
      samplePaths: files.slice(0, 24).map(file => file.path)
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
