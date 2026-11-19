#!/usr/bin/env python3
"""Static safety contract for the isolated Intelligence staging Worker."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "intelligence-staging-worker.js"
CONFIG = ROOT / "wrangler.intelligence-staging.jsonc"

class StagingWorkerSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SOURCE.read_text(encoding="utf-8")
        cls.config = CONFIG.read_text(encoding="utf-8")

    def test_pi_identity_is_verified_server_side(self):
        self.assertIn('https://api.minepi.com/v2/me', self.source)
        self.assertIn('Authorization: `Bearer ${accessToken}`', self.source)
        self.assertIn('piUser.uid !== ownerUid', self.source)
        self.assertIn('piUser.username.toLowerCase() !== "mehranmsh"', self.source)
        self.assertIn('MEHRAN_INTELLIGENCE_STAGING_OWNER_UID', self.source)

    def test_session_tokens_are_random_and_only_hashes_are_persisted(self):
        self.assertIn('crypto.getRandomValues(new Uint8Array(32))', self.source)
        self.assertIn('const tokenHash = await digest(token)', self.source)
        self.assertIn('token_hash', self.source)
        self.assertNotRegex(self.source, r'INSERT INTO intelligence_staging_sessions[^\n]*\btoken\b')

    def test_session_expiry_and_revocation_are_enforced(self):
        self.assertIn('revoked_at IS NULL AND expires_at > ?', self.source)
        self.assertIn('SESSION_SECONDS = 12 * 60 * 60', self.source)
        self.assertIn('session_revoked', self.source)

    def test_owner_scoping_is_present_on_sensitive_reads_and_writes(self):
        for fragment in [
            'WHERE owner_uid = ? AND archived_at IS NULL',
            'WHERE owner_uid = ? AND (? = \'\' OR status = ?)',
            'WHERE id=? AND owner_uid=?',
            'WHERE id=? AND created_by=?',
            'WHERE owner_uid = ?\n      ORDER BY updated_at DESC LIMIT 100',
        ]:
            self.assertIn(fragment, self.source)

    def test_audit_uses_database_batch_and_conditional_state_change(self):
        self.assertIn('await env.DB.batch([', self.source)
        self.assertIn('INSERT INTO intelligence_staging_audit', self.source)
        self.assertGreaterEqual(self.source.count('WHERE changes() = 1'), 4)
        self.assertIn('knowledge_relation_', self.source)
        self.assertIn('{ confirm: "knowledge_relation_confirmed", dismiss: "knowledge_relation_dismissed", resolve: "knowledge_relation_resolved" }', self.source)
        self.assertIn('approval_revoked', self.source)

    def test_no_executor_scheduler_or_production_binding(self):
        forbidden = [
            r'\bscheduled\s*\(',
            r'\bwaitUntil\s*\(',
            r'\bclaimTask\b',
            r'\bexecuteTask\b',
            r'\bMEHRAN_OWNER_PI_UID\b',
            r'\badmin_sessions\b',
            r'\badmin_audit_log\b',
            r'\bmehran-msh-db\b',
            r'\bworkers_ai_daily_budget\b',
        ]
        for pattern in forbidden:
            self.assertIsNone(re.search(pattern, self.source), pattern)
        self.assertIn('executor: false', self.source)
        self.assertIn('PRAGMA foreign_keys', self.source)
        self.assertIn('PRAGMA foreign_key_check', self.source)
        self.assertIn('foreignKeyViolations', self.source)

    def test_route_allowlist_has_no_task_execution_endpoint(self):
        self.assertIn('path === "/health"', self.source)
        self.assertIn('path === "/session"', self.source)
        self.assertIn('path === "/intelligence/knowledge"', self.source)
        self.assertIn('path === "/intelligence/memory"', self.source)
        self.assertIn('intelligence_owner_memory', self.source)
        self.assertIn('path === "/intelligence/knowledge/relations"', self.source)
        self.assertIn('path === "/intelligence/approvals"', self.source)
        self.assertIn('path === "/intelligence/tasks"', self.source)
        self.assertIn('executionEnabled: false', self.source)
        self.assertIn("VALUES (?,?,?,'mehran_intelligence',?,'queued',?,?)", self.source)

    def test_knowledge_update_archive_restore_are_owner_scoped_and_audited(self):
        self.assertIn('if (knowledgeMatch && method === "PUT")', self.source)
        self.assertIn('WHERE id=? AND owner_uid=? AND archived_at IS NULL', self.source)
        self.assertIn('WHERE id=? AND owner_uid=? AND archived_at IS NOT NULL', self.source)
        self.assertIn('"knowledge_updated"', self.source)
        self.assertIn('"knowledge_archived"', self.source)
        self.assertIn('"knowledge_restored"', self.source)
        self.assertIn('Content is evidence-linked. Create a corrected record and relate it instead.', self.source)
        self.assertIn('SELECT ?,?,?,?,?,?,? WHERE changes() = 1', self.source)

    def test_memory_deletion_is_owner_scoped_and_audited(self):
        self.assertIn('if (memoryDeleteMatch && method === "DELETE")', self.source)
        self.assertIn('DELETE FROM intelligence_owner_memory WHERE id=? AND owner_uid=?', self.source)
        self.assertIn('"owner_memory_deleted"', self.source)
        self.assertIn('SELECT ?,?,?,?,?,?,? WHERE changes() = 1', self.source)

    def test_expired_approval_is_transitioned_before_replacement(self):
        self.assertIn("UPDATE intelligence_approval_ledger SET status='expired'", self.source)
        self.assertIn('await env.DB.prepare("UPDATE intelligence_approval_ledger SET status=\'expired\' WHERE owner_uid=? AND status=\'issued\' AND expires_at<=?")', self.source)
        self.assertIn("status='issued' AND expires_at<=?", self.source)
        self.assertIn('scopeJson.length > 4096', self.source)
        self.assertIn('Object.keys(body.scope).length === 0', self.source)
        self.assertIn('approval_expired', (ROOT / "migrations" / "0003_intelligence_staging_runtime.sql").read_text(encoding="utf-8"))

    def test_strict_json_media_type_and_session_time_bounds(self):
        self.assertIn('type.split(";")[0].trim().toLowerCase() !== "application/json"', self.source)
        self.assertIn('!Number.isSafeInteger(createdAt)', self.source)
        self.assertIn('!Number.isSafeInteger(expiresAt)', self.source)
        self.assertIn('createdAt > now', self.source)
        self.assertIn('expiresAt <= createdAt', self.source)
        self.assertIn('typeof body.content !== "string"', self.source)

    def test_bounded_json_and_rate_limits(self):
        self.assertIn('MAX_BODY_BYTES = 20_000', self.source)
        self.assertIn('request_count', self.source)
        self.assertIn('RATE_WINDOW_SECONDS = 60', self.source)
        self.assertIn('RATE_MAX = 30', self.source)
        self.assertIn('CF-Connecting-IP', self.source)
        self.assertIn('"session-auth"', self.source)

    def test_staging_wrangler_config_is_isolated_and_not_deployable_yet(self):
        self.assertIn('"name": "mehran-intelligence-staging"', self.config)
        self.assertIn('"main": "intelligence-staging-worker.js"', self.config)
        self.assertIn('"database_name": "mehran-msh-intelligence-staging"', self.config)
        self.assertIn('"database_id": "REPLACE_WITH_VERIFIED_STAGING_DATABASE_ID"', self.config)
        self.assertNotIn('"mehran-msh-db"', self.config)
        self.assertNotIn('"ai":', self.config)
        self.assertNotRegex(self.config, r'"crons"\s*:')
        self.assertNotRegex(self.config, r'"queues"\s*:')
        self.assertNotRegex(self.config, r'"routes"\s*:')

if __name__ == "__main__":
    unittest.main(verbosity=2)
