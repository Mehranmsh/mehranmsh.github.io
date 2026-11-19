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
    ROOT / "migrations" / "0003_intelligence_staging_runtime.sql",
]

class IntelligenceStagingSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")

    def tearDown(self):
        self.db.close()

    def apply_chain(self):
        for path in MIGRATIONS:
            self.db.executescript(path.read_text(encoding="utf-8"))

    def test_ordered_migration_chain_and_idempotence(self):
        self.apply_chain()
        self.apply_chain()
        tables = {row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertTrue({
            "intelligence_tasks",
            "intelligence_knowledge",
            "intelligence_approval_ledger",
            "intelligence_knowledge_relations",
            "intelligence_staging_sessions",
            "intelligence_staging_audit",
            "intelligence_staging_rate_limits",
            "intelligence_owner_memory",
        }.issubset(tables))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        approval_fks = list(self.db.execute(
            "PRAGMA foreign_key_list(intelligence_approval_ledger)"
        ))
        relation_fks = list(self.db.execute(
            "PRAGMA foreign_key_list(intelligence_knowledge_relations)"
        ))
        self.assertTrue(any(row[2] == "intelligence_tasks" for row in approval_fks))
        self.assertTrue(any(row[2] == "intelligence_knowledge" for row in relation_fks))

    def test_approval_ledger_rejects_unknown_task(self):
        self.apply_chain()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,
                    base_sha,scope_json,scope_sha256,status,issued_at,expires_at
                ) VALUES('grant-x','missing','owner','owner','repo','branch',
                         'sha','{}','hash','issued',1,4102444800)
            """)

    def test_runtime_tables_are_separate_and_idempotent(self):
        self.apply_chain()
        expected = {
            "intelligence_staging_sessions",
            "intelligence_staging_audit",
            "intelligence_staging_rate_limits",
            "intelligence_owner_memory",
        }
        found = {row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertTrue(expected.issubset(found))
        self.assertNotIn("admin_sessions", found)
        self.assertNotIn("admin_audit_log", found)
        self.assertNotIn("social_users", found)

    def test_audit_insert_requires_a_successful_state_change(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_staging_sessions
            (id,token_hash,owner_uid,created_at,expires_at)
            VALUES('audit-session','audit-hash','owner-a',100,200)
        """)
        self.db.execute("""
            UPDATE intelligence_staging_sessions
            SET revoked_at=150
            WHERE id='audit-session' AND owner_uid='owner-a' AND revoked_at IS NULL
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'audit-1','owner-a','session_revoked','session','audit-session','{}',150
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 1)
        self.db.execute("""
            UPDATE intelligence_staging_sessions
            SET revoked_at=151
            WHERE id='audit-session' AND owner_uid='owner-a' AND revoked_at IS NULL
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'audit-2','owner-a','session_revoked','session','audit-session','{}',151
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 1)

    def test_session_token_hash_is_unique_and_revocation_is_scoped(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_staging_sessions
            (id,token_hash,owner_uid,created_at,expires_at)
            VALUES('s1','hash-1','owner-a',100,200)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_staging_sessions
                (id,token_hash,owner_uid,created_at,expires_at)
                VALUES('s2','hash-1','owner-b',100,200)
            """)

if __name__ == "__main__":
    unittest.main(verbosity=2)
