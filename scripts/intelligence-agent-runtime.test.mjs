import test from "node:test";
import assert from "node:assert/strict";
import {
  createServiceHealthReport,
  createRepositoryQualityReport,
  createAgentTaskResult
} from "./intelligence-agent-runtime.mjs";

test("service health report matches the Worker's independently verified schema", () => {
  const report = createServiceHealthReport({ status: "online", database: true, scheduler: { enabled: true } }, "2026-11-25T10:00:00.000Z");
  assert.equal(report.type, "service_health_report");
  assert.equal(report.worker, "online");
  assert.equal(report.database, true);
  assert.equal(report.scheduler.enabled, true);
  assert.throws(() => createServiceHealthReport({ status: "online", database: false }));
});

test("repository quality report matches the Worker's repository metadata schema", () => {
  const report = createRepositoryQualityReport({
    full_name: "Mehranmsh/mehranmsh.github.io",
    default_branch: "main",
    open_issues_count: 2,
    pushed_at: "2026-11-25T09:00:00Z"
  }, [{
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    commit: { committer: { date: "2026-11-25T08:00:00Z" } }
  }], "2026-11-25T10:00:00.000Z");
  assert.equal(report.type, "repository_quality_check");
  assert.equal(report.latestCommit, "abcdef123456");
  assert.throws(() => createRepositoryQualityReport({ full_name: "attacker/repo" }, []));
});

test("task result always carries the active claim token", () => {
  const task = { id: "task-1", claimToken: "A".repeat(43) };
  const body = createAgentTaskResult(task, { status: "blocked", result: "Unsupported action." });
  assert.equal(body.claimToken, task.claimToken);
  assert.equal(body.status, "blocked");
  assert.throws(() => createAgentTaskResult({ ...task, claimToken: "" }, { status: "completed", result: "{}" }));
});
