"""SQLite compatibility smoke tests for the proposed Cloudflare D1 schema.

These tests validate SQLite DDL/constraints locally. They are not a substitute
for integration tests against a disposable Cloudflare D1 database.
"""
import json
import pathlib
import sqlite3
import tempfile
import unittest


SCHEMA = pathlib.Path(__file__).with_name("pi-testnet-observation-d1-schema.sql")


class D1SchemaCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA.read_text(encoding="utf-8"))
        self.scope = "pi-testnet-observations"
        self.archive_id = "a" * 64
        self.source_hash = "b" * 64
        self.replacement_hash = "c" * 64
        self.envelope = {
            "schemaVersion": 1,
            "algorithm": "aes-256-gcm",
            "archiveScope": self.scope,
            "archiveId": self.archive_id,
            "keyId": "key-1",
            "iv": "AA==",
            "tag": "AA==",
            "ciphertext": "AA==",
        }
        self.envelope_json = json.dumps(self.envelope, separators=(",", ":"))
        self.db.execute(
            """INSERT INTO pi_testnet_archives
               (archive_scope, archive_id, envelope_json, envelope_sha256, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (self.scope, self.archive_id, self.envelope_json,
             self.source_hash, "2026-11-26T00:00:00Z"),
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_archive_envelope_must_match_scope_and_id(self):
        bad = dict(self.envelope, archiveId="f" * 64)
        with self.assertRaises(sqlite3.Error):
            self.db.execute(
                """INSERT INTO pi_testnet_archives
                   (archive_scope, archive_id, envelope_json, envelope_sha256, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (self.scope, "d" * 64, json.dumps(bad), "e" * 64, "now"),
            )

    def test_replacement_envelope_must_match_operation_scope_and_id(self):
        bad = dict(self.envelope, archiveId="f" * 64)
        with self.assertRaises(sqlite3.Error):
            self.db.execute(
                """INSERT INTO pi_testnet_archive_replacement_ops
                   (operation_id, archive_scope, archive_id, source_sha256,
                    replacement_sha256, replacement_envelope_json,
                    prepared_record_json, prepared_record_sha256, state)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared')""",
                ("op-bad", self.scope, self.archive_id, self.source_hash,
                 self.replacement_hash, json.dumps(bad), "{}", "d" * 64),
            )

    def test_operation_state_transition_is_one_way_and_fields_are_immutable(self):
        self.db.execute(
            """INSERT INTO pi_testnet_archive_replacement_ops
               (operation_id, archive_scope, archive_id, source_sha256,
                replacement_sha256, replacement_envelope_json,
                prepared_record_json, prepared_record_sha256, state)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared')""",
            ("op-1", self.scope, self.archive_id, self.source_hash,
             self.replacement_hash, self.envelope_json, "{}", "d" * 64),
        )
        self.db.execute(
            "UPDATE pi_testnet_archive_replacement_ops SET state='committed' WHERE operation_id='op-1'"
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE pi_testnet_archive_replacement_ops SET archive_id=? WHERE operation_id='op-1'",
                ("f" * 64,),
            )
        self.db.commit()

    def _run_phase1(self, db, operation_id, replacement_hash, replacement_json,
                    prepared_json, prepared_hash):
        db.execute(
            """INSERT INTO pi_testnet_archive_replacement_ops
               (operation_id, archive_scope, archive_id, source_sha256,
                replacement_sha256, replacement_envelope_json,
                prepared_record_json, prepared_record_sha256, state)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'prepared'
               WHERE EXISTS (
                 SELECT 1 FROM pi_testnet_archives
                 WHERE archive_scope=? AND archive_id=? AND envelope_sha256=?
               )
               ON CONFLICT(operation_id) DO NOTHING""",
            (operation_id, self.scope, self.archive_id, self.source_hash,
             replacement_hash, replacement_json, prepared_json, prepared_hash,
             self.scope, self.archive_id, self.source_hash),
        )
        changed = db.execute(
            """UPDATE pi_testnet_archives
               SET envelope_json=?, envelope_sha256=?
               WHERE archive_scope=? AND archive_id=? AND envelope_sha256=?
                 AND EXISTS (
                   SELECT 1 FROM pi_testnet_archive_replacement_ops
                   WHERE operation_id=? AND state='prepared'
                     AND archive_scope=? AND archive_id=?
                     AND source_sha256=? AND replacement_sha256=?
                     AND replacement_envelope_json=?
                     AND prepared_record_json=? AND prepared_record_sha256=?
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM pi_testnet_archive_replacement_journal
                   WHERE operation_id=? AND sequence=1
                     AND (state<>'prepared' OR record_json<>? OR record_sha256<>?)
                 )""",
            (replacement_json, replacement_hash, self.scope, self.archive_id,
             self.source_hash, operation_id, self.scope, self.archive_id,
             self.source_hash, replacement_hash, replacement_json,
             prepared_json, prepared_hash, operation_id, prepared_json, prepared_hash),
        ).rowcount
        db.execute(
            """INSERT INTO pi_testnet_archive_replacement_journal
               (operation_id, sequence, state, record_json, record_sha256)
               SELECT operation_id, 1, 'prepared', prepared_record_json, prepared_record_sha256
               FROM pi_testnet_archive_replacement_ops
               WHERE operation_id=? AND state='prepared'
               ON CONFLICT(operation_id, sequence) DO NOTHING""",
            (operation_id,),
        )
        return changed

    def test_two_competing_operations_only_one_can_replace_the_same_source(self):
        replacement_a = dict(self.envelope, ciphertext="replacement-A")
        replacement_b = dict(self.envelope, ciphertext="replacement-B")
        json_a = json.dumps(replacement_a, separators=(",", ":"))
        json_b = json.dumps(replacement_b, separators=(",", ":"))
        hash_a, hash_b = "c" * 64, "d" * 64
        prepared_a, prepared_b = '{"op":"A"}', '{"op":"B"}'
        prepared_hash_a, prepared_hash_b = "e" * 64, "f" * 64

        # Two connections share one SQLite database, like separate callers
        # submitting serialized atomic batches to the same D1 database.
        with tempfile.TemporaryDirectory() as directory:
            database_path = pathlib.Path(directory) / "race.sqlite"
            first = sqlite3.connect(database_path, timeout=5)
            second = sqlite3.connect(database_path, timeout=5)
            try:
                for db in (first, second):
                    db.execute("PRAGMA foreign_keys = ON")
                first.executescript(SCHEMA.read_text(encoding="utf-8"))
                first.execute(
                    """INSERT INTO pi_testnet_archives
                       (archive_scope, archive_id, envelope_json, envelope_sha256, updated_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (self.scope, self.archive_id, self.envelope_json,
                     self.source_hash, "2026-11-26T00:00:00Z"),
                )
                first.commit()

                first.execute("BEGIN IMMEDIATE")
                changed_a = self._run_phase1(
                    first, "op-A", hash_a, json_a, prepared_a, prepared_hash_a
                )
                first.commit()

                second.execute("BEGIN IMMEDIATE")
                changed_b = self._run_phase1(
                    second, "op-B", hash_b, json_b, prepared_b, prepared_hash_b
                )
                second.commit()

                self.assertEqual(changed_a, 1)
                self.assertEqual(changed_b, 0)
                winner = second.execute(
                    "SELECT envelope_sha256 FROM pi_testnet_archives WHERE archive_scope=? AND archive_id=?",
                    (self.scope, self.archive_id),
                ).fetchone()[0]
                self.assertEqual(winner, hash_a)
                operations = second.execute(
                    "SELECT operation_id FROM pi_testnet_archive_replacement_ops ORDER BY operation_id"
                ).fetchall()
                self.assertEqual(operations, [("op-A",)])
                journal = second.execute(
                    "SELECT operation_id, sequence FROM pi_testnet_archive_replacement_journal"
                ).fetchall()
                self.assertEqual(journal, [("op-A", 1)])
            finally:
                first.close()
                second.close()

    def test_reused_operation_id_with_different_payload_cannot_replace_archive(self):
        replacement_a = dict(self.envelope, ciphertext="original-operation")
        replacement_b = dict(self.envelope, ciphertext="substituted-operation")
        json_a = json.dumps(replacement_a, separators=(",", ":"))
        json_b = json.dumps(replacement_b, separators=(",", ":"))
        self.db.execute("BEGIN IMMEDIATE")
        self._run_phase1(self.db, "same-op", "c" * 64, json_a, '{"op":"same"}', "e" * 64)
        self.db.commit()

        self.db.execute("BEGIN IMMEDIATE")
        changed = self._run_phase1(
            self.db, "same-op", "d" * 64, json_b, '{"op":"changed"}', "f" * 64
        )
        self.db.commit()
        self.assertEqual(changed, 0)
        row = self.db.execute(
            "SELECT envelope_sha256, envelope_json FROM pi_testnet_archives"
        ).fetchone()
        self.assertEqual(row, ("c" * 64, json_a))
        operation = self.db.execute(
            "SELECT replacement_sha256, replacement_envelope_json, prepared_record_json "
            "FROM pi_testnet_archive_replacement_ops WHERE operation_id='same-op'"
        ).fetchone()
        self.assertEqual(operation, ("c" * 64, json_a, '{"op":"same"}'))

    def test_journal_is_append_only(self):
        self.db.execute(
            """INSERT INTO pi_testnet_archive_replacement_ops
               (operation_id, archive_scope, archive_id, source_sha256,
                replacement_sha256, replacement_envelope_json,
                prepared_record_json, prepared_record_sha256, state)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared')""",
            ("op-2", self.scope, self.archive_id, self.source_hash,
             self.replacement_hash, self.envelope_json, "{}", "d" * 64),
        )
        self.db.execute(
            """INSERT INTO pi_testnet_archive_replacement_journal
               (operation_id, sequence, state, record_json, record_sha256)
               VALUES ('op-2', 1, 'prepared', '{}', ?)""",
            ("e" * 64,),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE pi_testnet_archive_replacement_journal SET record_json='{}' WHERE operation_id='op-2'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "DELETE FROM pi_testnet_archive_replacement_journal WHERE operation_id='op-2'"
            )


if __name__ == "__main__":
    unittest.main()
