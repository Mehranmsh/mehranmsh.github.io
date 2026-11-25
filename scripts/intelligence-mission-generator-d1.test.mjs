import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
const trigger = sqlAfter("CREATE TRIGGER IF NOT EXISTS intelligence_mission_generator_lock_guard");
const reserve = sqlAfter("INSERT INTO intelligence_mission_generator_lock(id,cycle_key,package_id,status,expires_at,updated_at)");
const release = "UPDATE intelligence_mission_generator_lock SET status='released',updated_at=CURRENT_TIMESTAMP WHERE id=1 AND package_id=? AND status='reserved'";

const py = [
"import json, sqlite3, sys",
"s=json.loads(sys.stdin.read()); db=sqlite3.connect(':memory:')",
"db.execute(s['schemaLock']); db.execute(s['schemaPackages']); db.execute(s['trigger'])",
"def reserve(c,p): return db.execute(s['reserve'],(c,p)).rowcount",
"def add(p,k): db.execute('INSERT INTO intelligence_work_packages(id,idempotency_key,title,created_by) VALUES(?,?,?,?)',(p,k,'test','test'))",
"assert reserve('20261125T0615','pkg-a') == 1",
"assert reserve('20261125T0615','pkg-b') == 0",
"try: add('pkg-b','key-b'); raise AssertionError('competing insert passed')",
"except sqlite3.IntegrityError as e: assert 'reservation is active' in str(e)",
"add('pkg-a','key-a'); db.execute(s['release'],('pkg-a',))",
"assert db.execute('SELECT status FROM intelligence_mission_generator_lock').fetchone()[0] == 'released'",
"assert reserve('20261125T0630','pkg-c') == 0",
"db.execute(\"UPDATE intelligence_work_packages SET status='completed' WHERE id='pkg-a'\")",
"assert reserve('20261125T0630','pkg-c') == 1",
"db.execute(\"UPDATE intelligence_mission_generator_lock SET expires_at=datetime('now','-1 minute') WHERE id=1\")",
"assert reserve('20261125T0645','pkg-d') == 1",
"try: add('pkg-e','key-e'); raise AssertionError('insert passed during live reservation')",
"except sqlite3.IntegrityError as e: assert 'reservation is active' in str(e)",
"print(json.dumps({'ok':True,'checks':8}))"
].join("\n");

test("D1 mission-generator reservation SQL and insert guard pass SQLite integration checks", () => {
  const result = spawnSync("python3", ["-c", py], {
    input: JSON.stringify({ schemaLock, schemaPackages, trigger, reserve, release }),
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(result.error, undefined, String(result.error || ""));
  assert.equal(result.status, 0, result.stderr || result.stdout || "SQLite integration failed");
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: true, checks: 8 });
});
