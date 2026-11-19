import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { createHash, randomBytes } from "node:crypto";

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
];

async function applyMigrations(db, names) {
  for (const name of names) {
    const source = await readFile(new URL(`migrations/${name}.sql`, ROOT), "utf8");
    const sql = source
      .split("\n")
      .filter(line => !line.trim().startsWith("--"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (sql) await db.exec(sql);
  }
}

async function createWorker(migrationCount) {
  const mf = new Miniflare({
    scriptPath: new URL("../intelligence-staging-worker.js", import.meta.url).pathname,
    modules: true,
    bindings: { MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: "staging-owner-test-uid" },
    d1Databases: { DB: `intelligence-health-runtime-${migrationCount}` },
  });
  const db = await mf.getD1Database("DB");
  await applyMigrations(db, migrations.slice(0, migrationCount));
  return { mf, db };
}


function tokenHash(token) {
  return createHash("sha256").update(token).digest("base64url");
}

async function testSessionVerificationAndRevocation() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = tokenHash(token);
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-valid-0001", tokenDigest, ownerUid, now, now + 3600).run();

    const headers = { Authorization: `Bearer ${token}` };
    const accepted = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { success: true, ownerUid });

    const revoked = await mf.dispatchFetch("http://localhost/session", {
      method: "DELETE",
      headers,
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { success: true, revoked: true });

    const rejectedAfterRevocation = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(rejectedAfterRevocation.status, 401);

    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_revoked'"
    ).bind(ownerUid).first();
    assert.equal(Number(audit.count), 1);

    const expiredToken = randomBytes(32).toString("base64url");
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-expired-001", tokenHash(expiredToken), ownerUid, now - 7200, now - 3600).run();
    const expired = await mf.dispatchFetch("http://localhost/session", {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(expired.status, 401);

    const foreignToken = randomBytes(32).toString("base64url");
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-foreign-001", tokenHash(foreignToken), "different-owner-uid", now, now + 3600).run();
    const foreignOwner = await mf.dispatchFetch("http://localhost/session", {
      headers: { Authorization: `Bearer ${foreignToken}` },
    });
    assert.equal(foreignOwner.status, 401);

    console.log("PASS: staging sessions enforce owner binding, expiry, revocation, and audit");
  } finally {
    await mf.dispose();
  }
}


async function testSessionReadRateLimit() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-rate-limit-01", tokenHash(token), ownerUid, now, now + 3600).run();

    const headers = { Authorization: `Bearer ${token}` };
    for (let index = 0; index < 30; index += 1) {
      const response = await mf.dispatchFetch("http://localhost/session", { headers });
      assert.equal(response.status, 200, `request ${index + 1} should be allowed`);
    }
    const blocked = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), {
      success: false,
      error: "Rate limit exceeded."
    });
    const row = await db.prepare(
      "SELECT request_count FROM intelligence_staging_rate_limits WHERE rate_key=?"
    ).bind(tokenHash(`${ownerUid}:session-read`)).first();
    assert.equal(Number(row.request_count), 31);
    console.log("PASS: staging session read rate limit blocks request 31 and records counter");
  } finally {
    await mf.dispose();
  }
}

async function testCompleteSchemaReportsHealthy() {
  const { mf, db } = await createWorker(migrations.length);
  try {
    const response = await mf.dispatchFetch("http://localhost/health");
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.service, "mehran-intelligence-staging");
    assert.equal(body.schemaReady, true, JSON.stringify(body));
    assert.deepEqual(body.missingTables, []);
    assert.equal(body.foreignKeysEnabled, true);
    assert.equal(body.foreignKeyViolations, 0);
    assert.equal(body.executor, false);
    console.log("PASS: staging Worker /health accepts the complete isolated D1 schema");
  } finally {
    await mf.dispose();
  }
}

async function testMissingCapabilityLedgerFailsClosed() {
  const { mf } = await createWorker(migrations.length - 1);
  try {
    const response = await mf.dispatchFetch("http://localhost/health");
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.schemaReady, false);
    assert.deepEqual(body.missingTables, ["intelligence_capability_approvals"]);
    assert.equal(body.executor, false);
    console.log("PASS: staging Worker /health fails closed when migration 0008 is absent");
  } finally {
    await mf.dispose();
  }
}

async function testOriginAndSecurityHeaders() {
  const { mf } = await createWorker(migrations.length);
  try {
    const rejected = await mf.dispatchFetch("http://localhost/health", {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(rejected.status, 403);

    const accepted = await mf.dispatchFetch("http://localhost/health", {
      headers: { Origin: "https://mehranmsh.github.io" },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
    assert.equal(accepted.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(accepted.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(accepted.headers.get("X-Frame-Options"), "DENY");
    assert.equal(accepted.headers.get("Cache-Control"), "no-store");
    assert.equal(accepted.headers.get("Vary"), "Origin");

    const preflight = await mf.dispatchFetch("http://localhost/session", {
      method: "OPTIONS",
      headers: { Origin: "https://mehranmsh.github.io" },
    });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
    console.log("PASS: staging Worker rejects untrusted origins and emits security headers");
  } finally {
    await mf.dispose();
  }
}

async function testProtectedRoutesRequireSession() {
  const { mf, db } = await createWorker(migrations.length);
  try {
    const read = await mf.dispatchFetch("http://localhost/intelligence/tasks");
    assert.equal(read.status, 401);

    const write = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "unauthorized task" }),
    });
    assert.equal(write.status, 401);
    const rows = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_tasks").first();
    assert.equal(Number(rows.count), 0);
    console.log("PASS: staging Intelligence routes reject unauthenticated reads and writes");
  } finally {
    await mf.dispose();
  }
}

async function testJsonBodyLimitsAndContentType() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-body-limit-01", tokenHash(token), ownerUid, now, now + 3600).run();
    const headers = { Authorization: `Bearer ${token}` };

    const wrongType = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: JSON.stringify({ title: "wrong content type" }),
    });
    assert.equal(wrongType.status, 400);

    const oversized = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(21_000) }),
    });
    assert.equal(oversized.status, 400);

    const malformed = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{invalid-json",
    });
    assert.equal(malformed.status, 400);

    const rows = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_tasks").first();
    assert.equal(Number(rows.count), 0);
    console.log("PASS: staging Worker rejects wrong content types, oversized JSON, and malformed JSON");
  } finally {
    await mf.dispose();
  }
}

await testCompleteSchemaReportsHealthy();
await testMissingCapabilityLedgerFailsClosed();
await testSessionVerificationAndRevocation();
await testSessionReadRateLimit();
await testOriginAndSecurityHeaders();
await testProtectedRoutesRequireSession();
async function testTaskAuditAtomicityAndOwnerIsolation() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-task-audit-01", tokenHash(token), ownerUid, now, now + 3600).run();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const created = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Owner-scoped test task", priority: "normal" }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.executionEnabled, false);

    const audit = await db.prepare(
      "SELECT owner_uid, action, target_type, target_id FROM intelligence_staging_audit WHERE action='task_planned' AND target_id=?"
    ).bind(createdBody.id).first();
    assert.equal(audit.owner_uid, ownerUid);
    assert.equal(audit.action, "task_planned");
    assert.equal(audit.target_type, "task");

    await db.prepare(`
      INSERT INTO intelligence_tasks(id,title,created_by)
      VALUES('foreign-owner-task','Foreign task','different-owner-uid')
    `).run();
    const listed = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.deepEqual(listedBody.items.map(item => item.id), [createdBody.id]);

    await db.prepare(
      "CREATE TRIGGER reject_task_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action = 'task_planned' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const rejected = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Must roll back without audit" }),
    });
    assert.equal(rejected.status, 503);
    const ownerTasks = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_tasks WHERE created_by=?"
    ).bind(ownerUid).first();
    assert.equal(Number(ownerTasks.count), 1);
    const auditRows = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='task_planned'"
    ).bind(ownerUid).first();
    assert.equal(Number(auditRows.count), 1);
    console.log("PASS: task creation is owner-scoped and rolls back when audit recording fails");
  } finally {
    await mf.dispose();
  }
}

await testJsonBodyLimitsAndContentType();
async function testOwnerMemoryAuditIsolationAndProvenance() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const foreignKnowledgeId = "11111111-1111-4111-8111-111111111111";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-memory-governance-01", tokenHash(token), ownerUid, now, now + 3600).run();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const foreignKnowledge = await db.prepare(
      "INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by) VALUES(?,?,?,?,?)"
    ).bind(foreignKnowledgeId, "different-owner-uid", "Foreign source", "Private foreign source", "different-owner-uid").run();
    assert.equal(foreignKnowledge.success, true);

    const crossOwnerSource = await mf.dispatchFetch("http://localhost/intelligence/memory", {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Must not link another owner's source",
        memoryKind: "project_context",
        sourceType: "knowledge_record",
        sourceRef: foreignKnowledgeId,
      }),
    });
    assert.equal(crossOwnerSource.status, 503);
    const crossOwnerCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_owner_memory WHERE owner_uid=?"
    ).bind(ownerUid).first();
    assert.equal(Number(crossOwnerCount.count), 0);

    const created = await mf.dispatchFetch("http://localhost/intelligence/memory", {
      method: "POST",
      headers,
      body: JSON.stringify({
        category: "governance-test",
        content: "Owner-controlled memory record",
        memoryKind: "decision",
        sourceType: "owner_input",
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const audit = await db.prepare(
      "SELECT owner_uid, action, target_type, target_id FROM intelligence_staging_audit WHERE action='owner_memory_created' AND target_id=?"
    ).bind(createdBody.id).first();
    assert.equal(audit.owner_uid, ownerUid);
    assert.equal(audit.target_type, "memory");

    await db.prepare(
      "INSERT INTO intelligence_owner_memory(id,owner_uid,category,content) VALUES(?,?,?,?)"
    ).bind("foreign-memory-0001", "different-owner-uid", "private", "Do not disclose").run();

    const listed = await mf.dispatchFetch("http://localhost/intelligence/memory", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.deepEqual(listedBody.items.map(item => item.id), [createdBody.id]);

    await db.prepare(
      "CREATE TRIGGER reject_memory_review_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='owner_memory_confirmed' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const confirmFailed = await mf.dispatchFetch(`http://localhost/intelligence/memory/${createdBody.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(confirmFailed.status, 503);
    const unchanged = await db.prepare(
      "SELECT review_status FROM intelligence_owner_memory WHERE id=? AND owner_uid=?"
    ).bind(createdBody.id, ownerUid).first();
    assert.equal(unchanged.review_status, "unreviewed");

    const foreignUpdate = await mf.dispatchFetch("http://localhost/intelligence/memory/foreign-memory-0001", {
      method: "PUT",
      headers,
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(foreignUpdate.status, 404);

    console.log("PASS: owner memory enforces source ownership, read isolation, and atomic review audit");
  } finally {
    await mf.dispose();
  }
}

await testTaskAuditAtomicityAndOwnerIsolation();
await testOwnerMemoryAuditIsolationAndProvenance();
