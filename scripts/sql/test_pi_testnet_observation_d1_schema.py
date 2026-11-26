"""SQLite compatibility smoke tests for the proposed Cloudflare D1 schema.

These tests validate SQLite DDL/constraints locally. They are not a substitute
for integration tests against a disposable Cloudflare D1 database.
"""
import json
import pathlib
import sqlite3
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
