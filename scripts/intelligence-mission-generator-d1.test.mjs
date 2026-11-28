import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
function sqlAfter(marker) {
  const i = source.indexOf(marker);
  assert.notEqual(i, -1, "Missing Worker SQL: " + marker);
  const tick = String.fromCharCode(96);
  const a = source.lastIndexOf(tick, i), b = source.indexOf(tick, i);
  assert.ok(a >= 0 && b > a, "Missing SQL template: " + marker);
  return source.slice(a + 1, b);
}
const schemaLock = sqlAfter("CREATE TABLE IF NOT EXISTS intelligence_mission_generator_lock(");
const schemaPackages = sqlAfter("CREATE TABLE IF NOT EXISTS intelligence_work_packages(");
const schemaTasks = `CREATE TABLE intelligence_tasks (
  id TEXT PRIMARY KEY,
  work_package_id TEXT NOT NULL,
  status TEXT NOT NULL,
  action_type TEXT NOT NULL
);`;
const trigger = sqlAfter("CREATE TRIGGER IF NOT EXISTS intelligence_mission_generator_lock_guard");
const reserveSql = sqlAfter("INSERT INTO intelligence_mission_generator_lock(id,cycle_key,package_id,status,expires_at,updated_at)");
const release = "UPDATE intelligence_mission_generator_lock SET status='released',updated_at=CURRENT_TIMESTAMP WHERE id=1 AND package_id=? AND status='reserved'";

test("D1 mission-generator reservation SQL and insert guard pass SQLite integration checks", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaLock);
    db.exec(schemaPackages);
    db.exec(schemaTasks);
    db.exec(trigger);
    const reserveSlot = db.prepare(reserveSql);
    const addPackage = db.prepare("INSERT INTO intelligence_work_packages(id,idempotency_key,title,created_by) VALUES(?,?,?,?)");
    const reserve = (cycle, id, ignoreAttentionRequired = false) =>
      Number(reserveSlot.run(cycle, id, ignoreAttentionRequired ? 1 : 0, ignoreAttentionRequired ? 1 : 0,
        ignoreAttentionRequired ? 1 : 0, ignoreAttentionRequired ? 1 : 0).changes);
    const add = (id, key) => addPackage.run(id, key, "test", "test");

    assert.equal(reserve("20261125T0615", "pkg-a"), 1);
    assert.equal(reserve("20261125T0615", "pkg-b"), 0);
    assert.throws(() => add("pkg-b", "key-b"), /reservation is active/i);
    add("pkg-a", "key-a");
    db.prepare(release).run("pkg-a");
    assert.equal(db.prepare("SELECT status FROM intelligence_mission_generator_lock").get().status, "released");
    assert.equal(reserve("20261125T0630", "pkg-c"), 0);
    db.prepare("UPDATE intelligence_work_packages SET status='completed' WHERE id='pkg-a'").run();
    assert.equal(reserve("20261125T0630", "pkg-c"), 1);
    db.prepare("UPDATE intelligence_mission_generator_lock SET expires_at=datetime('now','-1 minute') WHERE id=1").run();
    assert.equal(reserve("20261125T0645", "pkg-d"), 1);
    assert.throws(() => add("pkg-e", "key-e"), /reservation is active/i);
    db.prepare(release).run("pkg-d");
    add("pkg-f", "key-f");
    db.prepare("UPDATE intelligence_work_packages SET status='attention_required' WHERE id='pkg-f'").run();
    assert.equal(reserve("20261125T0700", "pkg-g"), 0,
      "scheduled/default generation must remain blocked by attention-required packages");
    assert.equal(reserve("20261125T0700", "pkg-g", true), 1,
      "an explicit manual bootstrap may bypass only attention-required packages");
    db.prepare("UPDATE intelligence_mission_generator_lock SET status='released' WHERE id=1").run();
    add("pkg-h", "key-h");
    db.prepare("INSERT INTO intelligence_tasks(id,work_package_id,status,action_type) VALUES('held-ai','pkg-h','queued','inspect_repository')").run();
    assert.equal(reserve("20261125T0715", "pkg-i", true), 1,
      "owner bootstrap may pass a package whose only outstanding task is deferred AI");
    db.prepare("UPDATE intelligence_mission_generator_lock SET status='released' WHERE id=1").run();
    db.prepare("INSERT INTO intelligence_tasks(id,work_package_id,status,action_type) VALUES('runnable','pkg-h','queued','repository_quality_check')").run();
    assert.equal(reserve("20261125T0730", "pkg-j", true), 0,
      "a package with any deterministic task must continue blocking bootstrap");

  } finally {
    db.close();
  }
});
