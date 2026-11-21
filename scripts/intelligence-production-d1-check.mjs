import process from "node:process";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID || "2ee71f12-042b-4dba-8bf0-a0b577ace519";
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !token) {
  throw new Error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN GitHub Actions secret.");
}

async function query(sql) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
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
    throw new Error(`Cloudflare D1 query failed: ${JSON.stringify(payload.errors || payload)}`);
  }
  const first = payload.result?.[0];
  if (!first?.success) throw new Error(`D1 statement failed: ${JSON.stringify(first?.meta || first)}`);
  return first.results || [];
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
  requireExactColumnNames(await columns("intelligence_projects"), projectColumns, "intelligence_projects");
  requireExactColumnNames(await columns("intelligence_task_dependencies"), dependencyColumns, "intelligence_task_dependencies");
  requireNames(triggers, projectTriggers, "Migration 0001 triggers");
  requireNames(indexes, projectIndexes, "Migration 0001 indexes");
  requireAbsent(tables, ["intelligence_knowledge","intelligence_owner_memory"], "Migration 0002 tables");
  requireAbsent(indexes, [
    "idx_intelligence_knowledge_owner_active","idx_intelligence_knowledge_owner_category",
    "idx_intelligence_memory_owner_active",
  ], "Migration 0002 indexes");
  requireAbsent(triggers, knowledgeTriggers, "Migration 0002 triggers");
  console.log("PASS: migration 0001 schema is present; migration 0002 target objects are absent.");
}

if (mode === "verify-0001") {
  requireNames(tables, ["intelligence_projects","intelligence_task_dependencies"], "Migration 0001 tables");
  requireExactColumnNames(await columns("intelligence_tasks"), taskMigratedColumns, "intelligence_tasks");
  requireExactColumnNames(await columns("intelligence_projects"), projectColumns, "intelligence_projects");
  requireExactColumnNames(await columns("intelligence_task_dependencies"), dependencyColumns, "intelligence_task_dependencies");
  requireNames(triggers, projectTriggers, "Migration 0001 triggers");
  requireNames(indexes, projectIndexes, "Migration 0001 indexes");
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
  requireNames(indexes, projectIndexes, "Migration 0001 indexes");
  requireNames(triggers, projectTriggers, "Migration 0001 triggers");
  requireExactColumnNames(await columns("intelligence_knowledge"), knowledgeColumns, "intelligence_knowledge");
  requireExactColumnNames(await columns("intelligence_owner_memory"), memoryColumns, "intelligence_owner_memory");
  console.log("PASS: migration 0002 tables, columns, indexes, and owner immutability triggers verified.");
}
