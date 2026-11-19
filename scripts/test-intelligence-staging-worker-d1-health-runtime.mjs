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

    const invalidAuthorizationHeaders = [
      undefined,
      "",
      "Basic " + token,
      "Bearer",
      "Bearer ",
      "Bearer " + "x".repeat(39),
      "Bearer " + "x".repeat(201),
    ];
    for (const authorization of invalidAuthorizationHeaders) {
      const invalidHeaders = authorization === undefined ? {} : { Authorization: authorization };
      const invalid = await mf.dispatchFetch("http://localhost/session", { headers: invalidHeaders });
      assert.equal(invalid.status, 401, "missing, unsupported, empty, undersized, and oversized bearer credentials must be rejected");
    }
    const sessionCountAfterInvalidHeaders = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_sessions WHERE owner_uid=?"
    ).bind(ownerUid).first();
    const sessionAuditAfterInvalidHeaders = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_created'"
    ).bind(ownerUid).first();
    assert.equal(Number(sessionCountAfterInvalidHeaders.count), 1, "invalid authorization headers must not alter session rows");
    assert.equal(Number(sessionAuditAfterInvalidHeaders.count), 0, "invalid authorization headers must not create audit events");

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


async function testPiSessionFailureAndCreationAtomicity() {
  const ownerUid = "staging-owner-test-uid";
  const cases = [
    { name: "Pi upstream outage", fetch: async () => new Response("unavailable", { status: 503 }) },
    { name: "foreign Pi identity", fetch: async () => new Response(JSON.stringify({ uid: "foreign-owner", username: "mehranmsh" }), { status: 200, headers: { "Content-Type": "application/json" } }) },
    { name: "malformed Pi identity", fetch: async () => new Response("{invalid", { status: 200, headers: { "Content-Type": "application/json" } }) },
  ];
  for (const scenario of cases) {
    const { mf, db } = await createWorker(migrations.length);
    try {
      const env = {
        DB: db,
        MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: ownerUid,
        PI_IDENTITY: { fetch: scenario.fetch },
      };
      const response = await stagingWorker.fetch(new Request("http://localhost/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.90" },
        body: JSON.stringify({ accessToken: "valid-pi-access-token-123" }),
      }), env);
      assert.equal(response.status, 403, scenario.name + " must fail closed");
      const sessions = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_sessions").first();
      const audits = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE action='session_created'").first();
      assert.equal(Number(sessions.count), 0, scenario.name + " must not create a session");
      assert.equal(Number(audits.count), 0, scenario.name + " must not create a creation audit");
    } finally {
      await mf.dispose();
    }
  }

  for (const failure of ["session_insert", "audit_insert"]) {
    const { mf, db } = await createWorker(migrations.length);
    try {
      const env = {
        DB: db,
        MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: ownerUid,
        PI_IDENTITY: { fetch: async () => new Response(JSON.stringify({ uid: ownerUid, username: "mehranmsh" }), { status: 200, headers: { "Content-Type": "application/json" } }) },
      };
      const table = failure === "session_insert" ? "intelligence_staging_sessions" : "intelligence_staging_audit";
      const condition = failure === "session_insert" ? "" : " WHEN NEW.action='session_created'";
      const triggerName = "reject_session_creation_" + failure;
      await db.prepare(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${table}${condition} BEGIN SELECT RAISE(ABORT, 'simulated D1 write failure'); END`).run();
      const response = await stagingWorker.fetch(new Request("http://localhost/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": failure === "session_insert" ? "192.0.2.91" : "192.0.2.92" },
        body: JSON.stringify({ accessToken: "valid-pi-access-token-123" }),
      }), env);
      assert.equal(response.status, 503, failure + " failure must return service unavailable");
      const sessions = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_sessions").first();
      const audits = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE action='session_created'").first();
      assert.equal(Number(sessions.count), 0, failure + " failure must leave no partial session");
      assert.equal(Number(audits.count), 0, failure + " failure must leave no partial audit");
    } finally {
      await mf.dispose();
    }
  }
  console.log("PASS: Pi identity failures fail closed and session/audit creation is atomic under D1 write failures");
}

async function testPiSessionTokenStorageContract() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const env = {
    DB: db,
    MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: ownerUid,
    PI_IDENTITY: { fetch: async (_input, init = {}) => {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer valid-pi-access-token-123");
      return new Response(JSON.stringify({ uid: ownerUid, username: "mehranmsh" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } },
  };
  try {
    const response = await stagingWorker.fetch(new Request("http://localhost/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.93" },
      body: JSON.stringify({ accessToken: "valid-pi-access-token-123" }),
    }), env);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.token, "string");
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/, "session bearer token must contain 256 bits of base64url randomness");
    assert.equal(Number.isInteger(body.expiresAt), true);

    const session = await db.prepare(
      "SELECT id,token_hash,owner_uid,created_at,expires_at,revoked_at FROM intelligence_staging_sessions"
    ).first();
    assert.ok(session);
    assert.equal(session.owner_uid, ownerUid);
    assert.equal(session.token_hash, tokenHash(body.token), "only the SHA-256 digest of the bearer token is stored");
    assert.notEqual(session.token_hash, body.token, "the raw bearer token must never be persisted");
    assert.equal(body.expiresAt, Number(session.expires_at));
    assert.equal(Number(session.expires_at) - Number(session.created_at), 12 * 60 * 60);
    assert.equal(session.revoked_at, null);

    const auditRows = await db.prepare(
      "SELECT owner_uid,action,target_type,target_id FROM intelligence_staging_audit WHERE action='session_created'"
    ).all();
    assert.equal(auditRows.results.length, 1);
    assert.equal(auditRows.results[0].owner_uid, ownerUid);
    assert.equal(auditRows.results[0].target_type, "session");
    assert.equal(auditRows.results[0].target_id, session.id);
    console.log("PASS: Pi session issuance returns a single-use secret while persisting only its hash and matching audit reference");
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
await testPiSessionFailureAndCreationAtomicity();
await testPiSessionTokenStorageContract();
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

    const alteredToken = issuedBody.token.slice(0, -1) + (issuedBody.token.endsWith("A") ? "B" : "A");
    assert.notEqual(alteredToken, issuedBody.token);
    const tamperedBearer = await dispatch("http://localhost/session", {
      headers: { Authorization: "Bearer " + alteredToken },
    });
    assert.equal(tamperedBearer.status, 401, "a one-character-modified bearer token must be rejected");
    const rowsAfterTamper = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_sessions WHERE owner_uid=?"
    ).bind(ownerUid).first();
    const auditsAfterTamper = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_created'"
    ).bind(ownerUid).first();
    assert.equal(Number(rowsAfterTamper.count), 1, "tampered token verification must not create or alter sessions");
    assert.equal(Number(auditsAfterTamper.count), 1, "tampered token verification must not create audit records");

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


async function testEveryProtectedRouteRequiresOwnerSession() {
  const { mf, db } = await createWorker(migrations.length);
  const protectedRoutes = [
    ["GET", "/intelligence/capabilities"],
    ["GET", "/intelligence/capability-approvals"],
    ["POST", "/intelligence/capability-approvals"],
    ["DELETE", "/intelligence/capability-approvals/11111111-1111-4111-8111-111111111111"],
    ["POST", "/intelligence/capabilities/evaluate"],
    ["GET", "/intelligence/tasks"],
    ["POST", "/intelligence/tasks"],
    ["GET", "/intelligence/memory"],
    ["POST", "/intelligence/memory"],
    ["GET", "/intelligence/memory/review-queue"],
    ["PUT", "/intelligence/memory/22222222-2222-4222-8222-222222222222"],
    ["DELETE", "/intelligence/memory/22222222-2222-4222-8222-222222222222"],
    ["GET", "/intelligence/knowledge/review-queue"],
    ["GET", "/intelligence/knowledge"],
    ["GET", "/intelligence/knowledge/evaluations"],
    ["POST", "/intelligence/knowledge"],
    ["PUT", "/intelligence/knowledge/33333333-3333-4333-8333-333333333333"],
    ["GET", "/intelligence/knowledge/relations"],
    ["POST", "/intelligence/knowledge/relations"],
    ["PUT", "/intelligence/knowledge/relations/44444444-4444-4444-8444-444444444444"],
    ["GET", "/intelligence/knowledge/55555555-5555-4555-8555-555555555555/evaluation"],
    ["GET", "/intelligence/approvals"],
    ["POST", "/intelligence/approvals"],
    ["DELETE", "/intelligence/approvals/66666666-6666-4666-8666-666666666666"],
  ];

  try {
    for (const [method, path] of protectedRoutes) {
      const response = await stagingWorker.fetch(new Request("http://localhost" + path, {
        method,
        headers: method === "GET" || method === "DELETE"
          ? {}
          : { "Content-Type": "application/json" },
        body: method === "POST" || method === "PUT" ? "{}" : undefined,
      }), {
        DB: db,
        MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: "staging-owner-test-uid",
      });
      assert.equal(response.status, 401, `${method} ${path} must reject requests without an owner session`);
    }

    const protectedTables = [
      "intelligence_staging_sessions",
      "intelligence_staging_audit",
      "intelligence_staging_rate_limits",
      "intelligence_tasks",
      "intelligence_owner_memory",
      "intelligence_knowledge",
      "intelligence_knowledge_relations",
      "intelligence_approval_ledger",
      "intelligence_capability_approvals",
    ];
    for (const table of protectedTables) {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
      assert.equal(Number(row.count), 0, `unauthenticated requests must not mutate ${table}`);
    }

    const health = await stagingWorker.fetch(new Request("http://localhost/health"), { DB: db });
    assert.equal(health.status, 200, "the read-only staging health endpoint remains intentionally public");
    console.log(`PASS: all ${protectedRoutes.length} protected route/method combinations reject missing owner sessions before database writes`);
  } finally {
    await mf.dispose();
  }
}

await testEveryProtectedRouteRequiresOwnerSession();


async function testOwnerMemoryTransitionLifecycleAndAuditAtomicity() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const memoryId = "88888888-8888-4888-8888-888888888888";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-memory-transitions-01", tokenHash(token), ownerUid, now, now + 3600).run();
    await db.prepare(
      "INSERT INTO intelligence_owner_memory(id,owner_uid,category,content,memory_kind,source_type) VALUES(?,?,?,?,?,?)"
    ).bind(memoryId, ownerUid, "lifecycle", "Transition test record", "decision", "owner_input").run();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const dispatch = (action) => mf.dispatchFetch(`http://localhost/intelligence/memory/${memoryId}`, {
      method: "PUT", headers, body: JSON.stringify({ action }),
    });

    await db.prepare(
      "CREATE TRIGGER reject_memory_dispute_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='owner_memory_disputed' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const failedDispute = await dispatch("dispute");
    assert.equal(failedDispute.status, 503);
    let record = await db.prepare(
      "SELECT review_status, archived_at FROM intelligence_owner_memory WHERE id=? AND owner_uid=?"
    ).bind(memoryId, ownerUid).first();
    assert.equal(record.review_status, "unreviewed", "failed audit must roll back the dispute transition");
    assert.equal(record.archived_at, null);
    await db.prepare("DROP TRIGGER reject_memory_dispute_audit").run();

    const transitions = [
      { action: "confirm", expectedStatus: "owner_confirmed", expectedArchived: false, audit: "owner_memory_confirmed" },
      { action: "dispute", expectedStatus: "disputed", expectedArchived: false, audit: "owner_memory_disputed" },
      { action: "unverify", expectedStatus: "unreviewed", expectedArchived: false, audit: "owner_memory_unverified" },
      { action: "archive", expectedStatus: "unreviewed", expectedArchived: true, audit: "owner_memory_archived" },
      { action: "restore", expectedStatus: "unreviewed", expectedArchived: false, audit: "owner_memory_restored" },
    ];
    for (const transition of transitions) {
      const response = await dispatch(transition.action);
      assert.equal(response.status, 200, `${transition.action} transition should succeed`);
      record = await db.prepare(
        "SELECT review_status, archived_at FROM intelligence_owner_memory WHERE id=? AND owner_uid=?"
      ).bind(memoryId, ownerUid).first();
      assert.equal(record.review_status, transition.expectedStatus);
      assert.equal(Boolean(record.archived_at), transition.expectedArchived);
      const audit = await db.prepare(
        "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action=? AND target_id=?"
      ).bind(ownerUid, transition.audit, memoryId).first();
      assert.equal(Number(audit.count), 1, `${transition.action} must produce exactly one matching audit event`);
    }

    const duplicateRestore = await dispatch("restore");
    assert.equal(duplicateRestore.status, 404, "restoring an active record must not create a second transition");
    const auditCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE target_id=? AND action LIKE 'owner_memory_%'"
    ).bind(memoryId).first();
    assert.equal(Number(auditCount.count), 5, "only the five successful transitions should be audited");
    console.log("PASS: owner memory confirm/dispute/unverify/archive/restore transitions are owner-scoped and audit-atomic");
  } finally {
    await mf.dispose();
  }
}

await testOwnerMemoryTransitionLifecycleAndAuditAtomicity();


async function testKnowledgeRelationLifecycleAndAuditAtomicity() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const sourceId = "90000000-0000-4000-8000-000000000001";
  const targetId = "90000000-0000-4000-8000-000000000002";
  const foreignId = "90000000-0000-4000-8000-000000000003";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-knowledge-relation-lifecycle", tokenHash(token), ownerUid, now, now + 3600).run();
    for (const [id, owner, title, content] of [
      [sourceId, ownerUid, "Source record", "Evidence phrase alpha"],
      [targetId, ownerUid, "Target record", "Evidence phrase beta"],
      [foreignId, "different-owner-uid", "Foreign record", "Foreign evidence phrase"],
    ]) {
      await db.prepare(
        "INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by) VALUES(?,?,?,?,?)"
      ).bind(id, owner, title, content, owner).run();
    }
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const create = (source, target, sourceEvidence, targetEvidence, relationType = "supports") =>
      mf.dispatchFetch("http://localhost/intelligence/knowledge/relations", {
        method: "POST", headers,
        body: JSON.stringify({ sourceId: source, targetId: target, sourceEvidence, targetEvidence, relationType }),
      });

    const crossOwner = await create(sourceId, foreignId, "Evidence phrase alpha", "Foreign evidence phrase");
    assert.equal(crossOwner.status, 404, "a relation must not reference another owner's knowledge");
    const wrongEvidence = await create(sourceId, targetId, "not present in source", "Evidence phrase beta");
    assert.equal(wrongEvidence.status, 404, "relation evidence must match the exact source content");

    const proposed = await create(sourceId, targetId, "Evidence phrase alpha", "Evidence phrase beta");
    assert.equal(proposed.status, 201);
    const proposedBody = await proposed.json();
    assert.equal(proposedBody.status, "candidate");
    const proposalAudit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='knowledge_relation_proposed' AND target_id=?"
    ).bind(ownerUid, proposedBody.id).first();
    assert.equal(Number(proposalAudit.count), 1);

    await db.prepare(
      "CREATE TRIGGER reject_relation_confirm_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='knowledge_relation_confirmed' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const failedConfirm = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/relations/${proposedBody.id}`, {
      method: "PUT", headers, body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(failedConfirm.status, 503);
    let relation = await db.prepare(
      "SELECT status FROM intelligence_knowledge_relations WHERE id=? AND owner_uid=?"
    ).bind(proposedBody.id, ownerUid).first();
    assert.equal(relation.status, "candidate", "failed audit must roll back confirmation");
    await db.prepare("DROP TRIGGER reject_relation_confirm_audit").run();

    const confirmed = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/relations/${proposedBody.id}`, {
      method: "PUT", headers, body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(confirmed.status, 200);
    relation = await db.prepare("SELECT status FROM intelligence_knowledge_relations WHERE id=?")
      .bind(proposedBody.id).first();
    assert.equal(relation.status, "confirmed");

    const foreignMutation = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/relations/${proposedBody.id}`, {
      method: "PUT",
      headers: { Authorization: "Bearer " + randomBytes(32).toString("base64url"), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    });
    assert.equal(foreignMutation.status, 401);

    const conflict = await create(sourceId, targetId, "Evidence phrase alpha", "Evidence phrase beta", "conflicts_with");
    assert.equal(conflict.status, 201);
    const conflictBody = await conflict.json();
    const dismiss = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/relations/${conflictBody.id}`, {
      method: "PUT", headers, body: JSON.stringify({ action: "dismiss" }),
    });
    assert.equal(dismiss.status, 200);
    assert.equal((await dismiss.json()).status, "dismissed");
    const invalidResolve = await mf.dispatchFetch(`http://localhost/intelligence/knowledge/relations/${conflictBody.id}`, {
      method: "PUT", headers, body: JSON.stringify({ action: "resolve", resolvedKnowledgeId: sourceId }),
    });
    assert.equal(invalidResolve.status, 409, "dismissed conflicts cannot be resolved");

    const auditRows = await db.prepare(
      "SELECT action, COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND target_type='knowledge_relation' GROUP BY action"
    ).bind(ownerUid).all();
    const auditCounts = Object.fromEntries((auditRows.results || []).map(row => [row.action, Number(row.count)]));
    assert.equal(auditCounts.knowledge_relation_proposed, 2);
    assert.equal(auditCounts.knowledge_relation_confirmed, 1);
    assert.equal(auditCounts.knowledge_relation_dismissed, 1);
    assert.equal(auditCounts.knowledge_relation_resolved || 0, 0);
    console.log("PASS: knowledge relations enforce same-owner evidence, state transitions, and atomic audit");
  } finally {
    await mf.dispose();
  }
}

await testKnowledgeRelationLifecycleAndAuditAtomicity();


async function testApprovalRevocationAuditAtomicityAndOwnerIsolation() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const foreignUid = "different-owner-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const taskId = "abababab-abab-4bab-8bab-abababababab";
  const approvalId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
  const foreignApprovalId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-approval-revoke-atomicity", tokenHash(token), ownerUid, now, now + 3600).run();
    await db.prepare("INSERT INTO intelligence_tasks(id,title,created_by) VALUES(?,?,?)")
      .bind(taskId, "Approval revocation atomicity", ownerUid).run();
    for (const [id, owner] of [[approvalId, ownerUid], [foreignApprovalId, foreignUid]]) {
      await db.prepare(`
        INSERT INTO intelligence_approval_ledger
          (id,task_id,owner_uid,owner_username,repository,branch,base_sha,scope_json,scope_sha256,status,issued_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,'issued',?,?)
      `).bind(id, taskId, owner, "mehranmsh", "Mehranmsh/mehranmsh.github.io",
        "main", "a".repeat(40), '{"paths":["docs/"]}', "scope-hash-" + owner, now, now + 1800).run();
    }
    const headers = { Authorization: "Bearer " + token };
    const foreignRevoke = await mf.dispatchFetch(`http://localhost/intelligence/approvals/${foreignApprovalId}`, {
      method: "DELETE", headers,
    });
    assert.equal(foreignRevoke.status, 409, "an owner must not revoke another owner's approval");
    const foreignRow = await db.prepare("SELECT status FROM intelligence_approval_ledger WHERE id=?")
      .bind(foreignApprovalId).first();
    assert.equal(foreignRow.status, "issued");

    await db.prepare(
      "CREATE TRIGGER reject_approval_revoke_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='approval_revoked' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();
    const failedRevoke = await mf.dispatchFetch(`http://localhost/intelligence/approvals/${approvalId}`, {
      method: "DELETE", headers,
    });
    assert.equal(failedRevoke.status, 503);
    let row = await db.prepare("SELECT status,revoked_at FROM intelligence_approval_ledger WHERE id=?")
      .bind(approvalId).first();
    assert.equal(row.status, "issued", "revocation must roll back when audit insertion fails");
    assert.equal(row.revoked_at, null);
    const noAudit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='approval_revoked' AND target_id=?"
    ).bind(ownerUid, approvalId).first();
    assert.equal(Number(noAudit.count), 0);
    await db.prepare("DROP TRIGGER reject_approval_revoke_audit").run();

    const revoked = await mf.dispatchFetch(`http://localhost/intelligence/approvals/${approvalId}`, {
      method: "DELETE", headers,
    });
    assert.equal(revoked.status, 200);
    row = await db.prepare("SELECT status,revoked_at FROM intelligence_approval_ledger WHERE id=?")
      .bind(approvalId).first();
    assert.equal(row.status, "revoked");
    assert.ok(row.revoked_at);
    const repeated = await mf.dispatchFetch(`http://localhost/intelligence/approvals/${approvalId}`, {
      method: "DELETE", headers,
    });
    assert.equal(repeated.status, 409, "a revoked approval cannot be revoked twice");
    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='approval_revoked' AND target_id=?"
    ).bind(ownerUid, approvalId).first();
    assert.equal(Number(audit.count), 1, "successful revocation must create exactly one audit record");

    const wrongOwnerTask = await mf.dispatchFetch("http://localhost/intelligence/approvals", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "dededede-dede-4ede-8ede-dededededede",
        repository: "Mehranmsh/mehranmsh.github.io", branch: "main",
        baseSha: "b".repeat(40), scope: { paths: ["docs/"] }, expiresInSeconds: 300,
      }),
    });
    assert.equal(wrongOwnerTask.status, 404, "approval issuance must require a task owned by the session owner");
    console.log("PASS: approval revocation is owner-scoped, one-time, and audit-atomic");
  } finally {
    await mf.dispose();
  }
}

await testApprovalRevocationAuditAtomicityAndOwnerIsolation();


async function testApprovalScopeRejectsBroadOrUnsafePaths() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const taskId = "edededed-eded-4ded-8ded-edededededed";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-approval-scope-validation", tokenHash(token), ownerUid, now, now + 3600).run();
    await db.prepare("INSERT INTO intelligence_tasks(id,title,created_by) VALUES(?,?,?)")
      .bind(taskId, "Approval scope validation", ownerUid).run();
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const request = scope => mf.dispatchFetch("http://localhost/intelligence/approvals", {
      method: "POST", headers,
      body: JSON.stringify({
        taskId,
        repository: "Mehranmsh/mehranmsh.github.io",
        branch: "main",
        baseSha: "c".repeat(40),
        scope,
        expiresInSeconds: 300,
      }),
    });
    const invalidScopes = [
      { paths: ["../secrets/"] },
      { paths: ["/absolute/path"] },
      { paths: ["src\\\\..\\\\secrets"] },
      { paths: ["src/*"] },
      { paths: [".git/config"] },
      { paths: ["src/%2e%2e/secrets"] },
      { paths: ["src/", "src/"] },
      { paths: [] },
      { paths: Array.from({ length: 21 }, (_, i) => `docs/${i}/`) },
      { paths: ["docs/"], extra: true },
      { paths: ["docs/", ""] },
    ];
    for (const scope of invalidScopes) {
      const response = await request(scope);
      assert.equal(response.status, 400, `unsafe scope must be rejected: ${JSON.stringify(scope)}`);
    }
    const valid = await request({ paths: ["zeta/", "docs/readme.md", "alpha/"] });
    assert.equal(valid.status, 201);
    const body = await valid.json();
    const row = await db.prepare("SELECT scope_json,scope_sha256,status FROM intelligence_approval_ledger WHERE id=? AND owner_uid=?")
      .bind(body.id, ownerUid).first();
    assert.equal(row.status, "issued");
    assert.equal(row.scope_json, JSON.stringify({ paths: ["alpha/", "docs/readme.md", "zeta/"] }),
      "scope paths must be canonicalized before hashing and storage");
    assert.equal(row.scope_sha256.length, 43, "stored scope digest must be SHA-256 base64url");
    console.log("PASS: approval scopes reject traversal, wildcards, duplicates, and unbounded path sets");
  } finally {
    await mf.dispose();
  }
}

await testApprovalScopeRejectsBroadOrUnsafePaths();


async function testApprovalBindingIsImmutableAcrossLifecycle() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const taskId = "fefefefe-fefe-4efe-8efe-fefefefefefe";
  const scopeJson = JSON.stringify({ paths: ["docs/readme.md", "src/"] });
  const scopeHash = createHash("sha256").update(scopeJson).digest("base64url");
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-approval-binding-immutable", tokenHash(token), ownerUid, now, now + 3600).run();
    await db.prepare("INSERT INTO intelligence_tasks(id,title,created_by) VALUES(?,?,?)")
      .bind(taskId, "Approval binding immutability", ownerUid).run();

    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const issued = await mf.dispatchFetch("http://localhost/intelligence/approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        taskId,
        repository: "Mehranmsh/mehranmsh.github.io",
        branch: "intelligence/staging-approval-binding-immutability-v1",
        baseSha: "d".repeat(40),
        scope: { paths: ["src/", "docs/readme.md"] },
        expiresInSeconds: 900,
      }),
    });
    assert.equal(issued.status, 201);
    const body = await issued.json();
    const originalRow = await db.prepare(
      "SELECT id,task_id,owner_uid,owner_username,repository,branch,base_sha,scope_json,scope_sha256,issued_at,expires_at,status FROM intelligence_approval_ledger WHERE id=?"
    ).bind(body.id).first();
    assert.equal(originalRow.task_id, taskId);
    assert.equal(originalRow.owner_uid, ownerUid);
    assert.equal(originalRow.owner_username, "mehranmsh");
    assert.equal(originalRow.repository, "Mehranmsh/mehranmsh.github.io");
    assert.equal(originalRow.branch, "intelligence/staging-approval-binding-immutability-v1");
    assert.equal(originalRow.base_sha, "d".repeat(40));
    assert.equal(originalRow.scope_json, scopeJson);
    assert.equal(originalRow.scope_sha256, scopeHash);

    const mutations = [
      ["id", "00000000-0000-4000-8000-000000000000"],
      ["task_id", "11111111-1111-4111-8111-111111111111"],
      ["owner_uid", "different-owner"],
      ["owner_username", "different-user"],
      ["repository", "Other/repository"],
      ["branch", "main"],
      ["base_sha", "e".repeat(40)],
      ["scope_json", '{"paths":["*"]}'],
      ["scope_sha256", "tampered-hash"],
      ["issued_at", now + 1],
      ["expires_at", now + 901],
    ];
    for (const [column, value] of mutations) {
      await assert.rejects(
        db.prepare(`UPDATE intelligence_approval_ledger SET ${column}=? WHERE id=?`)
          .bind(value, body.id).run(),
        undefined,
        `approval binding field ${column} must be immutable`,
      );
    }

    const unchanged = await db.prepare(
      "SELECT id,task_id,owner_uid,owner_username,repository,branch,base_sha,scope_json,scope_sha256,issued_at,expires_at,status FROM intelligence_approval_ledger WHERE id=?"
    ).bind(body.id).first();
    for (const key of Object.keys(originalRow)) assert.equal(unchanged[key], originalRow[key], `immutable field ${key} changed`);

    const revoked = await mf.dispatchFetch(`http://localhost/intelligence/approvals/${body.id}`, {
      method: "DELETE", headers: { Authorization: "Bearer " + token },
    });
    assert.equal(revoked.status, 200);
    await assert.rejects(
      db.prepare("UPDATE intelligence_approval_ledger SET revoked_at=? WHERE id=?")
        .bind(now + 2, body.id).run(),
      undefined,
      "terminal revocation metadata must be immutable",
    );
    const finalRow = await db.prepare(
      "SELECT status,revoked_at,repository,branch,base_sha,scope_json,scope_sha256 FROM intelligence_approval_ledger WHERE id=?"
    ).bind(body.id).first();
    assert.equal(finalRow.status, "revoked");
    assert.ok(finalRow.revoked_at);
    assert.equal(finalRow.repository, originalRow.repository);
    assert.equal(finalRow.branch, originalRow.branch);
    assert.equal(finalRow.base_sha, originalRow.base_sha);
    assert.equal(finalRow.scope_json, originalRow.scope_json);
    assert.equal(finalRow.scope_sha256, originalRow.scope_sha256);
    console.log("PASS: approval task, owner, repository, branch, base SHA, scope, and terminal metadata remain immutable");
  } finally {
    await mf.dispose();
  }
}

await testApprovalBindingIsImmutableAcrossLifecycle();


async function testCapabilityAssessmentRejectsClientApprovalClaimsAndNeverConsumes() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const foreignUid = "foreign-capability-owner";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const approvalId = "12121212-1212-4212-8212-121212121212";
  const foreignApprovalId = "34343434-3434-4434-8434-343434343434";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-capability-assessment-boundary", tokenHash(token), ownerUid, now, now + 3600).run();

    for (const [id, owner] of [[approvalId, ownerUid], [foreignApprovalId, foreignUid]]) {
      await db.prepare(
        "INSERT INTO intelligence_capability_approvals(id,owner_uid,capability,scope,status,issued_at,expires_at) VALUES(?,?,?,'owner_staging','issued',?,?)"
      ).bind(id, owner, "memory.delete", now, now + 1800).run();
    }

    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const forged = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        capability: "memory.delete",
        approval: {
          serverVerified: true,
          ownerId: ownerUid,
          capability: "memory.delete",
          scope: "owner_staging",
          status: "issued",
          expiresAt: now + 1800,
          revoked: false,
          revokedAt: null,
          consumedAt: null,
          consumedBy: null
        }
      }),
    });
    assert.equal(forged.status, 400, "client-supplied approval objects must be rejected");

    const foreign = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.delete", approvalId: foreignApprovalId }),
    });
    assert.equal(foreign.status, 200);
    const foreignBody = await foreign.json();
    assert.equal(foreignBody.assessment.decision, "assessment_only_approval_required",
      "an approval owned by another user must not be loaded or validated");
    assert.equal(foreignBody.operationPerformed, false);
    assert.equal(foreignBody.approvalConsumed, false);

    const valid = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.delete", approvalId }),
    });
    assert.equal(valid.status, 200);
    const validBody = await valid.json();
    assert.equal(validBody.assessment.decision, "assessment_only_approval_validated");
    assert.equal(validBody.assessment.executionEnabled, false);
    assert.equal(validBody.assessment.assessmentOnly, true);
    assert.equal(validBody.assessment.operationPerformed, false);
    assert.equal(validBody.operationPerformed, false);
    assert.equal(validBody.approvalConsumed, false);
    assert.equal(validBody.auditRecorded, true);

    const mismatch = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.create", approvalId }),
    });
    assert.equal(mismatch.status, 200);
    assert.equal((await mismatch.json()).assessment.decision, "assessment_only_denied",
      "approval for one capability must not authorize another");

    const rows = await db.prepare(
      "SELECT id,owner_uid,capability,status,revoked_at,consumed_at,consumed_by FROM intelligence_capability_approvals ORDER BY id"
    ).all();
    const ownerRow = rows.results.find(row => row.id === approvalId);
    const foreignRow = rows.results.find(row => row.id === foreignApprovalId);
    assert.equal(ownerRow.status, "issued");
    assert.equal(ownerRow.revoked_at, null);
    assert.equal(ownerRow.consumed_at, null);
    assert.equal(ownerRow.consumed_by, null);
    assert.equal(foreignRow.status, "issued");
    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='capability_assessed'"
    ).bind(ownerUid).first();
    assert.equal(Number(audit.count), 3, "every assessment request must be audited exactly once");
    console.log("PASS: capability assessment rejects client approval claims, isolates owners, matches capability, and never consumes or executes");
  } finally {
    await mf.dispose();
  }
}

await testCapabilityAssessmentRejectsClientApprovalClaimsAndNeverConsumes();


async function testCapabilityAssessmentFailureAndApprovalStateSafety() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const validId = "56565656-5656-4565-8565-565656565656";
  const expiredId = "67676767-6767-4676-8676-676767676767";
  const revokedId = "78787878-7878-4787-8787-787878787878";
  const unknownId = "89898989-8989-4898-8989-898989898989";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-capability-assessment-failure-safety", tokenHash(token), ownerUid, now, now + 3600).run();

    await db.prepare(
      "INSERT INTO intelligence_capability_approvals(id,owner_uid,capability,scope,status,issued_at,expires_at) VALUES(?,?,?,'owner_staging','issued',?,?)"
    ).bind(validId, ownerUid, "memory.delete", now, now + 600).run();
    await db.prepare(
      "INSERT INTO intelligence_capability_approvals(id,owner_uid,capability,scope,status,issued_at,expires_at) VALUES(?,?,?,'owner_staging','issued',?,?)"
    ).bind(expiredId, ownerUid, "memory.delete", now - 3600, now - 1).run();
    await db.prepare(
      "INSERT INTO intelligence_capability_approvals(id,owner_uid,capability,scope,status,issued_at,expires_at) VALUES(?,?,?,'owner_staging','issued',?,?)"
    ).bind(revokedId, ownerUid, "memory.delete", now, now + 600).run();
    await db.prepare(
      "UPDATE intelligence_capability_approvals SET status='revoked',revoked_at=? WHERE id=?"
    ).bind(now, revokedId).run();

    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    await db.prepare(
      "CREATE TRIGGER reject_capability_assessment_audit BEFORE INSERT ON intelligence_staging_audit WHEN NEW.action='capability_assessed' BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END"
    ).run();

    const auditFailure = await mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.delete", approvalId: validId }),
    });
    assert.equal(auditFailure.status, 503, "assessment must fail closed when its audit cannot be written");
    const unchangedAfterFailure = await db.prepare(
      "SELECT status,revoked_at,consumed_at,consumed_by FROM intelligence_capability_approvals WHERE id=?"
    ).bind(validId).first();
    assert.equal(unchangedAfterFailure.status, "issued");
    assert.equal(unchangedAfterFailure.revoked_at, null);
    assert.equal(unchangedAfterFailure.consumed_at, null);
    assert.equal(unchangedAfterFailure.consumed_by, null);
    const failedAuditCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='capability_assessed'"
    ).bind(ownerUid).first();
    assert.equal(Number(failedAuditCount.count), 0);
    await db.prepare("DROP TRIGGER reject_capability_assessment_audit").run();

    const evaluate = approvalId => mf.dispatchFetch("http://localhost/intelligence/capabilities/evaluate", {
      method: "POST",
      headers,
      body: JSON.stringify({ capability: "memory.delete", approvalId }),
    });
    const unknown = await evaluate(unknownId);
    assert.equal(unknown.status, 200);
    assert.equal((await unknown.json()).assessment.decision, "assessment_only_approval_required",
      "unknown approval IDs must not be treated as valid approvals");

    const expired = await evaluate(expiredId);
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).assessment.decision, "assessment_only_denied",
      "expired approval records must be denied");

    const revoked = await evaluate(revokedId);
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).assessment.decision, "assessment_only_denied",
      "revoked approval records must be denied");

    const finalValid = await db.prepare(
      "SELECT status,revoked_at,consumed_at,consumed_by FROM intelligence_capability_approvals WHERE id=?"
    ).bind(validId).first();
    assert.equal(finalValid.status, "issued");
    assert.equal(finalValid.revoked_at, null);
    assert.equal(finalValid.consumed_at, null);
    assert.equal(finalValid.consumed_by, null);

    const auditCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='capability_assessed'"
    ).bind(ownerUid).first();
    assert.equal(Number(auditCount.count), 3,
      "only the three successfully audited assessments must create audit records");
    console.log("PASS: capability assessment fails closed on audit outage and denies unknown, expired, and revoked approvals without changing approval state");
  } finally {
    await mf.dispose();
  }
}

await testCapabilityAssessmentFailureAndApprovalStateSafety();


async function testCapabilityApprovalRevocationOwnerAndExpiryBoundaries() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const foreignUid = "foreign-capability-owner";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const ownId = "90909090-9090-4090-8090-909090909090";
  const foreignId = "abababab-abab-4bab-8bab-abababababab";
  const expiredId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-capability-revocation-boundaries", tokenHash(token), ownerUid, now, now + 3600).run();

    for (const [id, owner, issuedAt, expiresAt] of [
      [ownId, ownerUid, now, now + 600],
      [foreignId, foreignUid, now, now + 600],
      [expiredId, ownerUid, now - 120, now - 1],
    ]) {
      await db.prepare(
        "INSERT INTO intelligence_capability_approvals(id,owner_uid,capability,scope,status,issued_at,expires_at) VALUES(?,?,?,'owner_staging','issued',?,?)"
      ).bind(id, owner, "memory.delete", issuedAt, expiresAt).run();
    }

    const headers = { Authorization: "Bearer " + token };
    const foreignRevoke = await mf.dispatchFetch(
      `http://localhost/intelligence/capability-approvals/${foreignId}`,
      { method: "DELETE", headers }
    );
    assert.equal(foreignRevoke.status, 409,
      "an owner must not revoke another owner's capability approval");
    const foreignRow = await db.prepare(
      "SELECT owner_uid,status,revoked_at FROM intelligence_capability_approvals WHERE id=?"
    ).bind(foreignId).first();
    assert.equal(foreignRow.owner_uid, foreignUid);
    assert.equal(foreignRow.status, "issued");
    assert.equal(foreignRow.revoked_at, null);

    const expiredRevoke = await mf.dispatchFetch(
      `http://localhost/intelligence/capability-approvals/${expiredId}`,
      { method: "DELETE", headers }
    );
    assert.equal(expiredRevoke.status, 409,
      "an expired approval must not be revocable as an active approval");
    const expiredRow = await db.prepare(
      "SELECT status,revoked_at FROM intelligence_capability_approvals WHERE id=?"
    ).bind(expiredId).first();
    assert.equal(expiredRow.status, "issued");
    assert.equal(expiredRow.revoked_at, null);

    const revoked = await mf.dispatchFetch(
      `http://localhost/intelligence/capability-approvals/${ownId}`,
      { method: "DELETE", headers }
    );
    assert.equal(revoked.status, 200);
    const repeated = await mf.dispatchFetch(
      `http://localhost/intelligence/capability-approvals/${ownId}`,
      { method: "DELETE", headers }
    );
    assert.equal(repeated.status, 409,
      "a terminal approval must not be revoked a second time");

    const ownRow = await db.prepare(
      "SELECT status,revoked_at FROM intelligence_capability_approvals WHERE id=?"
    ).bind(ownId).first();
    assert.equal(ownRow.status, "revoked");
    assert.ok(ownRow.revoked_at);

    const ownAudit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='capability_approval_revoked' AND target_id=?"
    ).bind(ownerUid, ownId).first();
    assert.equal(Number(ownAudit.count), 1,
      "one successful revocation must produce exactly one audit event");
    const foreignAudit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE target_id=? AND action='capability_approval_revoked'"
    ).bind(foreignId).first();
    assert.equal(Number(foreignAudit.count), 0,
      "a rejected cross-owner revocation must not create a revocation audit event");
    console.log("PASS: capability approval revocation is owner-bound, expiry-aware, one-time, and audit-exact");
  } finally {
    await mf.dispose();
  }
}

await testCapabilityApprovalRevocationOwnerAndExpiryBoundaries();


async function testSessionRateLimitWindowResetsAfterExpiry() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const rateKey = tokenHash(`${ownerUid}:session-read`);
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-rate-window-reset-01", tokenHash(token), ownerUid, now, now + 3600).run();
    await db.prepare(
      "INSERT INTO intelligence_staging_rate_limits(rate_key,window_started_at,request_count,blocked_until) VALUES(?,?,?,NULL)"
    ).bind(rateKey, now, 30).run();

    const headers = { Authorization: `Bearer ${token}` };
    const blocked = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(blocked.status, 429, "request 31 in an active window must be blocked");
    const blockedRow = await db.prepare(
      "SELECT request_count,window_started_at FROM intelligence_staging_rate_limits WHERE rate_key=?"
    ).bind(rateKey).first();
    assert.equal(Number(blockedRow.request_count), 31);

    await db.prepare(
      "UPDATE intelligence_staging_rate_limits SET window_started_at=?,request_count=31 WHERE rate_key=?"
    ).bind(now - 61, rateKey).run();

    const afterWindow = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(afterWindow.status, 200,
      "a request after the rate-limit window expires must be allowed");
    const resetRow = await db.prepare(
      "SELECT request_count,window_started_at FROM intelligence_staging_rate_limits WHERE rate_key=?"
    ).bind(rateKey).first();
    assert.equal(Number(resetRow.request_count), 1,
      "the expired window must reset the request counter atomically");
    assert.ok(Number(resetRow.window_started_at) >= now,
      "the new window must begin at the current request time");
    console.log("PASS: staging session rate limit blocks at the threshold and recovers after its window expires");
  } finally {
    await mf.dispose();
  }
}

await testSessionRateLimitWindowResetsAfterExpiry();



async function testPiSessionCreationRateLimitBoundaries() {
  const { mf, db } = await createWorker(migrations.length);
  const calls = [];
  const ownerUid = "staging-owner-test-uid";
  const env = {
    DB: db,
    MEHRAN_INTELLIGENCE_STAGING_OWNER_UID: ownerUid,
    PI_IDENTITY: { fetch: async (input, init = {}) => {
      calls.push({
        url: typeof input === "string" ? input : input.url,
        authorization: new Headers(init.headers || (typeof input === "string" ? undefined : input.headers)).get("Authorization"),
      });
      return new Response(JSON.stringify({ uid: ownerUid, username: "mehranmsh" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } },
  };
  const postSession = ip => stagingWorker.fetch(new Request("http://localhost/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ accessToken: "valid-pi-access-token-123" }),
  }), env);

  try {
    for (let index = 0; index < 30; index += 1) {
      const response = await postSession("192.0.2.10");
      assert.equal(response.status, 201, `IP authentication request ${index + 1} should be allowed: ${await response.clone().text()}`);
    }
    const ipBlocked = await postSession("192.0.2.10");
    assert.equal(ipBlocked.status, 429, "the 31st authentication attempt from one IP must be blocked");
    assert.equal(calls.length, 30, "IP rate limiting must run before the upstream Pi identity request");

    const afterIpLimit = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_sessions").first();
    assert.equal(Number(afterIpLimit.count), 30, "blocked IP attempt must not create a session");

    for (let index = 0; index < 30; index += 1) {
      const response = await postSession(`198.51.100.${index + 1}`);
      assert.equal(response.status, 429, "owner session-creation limit must block attempts after its threshold");
    }
    assert.equal(calls.length, 60, "owner-level limit is checked after successful Pi identity verification");

    const ownerBlocked = await postSession("203.0.113.77");
    assert.equal(ownerBlocked.status, 429, "the owner-level session creation limit must reject the next verified attempt");
    assert.equal(calls.length, 61, "the owner-level limit must be checked only after Pi identity verification");

    for (const call of calls) {
      assert.equal(call.url, "https://api.minepi.com/v2/me");
      assert.equal(call.authorization, "Bearer valid-pi-access-token-123");
    }
    const finalSessions = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_sessions").first();
    const auditCount = await db.prepare("SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE action='session_created'").first();
    assert.equal(Number(finalSessions.count), 30, "rate-limited attempts must never create extra sessions");
    assert.equal(Number(auditCount.count), 30, "rate-limited attempts must never emit extra session-created audit events");
    console.log("PASS: Pi session creation enforces per-IP and per-owner rate limits before creating sessions");
  } finally {
    await mf.dispose();
  }
}
await testPiSessionCreationRateLimitBoundaries();


async function testConcurrentSessionRevocationIsSingleAndAudited() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const headers = { Authorization: `Bearer ${token}` };
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind("session-revoke-race-0001", tokenHash(token), ownerUid, now, now + 3600).run();

    const responses = await Promise.all([
      mf.dispatchFetch("http://localhost/session", { method: "DELETE", headers }),
      mf.dispatchFetch("http://localhost/session", { method: "DELETE", headers }),
    ]);
    const statuses = responses.map(response => response.status);
    assert.equal(statuses.filter(status => status === 200).length, 1,
      "exactly one concurrent revocation may succeed");
    assert.equal(statuses.every(status => [200, 401, 409].includes(status)), true,
      "the competing revocation must be rejected without a server error");

    const session = await db.prepare(
      "SELECT revoked_at FROM intelligence_staging_sessions WHERE id=?"
    ).bind("session-revoke-race-0001").first();
    assert.ok(session?.revoked_at, "the session must end in the revoked state");

    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_revoked' AND target_id=?"
    ).bind(ownerUid, "session-revoke-race-0001").first();
    assert.equal(Number(audit.count), 1,
      "concurrent revocation must create exactly one matching audit event");

    const replay = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(replay.status, 401,
      "the bearer token must remain unusable after the concurrent revocation race");
    console.log("PASS: concurrent session revocation is single-winner, terminal, and audit-exact");
  } finally {
    await mf.dispose();
  }
}

await testConcurrentSessionRevocationIsSingleAndAudited();


async function testSessionExpiryBoundaryIsFailClosed() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const boundaryToken = randomBytes(32).toString("base64url");
  const expiredToken = randomBytes(32).toString("base64url");
  const activeToken = randomBytes(32).toString("base64url");
  try {
    for (const [id, token, expiresAt] of [
      ["session-expiry-equality-001", boundaryToken, now],
      ["session-expired-before-request-001", expiredToken, now - 1],
      ["session-active-after-boundary-001", activeToken, now + 3600],
    ]) {
      await db.prepare(
        "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
      ).bind(id, tokenHash(token), ownerUid, now - 60, expiresAt).run();
    }

    for (const token of [boundaryToken, expiredToken]) {
      const headers = { Authorization: `Bearer ${token}` };
      const read = await mf.dispatchFetch("http://localhost/session", { headers });
      assert.equal(read.status, 401,
        "a session expiring at or before the current second must be rejected");
      const revoke = await mf.dispatchFetch("http://localhost/session", {
        method: "DELETE", headers,
      });
      assert.equal(revoke.status, 401,
        "an expired session must not be revocable as an active session");
    }

    const active = await mf.dispatchFetch("http://localhost/session", {
      headers: { Authorization: `Bearer ${activeToken}` },
    });
    assert.equal(active.status, 200,
      "a session with a future expiry must remain valid");

    const rows = await db.prepare(
      "SELECT id,revoked_at FROM intelligence_staging_sessions WHERE id IN (?,?,?) ORDER BY id"
    ).bind(
      "session-expiry-equality-001",
      "session-expired-before-request-001",
      "session-active-after-boundary-001"
    ).all();
    assert.equal(rows.results.length, 3);
    assert.ok(rows.results.every(row => row.revoked_at === null),
      "expiry rejection must not mutate revocation state");

    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_revoked'"
    ).bind(ownerUid).first();
    assert.equal(Number(audit.count), 0,
      "rejected expired-session revocations must not create audit events");
    console.log("PASS: session expiry equality and past-expiry boundaries fail closed without mutation");
  } finally {
    await mf.dispose();
  }
}

await testSessionExpiryBoundaryIsFailClosed();


async function testUntrustedOriginCannotReadOrRevokeOwnerSession() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const sessionId = "session-origin-boundary-001";
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind(sessionId, tokenHash(token), ownerUid, now, now + 3600).run();

    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: "https://untrusted.example",
    };
    const read = await mf.dispatchFetch("http://localhost/session", { headers });
    assert.equal(read.status, 403,
      "untrusted origins must be rejected before authenticated session reads");

    const revoke = await mf.dispatchFetch("http://localhost/session", {
      method: "DELETE",
      headers,
    });
    assert.equal(revoke.status, 403,
      "untrusted origins must be rejected before session revocation");

    const session = await db.prepare(
      "SELECT revoked_at FROM intelligence_staging_sessions WHERE id=?"
    ).bind(sessionId).first();
    assert.equal(session.revoked_at, null,
      "an untrusted-origin request must not revoke the session");

    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_revoked' AND target_id=?"
    ).bind(ownerUid, sessionId).first();
    assert.equal(Number(audit.count), 0,
      "untrusted-origin requests must not create revocation audit events");

    const trustedRead = await mf.dispatchFetch("http://localhost/session", {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://mehranmsh.github.io",
      },
    });
    assert.equal(trustedRead.status, 200,
      "the configured application origin must retain access to the valid session");
    console.log("PASS: untrusted origins cannot read or revoke owner sessions or mutate audit state");
  } finally {
    await mf.dispose();
  }
}

await testUntrustedOriginCannotReadOrRevokeOwnerSession();

async function testSpoofedOriginsCannotReadOrRevokeOwnerSession() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const sessionId = "session-origin-spoofing-001";
  const untrustedOrigins = [
    "null",
    "https://mehranmsh.github.io.attacker.example",
    "http://mehranmsh.github.io",
    "https://attacker.example",
  ];
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind(sessionId, tokenHash(token), ownerUid, now, now + 3600).run();

    for (const origin of untrustedOrigins) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Origin: origin,
      };
      const read = await mf.dispatchFetch("http://localhost/session", { headers });
      assert.equal(read.status, 403,
        `spoofed or opaque Origin ${origin} must not read the owner session`);

      const revoke = await mf.dispatchFetch("http://localhost/session", {
        method: "DELETE",
        headers,
      });
      assert.equal(revoke.status, 403,
        `spoofed or opaque Origin ${origin} must not revoke the owner session`);
    }

    const session = await db.prepare(
      "SELECT revoked_at FROM intelligence_staging_sessions WHERE id=?"
    ).bind(sessionId).first();
    assert.equal(session.revoked_at, null,
      "rejected spoofed origins must leave the owner session active");

    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=? AND action='session_revoked' AND target_id=?"
    ).bind(ownerUid, sessionId).first();
    assert.equal(Number(audit.count), 0,
      "rejected spoofed origins must not create session-revocation audit events");

    const trustedRead = await mf.dispatchFetch("http://localhost/session", {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://mehranmsh.github.io",
      },
    });
    assert.equal(trustedRead.status, 200,
      "the exact configured application origin must remain allowed");
    console.log("PASS: opaque and lookalike origins cannot read or revoke owner sessions");
  } finally {
    await mf.dispose();
  }
}

await testSpoofedOriginsCannotReadOrRevokeOwnerSession();

async function testUntrustedOriginRejectedAcrossProtectedRouteMatrix() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const sessionId = "session-origin-route-matrix-001";
  const resourceId = "11111111-1111-4111-8111-111111111111";
  const routes = [
    ["GET", "/intelligence/capabilities"],
    ["GET", "/intelligence/capability-approvals"],
    ["POST", "/intelligence/capability-approvals"],
    ["DELETE", `/intelligence/capability-approvals/${resourceId}`],
    ["POST", "/intelligence/capabilities/evaluate"],
    ["GET", "/intelligence/tasks"],
    ["POST", "/intelligence/tasks"],
    ["GET", "/intelligence/memory"],
    ["POST", "/intelligence/memory"],
    ["GET", "/intelligence/memory/review-queue"],
    ["PUT", `/intelligence/memory/${resourceId}`],
    ["DELETE", `/intelligence/memory/${resourceId}`],
    ["GET", "/intelligence/knowledge/review-queue"],
    ["GET", "/intelligence/knowledge"],
    ["GET", "/intelligence/knowledge/evaluations"],
    ["POST", "/intelligence/knowledge"],
    ["GET", `/intelligence/knowledge/evaluations/${resourceId}`],
    ["PUT", `/intelligence/knowledge/${resourceId}`],
    ["GET", "/intelligence/knowledge/relations"],
    ["POST", "/intelligence/knowledge/relations"],
    ["PUT", `/intelligence/knowledge/relations/${resourceId}`],
    ["GET", "/intelligence/approvals"],
    ["POST", "/intelligence/approvals"],
    ["DELETE", `/intelligence/approvals/${resourceId}`],
  ];
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind(sessionId, tokenHash(token), ownerUid, now, now + 3600).run();

    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'intelligence_%' ORDER BY name"
    ).all();
    const snapshot = async () => {
      const rows = [];
      for (const { name } of tables.results || []) {
        const safeName = String(name).replace(/"/g, '""');
        const result = await db.prepare(`SELECT * FROM "${safeName}" ORDER BY rowid`).all();
        rows.push([name, result.results || []]);
      }
      return rows;
    };
    const before = await snapshot();

    for (const [method, path] of routes) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Origin: "https://mehranmsh.github.io.attacker.example",
      };
      const init = { method, headers };
      if (["POST", "PUT"].includes(method)) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify({});
      }
      const response = await mf.dispatchFetch(`http://localhost${path}`, init);
      assert.equal(response.status, 403,
        `untrusted Origin must be rejected for ${method} ${path}`);
    }

    const after = await snapshot();
    assert.deepEqual(after, before,
      "rejected cross-origin requests must not alter any Intelligence staging table row or value");

    const session = await db.prepare(
      "SELECT revoked_at FROM intelligence_staging_sessions WHERE id=?"
    ).bind(sessionId).first();
    assert.equal(session.revoked_at, null,
      "the owner session must remain active after the route matrix");

    console.log(`PASS: untrusted Origin rejected across ${routes.length} protected routes with zero staging-table mutations`);
  } finally {
    await mf.dispose();
  }
}

await testUntrustedOriginRejectedAcrossProtectedRouteMatrix();


async function testCorsPreflightOriginBoundaries() {
  const { mf } = await createWorker(migrations.length);
  const paths = [
    "/intelligence/capabilities",
    "/intelligence/capability-approvals",
    "/intelligence/capabilities/evaluate",
    "/intelligence/tasks",
    "/intelligence/memory",
    "/intelligence/memory/review-queue",
    "/intelligence/knowledge",
    "/intelligence/knowledge/review-queue",
    "/intelligence/knowledge/evaluations",
    "/intelligence/knowledge/relations",
    "/intelligence/approvals",
  ];
  try {
    for (const path of paths) {
      const rejected = await mf.dispatchFetch(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://mehranmsh.github.io.attacker.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      assert.equal(rejected.status, 403,
        `untrusted preflight Origin must be rejected for ${path}`);
      assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io",
        "preflight responses must never reflect an untrusted Origin");

      const originless = await mf.dispatchFetch(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      assert.equal(originless.status, 200,
        `preflight without Origin must preserve non-browser compatibility for ${path}`);
      assert.equal(originless.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io",
        "originless preflight must retain only the configured allow-origin value");

      const accepted = await mf.dispatchFetch(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://mehranmsh.github.io",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      assert.equal(accepted.status, 200,
        `the configured application Origin must pass preflight for ${path}`);
      assert.equal(accepted.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
      assert.equal(accepted.headers.get("Vary"), "Origin");
      assert.match(accepted.headers.get("Access-Control-Allow-Methods") || "", /POST/);
      assert.match(accepted.headers.get("Access-Control-Allow-Headers") || "", /Authorization/);
    }
    console.log(`PASS: CORS preflight rejects spoofed origins and accepts only the configured origin across ${paths.length} protected route families`);
  } finally {
    await mf.dispose();
  }
}

await testCorsPreflightOriginBoundaries();


async function testOriginSerializationEdgeCasesFailClosed() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const sessionId = "session-origin-serialization-001";
  const resourceId = "22222222-2222-4222-8222-222222222222";
  const routes = [
    ["GET", "/intelligence/capabilities"],
    ["POST", "/intelligence/tasks"],
    ["GET", "/intelligence/memory"],
    ["POST", "/intelligence/knowledge"],
    ["GET", "/intelligence/knowledge/relations"],
    ["POST", "/intelligence/approvals"],
    ["DELETE", `/intelligence/approvals/${resourceId}`],
  ];
  const origins = [
    "https://mehranmsh.github.io@attacker.example",
    "https://mehranmsh.github.io:444",
    "https://mehranmsh.github.io.",
    "http://mehranmsh.github.io:443",
    "https://MEHRANMSH.github.io",
    "https://mehranmsh.github.io.attacker.example:443",
    "file://mehranmsh.github.io",
    "https://mehranmsh.github.io/",
    "https://mehranmsh.github.io/path",
    "https://mehranmsh.github.io?query=1",
    "https://mehranmsh.github.io#fragment",
    "https://mehranmsh.github.io, https://attacker.example",
  ];
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind(sessionId, tokenHash(token), ownerUid, now, now + 3600).run();

    for (const origin of origins) {
      for (const [method, path] of routes) {
        const headers = {
          Authorization: `Bearer ${token}`,
          Origin: origin,
        };
        const init = { method, headers };
        if (["POST", "PUT"].includes(method)) {
          headers["Content-Type"] = "application/json";
          init.body = JSON.stringify({});
        }
        const response = await mf.dispatchFetch(`http://localhost${path}`, init);
        assert.equal(response.status, 403,
          `non-exact Origin ${origin} must be rejected for ${method} ${path}`);
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io",
          "the response must retain only the configured allow-origin value");
      }

      const preflight = await mf.dispatchFetch("http://localhost/intelligence/tasks", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      assert.equal(preflight.status, 403,
        `non-exact Origin ${origin} must fail CORS preflight`);
    }

    const session = await db.prepare(
      "SELECT revoked_at FROM intelligence_staging_sessions WHERE id=?"
    ).bind(sessionId).first();
    assert.equal(session.revoked_at, null,
      "rejected Origin variants must leave the owner session active");
    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM intelligence_staging_audit WHERE owner_uid=?"
    ).bind(ownerUid).first();
    assert.equal(Number(audit.count), 0,
      "rejected Origin variants must not create audit records");

    const trusted = await mf.dispatchFetch("http://localhost/intelligence/capabilities", {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://mehranmsh.github.io",
      },
    });
    assert.equal(trusted.status, 200,
      "the exact configured Origin must continue to work");
    console.log(`PASS: ${origins.length} Origin serialization edge cases rejected across ${routes.length} protected routes without state mutation`);
  } finally {
    await mf.dispose();
  }
}

await testOriginSerializationEdgeCasesFailClosed();


async function testMissingOriginDoesNotBypassAuthentication() {
  const { mf, db } = await createWorker(migrations.length);
  const ownerUid = "staging-owner-test-uid";
  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(32).toString("base64url");
  const sessionId = "session-origin-absent-auth-001";
  const resourceId = "33333333-3333-4333-8333-333333333333";
  const protectedRequests = [
    ["GET", "/session"],
    ["GET", "/intelligence/capabilities"],
    ["GET", "/intelligence/capability-approvals"],
    ["POST", "/intelligence/capability-approvals"],
    ["POST", "/intelligence/capabilities/evaluate"],
    ["GET", "/intelligence/tasks"],
    ["POST", "/intelligence/tasks"],
    ["GET", "/intelligence/memory"],
    ["POST", "/intelligence/memory"],
    ["GET", "/intelligence/memory/review-queue"],
    ["PUT", `/intelligence/memory/${resourceId}`],
    ["DELETE", `/intelligence/memory/${resourceId}`],
    ["GET", "/intelligence/knowledge"],
    ["POST", "/intelligence/knowledge"],
    ["GET", "/intelligence/knowledge/relations"],
    ["POST", "/intelligence/knowledge/relations"],
    ["GET", "/intelligence/approvals"],
    ["POST", "/intelligence/approvals"],
    ["DELETE", `/intelligence/approvals/${resourceId}`],
  ];
  try {
    await db.prepare(
      "INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)"
    ).bind(sessionId, tokenHash(token), ownerUid, now, now + 3600).run();

    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'intelligence_%' ORDER BY name"
    ).all();
    const snapshot = async () => {
      const rows = [];
      for (const { name } of tables.results || []) {
        const safeName = String(name).replace(/"/g, '""');
        const result = await db.prepare(`SELECT * FROM "${safeName}" ORDER BY rowid`).all();
        rows.push([name, result.results || []]);
      }
      return rows;
    };
    const before = await snapshot();

    for (const [method, path] of protectedRequests) {
      const headers = {};
      const init = { method, headers };
      if (["POST", "PUT"].includes(method)) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify({});
      }
      const response = await mf.dispatchFetch(`http://localhost${path}`, init);
      assert.equal(response.status, 401,
        `missing Origin must not bypass authentication for ${method} ${path}`);
    }

    const after = await snapshot();
    assert.deepEqual(after, before,
      "unauthenticated requests without Origin must not mutate any Intelligence staging table");

    const authenticated = await mf.dispatchFetch("http://localhost/session", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authenticated.status, 200,
      "a valid bearer session from a non-browser client without Origin must remain usable");

    const session = await db.prepare(
      "SELECT revoked_at FROM intelligence_staging_sessions WHERE id=?"
    ).bind(sessionId).first();
    assert.equal(session.revoked_at, null,
      "missing-Origin authentication checks must not revoke the session");
    console.log(`PASS: missing-Origin requests cannot bypass auth across ${protectedRequests.length} protected routes; valid bearer access remains available`);
  } finally {
    await mf.dispose();
  }
}

await testMissingOriginDoesNotBypassAuthentication();


async function testSecurityHeadersAcrossResponseMatrix() {
  const { mf } = await createWorker(migrations.length);
  const cases = [
    ["GET", "/health", undefined, 200],
    ["GET", "/intelligence/capabilities", undefined, 401],
    ["POST", "/intelligence/tasks", JSON.stringify({}), 401],
    ["GET", "/intelligence/memory", undefined, 401],
    ["POST", "/intelligence/knowledge", JSON.stringify({}), 401],
    ["GET", "/not-a-real-route", undefined, 401],
  ];
  const expected = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "Access-Control-Allow-Origin": "https://mehranmsh.github.io",
  };
  try {
    for (const [method, path, body, status] of cases) {
      const headers = { Origin: "https://mehranmsh.github.io" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      assert.equal(response.status, status,
        `expected ${status} for ${method} ${path}`);
      for (const [name, value] of Object.entries(expected)) {
        assert.equal(response.headers.get(name), value,
          `${name} must be present and consistent for ${method} ${path} status ${status}`);
      }
      assert.match(response.headers.get("Content-Type") || "", /^application\/json\s*;/i,
        `responses must declare JSON content type for ${method} ${path}`);
    }
    console.log(`PASS: security and cache headers remain consistent across ${cases.length} success, authentication, and error response cases`);
  } finally {
    await mf.dispose();
  }
}

await testSecurityHeadersAcrossResponseMatrix();


async function testForbiddenOriginResponsesKeepSecurityHeaders() {
  const { mf } = await createWorker(migrations.length);
  const cases = [
    ["GET", "/health", undefined, "https://mehranmsh.github.io.attacker.example"],
    ["GET", "/intelligence/capabilities", undefined, "https://attacker.example"],
    ["POST", "/intelligence/tasks", JSON.stringify({}), "null"],
    ["OPTIONS", "/intelligence/knowledge", undefined, "http://mehranmsh.github.io"],
  ];
  const expected = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "Access-Control-Allow-Origin": "https://mehranmsh.github.io",
  };
  try {
    for (const [method, path, body, origin] of cases) {
      const headers = { Origin: origin };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        method, headers, ...(body !== undefined ? { body } : {}),
      });
      assert.equal(response.status, 403, `untrusted Origin must be rejected for ${method} ${path}`);
      for (const [name, value] of Object.entries(expected)) {
        assert.equal(response.headers.get(name), value,
          `${name} must remain secure on forbidden-Origin response for ${method} ${path}`);
      }
      assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), origin,
        "an untrusted Origin must never be reflected in CORS response headers");
      assert.match(response.headers.get("Content-Type") || "", /^application\/json\s*;/i,
        "forbidden-Origin responses must remain JSON");
    }
    console.log(`PASS: security headers remain intact and attacker Origins are never reflected across ${cases.length} forbidden-Origin responses`);
  } finally {
    await mf.dispose();
  }
}

await testForbiddenOriginResponsesKeepSecurityHeaders();


async function testCorsPreflightRequestHeaderAllowlist() {
  const { mf } = await createWorker(migrations.length);
  const paths = [
    "/intelligence/capabilities",
    "/intelligence/capability-approvals",
    "/intelligence/capabilities/evaluate",
    "/intelligence/tasks",
    "/intelligence/memory",
    "/intelligence/memory/review-queue",
    "/intelligence/knowledge",
    "/intelligence/knowledge/review-queue",
    "/intelligence/knowledge/evaluations",
    "/intelligence/knowledge/relations",
    "/intelligence/approvals",
  ];
  try {
    for (const path of paths) {
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://mehranmsh.github.io",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type,x-untrusted-header",
        },
      });
      assert.equal(response.status, 200,
        `trusted preflight must succeed for ${path}`);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
      assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type, Authorization",
        "preflight must advertise only the explicitly configured request-header allowlist");
      assert.doesNotMatch(response.headers.get("Access-Control-Allow-Headers") || "", /x-untrusted-header/i,
        "unrequested custom headers must never be reflected into the CORS allowlist");
      assert.equal(response.headers.get("Vary"), "Origin");
    }
    console.log(`PASS: CORS preflight advertises only the configured request-header allowlist across ${paths.length} protected route families`);
  } finally {
    await mf.dispose();
  }
}

await testCorsPreflightRequestHeaderAllowlist();
