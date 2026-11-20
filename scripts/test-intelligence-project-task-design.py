#!/usr/bin/env python3
"""Disposable SQLite contract tests for INTELLIGENCE project/task migration 0005.

These tests execute the committed staging migration 0005 in an in-memory
SQLite database. They do not apply it to live Cloudflare D1.
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

PROJECT_SCHEMA_PATH = ROOT / "migrations" / "0005_intelligence_projects_dependencies.sql"
PROJECT_SCHEMA = PROJECT_SCHEMA_PATH.read_text(encoding="utf-8")

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
