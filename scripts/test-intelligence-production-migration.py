import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "production" / "0001_intelligence_owner_projects.sql"

BASE_SCHEMA = """
CREATE TABLE intelligence_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL DEFAULT 'mehran_intelligence',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'queued',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  result_text TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT '',
  action_payload TEXT NOT NULL DEFAULT '{}',
  agent_claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""

class ProductionIntelligenceMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(BASE_SCHEMA)
        self.db.execute(
            "INSERT INTO intelligence_tasks(id,title,created_by) VALUES('legacy-1','Legacy task','mehranmsh')"
        )
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def add_project(self, project_id="p1", owner="pi-owner-1"):
        self.db.execute(
            "INSERT INTO intelligence_projects(id,owner_uid,name,module_key) VALUES(?,?,?,?)",
            (project_id, owner, "Test project", "intelligence"),
        )

    def add_task(self, task_id, owner="pi-owner-1", project="p1", status="queued"):
        self.db.execute(
            """INSERT INTO intelligence_tasks
               (id,title,created_by,owner_uid,project_id,status)
               VALUES(?,?,?,?,?,?)""",
            (task_id, task_id, "mehranmsh", owner, project, status),
        )

    def test_migration_preserves_legacy_task_without_fabricating_uid(self):
        row = self.db.execute(
            "SELECT id,created_by,owner_uid,project_id FROM intelligence_tasks WHERE id='legacy-1'"
        ).fetchone()
        self.assertEqual(row, ("legacy-1", "mehranmsh", None, None))

    def test_owner_scoped_project_assignment(self):
        self.add_project()
        self.add_task("task-1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_task("foreign-task", owner="another-owner", project="p1")

    def test_dependency_requires_same_owner_and_project(self):
        self.add_project()
        self.add_task("task-1")
        self.add_task("task-2")
        self.db.execute(
            """INSERT INTO intelligence_task_dependencies
               (id,owner_uid,task_id,depends_on_task_id)
               VALUES('dep-1','pi-owner-1','task-2','task-1')"""
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO intelligence_task_dependencies
                   (id,owner_uid,task_id,depends_on_task_id)
                   VALUES('dep-2','another-owner','task-2','task-1')"""
            )

    def test_dependency_cycle_is_rejected(self):
        self.add_project()
        self.add_task("task-1")
        self.add_task("task-2")
        self.db.execute(
            """INSERT INTO intelligence_task_dependencies
               (id,owner_uid,task_id,depends_on_task_id)
               VALUES('dep-1','pi-owner-1','task-2','task-1')"""
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO intelligence_task_dependencies
                   (id,owner_uid,task_id,depends_on_task_id)
                   VALUES('dep-2','pi-owner-1','task-1','task-2')"""
            )

    def test_task_cannot_complete_before_prerequisite(self):
        self.add_project()
        self.add_task("prerequisite")
        self.add_task("dependent")
        self.db.execute(
            """INSERT INTO intelligence_task_dependencies
               (id,owner_uid,task_id,depends_on_task_id)
               VALUES('dep-1','pi-owner-1','dependent','prerequisite')"""
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_tasks SET status='completed' WHERE id='dependent'")
        self.db.execute("UPDATE intelligence_tasks SET status='completed' WHERE id='prerequisite'")
        self.db.execute("UPDATE intelligence_tasks SET status='completed' WHERE id='dependent'")

    def test_production_api_uses_verified_owner_uid(self):
        api = (ROOT / "intelligence-production-project-api.mjs").read_text(encoding="utf-8")
        self.assertIn("const ownerUid=admin.uid", api)
        self.assertIn("t.owner_uid=p.owner_uid", api)
        self.assertIn("WHERE id=? AND owner_uid=?", api)
        self.assertNotIn("intelligence_staging_audit", api)
        self.assertNotIn("created_by=?", api)

    def test_project_and_task_updates_commit_with_audit_records(self):
        api = (ROOT / "intelligence-production-project-api.mjs").read_text(encoding="utf-8")
        self.assertNotIn(".run();await audit(", api)
        self.assertIn('env.DB.batch([\n        env.DB.prepare("UPDATE intelligence_projects', api)
        self.assertIn('env.DB.prepare("UPDATE intelligence_tasks SET project_id=', api)
        self.assertIn('env.DB.prepare("UPDATE intelligence_tasks SET status=', api)
        self.assertIn('"project_updated","intelligence_project"', api)
        self.assertIn('"task_project_changed","intelligence_task"', api)
        self.assertIn('"task_status_changed","intelligence_task"', api)

    def test_production_api_keeps_execution_disabled(self):
        api = (ROOT / "intelligence-production-project-api.mjs").read_text(encoding="utf-8")
        self.assertIn("executionEnabled:false", api)
        self.assertIn("Automated task approval and execution remain controlled", api)

    def test_worker_routes_projects_only_after_schema_gate(self):
        worker = (ROOT / "worker.js").read_text(encoding="utf-8")
        self.assertIn('import { handleProductionIntelligenceProjectApi }', worker)
        self.assertIn("intelligenceOwnershipSchemaReady(env)", worker)
        self.assertIn("const result = await handleProductionIntelligenceProjectApi", worker)
        self.assertIn("Admin authentication required", worker)

    def test_new_task_creation_persists_verified_pi_uid(self):
        worker = (ROOT / "worker.js").read_text(encoding="utf-8")
        self.assertGreaterEqual(worker.count("created_by,owner_uid"), 3)
        self.assertGreaterEqual(worker.count("admin.username,admin.uid"), 3)
        self.assertIn("Intelligence ownership migration is not installed", worker)

if __name__ == "__main__":
    unittest.main()
