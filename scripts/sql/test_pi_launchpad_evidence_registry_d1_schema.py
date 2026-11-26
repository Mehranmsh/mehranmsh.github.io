"""SQLite compatibility tests for the proposed Pi Launchpad evidence D1 schema.

These tests exercise local SQLite constraints only. They do not apply the schema
to Cloudflare D1 and do not test a live persistence adapter.
"""
import json
import pathlib
import sqlite3
import unittest

SCHEMA = pathlib.Path(__file__).with_name("pi-launchpad-evidence-registry-d1-schema.sql")


class PiLaunchpadEvidenceD1SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SCHEMA.read_text(encoding="utf-8"))
        self.row = (
            "plev_" + "a" * 32,
            "pi-mainnet",
            "asset:issuer:PIEX",
            "project-utility-1",
            "official_project_claim",
            "utility",
            json.dumps(75),
            json.dumps({
                "source": {
                    "sourceId": "project-site",
                    "kind": "official_project",
                    "url": "https://project.example/token"
                },
                "observedAt": "2026-11-26T17:30:00.000Z"
            }),
            "unverified",
            "not_verified",
            "blocked_pending_independent_chain_verification",
            "0.1.0",
            "2026-11-26T17:31:00.000Z"
        )

    def tearDown(self):
        self.db.close()

    def insert(self, row=None):
        self.db.execute(
            """INSERT INTO pi_launchpad_evidence_records
               (record_id, network_id, asset_identifier, evidence_id, evidence_type,
                field_name, value_json, provenance_json, verification_status,
                chain_verification_status, scoring_status, registry_version, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            row or self.row
        )

    def test_accepts_separate_mainnet_and_testnet_evidence_records(self):
        self.insert()
        testnet = list(self.row)
        testnet[0] = "plev_" + "b" * 32
        testnet[1] = "pi-testnet"
        self.insert(tuple(testnet))
        rows = self.db.execute(
            "SELECT network_id, count(*) FROM pi_launchpad_evidence_records GROUP BY network_id"
        ).fetchall()
        self.assertEqual(rows, [("pi-mainnet", 1), ("pi-testnet", 1)])

    def test_rejects_unknown_network_and_invalid_record_identifier(self):
        bad_network = list(self.row)
        bad_network[1] = "stellar-mainnet"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(tuple(bad_network))
        bad_id = list(self.row)
        bad_id[0] = "plev_not-a-valid-digest"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(tuple(bad_id))

    def test_rejects_any_chain_verification_or_scoring_promotion(self):
        bad_chain = list(self.row)
        bad_chain[9] = "independently_recomputed"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(tuple(bad_chain))
        bad_score = list(self.row)
        bad_score[10] = "eligible"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(tuple(bad_score))

    def test_rejects_invalid_provenance_and_evidence_class(self):
        bad_provenance = list(self.row)
        bad_provenance[7] = json.dumps({"source": {}, "observedAt": "now"})
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(tuple(bad_provenance))
        bad_type = list(self.row)
        bad_type[4] = "verified_chain_truth"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(tuple(bad_type))

    def test_record_is_append_only(self):
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE pi_launchpad_evidence_records SET verification_status='signature_verified'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM pi_launchpad_evidence_records")

    def test_duplicate_record_id_is_rejected(self):
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert()


if __name__ == "__main__":
    unittest.main()
