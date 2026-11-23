import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const workflow = readFileSync(".github/workflows/mehran-intelligence-runner.yml", "utf8");
const start = workflow.indexOf("          function serializeBoundedResult(");
const end = workflow.indexOf("\n          for (let count = 0;", start);
assert.ok(start >= 0 && end > start, "runner serializer function must exist");

const source = workflow.slice(start, end)
  .split("\n")
  .map(line => line.startsWith("          ") ? line.slice(10) : line)
  .join("\n");
const sandbox = {};
runInNewContext(source + "\nglobalThis.serializeBoundedResult = serializeBoundedResult;", sandbox);
const serializeBoundedResult = sandbox.serializeBoundedResult;

function auditReport() {
  const checks = Array.from({ length: 15 }, (_, index) => ({
    id: `security_check_${String(index + 1).padStart(2, "0")}`,
    passed: index !== 4,
    detail: `Detailed evidence for security control ${index + 1}. `.repeat(20)
  }));
  return {
    type: "source_security_audit",
    generatedAt: "2026-11-23T00:00:00.000Z",
    mode: "deterministic_read_only_static_audit",
    files: {
      "worker.js": { sha: "a".repeat(40), bytes: 120000 },
      ".github/workflows/mehran-intelligence-runner.yml": { sha: "b".repeat(40), bytes: 20000 },
      "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md": { sha: "c".repeat(40), bytes: 10000 }
    },
    summary: { checks: 15, passed: 14, failed: 1, status: "attention_required" },
    checks,
    limitations: Array.from({ length: 5 }, () => "Long limitation text. ".repeat(30))
  };
}

test("oversized security audit remains within limit and preserves verifier schema", () => {
  const serialized = serializeBoundedResult(auditReport(), 3000);
  assert.ok(serialized.length <= 3000);
  const report = JSON.parse(serialized);
  assert.equal(report.type, "source_security_audit");
  assert.equal(report.mode, "deterministic_read_only_static_audit");
  assert.equal(report.summary.checks, 15);
  assert.equal(report.summary.passed, 14);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.checks.length, 15);
  assert.ok(report.files["worker.js"]);
  assert.ok(report.files[".github/workflows/mehran-intelligence-runner.yml"]);
  for (const check of report.checks) {
    assert.equal(typeof check.id, "string");
    assert.equal(typeof check.passed, "boolean");
    assert.equal(typeof check.detail, "string");
  }
  assert.equal(report.checks[4].passed, false);
  assert.equal(report.detailsTruncated, true);
});

test("small results are preserved without unnecessary compaction", () => {
  const small = { type: "service_health_report", worker: "online", database: true };
  assert.equal(serializeBoundedResult(small), JSON.stringify(small));
});

test("invalid limits and results that cannot fit fail closed", () => {
  assert.throws(() => serializeBoundedResult({}, 100), /Invalid bounded-result/);
  const huge = {
    type: "source_security_audit",
    generatedAt: "2026-11-23T00:00:00.000Z",
    mode: "deterministic_read_only_static_audit",
    files: { "worker.js": { sha: "a".repeat(40), bytes: 1 }, ".github/workflows/mehran-intelligence-runner.yml": { sha: "b".repeat(40), bytes: 1 } },
    summary: { checks: 30, passed: 30, failed: 0, status: "passed" },
    checks: Array.from({ length: 30 }, (_, index) => ({ id: "x".repeat(80) + index, passed: true, detail: "" }))
  };
  assert.throws(() => serializeBoundedResult(huge, 256), /exceeds the Worker API limit/);
});
