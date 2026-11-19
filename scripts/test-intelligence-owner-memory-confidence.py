#!/usr/bin/env python3
"""Verify owner-memory confidence scores remain integer-valued in D1."""
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
    ROOT / "migrations" / "0005_intelligence_owner_memory_governance.sql",
    ROOT / "migrations" / "0006_intelligence_owner_memory_confidence_integer.sql",
]


class OwnerMemoryConfidenceIntegerTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_integer_and_null_confidence_are_allowed(self):
        self.db.execute("""
            INSERT INTO intelligence_owner_memory
                (id,owner_uid,category,content,confidence_score)
            VALUES('memory-int','owner-a','general','Integer confidence',87)
        """)
        self.db.execute("""
            INSERT INTO intelligence_owner_memory
                (id,owner_uid,category,content,confidence_score)
            VALUES('memory-null','owner-a','general','Unrated memory',NULL)
        """)
        values = self.db.execute("""
            SELECT id, confidence_score, typeof(confidence_score)
            FROM intelligence_owner_memory ORDER BY id
        """).fetchall()
        self.assertEqual(values, [
            ("memory-int", 87, "integer"),
            ("memory-null", None, "null"),
        ])

    def test_fractional_confidence_is_rejected_on_insert(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory
                    (id,owner_uid,category,content,confidence_score)
                VALUES('memory-float','owner-a','general','Fractional confidence',87.5)
            """)

    def test_fractional_confidence_is_rejected_on_update(self):
        self.db.execute("""
            INSERT INTO intelligence_owner_memory
                (id,owner_uid,category,content,confidence_score)
            VALUES('memory-update','owner-a','general','Update target',87)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_owner_memory SET confidence_score=42.5
                WHERE id='memory-update'
            """)
        self.assertEqual(self.db.execute("""
            SELECT confidence_score FROM intelligence_owner_memory
            WHERE id='memory-update'
        """).fetchone()[0], 87)

    def test_out_of_range_integer_is_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory
                    (id,owner_uid,category,content,confidence_score)
                VALUES('memory-range','owner-a','general','Out of range',101)
            """)


if __name__ == "__main__":
    unittest.main(verbosity=2)
