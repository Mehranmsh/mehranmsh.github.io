#!/usr/bin/env python3
"""Prove one-time capability approval consumption and mutation are atomic in SQLite."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "migrations" / f"{name}.sql"
    for name in [
        "0000_intelligence_staging_baseline",
        "0001_intelligence_approval_ledger",
        "0002_intelligence_knowledge_relations",
        "0003_intelligence_staging_runtime",
        "0004_intelligence_knowledge_provenance",
        "0005_intelligence_owner_memory_governance",
        "0006_intelligence_owner_memory_confidence_integer",
        "0007_intelligence_approval_ledger_state_guards",
        "0008_intelligence_capability_approval_ledger",
        "0016_intelligence_capability_approval_allowlist",
    ]
]

CONSUME = """
UPDATE intelligence_capability_approvals
SET status='consumed', consumed_at=?, consumed_by=?
WHERE id=? AND owner_uid=? AND capability=? AND scope='owner_staging'
  AND status='issued' AND expires_at>? AND revoked_at IS NULL
  AND consumed_at IS NULL AND consumed_by IS NULL
"""
# Deliberately violates a NOT NULL constraint unless the immediately preceding
# statement changed exactly one row. A D1 batch rolls the transaction back.
ASSERT_ONE_CHANGE = """
INSERT INTO intelligence_staging_audit
(id,owner_uid,action,target_type,target_id,details_json,created_at)
SELECT '__atomic_guard__','owner','atomic_guard','guard','guard',NULL,1
WHERE changes() <> 1
"""

class AtomicCapabilityConsumptionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))
        self.db.execute("""
            CREATE TABLE protected_operations (
                id TEXT PRIMARY KEY,
                owner_uid TEXT NOT NULL,
                capability TEXT NOT NULL,
                payload TEXT NOT NULL
            )
        """)
        self.db.execute("""
            INSERT INTO intelligence_capability_approvals
            (id,owner_uid,capability,scope,status,issued_at,expires_at)
            VALUES ('grant-valid','owner-a','memory.create','owner_staging','issued',100,200)
        """)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def run_atomic_operation(self, *, grant_id="grant-valid", owner="owner-a",
                             capability="memory.create", now=150,
                             operation_id="op-1", fail_operation=False):
        consumer_id = "staging-operation:" + operation_id
        try:
            self.db.execute("BEGIN IMMEDIATE")
            self.db.execute(CONSUME, (now, consumer_id, grant_id,
                                      owner, capability, now))
            self.db.execute(ASSERT_ONE_CHANGE)
            if fail_operation:
                self.db.execute("""
                    INSERT INTO protected_operations(id,owner_uid,capability,payload)
                    VALUES (?, ?, ?, NULL)
                """, (operation_id, owner, capability))
            else:
                self.db.execute("""
                    INSERT INTO protected_operations(id,owner_uid,capability,payload)
                    SELECT ?, ?, ?, 'committed'
                    WHERE EXISTS (
                        SELECT 1 FROM intelligence_capability_approvals
                        WHERE id=? AND owner_uid=? AND capability=?
                          AND scope='owner_staging' AND status='consumed'
                          AND consumed_by=? AND consumed_at=?
                    )
                """, (operation_id, owner, capability, grant_id, owner,
                      capability, consumer_id, now))
            self.db.execute(ASSERT_ONE_CHANGE)
            self.db.commit()
            return True
        except sqlite3.DatabaseError:
            self.db.rollback()
            return False

    def test_only_one_of_two_sequential_uses_can_consume(self):
        self.assertTrue(self.run_atomic_operation(operation_id="op-first"))
        self.assertFalse(self.run_atomic_operation(operation_id="op-second"))
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM protected_operations"
        ).fetchone()[0], 1)
        self.assertEqual(self.db.execute("""
            SELECT status, consumed_by FROM intelligence_capability_approvals
            WHERE id='grant-valid'
        """).fetchone(), ("consumed", "staging-operation:op-first"))
        self.assertEqual(self.db.execute("""
            SELECT COUNT(*) FROM intelligence_staging_audit
            WHERE target_id='grant-valid' AND action='capability_approval_consumed'
        """).fetchone()[0], 1)

    def test_two_simultaneous_contenders_commit_exactly_one_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "concurrent.sqlite"
            setup = sqlite3.connect(db_path)
            setup.execute("PRAGMA foreign_keys=ON")
            for migration in MIGRATIONS:
                setup.executescript(migration.read_text(encoding="utf-8"))
            setup.execute("""
                CREATE TABLE protected_operations (
                    id TEXT PRIMARY KEY,
                    owner_uid TEXT NOT NULL,
                    capability TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
            """)
            setup.execute("""
                INSERT INTO intelligence_capability_approvals
                (id,owner_uid,capability,scope,status,issued_at,expires_at)
                VALUES ('grant-valid','owner-a','memory.create','owner_staging','issued',100,200)
            """)
            setup.commit()
            setup.close()

            barrier = threading.Barrier(2)

            def contender(request_id):
                conn = sqlite3.connect(db_path, timeout=15)
                conn.execute("PRAGMA foreign_keys=ON")
                try:
                    barrier.wait(timeout=10)
                    conn.execute("BEGIN IMMEDIATE")
                    consumer_id = "staging-operation:" + request_id
                    conn.execute(CONSUME, (
                        150, consumer_id, "grant-valid", "owner-a",
                        "memory.create", 150
                    ))
                    conn.execute(ASSERT_ONE_CHANGE)
                    conn.execute("""
                        INSERT INTO protected_operations(id,owner_uid,capability,payload)
                        SELECT ?, 'owner-a', 'memory.create', 'committed'
                        WHERE EXISTS (
                            SELECT 1 FROM intelligence_capability_approvals
                            WHERE id='grant-valid' AND owner_uid='owner-a'
                              AND capability='memory.create' AND scope='owner_staging'
                              AND status='consumed' AND consumed_by=? AND consumed_at=150
                        )
                    """, (request_id, consumer_id))
                    conn.execute(ASSERT_ONE_CHANGE)
                    conn.commit()
                    return True
                except (sqlite3.DatabaseError, threading.BrokenBarrierError):
                    conn.rollback()
                    return False
                finally:
                    conn.close()

            with ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(contender, ["request-a", "request-b"]))

            verify = sqlite3.connect(db_path)
            self.assertEqual(sorted(outcomes), [False, True])
            self.assertEqual(verify.execute(
                "SELECT COUNT(*) FROM protected_operations"
            ).fetchone()[0], 1)
            self.assertEqual(verify.execute("""
                SELECT status FROM intelligence_capability_approvals
                WHERE id='grant-valid'
            """).fetchone()[0], "consumed")
            self.assertEqual(verify.execute("""
                SELECT COUNT(*) FROM intelligence_staging_audit
                WHERE target_id='grant-valid' AND action='capability_approval_consumed'
            """).fetchone()[0], 1)
            verify.close()

    def test_wrong_owner_capability_and_expired_grant_fail_closed(self):
        self.assertFalse(self.run_atomic_operation(owner="owner-b"))
        self.assertFalse(self.run_atomic_operation(capability="memory.delete"))
        self.assertFalse(self.run_atomic_operation(now=200))
        self.assertEqual(self.db.execute("""
            SELECT status FROM intelligence_capability_approvals
            WHERE id='grant-valid'
        """).fetchone()[0], "issued")
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM protected_operations"
        ).fetchone()[0], 0)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 0)

    def test_operation_failure_rolls_back_consumption_and_its_audit(self):
        self.assertFalse(self.run_atomic_operation(fail_operation=True))
        self.assertEqual(self.db.execute("""
            SELECT status, consumed_at, consumed_by
            FROM intelligence_capability_approvals WHERE id='grant-valid'
        """).fetchone(), ("issued", None, None))
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 0)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM protected_operations"
        ).fetchone()[0], 0)

    def test_revoked_grant_cannot_be_consumed(self):
        self.db.execute("""
            UPDATE intelligence_capability_approvals
            SET status='revoked', revoked_at=120 WHERE id='grant-valid'
        """)
        self.db.commit()
        self.assertFalse(self.run_atomic_operation())
        self.assertEqual(self.db.execute("""
            SELECT status FROM intelligence_capability_approvals
            WHERE id='grant-valid'
        """).fetchone()[0], "revoked")
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM protected_operations"
        ).fetchone()[0], 0)

if __name__ == "__main__":
    unittest.main(verbosity=2)
