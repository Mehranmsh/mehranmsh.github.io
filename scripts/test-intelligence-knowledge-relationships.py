#!/usr/bin/env python3
"""Validate the Intelligence knowledge-relationship migration in disposable SQLite."""
import sqlite3
import unittest
from pathlib import Path


MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "0002_intelligence_knowledge_relationships.sql"


class IntelligenceKnowledgeRelationshipMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("""CREATE TABLE intelligence_knowledge(
            id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, category TEXT NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL, importance TEXT NOT NULL,
            created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT)""")
        self.db.executemany(
            "INSERT INTO intelligence_knowledge(id,owner_uid,category,title,content,importance,created_by,archived_at) VALUES(?,?,?,?,?,?,?,?)",
            [
                ("a1","owner-a","decision","Policy A","A","high","owner-a",None),
                ("a2","owner-a","decision","Policy B","B","normal","owner-a",None),
                ("a3","owner-a","decision","Old policy","Old","normal","owner-a","2026-11-18"),
                ("b1","owner-b","decision","Private B","B","high","owner-b",None),
                ("s1","system_seed","company","Baseline","Shared","high","system_seed",None),
            ],
        )
        self.sql = MIGRATION.read_text(encoding="utf-8")
        self.db.executescript(self.sql)

    def tearDown(self):
        self.db.close()

    def insert(self, *, ident="r1", owner="owner-a", left="a1", right="a2",
               relation="conflicts_with", status="candidate", proposed_by="intelligence",
               evidence="[]", resolution=None):
        self.db.execute(
            """INSERT INTO intelligence_knowledge_relationships
            (id,owner_uid,left_knowledge_id,right_knowledge_id,relation_type,status,
             proposed_by,evidence_json,resolution_knowledge_id)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (ident,owner,min(left,right),max(left,right),relation,status,proposed_by,evidence,resolution),
        )

    def test_migration_is_idempotent(self):
        self.db.executescript(self.sql)
        self.assertIsNotNone(self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='intelligence_knowledge_relationships'"
        ).fetchone())

    def test_candidate_is_read_only_and_owner_scoped(self):
        self.insert()
        row = self.db.execute(
            "SELECT owner_uid,status,proposed_by FROM intelligence_knowledge_relationships WHERE id='r1'"
        ).fetchone()
        self.assertEqual(row, ("owner-a","candidate","intelligence"))

    def test_owner_can_confirm_and_resolve_without_deleting_either_record(self):
        self.insert()
        self.db.execute(
            "UPDATE intelligence_knowledge_relationships SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP WHERE id='r1' AND owner_uid='owner-a'"
        )
        self.db.execute(
            "UPDATE intelligence_knowledge_relationships SET status='resolved',resolution_knowledge_id='a2',resolved_at=CURRENT_TIMESTAMP WHERE id='r1' AND owner_uid='owner-a'"
        )
        self.assertEqual(self.db.execute("SELECT status,resolution_knowledge_id,proposed_by FROM intelligence_knowledge_relationships WHERE id='r1'").fetchone(),("resolved","a2","intelligence"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM intelligence_knowledge WHERE id IN ('a1','a2')").fetchone()[0],2)

    def test_owner_can_dismiss_candidate_without_deleting_evidence(self):
        self.insert()
        self.db.execute("UPDATE intelligence_knowledge_relationships SET status='dismissed',dismissed_at=CURRENT_TIMESTAMP WHERE id='r1' AND owner_uid='owner-a'")
        self.assertEqual(self.db.execute("SELECT status FROM intelligence_knowledge_relationships WHERE id='r1'").fetchone()[0],"dismissed")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM intelligence_knowledge WHERE id IN ('a1','a2')").fetchone()[0],2)

    def test_cross_owner_and_system_seed_links_are_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="cross",left="a1",right="b1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="system",left="a1",right="s1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="seed-owner",owner="system_seed",left="s1",right="a1")

    def test_missing_and_archived_knowledge_are_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="missing",left="a1",right="missing")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="archived",left="a1",right="a3")

    def test_self_reference_and_duplicate_relationship_are_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="self",left="a1",right="a1")
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="duplicate")

    def test_invalid_relation_status_and_resolution_are_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="bad-relation",relation="grants_permission")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="bad-status",status="auto_resolved")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="bad-resolution",status="resolved")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(ident="bad-resolution-target",status="resolved",resolution="b1")

    def test_old_knowledge_is_preserved_as_historical_evidence(self):
        self.insert()
        self.db.execute("UPDATE intelligence_knowledge SET archived_at='2026-11-19' WHERE id='a1'")
        row = self.db.execute("SELECT left_knowledge_id,right_knowledge_id FROM intelligence_knowledge_relationships WHERE id='r1'").fetchone()
        self.assertEqual(set(row),{"a1","a2"})
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM intelligence_knowledge WHERE id='a1'").fetchone()[0],1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
