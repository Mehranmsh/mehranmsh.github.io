#!/usr/bin/env python3
"""Prove one-time capability approval consumption and mutation are atomic in SQLite."""
from pathlib import Path
import sqlite3
import tempfile
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
    ]
]

CONSUME = """
UPDATE intelligence_capability_approvals
SET status='consumed', consumed_at=?, consumed_by=?
WHERE id=? AND owner_uid=? AND capability=? AND scope='owner_staging'
  AND status='issued' AND expires_at>? AND revoked_at IS NULL
  AND consumed_at IS NULL AND consumed_by IS NULL
"""
# In a D1 batch, every statement runs in one transaction. This deliberate
# constraint violation aborts the batch if the immediately preceding statement
# did not change exactly one row. The audit table's details_json is NOT NULL.
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
        try:
            self.db.execute("BEGIN IMMEDIATE")
            self.db.execute(CONSUME, (now, "staging-operation", grant_id,
                                      owner, capability, now))
            self.db.execute(ASSERT_ONE_CHANGE)
            if fail_operation:
                # Simulate a protected mutation that fails a database constraint.
                self.db.execute("""
                    INSERT INTO protected_operations(id,owner_uid,capability,payload)
                    VALUES (?, ?, ?, NULL)
                """, (operation_id, owner, capability))
            else:
                self.db.execute("""
                    INSERT INTO protected_operations(id,owner_uid,capability,payload)
                    SELECT ?, ?, ?, 'committed'
                    WHERE changes() = 1
                """, (operation_id, owner, capability))
            self.db.execute(ASSERT_ONE_CHANGE)
            self.db.commit()
            return True
        except sqlite3.DatabaseError:
            self.db.rollback()
            return False

    def test_only_one_of_two_competing_uses_can_consume(self):
        self.assertTrue(self.run_atomic_operation(operation_id="op-first"))
        self.assertFalse(self.run_atomic_operation(operation_id="op-second"))
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM protected_operations"
        ).fetchone()[0], 1)
        self.assertEqual(self.db.execute("""
            SELECT status, consumed_by FROM intelligence_capability_approvals
            WHERE id='grant-valid'
        """).fetchone(), ("consumed", "staging-operation"))
        self.assertEqual(self.db.execute("""
            SELECT COUNT(*) FROM intelligence_staging_audit
            WHERE target_id='grant-valid' AND action='capability_approval_consumed'
        """).fetchone()[0], 1)

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
