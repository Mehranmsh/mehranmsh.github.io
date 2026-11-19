import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const ROOT = new URL("../", import.meta.url);
const migrationNames = [
  "0000_intelligence_staging_baseline",
  "0001_intelligence_approval_ledger",
  "0002_intelligence_knowledge_relations",
  "0003_intelligence_staging_runtime",
  "0004_intelligence_knowledge_provenance",
  "0005_intelligence_owner_memory_governance",
  "0006_intelligence_owner_memory_confidence_integer",
  "0007_intelligence_approval_ledger_state_guards",
  "0008_intelligence_capability_approval_ledger",
];

const CONSUME = `
UPDATE intelligence_capability_approvals
SET status='consumed', consumed_at=?, consumed_by=?
WHERE id=? AND owner_uid=? AND capability=? AND scope='owner_staging'
  AND status='issued' AND expires_at>? AND revoked_at IS NULL
  AND consumed_at IS NULL AND consumed_by IS NULL
`;
const ASSERT_ONE_CHANGE = `
INSERT INTO intelligence_staging_audit
(id,owner_uid,action,target_type,target_id,details_json,created_at)
SELECT '__d1_atomic_guard__','owner','atomic_guard','guard','guard',NULL,1
WHERE changes() <> 1
`;

async function createDatabase() {
  const mf = new Miniflare({
    script: "export default { async fetch() { return new Response('ok'); } };",
    modules: true,
    d1Databases: { DB: "intelligence-d1-atomic-test" },
  });
  const db = await mf.getD1Database("DB");
  for (const name of migrationNames) {
    const sql = await readFile(new URL(`migrations/${name}.sql`, ROOT), "utf8");
    // The baseline file may contain only SQL comments; D1 exec rejects empty scripts.
    const executableSql = sql.split("\n").filter(line => !line.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
    if (executableSql) await db.exec(executableSql);
  }
  await db.prepare("CREATE TABLE protected_operations (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, capability TEXT NOT NULL, payload TEXT NOT NULL)").run();
  await db.prepare(`
    INSERT INTO intelligence_capability_approvals
      (id,owner_uid,capability,scope,status,issued_at,expires_at)
    VALUES ('grant-valid','owner-a','memory.create','owner_staging','issued',100,200)
  `).run();
  return { mf, db };
}

function statements(db, {
  grantId = "grant-valid", owner = "owner-a", capability = "memory.create",
  now = 150, operationId = "op-1", consumerId = `staging-operation:${operationId}`,
  failOperation = false,
} = {}) {
  const operation = failOperation
    ? db.prepare(`
        INSERT INTO protected_operations(id,owner_uid,capability,payload)
        VALUES (?, ?, ?, NULL)
      `).bind(operationId, owner, capability)
    : db.prepare(`
        INSERT INTO protected_operations(id,owner_uid,capability,payload)
        SELECT ?, ?, ?, 'committed'
        WHERE EXISTS (
          SELECT 1 FROM intelligence_capability_approvals
          WHERE id=? AND owner_uid=? AND capability=?
            AND scope='owner_staging' AND status='consumed'
            AND consumed_by=? AND consumed_at=?
        )
      `).bind(operationId, owner, capability, grantId, owner,
        capability, consumerId, now);
  return [
    db.prepare(CONSUME).bind(now, consumerId, grantId, owner, capability, now),
    db.prepare(ASSERT_ONE_CHANGE),
    operation,
    db.prepare(ASSERT_ONE_CHANGE),
  ];
}

async function count(db, sql) {
  const row = await db.prepare(sql).first();
  return Number(row.count);
}

async function testSequentialSingleUse() {
  const { mf, db } = await createDatabase();
  try {
    const first = await db.batch(statements(db, { operationId: "op-first" }));
    assert.equal(await count(db, "SELECT COUNT(*) AS count FROM protected_operations WHERE id='op-first'"), 1, "first operation must be committed");
    await assert.rejects(
      db.batch(statements(db, { operationId: "op-second" })),
      /constraint|NOT NULL|not null/i,
      "a second use must fail the fail-closed row-count guard",
    );
    assert.equal(await count(db, "SELECT COUNT(*) AS count FROM protected_operations"), 1);
    assert.equal(await count(db, "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE target_id='grant-valid' AND action='capability_approval_consumed'"), 1);
    const approval = await db.prepare("SELECT status, consumed_by FROM intelligence_capability_approvals WHERE id='grant-valid'").first();
    assert.equal(approval.status, "consumed");
    assert.equal(approval.consumed_by, "staging-operation:op-first");
  } finally {
    await mf.dispose();
  }
}

async function testRollbackOnOperationFailure() {
  const { mf, db } = await createDatabase();
  try {
    await assert.rejects(db.batch(statements(db, { failOperation: true })), /constraint|NOT NULL|not null/i);
    const approval = await db.prepare("SELECT status, consumed_at, consumed_by FROM intelligence_capability_approvals WHERE id='grant-valid'").first();
    assert.equal(approval.status, "issued");
    assert.equal(approval.consumed_at, null);
    assert.equal(approval.consumed_by, null);
    assert.equal(await count(db, "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE target_id='grant-valid'"), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS count FROM protected_operations"), 0);
  } finally {
    await mf.dispose();
  }
}

async function testWrongOwnerFailsClosed() {
  const { mf, db } = await createDatabase();
  try {
    await assert.rejects(db.batch(statements(db, { owner: "owner-b" })), /constraint|NOT NULL|not null/i);
    const approval = await db.prepare("SELECT status FROM intelligence_capability_approvals WHERE id='grant-valid'").first();
    assert.equal(approval.status, "issued");
    assert.equal(await count(db, "SELECT COUNT(*) AS count FROM protected_operations"), 0);
  } finally {
    await mf.dispose();
  }
}

async function testExpiredAndRevokedApprovalsFailClosed() {
  for (const scenario of ["expired", "revoked"]) {
    const { mf, db } = await createDatabase();
    try {
      if (scenario === "expired") {
        await db.prepare("INSERT INTO intelligence_capability_approvals(id,owner_uid,capability,scope,status,issued_at,expires_at) VALUES('grant-expired','owner-a','memory.create','owner_staging','issued',100,149)").run();
      } else {
        await db.prepare("UPDATE intelligence_capability_approvals SET status='revoked', revoked_at=140, id=id, owner_uid=owner_uid, capability=capability, scope=scope, issued_at=issued_at, expires_at=expires_at WHERE id='grant-valid'").run();
      }
      await assert.rejects(
        db.batch(statements(db, { grantId: scenario === "expired" ? "grant-expired" : "grant-valid", now: 150, operationId: `op-${scenario}` })),
        /constraint|NOT NULL|not null/i,
        `${scenario} approval must not authorize an operation`,
      );
      const approval = await db.prepare("SELECT status FROM intelligence_capability_approvals WHERE id='grant-valid'").first();
      assert.equal(approval.status, scenario === "expired" ? "issued" : "revoked");
      assert.equal(await count(db, "SELECT COUNT(*) AS count FROM protected_operations"), 0);
    } finally {
      await mf.dispose();
    }
  }
  console.log("PASS: D1-runtime expired and revoked approvals fail closed");
}

await testSequentialSingleUse();
console.log("PASS: D1-runtime sequential one-time consumption and row-count guard");
await testRollbackOnOperationFailure();
console.log("PASS: D1-runtime rollback restores approval and trigger audit");
await testWrongOwnerFailsClosed();
console.log("PASS: D1-runtime wrong-owner attempt fails closed");
await testExpiredAndRevokedApprovalsFailClosed();
