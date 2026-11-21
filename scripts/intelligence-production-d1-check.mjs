import process from "node:process";
import { appendFileSync, readFileSync } from "node:fs";

let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID || "2ee71f12-042b-4dba-8bf0-a0b577ace519";
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !token) {
  throw new Error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN GitHub Actions secret.");
}

async function verifyApiToken() {
  const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true || payload.result?.status !== "active") {
    throw new Error("Cloudflare API token verification failed or token is not active. No D1 query was sent.");
  }
  console.log("PASS: Cloudflare API token is active.");
}

async function query(sql, accountOverride = accountId) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountOverride}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
    },
  );
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    const errorCodes = (payload.errors || []).map((item) => Number(item.code));
    if (errorCodes.includes(7403)) {
      throw new Error("Cloudflare rejected the configured account/token for this D1 database (7403). Confirm CLOUDFLARE_ACCOUNT_ID is the account that owns the database and the API token has D1 Read or D1 Write permission on that same account. No migration was executed.");
    }
    throw new Error(`Cloudflare D1 query failed: ${JSON.stringify(payload.errors || payload)}`);
  }
  const first = payload.result?.[0];
  if (!first?.success) throw new Error(`D1 statement failed: ${JSON.stringify(first?.meta || first)}`);
  return first.results || [];
}

async function selectAuthorizedAccount() {
  const candidates = [
    ["secret", process.env.CLOUDFLARE_ACCOUNT_ID_SECRET],
    ["variable", process.env.CLOUDFLARE_ACCOUNT_ID_VARIABLE],
    ["selected", accountId],
  ].filter(([, value]) => Boolean(value));
  const unique = [];
  const seen = new Set();
  for (const [source, value] of candidates) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push({ source, value });
    }
  }

  let accountVerified = false;
  const accessible = [];
  for (const candidate of unique) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${candidate.value}/tokens/verify`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      );
      const payload = await response.json();
      if (response.ok && payload.success === true && payload.result?.status === "active") {
        accountVerified = true;
      }
    } catch {
      // The D1 query below remains the authoritative permission check.
    }

    try {
      await query("SELECT 1 AS preflight_account_probe", candidate.value);
      accessible.push(candidate);
    } catch {
      // Try the next configured account ID without exposing either value.
    }
  }

  if (!accessible.length) {
    if (accountVerified) {
      throw new Error("The token is active for a configured account, but D1 access is denied. Grant D1 Read for preflight and D1 Write for later migrations on that same account, and confirm the database ID belongs to it. No migration was executed.");
    }
    throw new Error("Neither the configured Account ID secret nor variable is authorized for this token and D1 database. The Account ID/token pair does not match the database account. No migration was executed.");
  }

  const chosen = accessible.find((item) => item.value === accountId) || accessible[0];
  accountId = chosen.value;
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_ACCOUNT_ID=${accountId}\\n`);
  }
  console.log(`PASS: D1 access verified using the repository Account ID ${chosen.source}.`);
}

async function objects() {
  return query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
}

async function columns(table) {
  return query(`PRAGMA table_info('${table}')`);
}

function requireNames(rows, names, label) {
  const found = new Set(rows.map((row) => row.name));
  const missing = names.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`${label} missing: ${missing.join(", ")}`);
}

function requireAbsent(rows, names, label) {
  const found = new Set(rows.map((row) => row.name));
  const present = names.filter((name) => found.has(name));
  if (present.length) throw new Error(`${label} already exist; refusing to continue: ${present.join(", ")}`);
}

function requireExactColumnNames(rows, expected, label) {
  const actual = rows.map((row) => row.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} columns differ from the reviewed schema. Found: ${actual.join(",")}`);
  }
}

function requireExactColumnDefinitions(rows, expected, label) {
  const actual = rows.map((row) => [
    row.name, String(row.type || "").toUpperCase(), Number(row.notnull),
    row.dflt_value === null ? null : String(row.dflt_value), Number(row.pk),
  ]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} column definitions differ from the reviewed schema: ${JSON.stringify(actual)}`);
  }
}

function normalizeSql(sql) {
  return String(sql || "").replace(/\bIF\s+NOT\s+EXISTS\b/i, "")
    .replace(/\s+/g, " ").trim().replace(/;+$/, "").toLowerCase();
}

function extractMigrationObjectSql(source, type, name) {
  const startPattern = new RegExp(
    "^CREATE\\s+(?:UNIQUE\\s+)?"+type+"\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"+name+"\\b",
    "im",
  );
  const match = startPattern.exec(source);
  if (!match) throw new Error("Migration source is missing "+type.toLowerCase()+" "+name+".");
  const nextPattern = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\b/gim;
  nextPattern.lastIndex = match.index + match[0].length;
  const next = nextPattern.exec(source);
  return source.slice(match.index, next ? next.index : source.length).trim();
}

function requireExactMigrationSql(rows, source, type, names, label) {
  const byName = new Map(rows.map((row) => [row.name, row.sql]));
  for (const name of names) {
    const actual = byName.get(name);
    const expected = extractMigrationObjectSql(source, type, name);
    if (!actual || normalizeSql(actual) !== normalizeSql(expected)) {
      throw new Error(label+" definition differs from the reviewed migration source: "+name);
    }
  }
}

function requireExactForeignKeys(rows, expected, label) {
  const signature = (items) => items.map((row) =>
    [row.table, row.from, row.to, String(row.on_update || "").toUpperCase(), String(row.on_delete || "").toUpperCase()].join("|")
  ).sort();
  if (JSON.stringify(signature(rows)) !== JSON.stringify(signature(expected))) {
    throw new Error(label+" foreign-key relationships differ from the reviewed schema: "+JSON.stringify(rows));
  }
}

async function foreignKeys(table) {
  return query("PRAGMA foreign_key_list('" + table + "')");
}

const migration0001Sql = readFileSync(new URL("../migrations/production/0001_intelligence_owner_projects.sql", import.meta.url), "utf8");
const migration0002Sql = readFileSync(new URL("../migrations/production/0002_intelligence_knowledge_memory.sql", import.meta.url), "utf8");

const taskBaseColumns = [
  "id","title","description","assigned_to","priority","status",
  "requires_approval","result_text","created_by","action_type",
  "action_payload","created_at","updated_at","agent_claimed_at",
];
const taskMigratedColumns = [...taskBaseColumns, "owner_uid", "project_id"];
const projectColumns = ["id","owner_uid","name","description","module_key","status","created_at","updated_at","archived_at"];
const dependencyColumns = ["id","owner_uid","task_id","depends_on_task_id","dependency_type","created_at"];
const knowledgeColumns = [
  "id","owner_uid","category","title","content","importance","source_type","source_ref",
  "source_title","source_excerpt","observed_at","recorded_confidence","verification_status",
  "reviewed_by","reviewed_at","created_at","updated_at","archived_at",
];
const memoryColumns = ["id","owner_uid","memory_type","category","content","importance","created_at","updated_at","archived_at"];

const taskMigratedDefinitions = [
  ["id","TEXT",0,null,1],["title","TEXT",1,null,0],["description","TEXT",1,"''",0],
  ["assigned_to","TEXT",1,"'mehran_intelligence'",0],["priority","TEXT",1,"'normal'",0],
  ["status","TEXT",1,"'queued'",0],["requires_approval","INTEGER",1,"0",0],
  ["result_text","TEXT",1,"''",0],["created_by","TEXT",1,null,0],["action_type","TEXT",1,"''",0],
  ["action_payload","TEXT",1,"'{}'",0],["created_at","TEXT",1,"CURRENT_TIMESTAMP",0],
  ["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0],["agent_claimed_at","TEXT",0,null,0],
  ["owner_uid","TEXT",0,null,0],["project_id","TEXT",0,null,0],
];
const projectDefinitions = [
  ["id","TEXT",0,null,1],["owner_uid","TEXT",1,null,0],["name","TEXT",1,null,0],
  ["description","TEXT",1,"''",0],["module_key","TEXT",1,null,0],["status","TEXT",1,"'planned'",0],
  ["created_at","TEXT",1,"CURRENT_TIMESTAMP",0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0],
  ["archived_at","TEXT",0,null,0],
];
const dependencyDefinitions = [
  ["id","TEXT",0,null,1],["owner_uid","TEXT",1,null,0],["task_id","TEXT",1,null,0],
  ["depends_on_task_id","TEXT",1,null,0],["dependency_type","TEXT",1,"'blocks'",0],
  ["created_at","TEXT",1,"CURRENT_TIMESTAMP",0],
];
const knowledgeDefinitions = [
  ["id","TEXT",0,null,1],["owner_uid","TEXT",1,null,0],["category","TEXT",1,"'company'",0],
  ["title","TEXT",1,null,0],["content","TEXT",1,null,0],["importance","TEXT",1,"'normal'",0],
  ["source_type","TEXT",1,"'owner_input'",0],["source_ref","TEXT",1,"''",0],
  ["source_title","TEXT",1,"''",0],["source_excerpt","TEXT",1,"''",0],
  ["observed_at","TEXT",0,null,0],["recorded_confidence","INTEGER",0,null,0],
  ["verification_status","TEXT",1,"'unreviewed'",0],["reviewed_by","TEXT",0,null,0],
  ["reviewed_at","TEXT",0,null,0],["created_at","TEXT",1,"CURRENT_TIMESTAMP",0],
  ["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0],["archived_at","TEXT",0,null,0],
];
const memoryDefinitions = [
  ["id","TEXT",0,null,1],["owner_uid","TEXT",1,null,0],["memory_type","TEXT",1,"'fact'",0],
  ["category","TEXT",1,"'general'",0],["content","TEXT",1,null,0],["importance","TEXT",1,"'normal'",0],
  ["created_at","TEXT",1,"CURRENT_TIMESTAMP",0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0],
  ["archived_at","TEXT",0,null,0],
];

const projectTriggers = [
  "trg_intelligence_task_project_owner_insert",
  "trg_intelligence_task_project_owner_update",
  "trg_intelligence_project_owner_immutable_with_tasks",
  "trg_intelligence_project_complete_guard",
  "trg_intelligence_task_completed_project_guard_insert",
  "trg_intelligence_task_completed_project_guard_update",
  "trg_intelligence_task_dependency_guard_insert",
  "trg_intelligence_task_dependency_guard_update",
  "trg_intelligence_task_completion_dependency_guard",
  "trg_intelligence_task_dependency_completed_guard_insert",
  "trg_intelligence_task_dependency_completed_guard_update",
  "trg_intelligence_task_reopen_dependency_guard",
  "trg_intelligence_task_dependency_consistency_update",
];
const projectIndexes = [
  "idx_intelligence_projects_owner_status",
  "idx_intelligence_projects_owner_module",
  "idx_intelligence_tasks_owner_project_status",
  "idx_intelligence_tasks_project_legacy",
  "idx_intelligence_task_dependencies_task",
  "idx_intelligence_task_dependencies_prerequisite",
];
const knowledgeTriggers = [
  "trg_intelligence_knowledge_owner_immutable",
  "trg_intelligence_memory_owner_immutable",
];

const mode = process.argv[2];
if (!["preflight-0001","preflight-0002","verify-0001","verify-0002"].includes(mode)) {
  throw new Error("Expected preflight-0001, preflight-0002, verify-0001, or verify-0002.");
}

await verifyApiToken();
await selectAuthorizedAccount();
const all = await objects();
const tables = all.filter((row) => row.type === "table");
const indexes = all.filter((row) => row.type === "index");
const triggers = all.filter((row) => row.type === "trigger");

if (mode === "preflight-0001") {
  requireNames(tables, ["intelligence_tasks","intelligence_scheduler_runs","admin_sessions","admin_audit_log"], "Production baseline tables");
  const taskCols = (await columns("intelligence_tasks")).map((row) => row.name);
  if (JSON.stringify(taskCols) !== JSON.stringify(taskBaseColumns)) {
    throw new Error(`Production intelligence_tasks schema differs from reviewed baseline. Found: ${taskCols.join(",")}`);
  }
  requireNames(indexes, ["idx_intelligence_tasks_queue","idx_intelligence_scheduler_runs_started"], "Existing production indexes");
  requireAbsent(tables, ["intelligence_projects","intelligence_task_dependencies"], "Migration 0001 tables");
  requireAbsent(indexes, [
    "idx_intelligence_projects_owner_status","idx_intelligence_projects_owner_module",
    "idx_intelligence_tasks_owner_project_status","idx_intelligence_tasks_project_legacy",
    "idx_intelligence_task_dependencies_task","idx_intelligence_task_dependencies_prerequisite",
  ], "Migration 0001 indexes");
  if (triggers.some((row) => row.name.startsWith("trg_intelligence_"))) {
    throw new Error("Existing trg_intelligence_* triggers detected; manual schema review required.");
  }
  console.log("PASS: production baseline matches reviewed schema; migration 0001 target objects are absent.");
}

if (mode === "preflight-0002") {
  requireNames(tables, ["intelligence_projects","intelligence_task_dependencies"], "Migration 0001 tables");
  requireExactColumnNames(await columns("intelligence_tasks"), taskMigratedColumns, "intelligence_tasks");
  requireExactColumnDefinitions(await columns("intelligence_tasks"), taskMigratedDefinitions, "intelligence_tasks");
  requireExactColumnNames(await columns("intelligence_projects"), projectColumns, "intelligence_projects");
  requireExactColumnDefinitions(await columns("intelligence_projects"), projectDefinitions, "intelligence_projects");
  requireExactColumnNames(await columns("intelligence_task_dependencies"), dependencyColumns, "intelligence_task_dependencies");
  requireExactColumnDefinitions(await columns("intelligence_task_dependencies"), dependencyDefinitions, "intelligence_task_dependencies");
  requireNames(triggers, projectTriggers, "Migration 0001 triggers");
  requireNames(indexes, projectIndexes, "Migration 0001 indexes");
  requireExactMigrationSql(triggers, migration0001Sql, "TRIGGER", projectTriggers, "Migration 0001 trigger");
  requireExactMigrationSql(indexes, migration0001Sql, "INDEX", projectIndexes, "Migration 0001 index");
  requireExactForeignKeys(await foreignKeys("intelligence_tasks"), [
    { table: "intelligence_projects", from: "project_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
  ], "intelligence_tasks");
  requireExactForeignKeys(await foreignKeys("intelligence_task_dependencies"), [
    { table: "intelligence_tasks", from: "task_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
    { table: "intelligence_tasks", from: "depends_on_task_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
  ], "intelligence_task_dependencies");
  requireAbsent(tables, ["intelligence_knowledge","intelligence_owner_memory"], "Migration 0002 tables");
  requireAbsent(indexes, [
    "idx_intelligence_knowledge_owner_active","idx_intelligence_knowledge_owner_category",
    "idx_intelligence_memory_owner_active",
  ], "Migration 0002 indexes");
  requireAbsent(triggers, knowledgeTriggers, "Migration 0002 triggers");
  const fk = await query("PRAGMA foreign_key_check");
  if (fk.length) throw new Error(`Foreign key violations before migration 0002: ${JSON.stringify(fk)}`);
  console.log("PASS: migration 0001 schema is present and internally consistent; migration 0002 target objects are absent.");
}

if (mode === "verify-0001") {
  requireNames(tables, ["intelligence_projects","intelligence_task_dependencies"], "Migration 0001 tables");
  requireExactColumnNames(await columns("intelligence_tasks"), taskMigratedColumns, "intelligence_tasks");
  requireExactColumnDefinitions(await columns("intelligence_tasks"), taskMigratedDefinitions, "intelligence_tasks");
  requireExactColumnNames(await columns("intelligence_projects"), projectColumns, "intelligence_projects");
  requireExactColumnDefinitions(await columns("intelligence_projects"), projectDefinitions, "intelligence_projects");
  requireExactColumnNames(await columns("intelligence_task_dependencies"), dependencyColumns, "intelligence_task_dependencies");
  requireExactColumnDefinitions(await columns("intelligence_task_dependencies"), dependencyDefinitions, "intelligence_task_dependencies");
  requireNames(triggers, projectTriggers, "Migration 0001 triggers");
  requireNames(indexes, projectIndexes, "Migration 0001 indexes");
  requireExactMigrationSql(triggers, migration0001Sql, "TRIGGER", projectTriggers, "Migration 0001 trigger");
  requireExactMigrationSql(indexes, migration0001Sql, "INDEX", projectIndexes, "Migration 0001 index");
  requireExactForeignKeys(await foreignKeys("intelligence_tasks"), [
    { table: "intelligence_projects", from: "project_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
  ], "intelligence_tasks");
  requireExactForeignKeys(await foreignKeys("intelligence_task_dependencies"), [
    { table: "intelligence_tasks", from: "task_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
    { table: "intelligence_tasks", from: "depends_on_task_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
  ], "intelligence_task_dependencies");
  const fk = await query("PRAGMA foreign_key_check");
  if (fk.length) throw new Error(`Foreign key violations after migration 0001: ${JSON.stringify(fk)}`);
  console.log("PASS: migration 0001 tables, columns, triggers, and foreign keys verified.");
}

if (mode === "verify-0002") {
  requireNames(tables, ["intelligence_knowledge","intelligence_owner_memory"], "Migration 0002 tables");
  requireNames(indexes, [
    "idx_intelligence_knowledge_owner_active","idx_intelligence_knowledge_owner_category",
    "idx_intelligence_memory_owner_active",
  ], "Migration 0002 indexes");
  requireNames(triggers, knowledgeTriggers, "Migration 0002 triggers");
  requireExactMigrationSql(triggers, migration0002Sql, "TRIGGER", knowledgeTriggers, "Migration 0002 trigger");
  requireExactMigrationSql(indexes, migration0002Sql, "INDEX", [
    "idx_intelligence_knowledge_owner_active",
    "idx_intelligence_knowledge_owner_category",
    "idx_intelligence_memory_owner_active",
  ], "Migration 0002 index");
  requireExactMigrationSql(triggers, migration0001Sql, "TRIGGER", projectTriggers, "Migration 0001 trigger");
  requireExactMigrationSql(indexes, migration0001Sql, "INDEX", projectIndexes, "Migration 0001 index");
  requireExactForeignKeys(await foreignKeys("intelligence_tasks"), [
    { table: "intelligence_projects", from: "project_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
  ], "intelligence_tasks");
  requireExactForeignKeys(await foreignKeys("intelligence_task_dependencies"), [
    { table: "intelligence_tasks", from: "task_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
    { table: "intelligence_tasks", from: "depends_on_task_id", to: "id", on_update: "NO ACTION", on_delete: "RESTRICT" },
  ], "intelligence_task_dependencies");
  requireNames(indexes, projectIndexes, "Migration 0001 indexes");
  requireNames(triggers, projectTriggers, "Migration 0001 triggers");
  requireExactColumnNames(await columns("intelligence_knowledge"), knowledgeColumns, "intelligence_knowledge");
  requireExactColumnDefinitions(await columns("intelligence_knowledge"), knowledgeDefinitions, "intelligence_knowledge");
  requireExactColumnNames(await columns("intelligence_owner_memory"), memoryColumns, "intelligence_owner_memory");
  requireExactColumnDefinitions(await columns("intelligence_owner_memory"), memoryDefinitions, "intelligence_owner_memory");
  const fk = await query("PRAGMA foreign_key_check");
  if (fk.length) throw new Error(`Foreign key violations after migration 0002: ${JSON.stringify(fk)}`);
  console.log("PASS: migration 0002 tables, columns, indexes, triggers, and foreign keys verified.");
}
