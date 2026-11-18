#!/usr/bin/env python3
"""Exercise owner-scoped Intelligence knowledge relationships in disposable SQLite."""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0002_intelligence_knowledge_relations.sql"


class KnowledgeRelationshipMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("""CREATE TABLE intelligence_knowledge(
            id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'company', title TEXT NOT NULL,
            content TEXT NOT NULL, importance TEXT NOT NULL DEFAULT 'normal',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT)""")
        self.db.executemany(
            "INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by) VALUES(?,?,?,?,?)",
            [
                ("a1", "owner-a", "Decision A", "Use method A.", "owner-a"),
                ("a2", "owner-a", "Decision B", "Use method B.", "owner-a"),
                ("a3", "owner-a", "Decision C", "Method C supports A.", "owner-a"),
                ("b1", "owner-b", "Private B", "Owner B only.", "owner-b"),
                ("b2", "owner-b", "Private B2", "Owner B second entry.", "owner-b"),
                ("s1", "system_seed", "Shared seed", "Immutable seed.", "system_seed"),
            ],
        )
        self.sql = MIGRATION.read_text(encoding="utf-8")

    def tearDown(self):
        self.db.close()

    def apply_migration(self):
        self.db.executescript(self.sql)

    def insert(self, relation_id="r1", owner="owner-a", source="a1", target="a2",
               kind="conflicts_with", status="candidate", resolved=None,
               source_evidence="Use method A.", target_evidence="Use method B."):
        self.db.execute(
            """INSERT INTO intelligence_knowledge_relations(
                id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,
                status,source_evidence,target_evidence,resolved_knowledge_id
            ) VALUES(?,?,?,?,?,?,?,?,?)""",
            (relation_id, owner, source, target, kind, status,
             source_evidence, target_evidence, resolved),
        )

    def test_migration_is_idempotent_and_has_expected_indexes(self):
        self.apply_migration()
        self.apply_migration()
        columns = {row[1] for row in self.db.execute(
            "PRAGMA table_info(intelligence_knowledge_relations)"
        )}
        self.assertEqual(columns, {
            "id", "owner_uid", "source_knowledge_id", "target_knowledge_id",
            "relation_type", "status", "source_evidence", "target_evidence",
            "resolved_knowledge_id", "created_at", "updated_at",
            "confirmed_at", "dismissed_at",
        })
        indexes = {row[1] for row in self.db.execute(
            "PRAGMA index_list(intelligence_knowledge_relations)"
        )}
        self.assertTrue({
            "idx_intelligence_knowledge_relation_unique",
            "idx_intelligence_knowledge_relation_owner_status",
        }.issubset(indexes))
        self.assertEqual(len(list(self.db.execute(
            "PRAGMA foreign_key_list(intelligence_knowledge_relations)"
        ))), 3)

    def test_candidate_is_not_implicitly_confirmed_and_can_be_confirmed(self):
        self.apply_migration()
        self.insert()
        self.assertEqual(self.db.execute(
            "SELECT status FROM intelligence_knowledge_relations WHERE id='r1'"
        ).fetchone()[0], "candidate")
        self.db.execute(
            "UPDATE intelligence_knowledge_relations SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP WHERE id='r1'"
        )
        self.assertEqual(self.db.execute(
            "SELECT status FROM intelligence_knowledge_relations WHERE id='r1'"
        ).fetchone()[0], "confirmed")

    def test_conflict_pair_is_canonical_and_duplicate_is_rejected(self):
        self.apply_migration()
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(relation_id="r2")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(relation_id="r3", source="a2", target="a1")

    def test_self_links_unknown_types_and_empty_evidence_are_rejected(self):
        self.apply_migration()
        for args in [
            {"relation_id":"self", "source":"a1", "target":"a1", "kind":"supports"},
            {"relation_id":"bad-type", "kind":"owns"},
            {"relation_id":"empty-evidence", "source_evidence":"   "},
        ]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.insert(**args)

    def test_cross_owner_and_system_seed_mutations_are_rejected(self):
        self.apply_migration()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(relation_id="cross", target="b1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(relation_id="seed", owner="system_seed", source="s1", target="a1")
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE intelligence_knowledge_relations SET owner_uid='owner-b' WHERE id='r1'"
            )

    def test_supersedes_and_supports_are_directional_and_resolution_is_explicit(self):
        self.apply_migration()
        self.insert(relation_id="sup", kind="supersedes", source="a2", target="a1")
        self.insert(relation_id="sup2", kind="supports", source="a3", target="a1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(relation_id="bad-resolution", status="resolved", resolved="a3")
        self.insert(relation_id="resolved", status="resolved", resolved="a2")
        row = self.db.execute(
            "SELECT relation_type,source_knowledge_id,target_knowledge_id,status,resolved_knowledge_id "
            "FROM intelligence_knowledge_relations WHERE id='resolved'"
        ).fetchone()
        self.assertEqual(row, ("conflicts_with", "a1", "a2", "resolved", "a2"))

    def test_owner_reads_only_own_confirmed_and_candidate_relations(self):
        self.apply_migration()
        self.insert()
        self.insert(relation_id="other", owner="owner-b", source="b1", target="b2",
                    kind="supports")
        rows = self.db.execute(
            "SELECT id FROM intelligence_knowledge_relations WHERE owner_uid=? AND status IN ('candidate','confirmed')",
            ("owner-a",),
        ).fetchall()
        self.assertEqual(rows, [("r1",)])
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_knowledge_relations WHERE owner_uid='owner-b'"
        ).fetchone()[0], 0)

    def test_foreign_keys_preserve_relationship_history(self):
        self.apply_migration()
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_knowledge WHERE id='a1'")

if __name__ == "__main__":
    unittest.main(verbosity=2)
