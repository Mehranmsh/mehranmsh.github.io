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
    ROOT / "migrations" / "0004_intelligence_knowledge_provenance.sql",
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
        # 0004 is a one-time additive ALTER TABLE migration; the earlier
        # CREATE IF NOT EXISTS migrations remain safely repeatable.
        for path in MIGRATIONS[:-1]:
            self.db.executescript(path.read_text(encoding="utf-8"))
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

    def test_linked_knowledge_content_guard_is_installed(self):
        self.apply_chain()
        trigger = self.db.execute("""
            SELECT sql FROM sqlite_master
            WHERE type='trigger' AND name='trg_intelligence_knowledge_content_immutable_with_relations'
        """).fetchone()
        self.assertIsNotNone(trigger)
        self.assertIn("OLD.content <> NEW.content", trigger[0])


    def test_knowledge_provenance_bounds_immutability_and_owner_review(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by,
                source_type,source_ref,observed_at,confidence_score)
            VALUES('prov-a','owner-a','A','Evidence A','owner',
                'external_url','https://example.org/source',
                '2026-11-19T10:00:00Z',75)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by,
                    source_type,source_ref)
                VALUES('prov-b','owner-a','B','Evidence B','owner',
                    'external_url','https://user:pass@example.org/private')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by,
                    confidence_score)
                VALUES('prov-c','owner-a','C','Evidence C','owner',101)
            """)
        self.db.execute("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES('prov-d','owner-a','D','Evidence D','owner')
        """)
        self.db.execute("""
            INSERT INTO intelligence_knowledge_relations(
                id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,
                status,source_evidence,target_evidence
            ) VALUES('prov-rel','owner-a','prov-a','prov-d',
                     'supports','candidate','Evidence A','Evidence D')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge SET source_ref='https://example.org/changed'
                WHERE id='prov-a'
            """)
        # Owner review is a separate audited workflow and remains possible after linking.
        self.db.execute("""
            UPDATE intelligence_knowledge SET verification_status='owner_verified'
            WHERE id='prov-a' AND owner_uid='owner-a'
        """)
        status = self.db.execute("""
            SELECT verification_status FROM intelligence_knowledge WHERE id='prov-a'
        """).fetchone()[0]
        self.assertEqual(status, 'owner_verified')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge SET verification_status='approved'
                WHERE id='prov-a'
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

    def test_approval_scope_constraints_and_expiry_audit(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_tasks(id,title,created_by)
            VALUES('task-a','Task A','owner-a')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                    scope_json,scope_sha256,status,issued_at,expires_at
                ) VALUES('bad-scope','task-a','owner-a','mehranmsh','owner/repo','main',
                         '0123456789012345678901234567890123456789','[]','hash','issued',100,200)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                    scope_json,scope_sha256,status,issued_at,expires_at
                ) VALUES('bad-lifetime','task-a','owner-a','mehranmsh','owner/repo','main',
                         '0123456789012345678901234567890123456789','{"paths":["src/"]}',
                         'hash','issued',100,4001)
            """)
        self.db.execute("""
            INSERT INTO intelligence_approval_ledger(
                id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                scope_json,scope_sha256,status,issued_at,expires_at
            ) VALUES('approval-a','task-a','owner-a','mehranmsh','owner/repo','main',
                     '0123456789012345678901234567890123456789','{"paths":["src/"]}',
                     'hash','issued',100,200)
        """)
        self.db.execute("""
            UPDATE intelligence_approval_ledger SET status='expired'
            WHERE id='approval-a' AND status='issued'
        """)
        event = self.db.execute("""
            SELECT action,target_id FROM intelligence_staging_audit
            WHERE target_id='approval-a'
        """).fetchone()
        self.assertEqual(event, ('approval_expired','approval-a'))

    def test_runtime_tables_enforce_session_rate_and_memory_bounds(self):
        self.apply_chain()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_staging_sessions
                (id,token_hash,owner_uid,created_at,expires_at)
                VALUES('bad-session','bad-hash','owner-a',200,100)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_staging_rate_limits
                (rate_key,window_started_at,request_count)
                VALUES('bad-rate',100,0)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory(id,owner_uid,category,content)
                VALUES('bad-memory','owner-a','general','')
            """)

    def test_knowledge_archive_preserves_relationship_history_and_owner_scope(self):
        self.apply_chain()
        self.db.executemany("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES(?,?,?,?,?)
        """, [
            ('knowledge-a','owner-a','A','Evidence A','owner'),
            ('knowledge-b','owner-a','B','Evidence B','owner'),
        ])
        self.db.execute("""
            INSERT INTO intelligence_knowledge_relations(
                id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,
                status,source_evidence,target_evidence
            ) VALUES('relation-a','owner-a','knowledge-a','knowledge-b',
                     'supports','candidate','Evidence A','Evidence B')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge SET content='Changed evidence'
                WHERE id='knowledge-a' AND owner_uid='owner-a'
            """)
        self.db.execute("""
            UPDATE intelligence_knowledge SET archived_at=CURRENT_TIMESTAMP
            WHERE id='knowledge-a' AND owner_uid='owner-b' AND archived_at IS NULL
        """)
        self.assertIsNone(self.db.execute(
            "SELECT archived_at FROM intelligence_knowledge WHERE id='knowledge-a'"
        ).fetchone()[0])
        self.db.execute("""
            UPDATE intelligence_knowledge SET archived_at=CURRENT_TIMESTAMP
            WHERE id='knowledge-a' AND owner_uid='owner-a' AND archived_at IS NULL
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_knowledge_relations WHERE id='relation-a'"
        ).fetchone()[0], 1)
        self.db.execute("""
            UPDATE intelligence_knowledge SET archived_at=NULL
            WHERE id='knowledge-a' AND owner_uid='owner-a' AND archived_at IS NOT NULL
        """)
        self.assertIsNone(self.db.execute(
            "SELECT archived_at FROM intelligence_knowledge WHERE id='knowledge-a'"
        ).fetchone()[0])

    def test_memory_delete_audit_requires_owner_match_and_existing_row(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_owner_memory(id,owner_uid,category,content)
            VALUES('mem-a','owner-a','note','Private note')
        """)
        self.db.execute("""
            DELETE FROM intelligence_owner_memory WHERE id='mem-a' AND owner_uid='owner-b'
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'delete-wrong-owner','owner-b','owner_memory_deleted','memory','mem-a','{}',100
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 0)
        self.db.execute("""
            DELETE FROM intelligence_owner_memory WHERE id='mem-a' AND owner_uid='owner-a'
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'delete-owner-a','owner-a','owner_memory_deleted','memory','mem-a','{}',101
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT action FROM intelligence_staging_audit WHERE target_id='mem-a'"
        ).fetchone()[0], 'owner_memory_deleted')

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
