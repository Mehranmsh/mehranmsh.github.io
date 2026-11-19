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
    d1Databases: { DB: `intelligence-health-runtime-${migrationCount}` },
  });
  const db = await mf.getD1Database("DB");
  await applyMigrations(db, migrations.slice(0, migrationCount));
  return { mf, db };
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

await testCompleteSchemaReportsHealthy();
await testMissingCapabilityLedgerFailsClosed();
