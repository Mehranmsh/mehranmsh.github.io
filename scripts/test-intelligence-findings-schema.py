#!/usr/bin/env python3
"""Exercise the Findings schema in a disposable SQLite database only."""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "migrations" / f"{n:04d}_{name}.sql"
    for n, name in [
        (0, "intelligence_staging_baseline"),
        (1, "intelligence_approval_ledger"),
        (2, "intelligence_knowledge_relations"),
        (3, "intelligence_staging_runtime"),
        (4, "intelligence_knowledge_provenance"),
        (5, "intelligence_owner_memory_governance"),
        (6, "intelligence_owner_memory_confidence_integer"),
        (7, "intelligence_approval_ledger_state_guards"),
        (8, "intelligence_capability_approval_ledger"),
        (9, "intelligence_findings_schema"),
    ]
]

class FindingsSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for path in MIGRATIONS:
            self.db.executescript(path.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def insert_finding(self, **overrides):
        row = {
            "id": "finding-a", "owner_uid": "owner-a", "module_id": "security",
            "check_id": "security-access-control", "blueprint_version": "1",
            "severity": "high", "status": "open", "title": "Access review needed",
            "description": "The access review evidence has not yet been collected.",
            "evidence_state": "missing", "recommendation": "Review role assignments.",
            "status_reason": None, "review_due_at": None, "created_at": 100,
            "updated_at": 100, "created_by": "owner",
        }
        row.update(overrides)
        columns = ",".join(row)
        marks = ",".join("?" for _ in row)
        self.db.execute(
            f"INSERT INTO intelligence_findings({columns}) VALUES({marks})",
            tuple(row.values())
        )

    def test_migration_chain_and_required_tables(self):
        tables = {r[0] for r in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertTrue({
            "intelligence_findings", "intelligence_finding_evidence",
            "intelligence_staging_audit"
        }.issubset(tables))
        cols = {r[1] for r in self.db.execute(
            "PRAGMA table_info(intelligence_findings)"
        )}
        self.assertNotIn("outcome", cols)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_missing_evidence_defaults_to_unknown_semantics_not_pass(self):
        self.insert_finding()
        row = self.db.execute(
            "SELECT evidence_state,status FROM intelligence_findings WHERE id='finding-a'"
        ).fetchone()
        self.assertEqual(row, ("missing", "open"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(id="finding-b", evidence_state="pass")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(id="finding-c", evidence_state="sufficient", status="pass")

    def test_sufficient_evidence_and_resolution_require_attached_references(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(evidence_state="sufficient")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(status="resolved", status_reason="Claimed resolved")
        self.insert_finding()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_findings
                SET evidence_state='sufficient',updated_at=110
                WHERE id='finding-a' AND owner_uid='owner-a'
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_findings
                SET status='resolved',status_reason='No evidence',updated_at=110
                WHERE id='finding-a' AND owner_uid='owner-a'
            """)
        self.db.execute("""
            INSERT INTO intelligence_finding_evidence
            (id,finding_id,owner_uid,kind,source_ref,note,created_at)
            VALUES('evidence-a','finding-a','owner-a','test_run','ci-run-321','Reviewed test result',111)
        """)
        self.db.execute("""
            UPDATE intelligence_findings
            SET evidence_state='sufficient',updated_at=112
            WHERE id='finding-a' AND owner_uid='owner-a'
        """)
        self.db.execute("""
            UPDATE intelligence_findings
            SET status='resolved',status_reason='Owner reviewed current evidence',
                updated_at=113
            WHERE id='finding-a' AND owner_uid='owner-a'
        """)
        row = self.db.execute("""
            SELECT evidence_state,status FROM intelligence_findings
            WHERE id='finding-a' AND owner_uid='owner-a'
        """).fetchone()
        self.assertEqual(row, ("sufficient", "resolved"))

    def test_owner_scoped_evidence_foreign_key(self):
        self.insert_finding()
        self.db.execute("""
            INSERT INTO intelligence_finding_evidence
            (id,finding_id,owner_uid,kind,source_ref,note,created_at)
            VALUES('evidence-a','finding-a','owner-a','test_run','ci-run-123','CI run reference',101)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_finding_evidence
                (id,finding_id,owner_uid,kind,source_ref,note,created_at)
                VALUES('evidence-b','finding-a','owner-b','test_run','ci-run-124','Cross-owner',101)
            """)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_evidence_metadata_rejects_urls_paths_and_bad_digests(self):
        self.insert_finding()
        bad_refs = ["https://example.com", "/etc/passwd", "../secret", "folder/file", "token value"]
        for i, ref in enumerate(bad_refs):
            with self.subTest(ref=ref), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("""
                    INSERT INTO intelligence_finding_evidence
                    (id,finding_id,owner_uid,kind,source_ref,note,created_at)
                    VALUES(?,?,?,?,?,?,?)
                """, (f"bad-{i}", "finding-a", "owner-a", "other", ref, "metadata only", 102))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_finding_evidence
                (id,finding_id,owner_uid,kind,source_ref,content_digest,note,created_at)
                VALUES('bad-digest','finding-a','owner-a','other','artifact-ref','not-a-sha','note',102)
            """)

    def test_enum_and_text_bounds_are_database_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(severity="emergency")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(id="finding-b", status="deleted")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(id="finding-c", title="   ")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding(id="finding-d", description="")

    def test_status_and_severity_changes_require_reason_and_audit(self):
        self.insert_finding()
        before = self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit WHERE target_id='finding-a'"
        ).fetchone()[0]
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_findings SET status='accepted',review_due_at=200,updated_at=110
                WHERE id='finding-a'
            """)
        self.db.execute("""
            UPDATE intelligence_findings
            SET status='accepted',status_reason='Owner accepts temporarily',
                review_due_at=200,updated_at=110
            WHERE id='finding-a' AND owner_uid='owner-a'
        """)
        self.db.execute("""
            UPDATE intelligence_findings
            SET severity='medium',status_reason='Evidence lowered the assessed risk',
                updated_at=120
            WHERE id='finding-a' AND owner_uid='owner-a'
        """)
        after = self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit WHERE target_id='finding-a'"
        ).fetchone()[0]
        self.assertEqual(after - before, 2)

    def test_finding_and_evidence_history_cannot_be_deleted_or_rewritten(self):
        self.insert_finding()
        self.db.execute("""
            INSERT INTO intelligence_finding_evidence
            (id,finding_id,owner_uid,kind,source_ref,note,created_at)
            VALUES('evidence-a','finding-a','owner-a','document','doc-ref-1','Reviewed document',101)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_findings WHERE id='finding-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_finding_evidence WHERE id='evidence-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_finding_evidence SET note='rewritten' WHERE id='evidence-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_findings SET owner_uid='owner-b' WHERE id='finding-a'")

    def test_audit_failure_rolls_back_finding_insert(self):
        self.db.execute("""
            CREATE TRIGGER reject_finding_audit BEFORE INSERT ON intelligence_staging_audit
            WHEN NEW.target_type='finding'
            BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_finding()
        count = self.db.execute(
            "SELECT COUNT(*) FROM intelligence_findings WHERE id='finding-a'"
        ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_audit_failure_rolls_back_evidence_insert(self):
        self.insert_finding()
        self.db.execute("""
            CREATE TRIGGER reject_evidence_audit BEFORE INSERT ON intelligence_staging_audit
            WHEN NEW.target_type='finding_evidence'
            BEGIN SELECT RAISE(ABORT, 'simulated audit outage'); END
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_finding_evidence
                (id,finding_id,owner_uid,kind,source_ref,note,created_at)
                VALUES('evidence-a','finding-a','owner-a','other','ref-a','Evidence',101)
            """)
        count = self.db.execute(
            "SELECT COUNT(*) FROM intelligence_finding_evidence WHERE id='evidence-a'"
        ).fetchone()[0]
        self.assertEqual(count, 0)

if __name__ == "__main__":
    unittest.main(verbosity=2)
