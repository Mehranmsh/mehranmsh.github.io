import assert from "node:assert/strict";
import stagingWorker, { fetchPiUser } from "../intelligence-staging-worker.js";
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

async function testPiIdentityResponseValidation() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization, accept: options.headers.Accept, redirect: options.redirect });
      return new Response(JSON.stringify({ uid: "staging-owner-test-uid", username: "mehranmsh" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
    assert.deepEqual(await fetchPiUser("valid-access-token-123"), { uid: "staging-owner-test-uid", username: "mehranmsh" });
    assert.equal(calls[0].url, "https://api.minepi.com/v2/me");
    assert.equal(calls[0].authorization, "Bearer valid-access-token-123");
    assert.equal(calls[0].accept, "application/json");
    assert.equal(calls[0].redirect, "error", "Pi token verification must not follow redirects");

    globalThis.fetch = async () => new Response("<html>not json</html>", {
      status: 200, headers: { "Content-Type": "text/html" },
    });
    assert.equal(await fetchPiUser("valid-access-token-123"), null, "non-JSON identity response must be rejected");

    globalThis.fetch = async () => new Response("{broken", {
      status: 200, headers: { "Content-Type": "application/json" },
    });
    assert.equal(await fetchPiUser("valid-access-token-123"), null, "malformed JSON must be rejected");

    globalThis.fetch = async () => new Response("x".repeat(8193), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
    assert.equal(await fetchPiUser("valid-access-token-123"), null, "oversized identity response must be rejected");

    globalThis.fetch = async () => new Response(JSON.stringify({ uid: "u", username: "x".repeat(101) }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
    assert.equal(await fetchPiUser("valid-access-token-123"), null, "oversized username must be rejected");

    globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
    assert.equal(await fetchPiUser("valid-access-token-123"), null, "Pi API errors must fail closed");

    globalThis.fetch = async () => { throw new Error("network details must not escape"); };
    assert.equal(await fetchPiUser("valid-access-token-123"), null, "network failures must fail closed");

    const originalSetTimeout = globalThis.setTimeout;
    let fireTimeout;
    try {
      globalThis.setTimeout = callback => { fireTimeout = callback; return 1; };
      globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        fireTimeout();
      });
      assert.equal(await fetchPiUser("valid-access-token-123"), null, "Pi API timeout must abort the in-flight request and fail closed");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    assert.equal(await fetchPiUser("short"), null, "invalid token length must avoid the upstream request");
    console.log("PASS: Pi identity verification bounds response size and rejects malformed, oversized, non-JSON, and failed upstream responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
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

    await db.prepare(
      "CREATE TRIGGER reject_session_revoke_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='session_revoked' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const auditFailure = await mf.dispatchFetch("http://localhost/session", {
      method: "DELETE",
      headers,
    });
    assert.equal(auditFailure.status, 503);
    const stillValidAfterAuditFailure = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(stillValidAfterAuditFailure.status, 200, "failed revocation audit must roll back the session revocation");
    await db.prepare("DROP TRIGGER reject_session_revoke_audit").run();

    const revoked = await mf.dispatchFetch("http://localhost/session", {
      method: "DELETE",
      headers,
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { success: true, revoked: true });

    const rejectedAfterRevocation = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(rejectedAfterRevocation.status, 401);
    const replayedRevoke = await mf.dispatchFetch("http://localhost/session", {
      method: "DELETE",
      headers,
    });
    assert.equal(replayedRevoke.status, 401, "a revoked bearer token must not revoke or access the session again");

    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_revoked'"
    ).bind(ownerUid).first();
    assert.equal(Number(audit.count), 1, "exactly one revocation audit must be recorded");

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

    const futureToken = randomBytes(32).toString("base64url");
    await db.prepare("INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)")
      .bind("session-future-created-001", tokenHash(futureToken), ownerUid, now + 60, now + 3600).run();
    const futureCreated = await mf.dispatchFetch("http://localhost/session", {
      headers: { Authorization: "Bearer " + futureToken },
    });
    assert.equal(futureCreated.status, 401, "sessions created in the future must be rejected");

    const staleToken = randomBytes(32).toString("base64url");
    await db.prepare("INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)")
      .bind("session-stale-created-001", tokenHash(staleToken), ownerUid, now - 43201, now + 60).run();
    const staleCreated = await mf.dispatchFetch("http://localhost/session", {
      headers: { Authorization: "Bearer " + staleToken },
    });
    assert.equal(staleCreated.status, 401, "sessions older than the maximum lifetime must be rejected");

    const longLifetimeToken = randomBytes(32).toString("base64url");
    await db.prepare("INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)")
      .bind("session-overlong-lifetime-001", tokenHash(longLifetimeToken), ownerUid, now, now + 43201).run();
    const overlongLifetime = await mf.dispatchFetch("http://localhost/session", {
      headers: { Authorization: "Bearer " + longLifetimeToken },
    });
    assert.equal(overlongLifetime.status, 401, "session expiry must never exceed the configured lifetime");

    const storedHash = await db.prepare("SELECT token_hash FROM intelligence_staging_sessions WHERE id=?")
      .bind("session-valid-0001").first();
    assert.equal(storedHash.token_hash, tokenDigest);
    assert.notEqual(storedHash.token_hash, token, "the raw bearer token must never be stored");

    console.log("PASS: staging sessions enforce owner binding, expiry, revocation, audit, and strict timestamp bounds");
  } finally {
    await mf.dispose();
  }
}


async function testPiSessionCreationRejectsUntrustedClientClaims() {
  const { mf, db } = await createWorker(migrations.length);
  try {
    const invalidBodies = [
      {},
      { accessToken: "short" },
      { accessToken: "x".repeat(4097) },
      { accessToken: "not-a-valid-token", username: "mehranmsh", uid: "staging-owner-test-uid" },
      { accessToken: "not-a-valid-token", isOwner: true },
    ];
    for (const body of invalidBodies) {
      const response = await mf.dispatchFetch("http://localhost/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    const sessionCount = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_sessions").first();
    const auditCount = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE action='session_created'").first();
    assert.equal(Number(sessionCount.count), 0);
    assert.equal(Number(auditCount.count), 0);
    console.log("PASS: Pi session creation rejects client-supplied identity claims and malformed payloads");
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
await testPiIdentityResponseValidation();
await testSessionVerificationAndRevocation();
await testPiSessionCreationRejectsUntrustedClientClaims();
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
async function testKnowledgeOwnershipEvidenceAndAuditAtomicity() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-knowledge-governance-01", tokenHash(token), ownerUid, now, now + 3600).run();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const createKnowledge = async (title, content) => {
      const response = await mf.dispatchFetch("http://localhost/intelligence/knowledge", {
        method: "POST",
        headers,
        body: JSON.stringify({ title, content, category: "governance-test", sourceType: "owner_input" }),
      });
      assert.equal(response.status, 201);
      return (await response.json()).id;
    };
    const sourceId = await createKnowledge("Evidence source A", "Verified phrase alpha");
    const targetId = await createKnowledge("Evidence source B", "Verified phrase beta");

    await db.prepare(
      "INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by) VALUES(?,?,?,?,?)"
    ).bind("22222222-2222-4222-8222-222222222222", "different-owner-uid", "Foreign knowledge", "Private", "different-owner-uid").run();

    const listed = await mf.dispatchFetch("http://localhost/intelligence/knowledge", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.deepEqual(listBody.items.map(item => item.id).sort(), [sourceId, targetId].sort());

    const relation = await mf.dispatchFetch("http://localhost/intelligence/knowledge/relations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceId,
        targetId,
        relationType: "supports",
        sourceEvidence: "Verified phrase alpha",
        targetEvidence: "Verified phrase beta",
      }),
    });
    assert.equal(relation.status, 201);
    const relationId = (await relation.json()).id;

    const foreignRelation = await mf.dispatchFetch("http://localhost/intelligence/knowledge/relations/cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
      method: "PUT",
      headers,
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(foreignRelation.status, 404);

    await db.prepare(
      "CREATE TRIGGER reject_relation_confirm_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='knowledge_relation_confirmed' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const failedConfirm = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/relations/${relationId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(failedConfirm.status, 503);
    const stillCandidate = await db.prepare("SELECT status FROM intelligence_knowledge_relations WHERE id=? AND owner_uid=?")
      .bind(relationId, ownerUid).first();
    assert.equal(stillCandidate.status, "candidate");
    await db.prepare("DROP TRIGGER reject_relation_confirm_audit").run();

    const confirmed = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/relations/${relationId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(confirmed.status, 200);
    const relationAudit = await db.prepare(
      "SELECT action,target_type,target_id FROM intelligence_staging_audit WHERE owner_uid=? AND target_id=? AND action='knowledge_relation_confirmed'"
    ).bind(ownerUid, relationId).first();
    assert.equal(relationAudit.target_type, "knowledge_relation");

    const blockedEdit = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/${sourceId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ content: "Altered evidence after relation" }),
    });
    assert.equal(blockedEdit.status, 409);
    const unchanged = await db.prepare("SELECT content FROM intelligence_knowledge WHERE id=? AND owner_uid=?")
      .bind(sourceId, ownerUid).first();
    assert.equal(unchanged.content, "Verified phrase alpha");

    await db.prepare(
      "CREATE TRIGGER reject_knowledge_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='knowledge_created' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const failedCreate = await mf.dispatchFetch("http://localhost/intelligence/knowledge", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Must roll back", content: "No unaudited knowledge", sourceType: "owner_input" }),
    });
    assert.equal(failedCreate.status, 503);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_knowledge WHERE owner_uid=?")
      .bind(ownerUid).first();
    assert.equal(Number(count.count), 2);
    console.log("PASS: knowledge ownership, evidence immutability, and atomic audit are enforced");
  } finally {
    await mf.dispose();
  }
}

await testOwnerMemoryAuditIsolationAndProvenance();
await testKnowledgeOwnershipEvidenceAndAuditAtomicity();
async function testCapabilityApprovalLifecycleIsAssessmentOnly() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-capability-lifecycle-01", tokenHash(token), ownerUid, now, now + 3600).run();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const invalid = await mf.dispatchFetch("http://localhost/intelligence/capability-approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "arbitrary.shell", expiresInSeconds: 300 }),
    });
    assert.equal(invalid.status, 400);

    await db.prepare(
      "CREATE TRIGGER reject_capability_issue_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='capability_approval_issued' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const auditFailure = await mf.dispatchFetch("http://localhost/intelligence/capability-approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.create", expiresInSeconds: 300 }),
    });
    assert.equal(auditFailure.status, 503);
    const rolledBack = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_capability_approvals WHERE owner_uid=?"
    ).bind(ownerUid).first();
    assert.equal(Number(rolledBack.count), 0);
    await db.prepare("DROP TRIGGER reject_capability_issue_audit").run();

    const issued = await mf.dispatchFetch("http://localhost/intelligence/capability-approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.create", expiresInSeconds: 300 }),
    });
    assert.equal(issued.status, 201);
    const issuedBody = await issued.json();
    assert.equal(issuedBody.executionEnabled, false);
    assert.equal(issuedBody.status, "issued");

    const expiredId = "88888888-8888-4888-8888-888888888888";
    await db.prepare(`
      INSERT INTO intelligence_capability_approvals
        (id,owner_uid,capability,scope,status,issued_at,expires_at)
      VALUES(?,?,?,'owner_staging','issued',?,?)
    `).bind(expiredId, ownerUid, "memory.delete", now - 120, now - 60).run();
    const approvalList = await mf.dispatchFetch("http://localhost/intelligence/capability-approvals", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(approvalList.status, 200);
    const approvalListBody = await approvalList.json();
    assert.equal(approvalListBody.items.find(item => item.id === expiredId).status, "expired");
    const expiredStored = await db.prepare(
      "SELECT status FROM intelligence_capability_approvals WHERE id=? AND owner_uid=?"
    ).bind(expiredId, ownerUid).first();
    assert.equal(expiredStored.status, "issued", "GET must not mutate the approval ledger");

    const assessment = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.create", approvalId: issuedBody.id }),
    });
    assert.equal(assessment.status, 200);
    const assessmentBody = await assessment.json();
    assert.equal(assessmentBody.operationPerformed, false);
    assert.equal(assessmentBody.approvalConsumed, false);
    assert.equal(assessmentBody.assessmentOnly, true);
    assert.equal(assessmentBody.auditRecorded, true);

    const approvalRow = await db.prepare(
      "SELECT owner_uid,status,consumed_at,consumed_by FROM intelligence_capability_approvals WHERE id=?"
    ).bind(issuedBody.id).first();
    assert.equal(approvalRow.owner_uid, ownerUid);
    assert.equal(approvalRow.status, "issued");
    assert.equal(approvalRow.consumed_at, null);
    assert.equal(approvalRow.consumed_by, null);

    const foreignAssessment = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.create", approvalId: "33333333-3333-4333-8333-333333333333" }),
    });
    assert.equal(foreignAssessment.status, 200);
    const foreignBody = await foreignAssessment.json();
    assert.equal(foreignBody.operationPerformed, false);
    assert.equal(foreignBody.approvalConsumed, false);

    await db.prepare(
      "CREATE TRIGGER reject_capability_revoke_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='capability_approval_revoked' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const revokeAuditFailure = await mf.dispatchFetch(`http://localhost/intelligence/capability-approvals/${issuedBody.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(revokeAuditFailure.status, 503);
    const stillIssued = await db.prepare(
      "SELECT status,revoked_at FROM intelligence_capability_approvals WHERE id=? AND owner_uid=?"
    ).bind(issuedBody.id, ownerUid).first();
    assert.equal(stillIssued.status, "issued");
    assert.equal(stillIssued.revoked_at, null);
    await db.prepare("DROP TRIGGER reject_capability_revoke_audit").run();

    const revoked = await mf.dispatchFetch(`http://localhost/intelligence/capability-approvals/${issuedBody.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(revoked.status, 200);
    const afterRevoke = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.create", approvalId: issuedBody.id }),
    });
    assert.equal(afterRevoke.status, 200);
    const afterRevokeBody = await afterRevoke.json();
    assert.equal(afterRevokeBody.operationPerformed, false);
    assert.equal(afterRevokeBody.approvalConsumed, false);
    const revokedRow = await db.prepare(
      "SELECT status,revoked_at FROM intelligence_capability_approvals WHERE id=?"
    ).bind(issuedBody.id).first();
    assert.equal(revokedRow.status, "revoked");
    assert.notEqual(revokedRow.revoked_at, null);

    const approvalAuditRows = await db.prepare(
      "SELECT action,target_type,target_id FROM intelligence_staging_audit WHERE owner_uid=? AND target_id=? ORDER BY created_at"
    ).bind(ownerUid, issuedBody.id).all();
    assert.ok(approvalAuditRows.results.some(row => row.action === "capability_approval_issued"));
    assert.ok(approvalAuditRows.results.some(row => row.action === "capability_approval_revoked"));
    assert.equal(
      approvalAuditRows.results.filter(row => row.action === "capability_approval_revoked").length,
      1,
      "the database transition trigger must produce exactly one revocation audit",
    );
    const assessmentAudit = await db.prepare(
      "SELECT action,target_type,target_id FROM intelligence_staging_audit WHERE owner_uid=? AND action='capability_assessed' AND target_id='memory.create'"
    ).bind(ownerUid).first();
    assert.equal(assessmentAudit.action, "capability_assessed");
    assert.equal(assessmentAudit.target_type, "capability");
    console.log("PASS: capability approvals are owner-bound, audited, revocable, and assessment-only");
  } finally {
    await mf.dispose();
  }
}

await testCapabilityApprovalLifecycleIsAssessmentOnly();

async function testApprovalReadsAreReadOnlyAndExpirySweepIsAudited() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const expiredId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-approval-readonly-01", tokenHash(token), ownerUid, now, now + 3600).run();
    await db.prepare(
      "INSERT INTO intelligence_tasks(id,title,created_by) VALUES(?,?,?)"
    ).bind(taskId, "Approval expiry audit test", ownerUid).run();
    await db.prepare(`
      INSERT INTO intelligence_approval_ledger
        (id,task_id,owner_uid,owner_username,repository,branch,base_sha,scope_json,scope_sha256,status,issued_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,'issued',?,?)
    `).bind(expiredId, taskId, ownerUid, "mehranmsh", "Mehranmsh/mehranmsh.github.io",
      "main", "a".repeat(40), '{"paths":["docs/"]}', "test-scope-hash", now - 120, now - 60).run();

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const listed = await mf.dispatchFetch("http://localhost/intelligence/approvals", { headers });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.items.find(item => item.id === expiredId).status, "expired");
    const afterRead = await db.prepare("SELECT status FROM intelligence_approval_ledger WHERE id=?")
      .bind(expiredId).first();
    assert.equal(afterRead.status, "issued", "GET must not mutate approval state");

    await db.prepare(
      "CREATE TRIGGER reject_approval_expiry_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='approval_expiry_sweep' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const payload = {
      taskId, repository: "Mehranmsh/mehranmsh.github.io", branch: "main",
      baseSha: "b".repeat(40), scope: { paths: ["docs/"] }, expiresInSeconds: 300,
    };
    const auditFailure = await mf.dispatchFetch("http://localhost/intelligence/approvals", {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    assert.equal(auditFailure.status, 409);
    const rolledBack = await db.prepare("SELECT status FROM intelligence_approval_ledger WHERE id=?")
      .bind(expiredId).first();
    assert.equal(rolledBack.status, "issued", "failed expiry audit must roll back the state change");
    await db.prepare("DROP TRIGGER reject_approval_expiry_audit").run();

    const issued = await mf.dispatchFetch("http://localhost/intelligence/approvals", {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    assert.equal(issued.status, 201);
    const expiredAfterIssue = await db.prepare("SELECT status FROM intelligence_approval_ledger WHERE id=?")
      .bind(expiredId).first();
    assert.equal(expiredAfterIssue.status, "expired");
    const expiryAudit = await db.prepare(
      "SELECT action,target_type,target_id FROM intelligence_staging_audit WHERE owner_uid=? AND action='approval_expiry_sweep' AND target_id=?"
    ).bind(ownerUid, taskId).first();
    assert.equal(expiryAudit.action, "approval_expiry_sweep");
    assert.equal(expiryAudit.target_type, "task");
    console.log("PASS: approval GET is read-only and expiry sweeps are audit-atomic");
  } finally {
    await mf.dispose();
  }
}

await testApprovalReadsAreReadOnlyAndExpirySweepIsAudited();


async function testOwnerSensitiveMutationAuditAndIsolation() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-sensitive-mutations-01", tokenHash(token), ownerUid, now, now + 3600).run();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const memoryId = "44444444-4444-4444-8444-444444444444";
    await db.prepare(
      "INSERT INTO intelligence_owner_memory(id,owner_uid,category,content,memory_kind,source_type) VALUES(?,?,?,?,?,?)"
    ).bind(memoryId, ownerUid, "test", "Owner-only memory", "general", "owner_input").run();
    const foreignMemoryId = "55555555-5555-4555-8555-555555555555";
    await db.prepare(
      "INSERT INTO intelligence_owner_memory(id,owner_uid,category,content,memory_kind,source_type) VALUES(?,?,?,?,?,?)"
    ).bind(foreignMemoryId, "different-owner-uid", "test", "Foreign memory", "general", "owner_input").run();

    const foreignDelete = await mf.dispatchFetch(`http://localhost/intelligence/memory/${foreignMemoryId}`, {
      method: "DELETE", headers,
    });
    assert.equal(foreignDelete.status, 404);
    const foreignStillExists = await db.prepare("SELECT id FROM intelligence_owner_memory WHERE id=?")
      .bind(foreignMemoryId).first();
    assert.ok(foreignStillExists);

    await db.prepare(
      "CREATE TRIGGER reject_memory_delete_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='owner_memory_deleted' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const deleteAuditFailure = await mf.dispatchFetch(`http://localhost/intelligence/memory/${memoryId}`, {
      method: "DELETE", headers,
    });
    assert.equal(deleteAuditFailure.status, 503);
    const memoryAfterFailure = await db.prepare("SELECT id FROM intelligence_owner_memory WHERE id=?")
      .bind(memoryId).first();
    assert.ok(memoryAfterFailure, "memory deletion must roll back if audit insertion fails");
    await db.prepare("DROP TRIGGER reject_memory_delete_audit").run();

    const deleted = await mf.dispatchFetch(`http://localhost/intelligence/memory/${memoryId}`, {
      method: "DELETE", headers,
    });
    assert.equal(deleted.status, 200);
    const deletedRow = await db.prepare("SELECT id FROM intelligence_owner_memory WHERE id=?")
      .bind(memoryId).first();
    assert.equal(deletedRow, null);
    const deleteAudit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='owner_memory_deleted' AND target_id=?"
    ).bind(ownerUid, memoryId).first();
    assert.equal(Number(deleteAudit.count), 1);

    const knowledgeId = "66666666-6666-4666-8666-666666666666";
    await db.prepare(
      "INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by) VALUES(?,?,?,?,?)"
    ).bind(knowledgeId, ownerUid, "Review target", "Reviewable content", "pi-owner").run();
    const foreignKnowledgeId = "77777777-7777-4777-8777-777777777777";
    await db.prepare(
      "INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by) VALUES(?,?,?,?,?)"
    ).bind(foreignKnowledgeId, "different-owner-uid", "Foreign target", "Private content", "different-owner-uid").run();

    const foreignReview = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/${foreignKnowledgeId}`, {
      method: "PUT", headers, body: JSON.stringify({ action: "verify" }),
    });
    assert.equal(foreignReview.status, 404);
    const foreignKnowledge = await db.prepare("SELECT verification_status FROM intelligence_knowledge WHERE id=?")
      .bind(foreignKnowledgeId).first();
    assert.equal(foreignKnowledge.verification_status, "unreviewed");

    await db.prepare(
      "CREATE TRIGGER reject_knowledge_review_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='knowledge_owner_verified' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const reviewAuditFailure = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/${knowledgeId}`, {
      method: "PUT", headers, body: JSON.stringify({ action: "verify" }),
    });
    assert.equal(reviewAuditFailure.status, 503);
    const knowledgeAfterFailure = await db.prepare("SELECT verification_status FROM intelligence_knowledge WHERE id=?")
      .bind(knowledgeId).first();
    assert.equal(knowledgeAfterFailure.verification_status, "unreviewed");
    await db.prepare("DROP TRIGGER reject_knowledge_review_audit").run();

    const reviewed = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/${knowledgeId}`, {
      method: "PUT", headers, body: JSON.stringify({ action: "verify" }),
    });
    assert.equal(reviewed.status, 200);
    const verified = await db.prepare("SELECT verification_status FROM intelligence_knowledge WHERE id=?")
      .bind(knowledgeId).first();
    assert.equal(verified.verification_status, "owner_verified");
    const reviewAudit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='knowledge_owner_verified' AND target_id=?"
    ).bind(ownerUid, knowledgeId).first();
    assert.equal(Number(reviewAudit.count), 1);

    const unauthenticated = await mf.dispatchFetch(`http://localhost/intelligence/memory/${foreignMemoryId}`, {
      method: "DELETE",
    });
    assert.equal(unauthenticated.status, 401);
    console.log("PASS: sensitive owner mutations enforce owner isolation and atomic audit on delete/review");
  } finally {
    await mf.dispose();
  }
}

await testOwnerSensitiveMutationAuditAndIsolation();

async function testKnowledgeRelationReadsAreOwnerScoped() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const ownerSource = "10000000-0000-4000-8000-000000000001";
  const ownerTarget = "20000000-0000-4000-8000-000000000002";
  const foreignSource = "30000000-0000-4000-8000-000000000003";
  const foreignTarget = "40000000-0000-4000-8000-000000000004";
  const ownerRelation = "50000000-0000-4000-8000-000000000005";
  const foreignRelation = "60000000-0000-4000-8000-000000000006";
  try {
    await db.prepare("INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)")
      .bind("session-relation-read-scope", tokenHash(token), ownerUid, now, now + 3600).run();
    for (const [id, owner, title, content] of [
      [ownerSource, ownerUid, "Owner source", "Owner evidence alpha"],
      [ownerTarget, ownerUid, "Owner target", "Owner evidence beta"],
      [foreignSource, "different-owner-uid", "Foreign source", "Foreign evidence alpha"],
      [foreignTarget, "different-owner-uid", "Foreign target", "Foreign evidence beta"],
    ]) {
      await db.prepare("INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by) VALUES(?,?,?,?,?)")
        .bind(id, owner, title, content, owner).run();
    }
    for (const [id, owner, source, target, sourceEvidence, targetEvidence] of [
      [ownerRelation, ownerUid, ownerSource, ownerTarget, "Owner evidence alpha", "Owner evidence beta"],
      [foreignRelation, "different-owner-uid", foreignSource, foreignTarget, "Foreign evidence alpha", "Foreign evidence beta"],
    ]) {
      await db.prepare("INSERT INTO intelligence_knowledge_relations(id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,status,source_evidence,target_evidence) VALUES(?,?,?,?,'supports','candidate',?,?)")
        .bind(id, owner, source, target, sourceEvidence, targetEvidence).run();
    }
    const headers = { Authorization: "Bearer " + token };
    const listed = await mf.dispatchFetch("http://localhost/intelligence/knowledge/relations", { headers });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.deepEqual(listedBody.items.map(item => item.id), [ownerRelation]);
    const foreignEvaluation = await mf.dispatchFetch("http://localhost/intelligence/knowledge/" + foreignSource + "/evaluation", { headers });
    assert.equal(foreignEvaluation.status, 404);
    const ownerEvaluation = await mf.dispatchFetch("http://localhost/intelligence/knowledge/" + ownerSource + "/evaluation", { headers });
    assert.equal(ownerEvaluation.status, 200);
    const ownerEvaluationBody = await ownerEvaluation.json();
    assert.equal(ownerEvaluationBody.evaluation.relationCount, 1);
    console.log("PASS: knowledge relation and evaluation reads remain owner-scoped");
  } finally {
    await mf.dispose();
  }
}

await testKnowledgeRelationReadsAreOwnerScoped();


async function testPiSessionIssuanceEndToEndAndIpRateLimit() {
  let piCalls = 0;
  let identity = { uid: "staging-owner-test-uid", username: "mehranmsh" };
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const env = {
    DB: db,
    MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: ownerUid,
    PI_IDENTITY: { fetch: async (input, init = {}) => {
      piCalls += 1;
      const requestUrl = typeof input === "string" ? input : input.url;
      const requestHeaders = new Headers(init.headers || (typeof input === "string" ? undefined : input.headers));
      assert.equal(new URL(requestUrl).href, "https://api.minepi.com/v2/me");
      assert.equal(requestHeaders.get("Authorization"), "Bearer valid-access-token-123");
      return new Response(JSON.stringify(identity), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } },
  };
  const dispatch = (url, init = {}) => stagingWorker.fetch(new Request(url, init), env);
  try {
    const issue = () => dispatch("http://localhost/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "198.51.100.27",
      },
      body: JSON.stringify({ accessToken: "valid-access-token-123" }),
    });

    const issued = await issue();
    assert.equal(issued.status, 201, `session issuance failed: ${await issued.clone().text()}; Pi identity calls: ${piCalls}`);
    const issuedBody = await issued.json();
    assert.equal(issuedBody.success, true);
    assert.equal(typeof issuedBody.token, "string");
    assert.equal(issuedBody.token.length, 43);
    assert.equal(issuedBody.expiresAt > Math.floor(Date.now() / 1000), true);

    const session = await db.prepare(
      "SELECT id,token_hash,owner_uid,created_at,expires_at FROM intelligence_staging_sessions WHERE owner_uid=?"
    ).bind(ownerUid).first();
    assert.ok(session);
    assert.equal(session.token_hash, tokenHash(issuedBody.token));
    assert.notEqual(session.token_hash, issuedBody.token, "only the hash of the issued bearer token may be stored");
    assert.equal(session.owner_uid, ownerUid);

    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_created' AND target_id=?"
    ).bind(ownerUid, session.id).first();
    assert.equal(Number(audit.count), 1, "session issuance must create exactly one matching audit row");

    const authenticated = await dispatch("http://localhost/session", {
      headers: { Authorization: "Bearer " + issuedBody.token },
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), { success: true, ownerUid });

    await db.prepare(
      "CREATE TRIGGER reject_session_create_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='session_created' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const auditFailure = await issue();
    assert.equal(auditFailure.status, 503);
    const sessionCountAfterFailure = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_sessions WHERE owner_uid=?"
    ).bind(ownerUid).first();
    const auditCountAfterFailure = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_created'"
    ).bind(ownerUid).first();
    assert.equal(Number(sessionCountAfterFailure.count), 1, "session row must roll back when its audit insert fails");
    assert.equal(Number(auditCountAfterFailure.count), 1, "failed issuance must not leave a success audit");
    await db.prepare("DROP TRIGGER reject_session_create_audit").run();

    identity = { uid: "different-owner-uid", username: "mehranmsh" };
    const foreignIdentity = await issue();
    assert.equal(foreignIdentity.status, 403, "a valid Pi account with a different UID must not receive an owner session");
    const sessionCountAfterForeign = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_sessions WHERE owner_uid=?"
    ).bind(ownerUid).first();
    assert.equal(Number(sessionCountAfterForeign.count), 1);
    assert.equal(piCalls, 3);
    console.log("PASS: Pi owner session issuance verifies identity, stores only token hashes, audits atomically, and authenticates the issued session");
  } finally {
    await mf.dispose();
  }

  let rateLimitPiCalls = 0;
  const rateLimited = await createWorker(migrations.length);
  const rateLimitEnv = {
    DB: rateLimited.db,
    MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: ownerUid,
    PI_IDENTITY: { fetch: async () => {
      rateLimitPiCalls += 1;
      return new Response(JSON.stringify({ uid: ownerUid, username: "mehranmsh" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } },
  };
  const rateLimitDispatch = (url, init = {}) => stagingWorker.fetch(new Request(url, init), rateLimitEnv);
  try {
    for (let index = 0; index < 30; index += 1) {
      const allowed = await rateLimitDispatch("http://localhost/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "198.51.100.28",
        },
        body: JSON.stringify({ accessToken: "valid-access-token-123" }),
      });
      assert.equal(allowed.status, 201, "the first 30 authentication attempts should be allowed");
    }
    const blocked = await rateLimitDispatch("http://localhost/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "198.51.100.28",
      },
      body: JSON.stringify({ accessToken: "valid-access-token-123" }),
    });
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), {
      success: false,
      error: "Authentication rate limit exceeded.",
    });
    assert.equal(rateLimitPiCalls, 30, "blocked IP attempts must not reach the Pi identity API");
    console.log("PASS: session authentication IP rate limit blocks request 31 before contacting Pi");
  } finally {
    await rateLimited.mf.dispose();
  }
}
await testPiSessionIssuanceEndToEndAndIpRateLimit();
