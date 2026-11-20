#!/usr/bin/env python3
"""Verify the isolated Intelligence staging schema chain in disposable SQLite."""
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
    ROOT / "migrations" / "0007_intelligence_approval_ledger_state_guards.sql",
    ROOT / "migrations" / "0008_intelligence_capability_approval_ledger.sql",
    ROOT / "migrations" / "0009_intelligence_findings_schema.sql",
    ROOT / "migrations" / "0010_intelligence_finding_review_ledger.sql",
    ROOT / "migrations" / "0011_intelligence_evidence_correlation_reviews.sql",
    ROOT / "migrations" / "0012_intelligence_evidence_decision_reviews.sql",
    ROOT / "migrations" / "0013_intelligence_priority_action_reviews.sql",
    ROOT / "migrations" / "0014_intelligence_owner_identity_immutability.sql",
    ROOT / "migrations" / "0015_intelligence_task_execution_disabled.sql",
    ROOT / "migrations" / "0016_intelligence_capability_approval_allowlist.sql",
    ROOT / "migrations" / "0017_intelligence_audit_immutability_and_approval_timestamps.sql",
]

class IntelligenceStagingSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")

    def tearDown(self):
        self.db.close()

    def apply_chain(self):
        for path in MIGRATIONS:
            self.db.executescript(path.read_text(encoding="utf-8"))

    def test_ordered_migration_chain_and_idempotence(self):
        self.apply_chain()
        # 0004 and 0005 are one-time additive ALTER TABLE migrations;
        # only the original CREATE IF NOT EXISTS migrations are repeatable.
        for path in MIGRATIONS[:4]:
            self.db.executescript(path.read_text(encoding="utf-8"))
        tables = {row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertTrue({
            "intelligence_tasks",
            "intelligence_knowledge",
            "intelligence_approval_ledger",
            "intelligence_knowledge_relations",
            "intelligence_staging_sessions",
            "intelligence_staging_audit",
            "intelligence_staging_rate_limits",
            "intelligence_owner_memory",
            "intelligence_capability_approvals",
            "intelligence_findings",
            "intelligence_finding_evidence",
            "intelligence_finding_reviews",
            "intelligence_evidence_correlation_reviews",
            "intelligence_evidence_decision_reviews",
        }.issubset(tables))
        memory_columns = {row[1] for row in self.db.execute("PRAGMA table_info(intelligence_owner_memory)")}
        self.assertTrue({"memory_kind", "source_type", "source_ref", "confidence_score", "review_status", "reviewed_at", "archived_at"}.issubset(memory_columns))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        approval_fks = list(self.db.execute(
            "PRAGMA foreign_key_list(intelligence_approval_ledger)"
        ))
        relation_fks = list(self.db.execute(
            "PRAGMA foreign_key_list(intelligence_knowledge_relations)"
        ))
        self.assertTrue(any(row[2] == "intelligence_tasks" for row in approval_fks))
        self.assertTrue(any(row[2] == "intelligence_knowledge" for row in relation_fks))




    def test_capability_approval_database_allowlist_rejects_memory_delete(self):
        self.apply_chain()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_capability_approvals(
                    id,owner_uid,capability,scope,status,issued_at,expires_at
                ) VALUES('grant-delete','owner-a','memory.delete','owner_staging','issued',100,200)
            """)
        self.db.execute("""
            INSERT INTO intelligence_capability_approvals(
                id,owner_uid,capability,scope,status,issued_at,expires_at
            ) VALUES('grant-create','owner-a','memory.create','owner_staging','issued',100,200)
        """)
        self.assertEqual(self.db.execute(
            "SELECT capability FROM intelligence_capability_approvals WHERE id='grant-create'"
        ).fetchone()[0], "memory.create")

    def test_knowledge_and_memory_owner_identity_is_immutable(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES('owner-lock-knowledge','owner-a','Private','Owner-bound knowledge','owner-a')
        """)
        self.db.execute("""
            INSERT INTO intelligence_owner_memory(id,owner_uid,category,content)
            VALUES('owner-lock-memory','owner-a','general','Owner-bound memory')
        """)
        for table, record_id in (
            ('intelligence_knowledge', 'owner-lock-knowledge'),
            ('intelligence_owner_memory', 'owner-lock-memory'),
        ):
            with self.subTest(table=table):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(
                        f"UPDATE {table} SET owner_uid='owner-b' WHERE id=?",
                        (record_id,),
                    )
                owner = self.db.execute(
                    f"SELECT owner_uid FROM {table} WHERE id=?", (record_id,)
                ).fetchone()[0]
                self.assertEqual(owner, 'owner-a')

    def test_owner_finding_review_ledger_is_append_only_scoped_and_audited(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_findings(
                id,owner_uid,module_id,check_id,blueprint_version,title,description,
                created_at,updated_at,created_by
            ) VALUES(
                '00000000-0000-4000-8000-000000000001','owner-a','security',
                'auditability','v1','Audit review','Check evidence provenance',
                100,100,'owner-a'
            )
        """)
        insert = """
            INSERT INTO intelligence_finding_reviews(
                id,finding_id,owner_uid,reviewer_uid,outcome,reason,
                evidence_snapshot_json,evidence_snapshot_sha256,evidence_count,
                reviewed_at,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        """
        good = (
            '00000000-0000-4000-8000-000000000010',
            '00000000-0000-4000-8000-000000000001',
            'owner-a','owner-a','needs_more_info','Need a reproducible test report.',
            '[]','a' * 64,0,200,200
        )
        self.db.execute(insert, good)
        audit = self.db.execute("""
            SELECT action,target_type,target_id FROM intelligence_staging_audit
            WHERE target_id=? ORDER BY created_at DESC LIMIT 1
        """, (good[0],)).fetchone()
        self.assertEqual(audit, ('finding_evidence_review_recorded','finding_review',good[0]))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, (good[0] + '-2',good[1],'owner-a','other-owner',
                'accepted','No', '[]','b' * 64,0,201,201))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, (good[0] + '-3',good[1],'owner-b','owner-b',
                'accepted','Cross owner', '[]','b' * 64,0,201,201))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, (good[0] + '-4',good[1],'owner-a','owner-a',
                'accepted','Bad snapshot', '[{}]','b' * 64,0,201,201))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_finding_reviews SET reason='rewritten' WHERE id=?", (good[0],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_finding_reviews WHERE id=?", (good[0],))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_evidence_correlation_review_ledger_is_owner_decided_append_only_and_audited(self):
        self.apply_chain()
        insert = """
            INSERT INTO intelligence_evidence_correlation_reviews(
                id,owner_uid,reviewer_uid,correlation_type,correlation_key_sha256,
                outcome,reason,correlation_snapshot_json,correlation_snapshot_sha256,
                reference_count,reviewed_at,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """
        snapshot = '[{"evidenceId":"20000000-0000-4000-8000-000000000001","findingId":"10000000-0000-4000-8000-000000000001"},{"evidenceId":"20000000-0000-4000-8000-000000000002","findingId":"10000000-0000-4000-8000-000000000002"}]'
        good = (
            "correlation-review-a","owner-a","owner-a","shared_source_reference",
            "a" * 64,"needs_more_info","Confirm whether both references identify the same artifact.",
            snapshot,"b" * 64,2,300,300
        )
        self.db.execute(insert, good)
        audit = self.db.execute(
            "SELECT action,target_type,target_id FROM intelligence_staging_audit WHERE target_id=?",
            (good[0],)
        ).fetchone()
        self.assertEqual(audit, ("evidence_correlation_review_recorded","evidence_correlation_review",good[0]))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("correlation-review-b","owner-a","other-owner","shared_source_reference",
                "a" * 64,"related","No","[]","b" * 64,0,301,301))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("correlation-review-c","owner-a","owner-a","unknown",
                "a" * 64,"related","No",snapshot,"b" * 64,2,301,301))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("correlation-review-d","owner-a","owner-a","shared_digest",
                "a" * 64,"related","No",snapshot,"b" * 64,1,301,301))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_evidence_correlation_reviews SET reason='rewritten' WHERE id=?", (good[0],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_evidence_correlation_reviews WHERE id=?", (good[0],))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_evidence_decision_review_ledger_is_owner_decided_append_only_and_audited(self):
        self.apply_chain()
        insert = """
            INSERT INTO intelligence_evidence_decision_reviews(
                id,owner_uid,reviewer_uid,review_key_sha256,source_type,source_id,
                outcome,reason,review_snapshot_json,review_snapshot_sha256,
                reviewed_at,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """
        good = (
            "decision-review-a","owner-a","owner-a","a"*64,
            "finding_metadata","finding-1","accepted","Reviewed current recommendation.",
            '{"sourceType":"finding_metadata","sourceId":"finding-1"}',"b"*64,400,400
        )
        self.db.execute(insert, good)
        audit = self.db.execute(
            "SELECT action,target_type,target_id FROM intelligence_staging_audit WHERE target_id=?",
            (good[0],)
        ).fetchone()
        self.assertEqual(audit, ("evidence_decision_review_recorded","evidence_decision_review",good[0]))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("decision-review-b","owner-a","other-owner","a"*64,
                "finding_metadata","finding-1","accepted","Spoofed reviewer.",
                '{"sourceType":"finding_metadata"}',"b"*64,401,401))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("decision-review-c","owner-a","owner-a","a"*64,
                "unknown","finding-1","accepted","Unknown source.",
                '{"sourceType":"unknown"}',"b"*64,401,401))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("decision-review-d","owner-a","owner-a","a"*64,
                "finding_metadata","finding-1","approved","Invalid outcome.",
                '{"sourceType":"finding_metadata"}',"b"*64,401,401))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ("decision-review-e","owner-a","owner-a","a"*64,
                "finding_metadata","finding-1","accepted","Invalid JSON.",
                '{broken}',"b"*64,401,401))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_evidence_decision_reviews SET reason='rewritten' WHERE id=?", (good[0],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_evidence_decision_reviews WHERE id=?", (good[0],))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_review_audit_failure_rolls_back_all_three_owner_decision_ledgers(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_findings(
                id,owner_uid,module_id,check_id,blueprint_version,title,description,
                created_at,updated_at,created_by
            ) VALUES(
                '00000000-0000-4000-8000-000000000001','owner-a','security',
                'auditability','v1','Audit rollback fixture','Verify atomic audit behavior',
                500,500,'owner-a'
            )
        """)
        audit_count_before = self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0]
        self.db.execute("""
            CREATE TRIGGER reject_review_audit
            BEFORE INSERT ON intelligence_staging_audit
            BEGIN SELECT RAISE(ABORT, 'simulated review audit outage'); END
        """)

        with self.subTest(ledger="correlation"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("""
                    INSERT INTO intelligence_evidence_correlation_reviews(
                        id,owner_uid,reviewer_uid,correlation_type,correlation_key_sha256,
                        outcome,reason,correlation_snapshot_json,correlation_snapshot_sha256,
                        reference_count,reviewed_at,created_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    "rollback-correlation","owner-a","owner-a","shared_digest","a"*64,
                    "related","Audit must be atomic.",
                    '[{"evidenceId":"20000000-0000-4000-8000-000000000001","findingId":"10000000-0000-4000-8000-000000000001"},{"evidenceId":"20000000-0000-4000-8000-000000000002","findingId":"10000000-0000-4000-8000-000000000002"}]',
                    "b"*64,2,501,501
                ))

        with self.subTest(ledger="decision"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("""
                    INSERT INTO intelligence_evidence_decision_reviews(
                        id,owner_uid,reviewer_uid,review_key_sha256,source_type,source_id,
                        outcome,reason,review_snapshot_json,review_snapshot_sha256,
                        reviewed_at,created_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    "rollback-decision","owner-a","owner-a","c"*64,"finding_metadata",
                    "finding-1","accepted","Audit must be atomic.",
                    '{"sourceType":"finding_metadata","sourceId":"finding-1"}',
                    "d"*64,502,502
                ))

        with self.subTest(ledger="priority_action"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("""
                    INSERT INTO intelligence_priority_action_reviews(
                        id,owner_uid,reviewer_uid,finding_id,module_id,check_id,
                        action_key_sha256,outcome,reason,review_snapshot_json,
                        review_snapshot_sha256,reviewed_at,created_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    "rollback-priority","owner-a","owner-a",
                    "00000000-0000-4000-8000-000000000001","security","auditability",
                    "e"*64,"accepted","Audit must be atomic.",
                    '{"findingId":"00000000-0000-4000-8000-000000000001","moduleId":"security","checkId":"auditability"}',
                    "f"*64,503,503
                ))

        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_evidence_correlation_reviews"
        ).fetchone()[0], 0)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_evidence_decision_reviews"
        ).fetchone()[0], 0)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_priority_action_reviews"
        ).fetchone()[0], 0)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], audit_count_before)

    def test_approval_ledger_rejects_unknown_task(self):
        self.apply_chain()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,
                    base_sha,scope_json,scope_sha256,status,issued_at,expires_at
                ) VALUES('grant-x','missing','owner','owner','repo','branch',
                         'sha','{}','hash','issued',1,4102444800)
            """)


    def test_approval_ledger_scope_is_immutable_and_states_are_one_way(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_tasks(id,title,created_by)
            VALUES('guard-task','Guard task','owner-a')
        """)
        insert = """
            INSERT INTO intelligence_approval_ledger(
                id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                scope_json,scope_sha256,status,issued_at,expires_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """
        good = ('guard-a','guard-task','owner-a','mehranmsh','owner/repo','main',
                'a'*40,'{"paths":["src/"]}','b'*64,'issued',100,200)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, good[:9] + ('revoked',) + good[10:])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                    scope_json,scope_sha256,status,issued_at,expires_at,revoked_at
                ) VALUES('guard-b','guard-task','owner-a','mehranmsh','owner/repo','main',
                         ?, '{"paths":["src/"]}', ?, 'issued',100,200,150)
            """, ('a'*40,'b'*64))
        self.db.execute(insert, good)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET repository='attacker/repo' WHERE id='guard-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET status='revoked' WHERE id='guard-a'")
        self.db.execute("UPDATE intelligence_approval_ledger SET status='revoked',revoked_at=150 WHERE id='guard-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET status='consumed',consumed_at=160,consumed_by='executor' WHERE id='guard-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET revoked_at=151 WHERE id='guard-a'")

        consumed = ('guard-c','guard-task','owner-a','mehranmsh','owner/repo','main',
                    'c'*40,'{"paths":["docs/"]}','d'*64,'issued',100,200)
        self.db.execute(insert, consumed)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET status='consumed' WHERE id='guard-c'")
        self.db.execute("""
            UPDATE intelligence_approval_ledger
            SET status='consumed',consumed_at=150,consumed_by='staging-test'
            WHERE id='guard-c'
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET consumed_by='other' WHERE id='guard-c'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET status='expired' WHERE id='guard-c'")

        expired = ('guard-d','guard-task','owner-a','mehranmsh','owner/repo','main',
                   'e'*40,'{"paths":["tests/"]}','f'*64,'issued',100,200)
        self.db.execute(insert, expired)
        self.db.execute("UPDATE intelligence_approval_ledger SET status='expired' WHERE id='guard-d'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_approval_ledger SET status='issued' WHERE id='guard-d'")


    def test_capability_approval_ledger_is_separate_scoped_and_one_way(self):
        self.apply_chain()
        insert = """
            INSERT INTO intelligence_capability_approvals(
                id,owner_uid,capability,scope,status,issued_at,expires_at
            ) VALUES(?,?,?,?,?,?,?)
        """
        good = ('cap-a','owner-a','memory.create','owner_staging','issued',100,200)
        self.db.execute(insert, good)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ('cap-b','owner-a','task.execute','owner_staging','issued',100,200))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ('cap-c','owner-a','memory.delete','production','issued',100,200))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ('cap-d','owner-a','memory.delete','owner_staging','revoked',100,200))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_capability_approvals SET capability='knowledge.create' WHERE id='cap-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_capability_approvals SET status='revoked' WHERE id='cap-a'")
        self.db.execute("UPDATE intelligence_capability_approvals SET status='revoked',revoked_at=150 WHERE id='cap-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_capability_approvals SET status='issued' WHERE id='cap-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_capability_approvals SET revoked_at=151 WHERE id='cap-a'")
        audit = self.db.execute("""
            SELECT action,target_type,target_id FROM intelligence_staging_audit
            WHERE target_id='cap-a'
        """).fetchone()
        self.assertEqual(audit, ('capability_approval_revoked','capability_approval','cap-a'))

        consumed = ('cap-e','owner-a','knowledge.review','owner_staging','issued',100,200)
        self.db.execute(insert, consumed)
        self.db.execute("""
            UPDATE intelligence_capability_approvals
            SET status='consumed',consumed_at=160,consumed_by='staging-test'
            WHERE id='cap-e'
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_capability_approvals SET consumed_by='other' WHERE id='cap-e'")
        self.assertEqual(self.db.execute("""
            SELECT action FROM intelligence_staging_audit WHERE target_id='cap-e'
        """).fetchone()[0], 'capability_approval_consumed')

        expired = ('cap-f','owner-a','memory.create','owner_staging','issued',100,200)
        self.db.execute(insert, expired)
        self.db.execute("UPDATE intelligence_capability_approvals SET status='expired' WHERE id='cap-f'")
        self.assertEqual(self.db.execute("""
            SELECT action FROM intelligence_staging_audit WHERE target_id='cap-f'
        """).fetchone()[0], 'capability_approval_expired')

    def test_staging_audit_is_append_only(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
                (id,owner_uid,action,target_type,target_id,details_json,created_at)
            VALUES('audit-immutable','owner-a','test','test','target','{}',100)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_staging_audit SET action='rewritten' WHERE id='audit-immutable'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM intelligence_staging_audit WHERE id='audit-immutable'")
        self.assertEqual(self.db.execute(
            "SELECT action FROM intelligence_staging_audit WHERE id='audit-immutable'"
        ).fetchone()[0], "test")

    def test_capability_approval_terminal_timestamps_reject_future_and_preissue_values(self):
        self.apply_chain()
        now = int(__import__("time").time())
        insert = """
            INSERT INTO intelligence_capability_approvals
                (id,owner_uid,capability,scope,status,issued_at,expires_at)
            VALUES(?, 'owner-a','memory.create','owner_staging','issued',?,?)
        """
        self.db.execute(insert, ("future-revoke", now - 60, now + 600))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE intelligence_capability_approvals SET status='revoked',revoked_at=? WHERE id='future-revoke'",
                (now + 3600,)
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE intelligence_capability_approvals SET status='revoked',revoked_at=? WHERE id='future-revoke'",
                (now - 61,)
            )
        self.db.execute(insert, ("early-expiry", now - 60, now + 600))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE intelligence_capability_approvals SET status='expired' WHERE id='early-expiry'")

    def test_linked_knowledge_content_guard_is_installed(self):
        self.apply_chain()
        trigger = self.db.execute("""
            SELECT sql FROM sqlite_master
            WHERE type='trigger' AND name='trg_intelligence_knowledge_content_immutable_with_relations'
        """).fetchone()
        self.assertIsNotNone(trigger)
        self.assertIn("OLD.content <> NEW.content", trigger[0])


    def test_knowledge_provenance_bounds_immutability_and_owner_review(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by,
                source_type,source_ref,observed_at,confidence_score)
            VALUES('prov-a','owner-a','A','Evidence A','owner',
                'external_url','https://example.org/source',
                '2026-11-19T10:00:00Z',75)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by,
                    source_type,source_ref)
                VALUES('prov-b','owner-a','B','Evidence B','owner',
                    'external_url','https://user:pass@example.org/private')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by,
                    source_type,source_ref)
                VALUES('prov-empty','owner-a','Empty','Evidence','owner',
                    'external_url','https://')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by,
                    confidence_score)
                VALUES('prov-c','owner-a','C','Evidence C','owner',101)
            """)
        self.db.execute("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES('prov-d','owner-a','D','Evidence D','owner')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge
                SET source_type='external_url', source_ref='https://'
                WHERE id='prov-d'
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge
                SET source_type='external_url', source_ref='http://example.org'
                WHERE id='prov-d'
            """)
        self.db.execute("""
            INSERT INTO intelligence_knowledge_relations(
                id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,
                status,source_evidence,target_evidence
            ) VALUES('prov-rel','owner-a','prov-a','prov-d',
                     'supports','candidate','Evidence A','Evidence D')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge SET source_ref='https://example.org/changed'
                WHERE id='prov-a'
            """)
        # Owner review is a separate audited workflow and remains possible after linking.
        self.db.execute("""
            UPDATE intelligence_knowledge SET verification_status='owner_verified'
            WHERE id='prov-a' AND owner_uid='owner-a'
        """)
        status = self.db.execute("""
            SELECT verification_status FROM intelligence_knowledge WHERE id='prov-a'
        """).fetchone()[0]
        self.assertEqual(status, 'owner_verified')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge SET verification_status='approved'
                WHERE id='prov-a'
            """)

    def test_knowledge_evaluation_relation_aggregation_is_owner_scoped(self):
        self.apply_chain()
        self.db.executemany("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES(?,?,?,?,?)
        """, [
            ("eval-a", "owner-a", "A", "Evidence A", "owner"),
            ("eval-b", "owner-a", "B", "Evidence B", "owner"),
            ("eval-c", "owner-a", "C", "Evidence C", "owner"),
            ("eval-other", "owner-b", "Other", "Private evidence", "owner"),
            ("eval-other-2", "owner-b", "Other 2", "Other evidence", "owner"),
        ])
        self.db.executemany("""
            INSERT INTO intelligence_knowledge_relations(
                id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,
                status,source_evidence,target_evidence
            ) VALUES(?,?,?,?,?,?,?,?)
        """, [
            ("eval-rel-1", "owner-a", "eval-a", "eval-b",
             "conflicts_with", "candidate", "Evidence A", "Evidence B"),
            ("eval-rel-2", "owner-a", "eval-a", "eval-c",
             "supports", "confirmed", "Evidence A", "Evidence C"),
            ("eval-rel-3", "owner-b", "eval-other", "eval-other-2",
             "supports", "confirmed", "Private evidence", "Other evidence"),
        ])
        rows = self.db.execute("""
            WITH relation_edges AS (
                SELECT source_knowledge_id AS knowledge_id, relation_type, status
                FROM intelligence_knowledge_relations WHERE owner_uid = ?
                UNION ALL
                SELECT target_knowledge_id AS knowledge_id, relation_type, status
                FROM intelligence_knowledge_relations WHERE owner_uid = ?
            ),
            relation_stats AS (
                SELECT knowledge_id,
                    COUNT(*) AS relation_count,
                    SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate_relation_count,
                    SUM(CASE WHEN relation_type = 'conflicts_with' AND status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_conflict_count,
                    SUM(CASE WHEN relation_type = 'conflicts_with' AND status IN ('candidate','confirmed') THEN 1 ELSE 0 END) AS unresolved_conflict_count,
                    SUM(CASE WHEN relation_type = 'supports' AND status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_support_count,
                    SUM(CASE WHEN relation_type = 'supersedes' AND status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_supersedes_count
                FROM relation_edges GROUP BY knowledge_id
            )
            SELECT k.id, COALESCE(s.relation_count, 0),
                   COALESCE(s.candidate_relation_count, 0),
                   COALESCE(s.unresolved_conflict_count, 0),
                   COALESCE(s.confirmed_support_count, 0)
            FROM intelligence_knowledge k
            LEFT JOIN relation_stats s ON s.knowledge_id = k.id
            WHERE k.owner_uid = ?
            ORDER BY k.id
        """, ("owner-a", "owner-a", "owner-a")).fetchall()
        self.assertEqual(rows, [
            ("eval-a", 2, 1, 1, 1),
            ("eval-b", 1, 1, 1, 0),
            ("eval-c", 1, 0, 0, 1),
        ])


    def test_owner_memory_governance_provenance_and_review(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES('mem-source-a','owner-a','Source','Owner A evidence','owner')
        """)
        self.db.execute("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES('mem-source-b','owner-b','Other','Owner B evidence','owner')
        """)
        self.db.execute("""
            INSERT INTO intelligence_owner_memory(
                id,owner_uid,category,content,memory_kind,source_type,source_ref,confidence_score
            ) VALUES('mem-a','owner-a','project','A project decision',
                     'decision','knowledge_record','mem-source-a',90)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory(
                    id,owner_uid,category,content,memory_kind,source_type,source_ref
                ) VALUES('mem-cross','owner-a','project','Cross-owner reference',
                         'project_context','knowledge_record','mem-source-b')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory(
                    id,owner_uid,category,content,memory_kind,source_type,source_ref
                ) VALUES('mem-bad-kind','owner-a','project','Bad kind',
                         'secret','owner_input',NULL)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory(
                    id,owner_uid,category,content,memory_kind,source_type,source_ref,confidence_score
                ) VALUES('mem-bad-score','owner-a','project','Bad score',
                         'goal','owner_input',NULL,101)
            """)
        # The database enforces source semantics even if a future caller bypasses the Worker.
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory(
                    id,owner_uid,category,content,source_type,source_ref
                ) VALUES('mem-owner-ref','owner-a','project','Mislabelled source',
                         'owner_input','mem-source-a')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory(
                    id,owner_uid,category,content,source_type,source_ref
                ) VALUES('mem-missing-ref','owner-a','project','Missing source',
                         'knowledge_record',NULL)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_owner_memory SET source_ref='mem-source-b'
                WHERE id='mem-a'
            """)
        self.db.execute("""
            UPDATE intelligence_owner_memory
            SET review_status='owner_confirmed', reviewed_at='2026-11-19T03:00:00Z'
            WHERE id='mem-a' AND owner_uid='owner-a'
        """)
        self.db.execute("""
            UPDATE intelligence_owner_memory
            SET archived_at='2026-11-19T03:05:00Z'
            WHERE id='mem-a' AND owner_uid='owner-a'
        """)
        row = self.db.execute("""
            SELECT review_status, archived_at, source_ref
            FROM intelligence_owner_memory WHERE id='mem-a'
        """).fetchone()
        self.assertEqual(row, ('owner_confirmed', '2026-11-19T03:05:00Z', 'mem-source-a'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_owner_memory SET review_status='approved'
                WHERE id='mem-a'
            """)

    def test_runtime_tables_are_separate_and_idempotent(self):
        self.apply_chain()
        expected = {
            "intelligence_staging_sessions",
            "intelligence_staging_audit",
            "intelligence_staging_rate_limits",
            "intelligence_owner_memory",
        }
        found = {row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertTrue(expected.issubset(found))
        self.assertNotIn("admin_sessions", found)
        self.assertNotIn("admin_audit_log", found)
        self.assertNotIn("social_users", found)

    def test_approval_scope_constraints_and_expiry_audit(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_tasks(id,title,created_by)
            VALUES('task-a','Task A','owner-a')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                    scope_json,scope_sha256,status,issued_at,expires_at
                ) VALUES('bad-scope','task-a','owner-a','mehranmsh','owner/repo','main',
                         '0123456789012345678901234567890123456789','[]','hash','issued',100,200)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_approval_ledger(
                    id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                    scope_json,scope_sha256,status,issued_at,expires_at
                ) VALUES('bad-lifetime','task-a','owner-a','mehranmsh','owner/repo','main',
                         '0123456789012345678901234567890123456789','{"paths":["src/"]}',
                         'hash','issued',100,4001)
            """)
        self.db.execute("""
            INSERT INTO intelligence_approval_ledger(
                id,task_id,owner_uid,owner_username,repository,branch,base_sha,
                scope_json,scope_sha256,status,issued_at,expires_at
            ) VALUES('approval-a','task-a','owner-a','mehranmsh','owner/repo','main',
                     '0123456789012345678901234567890123456789','{"paths":["src/"]}',
                     'hash','issued',100,200)
        """)
        self.db.execute("""
            UPDATE intelligence_approval_ledger SET status='expired'
            WHERE id='approval-a' AND status='issued'
        """)
        event = self.db.execute("""
            SELECT action,target_id FROM intelligence_staging_audit
            WHERE target_id='approval-a'
        """).fetchone()
        self.assertEqual(event, ('approval_expired','approval-a'))

    def test_runtime_tables_enforce_session_rate_and_memory_bounds(self):
        self.apply_chain()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_staging_sessions
                (id,token_hash,owner_uid,created_at,expires_at)
                VALUES('bad-session','bad-hash','owner-a',200,100)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_staging_rate_limits
                (rate_key,window_started_at,request_count)
                VALUES('bad-rate',100,0)
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_owner_memory(id,owner_uid,category,content)
                VALUES('bad-memory','owner-a','general','')
            """)

    def test_knowledge_archive_preserves_relationship_history_and_owner_scope(self):
        self.apply_chain()
        self.db.executemany("""
            INSERT INTO intelligence_knowledge(id,owner_uid,title,content,created_by)
            VALUES(?,?,?,?,?)
        """, [
            ('knowledge-a','owner-a','A','Evidence A','owner'),
            ('knowledge-b','owner-a','B','Evidence B','owner'),
        ])
        self.db.execute("""
            INSERT INTO intelligence_knowledge_relations(
                id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,
                status,source_evidence,target_evidence
            ) VALUES('relation-a','owner-a','knowledge-a','knowledge-b',
                     'supports','candidate','Evidence A','Evidence B')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE intelligence_knowledge SET content='Changed evidence'
                WHERE id='knowledge-a' AND owner_uid='owner-a'
            """)
        self.db.execute("""
            UPDATE intelligence_knowledge SET archived_at=CURRENT_TIMESTAMP
            WHERE id='knowledge-a' AND owner_uid='owner-b' AND archived_at IS NULL
        """)
        self.assertIsNone(self.db.execute(
            "SELECT archived_at FROM intelligence_knowledge WHERE id='knowledge-a'"
        ).fetchone()[0])
        self.db.execute("""
            UPDATE intelligence_knowledge SET archived_at=CURRENT_TIMESTAMP
            WHERE id='knowledge-a' AND owner_uid='owner-a' AND archived_at IS NULL
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_knowledge_relations WHERE id='relation-a'"
        ).fetchone()[0], 1)
        self.db.execute("""
            UPDATE intelligence_knowledge SET archived_at=NULL
            WHERE id='knowledge-a' AND owner_uid='owner-a' AND archived_at IS NOT NULL
        """)
        self.assertIsNone(self.db.execute(
            "SELECT archived_at FROM intelligence_knowledge WHERE id='knowledge-a'"
        ).fetchone()[0])

    def test_memory_delete_audit_requires_owner_match_and_existing_row(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_owner_memory(id,owner_uid,category,content)
            VALUES('mem-a','owner-a','note','Private note')
        """)
        self.db.execute("""
            DELETE FROM intelligence_owner_memory WHERE id='mem-a' AND owner_uid='owner-b'
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'delete-wrong-owner','owner-b','owner_memory_deleted','memory','mem-a','{}',100
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 0)
        self.db.execute("""
            DELETE FROM intelligence_owner_memory WHERE id='mem-a' AND owner_uid='owner-a'
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'delete-owner-a','owner-a','owner_memory_deleted','memory','mem-a','{}',101
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT action FROM intelligence_staging_audit WHERE target_id='mem-a'"
        ).fetchone()[0], 'owner_memory_deleted')

    def test_audit_insert_requires_a_successful_state_change(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_staging_sessions
            (id,token_hash,owner_uid,created_at,expires_at)
            VALUES('audit-session','audit-hash','owner-a',100,200)
        """)
        self.db.execute("""
            UPDATE intelligence_staging_sessions
            SET revoked_at=150
            WHERE id='audit-session' AND owner_uid='owner-a' AND revoked_at IS NULL
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'audit-1','owner-a','session_revoked','session','audit-session','{}',150
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 1)
        self.db.execute("""
            UPDATE intelligence_staging_sessions
            SET revoked_at=151
            WHERE id='audit-session' AND owner_uid='owner-a' AND revoked_at IS NULL
        """)
        self.db.execute("""
            INSERT INTO intelligence_staging_audit
            (id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT 'audit-2','owner-a','session_revoked','session','audit-session','{}',151
            WHERE changes() = 1
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM intelligence_staging_audit"
        ).fetchone()[0], 1)

    def test_session_token_hash_is_unique_and_revocation_is_scoped(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_staging_sessions
            (id,token_hash,owner_uid,created_at,expires_at)
            VALUES('s1','hash-1','owner-a',100,200)
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO intelligence_staging_sessions
                (id,token_hash,owner_uid,created_at,expires_at)
                VALUES('s2','hash-1','owner-b',100,200)
            """)


    def test_task_records_are_plan_only_and_execution_fields_are_locked(self):
        self.apply_chain()
        self.db.execute("""
            INSERT INTO intelligence_tasks(id,title,created_by)
            VALUES('plan-only-task','Plan only','owner-a')
        """)
        blocked_updates = [
            "UPDATE intelligence_tasks SET status='in_progress' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET assigned_to='external_executor' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET result_text='executed' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET action_type='shell' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET action_payload='{\"command\":\"run\"}' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET agent_claimed_at='now' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET scheduler_claim_id='claim-1' WHERE id='plan-only-task'",
        ]
        for statement in blocked_updates:
            with self.subTest(statement=statement):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(statement)
        for statement in (
            "UPDATE intelligence_tasks SET created_by='owner-b' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET id='transferred-task' WHERE id='plan-only-task'",
            "UPDATE intelligence_tasks SET created_at='changed' WHERE id='plan-only-task'",
        ):
            with self.subTest(statement=statement):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(statement)
        for statement in (
            "INSERT INTO intelligence_tasks(id,title,created_by,status) VALUES('bad-status','Bad','owner-a','in_progress')",
            "INSERT INTO intelligence_tasks(id,title,created_by,action_type) VALUES('bad-action','Bad','owner-a','shell')",
            "INSERT INTO intelligence_tasks(id,title,created_by,agent_claim_id) VALUES('bad-claim','Bad','owner-a','claim-1')",
            "INSERT INTO intelligence_tasks(id,title,created_by,requires_approval) VALUES('bad-approval','Bad','owner-a',2)",
        ):
            with self.subTest(statement=statement):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(statement)
        row = self.db.execute(
            "SELECT status,assigned_to,result_text,action_type,action_payload,created_by FROM intelligence_tasks WHERE id='plan-only-task'"
        ).fetchone()
        self.assertEqual(row, ('queued','mehran_intelligence','','','{}','owner-a'))


if __name__ == "__main__":
    unittest.main(verbosity=2)
