#!/usr/bin/env python3
"""Execute the Intelligence approval-ledger migration against disposable SQLite."""
from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0001_intelligence_approval_ledger.sql"


class ApprovalLedgerMigrationTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute(
            "CREATE TABLE intelligence_tasks (id TEXT PRIMARY KEY)"
        )
        self.connection.execute(
            "INSERT INTO intelligence_tasks(id) VALUES ('task-1')"
        )
        self.sql = MIGRATION.read_text(encoding="utf-8")

    def tearDown(self):
        self.connection.close()

    def apply_migration(self):
        self.connection.executescript(self.sql)

    def insert_grant(self, grant_id, task_id="task-1", owner_uid="owner-1", status="issued"):
        self.connection.execute(
            """
            INSERT INTO intelligence_approval_ledger(
                id, task_id, owner_uid, owner_username, repository, branch,
                base_sha, scope_json, scope_sha256, status, issued_at, expires_at
            ) VALUES (?, ?, ?, 'mehranmsh', 'Mehranmsh/mehranmsh.github.io',
                      'intelligence/patch-testbranch', ?, '{}', ?, ?, 100, 200)
            """,
            (grant_id, task_id, owner_uid, "a" * 40, "b" * 64, status),
        )

    def test_migration_executes_and_is_idempotent(self):
        self.apply_migration()
        self.apply_migration()
        columns = {
            row[1]: (row[2], row[3], row[4])
            for row in self.connection.execute(
                "PRAGMA table_info(intelligence_approval_ledger)"
            )
        }
        self.assertEqual(
            set(columns),
            {
                "id", "task_id", "owner_uid", "owner_username", "repository",
                "branch", "base_sha", "scope_json", "scope_sha256", "status",
                "issued_at", "expires_at", "revoked_at", "consumed_at",
                "consumed_by", "created_at",
            },
        )
        self.assertEqual(columns["status"][2], "'issued'")
        indexes = {
            row[1] for row in self.connection.execute(
                "PRAGMA index_list(intelligence_approval_ledger)"
            )
        }
        self.assertTrue({
            "idx_intelligence_approval_task",
            "idx_intelligence_approval_owner",
            "idx_intelligence_approval_active_task",
        }.issubset(indexes))
        foreign_keys = list(
            self.connection.execute("PRAGMA foreign_key_list(intelligence_approval_ledger)")
        )
        self.assertTrue(any(
            row[2] == "intelligence_tasks" and row[3] == "task_id" and row[4] == "id"
            for row in foreign_keys
        ))

    def test_foreign_key_rejects_unknown_task(self):
        self.apply_migration()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_grant("grant-invalid", task_id="missing-task")

    def test_status_check_rejects_unknown_state(self):
        self.apply_migration()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_grant("grant-invalid", status="approved")

    def test_only_one_active_grant_per_task_and_owner(self):
        self.apply_migration()
        self.insert_grant("grant-1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_grant("grant-2")
        self.connection.execute(
            "UPDATE intelligence_approval_ledger SET status='revoked' WHERE id='grant-1'"
        )
        self.insert_grant("grant-2")
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) FROM intelligence_approval_ledger WHERE status='issued'"
            ).fetchone()[0],
            1,
        )

    def test_active_grants_are_scoped_by_owner(self):
        self.apply_migration()
        self.insert_grant("grant-1")
        self.insert_grant("grant-2", owner_uid="owner-2")
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) FROM intelligence_approval_ledger WHERE status='issued'"
            ).fetchone()[0],
            2,
        )


    def test_worker_bootstrap_schema_matches_migration(self):
        import re

        worker_source = (ROOT / "worker.js").read_text(encoding="utf-8")
        helper = re.search(
            r"async function ensureIntelligenceApprovalLedgerTable\(env\)\s*\{\s*"
            r"await env\.DB\.prepare\(`([\s\S]*?)`\)\.run\(\);"
            r"([\s\S]*?)\n\}",
            worker_source,
        )
        self.assertIsNotNone(helper, "Worker approval-ledger bootstrap helper must exist")

        worker_db = sqlite3.connect(":memory:")
        try:
            worker_db.execute("PRAGMA foreign_keys = ON")
            worker_db.execute("CREATE TABLE intelligence_tasks (id TEXT PRIMARY KEY)")
            worker_db.executescript(helper.group(1))
            index_sql = re.findall(
                r'env\.DB\.prepare\("(CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [^"]+)"\)\.run\(\)',
                helper.group(2),
            )
            self.assertEqual(len(index_sql), 3, "Worker helper must define all three indexes")
            for statement in index_sql:
                worker_db.execute(statement)

            self.apply_migration()
            table_info_migration = list(self.connection.execute(
                "PRAGMA table_info(intelligence_approval_ledger)"
            ))
            table_info_worker = list(worker_db.execute(
                "PRAGMA table_info(intelligence_approval_ledger)"
            ))
            self.assertEqual(table_info_worker, table_info_migration)

            fk_migration = list(self.connection.execute(
                "PRAGMA foreign_key_list(intelligence_approval_ledger)"
            ))
            fk_worker = list(worker_db.execute(
                "PRAGMA foreign_key_list(intelligence_approval_ledger)"
            ))
            self.assertEqual(fk_worker, fk_migration)

            indexes_migration = sorted(
                (row[1], row[2], row[4])
                for row in self.connection.execute(
                    "PRAGMA index_list(intelligence_approval_ledger)"
                )
            )
            indexes_worker = sorted(
                (row[1], row[2], row[4])
                for row in worker_db.execute(
                    "PRAGMA index_list(intelligence_approval_ledger)"
                )
            )
            self.assertEqual(indexes_worker, indexes_migration)
        finally:
            worker_db.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
