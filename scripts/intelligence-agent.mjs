import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

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
    signal: options.signal || AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error("Worker returned non-JSON response (" + response.status + ")."); }
  if (!response.ok) throw new Error(bounded(data.error || "Worker request failed: " + response.status));
  return data;
}

async function monitorTaskStatus(taskId, executionController, monitorSignal, state) {
  let consecutiveFailures = 0;
  while (!monitorSignal.aborted && !executionController.signal.aborted) {
    try {
      const signal = AbortSignal.any([monitorSignal, AbortSignal.timeout(7000)]);
      const response = await request("/agent/v1/tasks/" + encodeURIComponent(taskId) + "/status", { signal });
      consecutiveFailures = 0;
      if (response.task?.status !== "in_progress" || response.task?.agentClaimed !== true) {
        state.reason = "Task cancelled by owner or execution claim was revoked.";
        executionController.abort(new Error(state.reason));
        return;
      }
    } catch (error) {
      if (monitorSignal.aborted || executionController.signal.aborted) return;
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        state.reason = "Task ownership could not be verified; execution stopped fail-closed.";
        executionController.abort(new Error(state.reason));
        return;
      }
    }
    try { await delay(2500, undefined, { signal: monitorSignal }); }
    catch { return; }
  }
}

async function runQualityChecks(signal) {
  const steps = [
    ["Python and HTML/JavaScript quality checks", "python", ["scripts/quality-check.py"]],
    ["Worker API smoke tests", "node", ["--test", "scripts/worker-smoke.test.mjs"]],
    ["Music Studio control-plane tests", "python", ["-m", "unittest", "discover", "-s", "engine", "-p", "test_*.py", "-v"]]
  ];
  const output = [];
  for (const [label, executable, args] of steps) {
    if (signal.aborted) return { status: "blocked", result: "Execution stopped before the next check." };
    try {
      const result = await run(executable, args, { timeout: 120000, maxBuffer: 1024 * 1024, signal });
      output.push("PASS: " + label + "\n" + bounded(result.stdout, 450));
      if (result.stderr) output.push(bounded(result.stderr, 250));
    } catch (error) {
      if (signal.aborted) return { status: "blocked", result: "Execution interrupted because the owner cancelled the task or task ownership could not be verified." };
      output.push("FAIL: " + label + "\n" + bounded(error.stdout, 500) + "\n" + bounded(error.stderr, 700));
      return { status: "blocked", result: output.join("\n\n") };
    }
  }
  return { status: "completed", result: output.join("\n\n") };
}

async function runServiceHealth(signal) {
  const response = await fetch(new URL("/health", WORKER), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const health = await response.json();
  const pageResponse = await fetch(APP, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "follow" });
  const details = [
    "Worker HTTP: " + response.status,
    "Worker status: " + (health.status || "unknown"),
    "Database: " + (health.database === true ? "connected" : "not confirmed"),
    "App HTTP: " + pageResponse.status
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

  console.log("Claimed task " + bounded(task.id, 80) + ": " + bounded(task.title, 160));
  const executionController = new AbortController();
  const monitorController = new AbortController();
  const monitorState = { reason: "" };
  const monitor = monitorTaskStatus(task.id, executionController, monitorController.signal, monitorState);
  let outcome;
  try {
    if (task.actionType === "repository_quality_check") {
      outcome = await runQualityChecks(executionController.signal);
    } else if (task.actionType === "service_health_report") {
      outcome = await runServiceHealth(executionController.signal);
    } else {
      outcome = {
        status: "blocked",
        result: "This runner does not yet support action type " + bounded(task.actionType || "(empty)", 100) + ". No external change was made."
      };
    }
  } catch (error) {
    outcome = { status: "blocked", result: bounded(error.message || error) };
  } finally {
    monitorController.abort();
    await monitor;
  }

  if (executionController.signal.aborted) {
    console.log(monitorState.reason || "Task execution was aborted; no completion result was submitted.");
    return;
  }

  const finalStatus = await request("/agent/v1/tasks/" + encodeURIComponent(task.id) + "/status");
  if (finalStatus.task?.status !== "in_progress" || finalStatus.task?.agentClaimed !== true) {
    console.log("Task ownership changed before result submission; no completion result was submitted.");
    return;
  }

  await request("/agent/v1/tasks/" + encodeURIComponent(task.id) + "/result", {
    method: "POST",
    body: JSON.stringify({ status: outcome.status, result: bounded(outcome.result, 2900) })
  });
  console.log("Task " + task.id + " finished with status: " + outcome.status);
}

main().catch(error => {
  console.error(bounded(error.message || error, 1000));
  process.exitCode = 1;
});
