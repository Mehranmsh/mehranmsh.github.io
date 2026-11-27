import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readBoundedResponse } from "./intelligence-bounded-response.mjs";

const run = promisify(execFile);
const WORKER = "https://mehran-msh-auth.mehran79mehran.workers.dev";
const APP = "https://mehranmsh.github.io";
const token = process.env.MEHRAN_AGENT_TOKEN;

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

async function runRepositoryTests() {
  const steps = [
    ["Worker syntax", "node", ["--check", "worker.js"]],
    ["Capability syntax", "node", ["--check", "scripts/intelligence-capabilities.mjs"]],
    ["Checkpoint syntax", "node", ["--check", "scripts/intelligence-checkpoint.mjs"]],
    ["Static security scanner syntax", "node", ["--check", "scripts/intelligence-static-security-audit.mjs"]],
    ["Step checkpoint syntax", "node", ["--check", "scripts/intelligence-step-checkpoint.mjs"]],
    ["Fixed Intelligence policy suite", "node", ["--test", "scripts/intelligence-capabilities.test.mjs", "scripts/intelligence-repository-inventory.test.mjs", "scripts/intelligence-checkpoint.test.mjs", "scripts/intelligence-step-checkpoint.test.mjs", "scripts/intelligence-inbox-schema.test.mjs", "scripts/intelligence-report-finalization.test.mjs", "scripts/intelligence-static-security-audit.test.mjs"]]
  ];
  const output = [];
  for (const [label, executable, args] of steps) {
    try {
      const result = await run(executable, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
      output.push("PASS: " + label + "\n" + bounded(result.stdout, 900));
      if (result.stderr) output.push(bounded(result.stderr, 300));
    } catch (error) {
      output.push("FAIL: " + label + "\n" + bounded(error.stdout, 700) + "\n" + bounded(error.stderr, 900));
      return { status: "blocked", result: output.join("\n\n") };
    }
  }
  return { status: "completed", result: output.join("\n\n") };
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

async function runRepositoryInspection(task) {
  const token = process.env.GITHUB_TOKEN || "";
  if (token.length < 20) throw new Error("GitHub read token is unavailable.");
  let payload = {};
  try { payload = typeof task.actionPayload === "string" ? JSON.parse(task.actionPayload) : (task.actionPayload || {}); }
  catch { throw new Error("Inspection task payload is not valid JSON."); }
  const allowed = new Set(["worker.js","scripts/intelligence-agent.mjs","scripts/intelligence-capabilities.mjs","scripts/intelligence-capabilities.test.mjs",".github/workflows/mehran-intelligence-runner.yml","docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"]);
  const paths = payload.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 6 || new Set(paths).size !== paths.length || paths.some(p => typeof p !== "string" || !allowed.has(p))) throw new Error("Inspection paths are outside the exact read-only allowlist.");
  const headers = { Accept:"application/vnd.github+json", Authorization:"Bearer " + token, "User-Agent":"MEHRAN-MSH-INTELLIGENCE" };
  const repo = "Mehranmsh/mehranmsh.github.io";
  const cr = await fetch("https://api.github.com/repos/" + repo + "/commits/main", {headers,signal:AbortSignal.timeout(15000)});
  if (!cr.ok) throw new Error("GitHub main commit lookup HTTP " + cr.status);
  const commit = await cr.json();
  if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw new Error("GitHub returned an invalid main commit SHA.");
  const files = []; let total = 0;
  for (const path of paths) {
    const apiPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch("https://api.github.com/repos/" + repo + "/contents/" + apiPath + "?ref=" + commit.sha, {headers,signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("GitHub source read failed for " + path + ": HTTP " + response.status);
    const file = await response.json();
    if (file.type !== "file" || file.path !== path || file.encoding !== "base64" || typeof file.content !== "string" || typeof file.sha !== "string" || !/^[a-f0-9]{40}$/i.test(file.sha) || !Number.isInteger(file.size) || file.size < 0 || file.size > 600000) throw new Error("Invalid or oversized source file: " + path);
    const content = Buffer.from(file.content.replace(/\n/g,""),"base64").toString("utf8");
    const bytes = Buffer.byteLength(content,"utf8");
    if (bytes !== file.size) throw new Error("Source size verification failed for " + path);
    total += bytes; if (total > 750000) throw new Error("Inspection exceeded the 750 KB aggregate source limit.");
    files.push({path,blobSha:file.sha,content});
  }
  const {buildRepositoryInventory} = await import("./intelligence-repository-inventory.mjs");
  const report = buildRepositoryInventory(files,commit.sha);
  return {status:"completed",result:JSON.stringify({...report,generatedAt:new Date().toISOString()})};
}


async function runSourceSecurityAudit() {
  const githubToken = process.env.GITHUB_TOKEN || "";
  if (githubToken.length < 20) throw new Error("GitHub read token is unavailable.");
  const paths = [
    "worker.js",
    "scripts/intelligence-agent.mjs",
    "scripts/intelligence-capabilities.mjs",
    ".github/workflows/mehran-intelligence-runner.yml"
  ];
  const headers = {
    Accept:"application/vnd.github+json",
    Authorization:"Bearer " + githubToken,
    "User-Agent":"MEHRAN-MSH-INTELLIGENCE"
  };
  const repo = "Mehranmsh/mehranmsh.github.io";
  const commitResponse = await fetch("https://api.github.com/repos/" + repo + "/commits/main", {
    headers, signal:AbortSignal.timeout(15000)
  });
  if (!commitResponse.ok) throw new Error("GitHub main commit lookup HTTP " + commitResponse.status);
  const commit = await commitResponse.json();
  if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/i.test(commit.sha)) {
    throw new Error("GitHub returned an invalid immutable commit SHA.");
  }
  const files = [];
  let total = 0;
  for (const path of paths) {
    const apiPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch("https://api.github.com/repos/" + repo + "/contents/" + apiPath + "?ref=" + commit.sha, {
      headers, signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error("Security audit source read failed for " + path + ": HTTP " + response.status);
    const file = await response.json();
    if (file.type !== "file" || file.path !== path || file.encoding !== "base64" ||
        typeof file.content !== "string" || typeof file.sha !== "string" ||
        !/^[a-f0-9]{40}$/i.test(file.sha) || !Number.isInteger(file.size) ||
        file.size < 0 || file.size > 600000) {
      throw new Error("Invalid or oversized security audit source: " + path);
    }
    const content = Buffer.from(file.content.replace(/\n/g,""),"base64").toString("utf8");
    const bytes = Buffer.byteLength(content,"utf8");
    if (bytes !== file.size) throw new Error("Security audit source size verification failed for " + path);
    total += bytes;
    if (total > 750000) throw new Error("Security audit exceeded the 750 KB aggregate source limit.");
    files.push({path,blobSha:file.sha,content});
  }
  const {buildStaticSecurityAudit} = await import("./intelligence-static-security-audit.mjs");
  const report = buildStaticSecurityAudit(files,commit.sha);
  return {status:"completed",result:JSON.stringify({...report,generatedAt:new Date().toISOString()})};
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
  let outcome;
  try {
    if (task.actionType === "repository_quality_check") {
      outcome = await runQualityChecks();
    } else if (task.actionType === "run_repository_tests") {
      outcome = await runRepositoryTests();
    } else if (task.actionType === "service_health_report") {
      outcome = await runServiceHealth();
    } else if (task.actionType === "inspect_repository") {
      outcome = await runRepositoryInspection(task);
    } else if (task.actionType === "source_security_audit") {
      outcome = await runSourceSecurityAudit();
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
