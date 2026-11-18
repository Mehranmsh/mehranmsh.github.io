#!/usr/bin/env python3
"""Exercise the exact owner-scoped Intelligence knowledge and memory SELECTs in disposable SQLite."""
import re
import sqlite3
import unittest
from pathlib import Path


KNOWLEDGE_SQL = """SELECT id,owner_uid,category,title,content,importance,updated_at
FROM intelligence_knowledge
WHERE archived_at IS NULL AND owner_uid IN (?, 'system_seed')
ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
updated_at DESC LIMIT 100"""

MEMORY_SQL = """SELECT category,content,updated_at
FROM intelligence_owner_memory
WHERE owner_uid=? ORDER BY updated_at DESC LIMIT 30"""


class IntelligenceKnowledgeIsolationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("""CREATE TABLE intelligence_knowledge(
            id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'company', title TEXT NOT NULL,
            content TEXT NOT NULL, importance TEXT NOT NULL DEFAULT 'normal',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT)""")
        self.db.execute("""CREATE TABLE intelligence_owner_memory(
            id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'company', content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        self.db.executemany(
            "INSERT INTO intelligence_knowledge(id,owner_uid,category,title,content,importance,created_by,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [
                ("a1","owner-a","decision","A private policy","Owner A secret","high","owner-a","2026-11-19",None),
                ("b1","owner-b","decision","B private policy","Owner B secret","high","owner-b","2026-11-19",None),
                ("s1","system_seed","company","Shared baseline","Approved shared baseline","normal","system","2026-11-18",None),
                ("a2","owner-a","decision","Archived A policy","Do not retrieve","high","owner-a","2026-11-19","2026-11-19"),
            ],
        )
        self.db.executemany(
            "INSERT INTO intelligence_owner_memory(id,owner_uid,category,content,updated_at) VALUES(?,?,?,?,?)",
            [
                ("ma","owner-a","note","A memory","2026-11-19"),
                ("mb","owner-b","note","B memory","2026-11-19"),
            ],
        )

    def tearDown(self):
        self.db.close()

    def test_sql_contract_matches_worker_source(self):
        worker_source = (Path(__file__).resolve().parents[1] / "worker.js").read_text(encoding="utf-8")
        normalized_source = re.sub(r"\\s+", " ", worker_source)
        self.assertIn(re.sub(r"\\s+", " ", KNOWLEDGE_SQL), normalized_source)
        self.assertIn(re.sub(r"\\s+", " ", MEMORY_SQL), normalized_source)

    def test_knowledge_returns_only_authenticated_owner_and_system_seed(self):
        rows = self.db.execute(KNOWLEDGE_SQL, ("owner-a",)).fetchall()
        ids = {row[0] for row in rows}
        self.assertEqual(ids, {"a1", "s1"})
        self.assertNotIn("Owner B secret", [row[4] for row in rows])
        self.assertNotIn("Archived A policy", [row[3] for row in rows])

    def test_other_owner_cannot_read_owner_a_knowledge(self):
        rows = self.db.execute(KNOWLEDGE_SQL, ("owner-b",)).fetchall()
        ids = {row[0] for row in rows}
        self.assertEqual(ids, {"b1", "s1"})
        self.assertNotIn("a1", ids)

    def test_memory_is_strictly_owner_scoped(self):
        rows = self.db.execute(MEMORY_SQL, ("owner-a",)).fetchall()
        self.assertEqual([row[1] for row in rows], ["A memory"])
        self.assertNotIn("B memory", [row[1] for row in rows])

    def test_empty_owner_uid_does_not_leak_other_owner_records(self):
        rows = self.db.execute(KNOWLEDGE_SQL, ("",)).fetchall()
        self.assertEqual({row[0] for row in rows}, {"s1"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
