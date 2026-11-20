import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const ROOT = new URL("../", import.meta.url);
const migrations = [
  "0000_intelligence_staging_baseline",
  "0001_intelligence_approval_ledger",
  "0002_intelligence_knowledge_relations",
  "0003_intelligence_staging_runtime",
  "0004_intelligence_knowledge_provenance",
  "0005_intelligence_owner_memory_governance",
  "0006_intelligence_owner_memory_confidence_integer",
  "0007_intelligence_approval_ledger_state_guards",
  "0008_intelligence_capability_approval_ledger",
  "0009_intelligence_findings_schema",
  "0010_intelligence_finding_review_ledger",
  "0011_intelligence_evidence_correlation_reviews",
  "0012_intelligence_evidence_decision_reviews",
  "0013_intelligence_priority_action_reviews",
  "0014_intelligence_owner_identity_immutability",
  "0015_intelligence_task_execution_disabled",
  "0016_intelligence_capability_approval_allowlist",
  "0017_intelligence_audit_immutability_and_approval_timestamps",
  "0018_intelligence_capability_approval_issued_at_guard",
  "0019_intelligence_approval_consumption_lock_and_legacy_timestamps",
];

const mf = new Miniflare({
  script: "export default { async fetch() { return new Response('ok'); } };",
  modules: true,
  d1Databases: { DB: "intelligence-approval-lock-d1-runtime" },
});

try {
  const db = await mf.getD1Database("DB");
  for (const name of migrations) {
    const source = await readFile(new URL(`migrations/${name}.sql`, ROOT), "utf8");
    const sql = source.split("\n").filter(line => !line.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
    if (sql) await db.exec(sql);
  }

  const clock = await db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER) AS now").first();
  const now = Number(clock.now);
  const issuedAt = now - 120;
  const expiresAt = now + 300;

  for (const taskId of ["task-legacy-main", "task-legacy-expired"]) {
    await db.prepare("INSERT INTO intelligence_tasks(id,title,created_by) VALUES(?,?,?)")
      .bind(taskId, "Approval lock fixture", "owner-a").run();
  }

  const legacyValues = (id, taskId, issued, expiry) => [
    id, taskId, "owner-a", "mehranmsh", "Mehranmsh/mehranmsh.github.io",
    "intelligence/staging-test", "a".repeat(40), "{}", "b".repeat(64), issued, expiry
  ];
  await db.prepare(`
    INSERT INTO intelligence_approval_ledger(
      id,task_id,owner_uid,owner_username,repository,branch,base_sha,
      scope_json,scope_sha256,status,issued_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'issued',?,?)
  `).bind(...legacyValues("legacy-main", "task-legacy-main", issuedAt, expiresAt)).run();

  await assert.rejects(
    db.prepare("UPDATE intelligence_approval_ledger SET status='consumed',consumed_at=?,consumed_by='executor' WHERE id='legacy-main'")
      .bind(now).run(),
    /consumption is disabled/i,
    "legacy task/repository approvals must not be consumed",
  );
  let legacy = await db.prepare("SELECT status,consumed_at,consumed_by FROM intelligence_approval_ledger WHERE id='legacy-main'").first();
  assert.deepEqual([legacy.status, legacy.consumed_at, legacy.consumed_by], ["issued", null, null]);

  await assert.rejects(
    db.prepare("UPDATE intelligence_approval_ledger SET status='revoked',revoked_at=? WHERE id='legacy-main'")
      .bind(issuedAt - 1).run(),
    /terminal timestamp/i,
    "legacy revocation before issuance must be rejected",
  );
  await assert.rejects(
    db.prepare("UPDATE intelligence_approval_ledger SET status='revoked',revoked_at=? WHERE id='legacy-main'")
      .bind(now + 60).run(),
    /terminal timestamp/i,
    "future-dated legacy revocation must be rejected",
  );
  await db.prepare("UPDATE intelligence_approval_ledger SET status='revoked',revoked_at=? WHERE id='legacy-main'")
    .bind(now).run();
  legacy = await db.prepare("SELECT status,revoked_at FROM intelligence_approval_ledger WHERE id='legacy-main'").first();
  assert.deepEqual([legacy.status, Number(legacy.revoked_at)], ["revoked", now]);

  await db.prepare(`
    INSERT INTO intelligence_approval_ledger(
      id,task_id,owner_uid,owner_username,repository,branch,base_sha,
      scope_json,scope_sha256,status,issued_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'issued',?,?)
  `).bind(...legacyValues("legacy-expired", "task-legacy-expired", issuedAt, now - 1)).run();
  await assert.rejects(
    db.prepare("UPDATE intelligence_approval_ledger SET status='expired' WHERE id='legacy-expired'").run(),
    /terminal timestamp/i,
    "legacy approval must not expire before its expiry time",
  );

  await assert.rejects(
    db.prepare(`
      INSERT INTO intelligence_approval_ledger(
        id,task_id,owner_uid,owner_username,repository,branch,base_sha,
        scope_json,scope_sha256,status,issued_at,expires_at
      ) VALUES('legacy-future-issue','task-legacy-main','owner-a','mehranmsh',
        'Mehranmsh/mehranmsh.github.io','intelligence/staging-test',?,'{}',?,'issued',?,?)
    `).bind("a".repeat(40), "b".repeat(64), now + 60, now + 120).run(),
    /invalid legacy approval issue/i,
    "future-dated legacy issuance must be rejected",
  );

  await db.prepare(`
    INSERT INTO intelligence_capability_approvals(
      id,owner_uid,capability,scope,status,issued_at,expires_at
    ) VALUES('capability-main','owner-a','memory.create','owner_staging','issued',?,?)
  `).bind(issuedAt, expiresAt).run();
  await assert.rejects(
    db.prepare("UPDATE intelligence_capability_approvals SET status='consumed',consumed_at=?,consumed_by='executor' WHERE id='capability-main'")
      .bind(now).run(),
    /consumption is disabled/i,
    "capability approvals must not be consumed",
  );
  const capability = await db.prepare("SELECT status,consumed_at,consumed_by FROM intelligence_capability_approvals WHERE id='capability-main'").first();
  assert.deepEqual([capability.status, capability.consumed_at, capability.consumed_by], ["issued", null, null]);

  await assert.rejects(
    db.prepare("UPDATE intelligence_capability_approvals SET status='revoked',revoked_at=? WHERE id='capability-main'")
      .bind(issuedAt - 1).run(),
    /terminal timestamp/i,
    "capability revocation before issuance must be rejected",
  );
  await assert.rejects(
    db.prepare("UPDATE intelligence_capability_approvals SET status='revoked',revoked_at=? WHERE id='capability-main'")
      .bind(now + 60).run(),
    /terminal timestamp/i,
    "future-dated capability revocation must be rejected",
  );

  const consumptionAudit = await db.prepare(`
    SELECT COUNT(*) AS count FROM intelligence_staging_audit
    WHERE action IN ('approval_consumed','capability_approval_consumed')
  `).first();
  assert.equal(Number(consumptionAudit.count), 0,
    "blocked consumption must not create a consumption audit event");

  const required = [
    "trg_intelligence_approval_issued_at_guard",
    "trg_intelligence_approval_terminal_timestamp_guard",
    "trg_intelligence_approval_consumption_disabled",
    "trg_intelligence_capability_approval_consumption_disabled",
  ];
  const triggerRows = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${required.map(() => "?").join(",")})`
  ).bind(...required).all();
  assert.deepEqual(new Set(triggerRows.results.map(row => row.name)), new Set(required));

  console.log("PASS: D1 blocks consumption in both approval ledgers and enforces legacy issue/revocation/expiry timestamps");
} finally {
  await mf.dispose();
}
