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
  let outcome;
  try {
    if (task.actionType === "repository_quality_check") {
      outcome = await runQualityChecks();
    } else if (task.actionType === "service_health_report") {
      outcome = await runServiceHealth();
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
