import {
  createServiceHealthReport,
  createRepositoryQualityReport,
  createAgentTaskResult
} from "./intelligence-agent-runtime.mjs";

const WORKER = "https://mehran-msh-auth.mehran79mehran.workers.dev";
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
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`Worker returned non-JSON response (${response.status}).`); }
  if (!response.ok) throw new Error(bounded(data.error || `Worker request failed: ${response.status}`));
  return data;
}

async function runRepositoryQuality() {
  const headers = {
    "Accept": "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    "User-Agent": "MEHRAN-MSH-INTELLIGENCE"
  };
  const repoResponse = await fetch("https://api.github.com/repos/Mehranmsh/mehranmsh.github.io", {
    headers, signal: AbortSignal.timeout(12000)
  });
  if (!repoResponse.ok) throw new Error(`GitHub repository metadata HTTP ${repoResponse.status}`);
  const metadata = await repoResponse.json();
  const commitResponse = await fetch("https://api.github.com/repos/Mehranmsh/mehranmsh.github.io/commits?per_page=1", {
    headers, signal: AbortSignal.timeout(12000)
  });
  if (!commitResponse.ok) throw new Error(`GitHub latest commit HTTP ${commitResponse.status}`);
  const commits = await commitResponse.json();
  return createRepositoryQualityReport(metadata, commits);
}

async function runServiceHealth() {
  const response = await fetch(new URL("/health", WORKER), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Worker health HTTP ${response.status}`);
  const health = await response.json();
  return createServiceHealthReport(health);
}

async function main() {
  if (!token || token.length < 40 || token.length > 200) {
    throw new Error("MEHRAN_AGENT_TOKEN is missing or invalid.");
  }
  const claimed = await request("/agent/v1/tasks/next");
  const task = claimed.task;
  if (!task) {
    console.log("No approved Intelligence task is waiting.");
    return;
  }
  if (typeof task.claimToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(task.claimToken)) {
    throw new Error("Claimed task did not include a valid lease token; refusing execution.");
  }

  console.log(`Claimed task ${bounded(task.id, 80)}: ${bounded(task.title, 160)}`);
  let outcome;
  try {
    if (task.actionType === "repository_quality_check") {
      outcome = { status: "completed", result: JSON.stringify(await runRepositoryQuality()) };
    } else if (task.actionType === "service_health_report") {
      outcome = { status: "completed", result: JSON.stringify(await runServiceHealth()) };
    } else {
      outcome = {
        status: "blocked",
        result: `This runner does not support action type "${bounded(task.actionType || "(empty)", 100)}". No external change was made.`
      };
    }
  } catch (error) {
    outcome = { status: "blocked", result: bounded(error.message || error) };
  }

  const resultBody = createAgentTaskResult(task, {
    ...outcome,
    result: bounded(outcome.result, 2900)
  });
  await request(`/agent/v1/tasks/${encodeURIComponent(task.id)}/result`, {
    method: "POST",
    body: JSON.stringify(resultBody)
  });
  console.log(`Task ${task.id} finished with status: ${outcome.status}`);
}

main().catch(error => {
  console.error(bounded(error.message || error, 1000));
  process.exitCode = 1;
});
