#!/usr/bin/env python3
"""Disposable SQLite proof for the proposed INTELLIGENCE project/task schema.

This is a design contract test, not a production migration. It applies the
current staging migrations to an in-memory database, then exercises the
proposed additive project/dependency constraints.
"""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "migrations" / f"{name}.sql"
    for name in (
        "0000_intelligence_staging_baseline",
        "0001_intelligence_approval_ledger",
        "0002_intelligence_knowledge_relations",
        "0003_intelligence_staging_runtime",
        "0004_intelligence_knowledge_provenance",
    )
]

PROJECT_SCHEMA = """
CREATE TABLE intelligence_projects (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 3000),
  module_key TEXT NOT NULL CHECK(length(module_key) BETWEEN 1 AND 40),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','active','paused','completed','archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);
CREATE INDEX idx_intelligence_projects_owner_status
  ON intelligence_projects(owner_uid,status,updated_at DESC);
CREATE INDEX idx_intelligence_projects_owner_module
  ON intelligence_projects(owner_uid,module_key,updated_at DESC);

ALTER TABLE intelligence_tasks
  ADD COLUMN project_id TEXT REFERENCES intelligence_projects(id) ON DELETE RESTRICT;
CREATE INDEX idx_intelligence_tasks_project
  ON intelligence_tasks(created_by,project_id,status,created_at);

CREATE TRIGGER trg_intelligence_task_project_owner_insert
BEFORE INSERT ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT,'task project owner mismatch');
END;

CREATE TRIGGER trg_intelligence_task_project_owner_update
BEFORE UPDATE OF project_id,created_by ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT,'task project owner mismatch');
END;

CREATE TRIGGER trg_intelligence_project_owner_immutable_with_tasks
BEFORE UPDATE OF owner_uid ON intelligence_projects
WHEN EXISTS (SELECT 1 FROM intelligence_tasks t WHERE t.project_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT,'project owner cannot change while tasks are attached');
END;

CREATE TRIGGER trg_intelligence_project_complete_guard
BEFORE UPDATE OF status ON intelligence_projects
WHEN NEW.status='completed' AND EXISTS (
  SELECT 1 FROM intelligence_tasks t
  WHERE t.project_id=OLD.id AND t.status<>'completed'
)
BEGIN
  SELECT RAISE(ABORT,'project has incomplete tasks');
END;

CREATE TRIGGER trg_intelligence_task_completed_project_guard_insert
BEFORE INSERT ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.status='completed'
) AND NEW.status<>'completed'
BEGIN
  SELECT RAISE(ABORT,'cannot add incomplete task to completed project');
END;

CREATE TRIGGER trg_intelligence_task_completed_project_guard_update
BEFORE UPDATE OF project_id,status ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NEW.status<>'completed' AND EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.status='completed'
)
BEGIN
  SELECT RAISE(ABORT,'cannot place incomplete task in completed project');
END;

CREATE TRIGGER trg_intelligence_task_dependency_consistency_update
BEFORE UPDATE OF project_id,created_by ON intelligence_tasks
WHEN EXISTS (
  SELECT 1
  FROM intelligence_task_dependencies d
  JOIN intelligence_tasks other
    ON other.id = CASE WHEN d.task_id=OLD.id THEN d.depends_on_task_id ELSE d.task_id END
  WHERE (d.task_id=OLD.id OR d.depends_on_task_id=OLD.id)
    AND (other.created_by<>NEW.created_by
      OR COALESCE(other.project_id,'')<>COALESCE(NEW.project_id,''))
)
BEGIN
  SELECT RAISE(ABORT,'task move would invalidate dependency scope');
END;

CREATE TABLE intelligence_task_dependencies (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES intelligence_tasks(id) ON DELETE RESTRICT,
  depends_on_task_id TEXT NOT NULL REFERENCES intelligence_tasks(id) ON DELETE RESTRICT,
  dependency_type TEXT NOT NULL DEFAULT 'blocks' CHECK(dependency_type='blocks'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(task_id <> depends_on_task_id),
  UNIQUE(owner_uid,task_id,depends_on_task_id,dependency_type)
);
CREATE INDEX idx_intelligence_task_dependencies_task
  ON intelligence_task_dependencies(owner_uid,task_id);
CREATE INDEX idx_intelligence_task_dependencies_prerequisite
  ON intelligence_task_dependencies(owner_uid,depends_on_task_id);

CREATE TRIGGER trg_intelligence_task_dependency_guard_insert
BEFORE INSERT ON intelligence_task_dependencies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_tasks t
    JOIN intelligence_tasks prerequisite ON prerequisite.id=NEW.depends_on_task_id
    WHERE t.id=NEW.task_id
      AND t.created_by=NEW.owner_uid
      AND prerequisite.created_by=NEW.owner_uid
      AND COALESCE(t.project_id,'')=COALESCE(prerequisite.project_id,'')
  ) THEN RAISE(ABORT,'task dependency owner or project mismatch') END;

  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable(task_id) AS (
      SELECT NEW.depends_on_task_id
      UNION
      SELECT d.depends_on_task_id
      FROM intelligence_task_dependencies d
      JOIN reachable r ON d.task_id=r.task_id
      WHERE d.owner_uid=NEW.owner_uid
    )
    SELECT 1 FROM reachable WHERE task_id=NEW.task_id
  ) THEN RAISE(ABORT,'task dependency cycle') END;
END;

CREATE TRIGGER trg_intelligence_task_dependency_guard_update
BEFORE UPDATE OF owner_uid,task_id,depends_on_task_id,dependency_type
ON intelligence_task_dependencies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_tasks t
    JOIN intelligence_tasks prerequisite ON prerequisite.id=NEW.depends_on_task_id
    WHERE t.id=NEW.task_id
      AND t.created_by=NEW.owner_uid
      AND prerequisite.created_by=NEW.owner_uid
      AND COALESCE(t.project_id,'')=COALESCE(prerequisite.project_id,'')
  ) THEN RAISE(ABORT,'task dependency owner or project mismatch') END;

  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable(task_id) AS (
      SELECT NEW.depends_on_task_id
      UNION
      SELECT d.depends_on_task_id
      FROM intelligence_task_dependencies d
      JOIN reachable r ON d.task_id=r.task_id
      WHERE d.owner_uid=NEW.owner_uid AND d.id<>OLD.id
    )
    SELECT 1 FROM reachable WHERE task_id=NEW.task_id
  ) THEN RAISE(ABORT,'task dependency cycle') END;
END;
"""

class ProjectTaskDesignTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))
        self.db.executescript(PROJECT_SCHEMA)

    def tearDown(self):
        self.db.close()

    def project(self, project_id, owner="owner-a", name=None):
        self.db.execute(
            "INSERT INTO intelligence_projects(id,owner_uid,name,module_key) VALUES(?,?,?,?)",
            (project_id, owner, name or project_id, "intelligence"),
        )

    def task(self, task_id, owner="owner-a", project_id=None):
        self.db.execute(
            """INSERT INTO intelligence_tasks
               (id,title,created_by,project_id) VALUES(?,?,?,?)""",
            (task_id, task_id, owner, project_id),
        )

    def edge(self, edge_id, task_id, prerequisite_id, owner="owner-a"):
        self.db.execute(
            """INSERT INTO intelligence_task_dependencies
               (id,owner_uid,task_id,depends_on_task_id)
               VALUES(?,?,?,?)""",
            (edge_id, owner, task_id, prerequisite_id),
        )

    def test_owner_project_assignment_and_detachment(self):
        self.project("p-a")
        self.project("p-b", owner="owner-b")
        self.task("t-a", project_id="p-a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.task("t-b", project_id="p-b")
        self.task("t-c")
        self.db.execute("UPDATE intelligence_tasks SET project_id='p-a' WHERE id='t-c'")
        self.db.execute("UPDATE intelligence_tasks SET project_id=NULL WHERE id='t-c'")

    def test_project_owner_and_completion_are_protected(self):
        self.project("p-a")
        self.task("queued-task", project_id="p-a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_projects SET status='completed' WHERE id='p-a'")
        self.db.execute("UPDATE intelligence_tasks SET status='completed' WHERE id='queued-task'")
        self.db.execute("UPDATE intelligence_projects SET status='completed' WHERE id='p-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_projects SET owner_uid='owner-b' WHERE id='p-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.task("new-incomplete", project_id="p-a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_tasks SET status='queued' WHERE id='queued-task'")

    def test_task_move_cannot_break_existing_dependency_scope(self):
        self.project("p-a")
        self.project("p-b")
        self.task("a", project_id="p-a")
        self.task("b", project_id="p-a")
        self.edge("a-needs-b", "a", "b")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_tasks SET project_id='p-b' WHERE id='a'")
        self.db.execute("DELETE FROM intelligence_task_dependencies WHERE id='a-needs-b'")
        self.db.execute("UPDATE intelligence_tasks SET project_id='p-b' WHERE id='a'")

    def test_dependency_requires_same_owner_and_same_project(self):
        self.project("p-a")
        self.project("p-b")
        self.task("a", project_id="p-a")
        self.task("b", project_id="p-a")
        self.task("other-owner", owner="owner-b")
        self.task("other-project", project_id="p-b")
        self.edge("valid", "a", "b")
        with self.assertRaises(sqlite3.IntegrityError):
            self.edge("cross-owner", "a", "other-owner")
        with self.assertRaises(sqlite3.IntegrityError):
            self.edge("cross-project", "a", "other-project")

    def test_self_duplicate_and_cycle_edges_are_rejected(self):
        self.task("a")
        self.task("b")
        self.task("c")
        with self.assertRaises(sqlite3.IntegrityError):
            self.edge("self", "a", "a")
        self.edge("a-needs-b", "a", "b")
        with self.assertRaises(sqlite3.IntegrityError):
            self.edge("duplicate", "a", "b")
        self.edge("b-needs-c", "b", "c")
        with self.assertRaises(sqlite3.IntegrityError):
            self.edge("cycle", "c", "a")

    def test_dependency_update_cannot_introduce_cycle_or_change_owner(self):
        self.task("a")
        self.task("b")
        self.task("c")
        self.edge("a-needs-b", "a", "b")
        self.edge("b-needs-c", "b", "c")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE intelligence_task_dependencies SET depends_on_task_id='a' WHERE id='b-needs-c'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE intelligence_task_dependencies SET owner_uid='owner-b' WHERE id='a-needs-b'"
            )

    def test_project_delete_is_restricted_while_tasks_reference_it(self):
        self.project("p-a")
        self.task("a", project_id="p-a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_projects WHERE id='p-a'")

    def test_dependency_delete_and_task_delete_respect_references(self):
        self.task("a")
        self.task("b")
        self.edge("a-needs-b", "a", "b")
        self.db.execute("DELETE FROM intelligence_task_dependencies WHERE id='a-needs-b'")
        self.db.execute("DELETE FROM intelligence_tasks WHERE id='b'")

if __name__ == "__main__":
    unittest.main(verbosity=2)
