const isoDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export function createServiceHealthReport(health, generatedAt = new Date().toISOString()) {
  if (!health || health.status !== "online" || health.database !== true || !isoDate(generatedAt)) {
    throw new Error("service_health_not_verified");
  }
  return {
    type: "service_health_report",
    generatedAt,
    worker: "online",
    database: true,
    scheduler: health.scheduler || null,
    scope: "Read-only Worker health endpoint."
  };
}

export function createRepositoryQualityReport(metadata, commits, generatedAt = new Date().toISOString()) {
  const latest = Array.isArray(commits) ? commits[0] : null;
  const latestCommit = String(latest?.sha || "").slice(0, 12).toLowerCase();
  const lastPushedAt = metadata?.pushed_at || "";
  const latestCommitAt = latest?.commit?.committer?.date || latest?.commit?.author?.date || "";
  if (metadata?.full_name !== "Mehranmsh/mehranmsh.github.io" ||
      typeof metadata?.default_branch !== "string" || !metadata.default_branch ||
      !Number.isInteger(metadata?.open_issues_count) || metadata.open_issues_count < 0 ||
      !isoDate(lastPushedAt) || !/^[a-f0-9]{12}$/.test(latestCommit) ||
      !isoDate(latestCommitAt) || !isoDate(generatedAt)) {
    throw new Error("repository_metadata_not_verified");
  }
  return {
    type: "repository_quality_check",
    generatedAt,
    repository: metadata.full_name,
    defaultBranch: metadata.default_branch,
    openIssues: metadata.open_issues_count,
    lastPushedAt,
    latestCommit,
    latestCommitAt,
    scope: "Public GitHub metadata only. No source execution or repository writes."
  };
}

export function createAgentTaskResult(task, outcome) {
  if (!task || typeof task.id !== "string" || typeof task.claimToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(task.claimToken) ||
      !outcome || !["completed", "blocked"].includes(outcome.status) ||
      typeof outcome.result !== "string" || !outcome.result.trim() || outcome.result.length > 3000) {
    throw new Error("invalid_claimed_task_result");
  }
  return {
    status: outcome.status,
    result: outcome.result,
    retryable: outcome.retryable === true,
    claimToken: task.claimToken
  };
}
