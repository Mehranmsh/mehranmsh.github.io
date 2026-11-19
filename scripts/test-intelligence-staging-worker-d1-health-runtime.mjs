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
\nasync function testCompleteSchemaReportsHealthy() {
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

await testCompleteSchemaReportsHealthy();
await testMissingCapabilityLedgerFailsClosed();
await testSessionVerificationAndRevocation();\nawait testSessionReadRateLimit();
