#!/usr/bin/env python3
"""Verify the isolated Intelligence staging schema chain in disposable SQLite."""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "migrations" / "0000_intelligence_staging_baseline.sql",
    ROOT / "migrations" / "0001_intelligence_approval_ledger.sql",
    ROOT / "migrations" / "0002_intelligence_knowledge_relations.sql",
]

class IntelligenceStagingSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")

    def tearDown(self):
        self.db.close()

    def test_ordered_migration_chain_and_idempotence(self):
        for path in MIGRATIONS:
            self.db.executescript(path.read_text(encoding="utf-8"))
        for path in MIGRATIONS:
            self.db.executescript(path.read_text(encoding="utf-8"))
        tables = {row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertTrue({
            "intelligence_tasks",
            "intelligence_knowledge",
            "intelligence_approval_ledger",
            "intelligence_knowledge_relations",
        }.issubset(tables))
        self.assertEqual(
            self.db.execute("PRAGMA foreign_key_check").fetchall(), []
        )
        approval_fks = list(self.db.execute(
            "PRAGMA foreign_key_list(intelligence_approval_ledger)"
        ))
        relation_fks = list(self.db.execute(
            "PRAGMA foreign_key_list(intelligence_knowledge_relations)"
        ))
        self.assertTrue(any(row[2] == "intelligence_tasks" for row in approval_fks))
        self.assertTrue(any(row[2] == "intelligence_knowledge" for row in relation_fks))

    def test_approval_ledger_rejects_unknown_task(self):
        for path in MIGRATIONS:
            self.db.executescript(path.read_text(encoding="utf-8"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,
                    base_sha,scope_json,scope_sha256,status,expires_at
                ) VALUES('grant-x','missing','owner','owner','repo','branch',
                         'sha','{}','hash','issued',1,4102444800)
            """)

if __name__ == "__main__":
    unittest.main(verbosity=2)
