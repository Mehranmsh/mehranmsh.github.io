#!/usr/bin/env python3
"""Static safety contract for the isolated Intelligence staging Worker."""
from pathlib import Path
import re
import json
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "intelligence-staging-worker.js"
CONFIG = ROOT / "wrangler.intelligence-staging.jsonc"
PROJECT_API = ROOT / "intelligence-project-api.mjs"

class StagingWorkerSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SOURCE.read_text(encoding="utf-8")
        cls.config = CONFIG.read_text(encoding="utf-8")
        cls.project_api = PROJECT_API.read_text(encoding="utf-8")

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
            'WHERE owner_uid = ?\n        AND (? = \'all\' OR (? = \'archived\' AND archived_at IS NOT NULL) OR (? = \'active\' AND archived_at IS NULL))',
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

    def test_project_api_is_owner_scoped_audited_and_non_executing(self):
        self.assertIn('import { handleProjectApi } from "./intelligence-project-api.mjs";', self.source)
        self.assertIn('handleProjectApi({ request, env, owner, url, path, method', self.source)
        for fragment in [
            'path==="/intelligence/projects"&&method==="GET"',
            'path==="/intelligence/projects"&&method==="POST"',
            'if(projectMatch&&method==="GET")',
            'if(projectMatch&&method==="PUT")',
            'if(taskProjectMatch&&method==="PUT")',
            'if(taskStatusMatch&&method==="PUT")',
            'task_manually_completed',
            'task_manually_reopened',
            'Only manual completion, reopening, or cancellation is allowed.',
            'if(taskDepsMatch&&method==="GET")',
            'if(taskDepsMatch&&method==="POST")',
            'if(depDeleteMatch&&method==="DELETE")',
            'const clauses=["p.owner_uid = ?"]',
            'WHERE id=? AND owner_uid=?',
            'WHERE id=? AND created_by=?',
            'task_dependency_added',
            'task_dependency_removed',
            'project_created',
            'project_archived',
            'project_restored',
            'archived_at=CURRENT_TIMESTAMP',
            'archived_at=NULL',
            'WHERE changes()=1',
            'executionEnabled:false',
        ]:
            self.assertIn(fragment, self.project_api)
        self.assertNotIn('action_payload', self.project_api)
        self.assertNotIn('fetch(', self.project_api)
        self.assertNotIn('scheduled(', self.project_api)

    def test_project_api_dispatch_occurs_after_session_auth_and_rate_limit(self):
        auth_index = self.source.rindex("const owner = await verifySession(request, env);")
        rate_index = self.source.index("if (!await rateLimit(env.DB, owner.uid, `${method}:")
        dispatch_index = self.source.index("const projectApiResponse = await handleProjectApi")
        self.assertLess(auth_index, rate_index)
        self.assertLess(rate_index, dispatch_index)
        self.assertIn("owner, url, path, method", self.source[dispatch_index:dispatch_index + 250])

    def test_project_api_rejects_unexpected_payload_fields_and_uses_bound_owner_scopes(self):
        for fragment in [
            'Object.keys(body).some(k=>!["name","description","moduleKey"].includes(k))',
            'Object.keys(body).some(k=>!allowed.includes(k))',
            'Object.keys(body).some(k=>!["status","result"].includes(k))',
            'Object.keys(body).some(k=>k!=="projectId")',
            'Object.keys(body).some(k=>k!=="dependsOnTaskId")',
            'WHERE id=? AND owner_uid=?',
            'WHERE id=? AND created_by=?',
            'WHERE d.owner_uid=? AND d.task_id=?',
            'WHERE d.owner_uid=? AND d.depends_on_task_id=?',
            '.bind(id,owner.uid)',
            '.bind(taskId,owner.uid)',
        ]:
            self.assertIn(fragment, self.project_api)
        self.assertNotRegex(self.project_api, r"(?:SELECT|UPDATE|DELETE|INSERT)[^\\n]*\\+\\s*owner\\.uid")
        self.assertNotIn('fetch(', self.project_api)
        self.assertNotIn('eval(', self.project_api)

    def test_archived_knowledge_can_be_listed_without_cross_owner_access(self):
        self.assertIn('const state = clean(url.searchParams.get("state") || "active", 16)', self.source)
        self.assertIn('["active","archived","all"].includes(state)', self.source)
        self.assertIn("(? = 'archived' AND archived_at IS NOT NULL)", self.source)
        self.assertIn("(? = 'active' AND archived_at IS NULL)", self.source)

    def test_knowledge_update_archive_restore_are_owner_scoped_and_audited(self):
        self.assertIn('if (knowledgeMatch && method === "PUT")', self.source)
        self.assertIn('WHERE id=? AND owner_uid=? AND archived_at IS NULL', self.source)
        self.assertIn('WHERE id=? AND owner_uid=? AND archived_at IS NOT NULL', self.source)
        self.assertIn('"knowledge_updated"', self.source)
        self.assertIn('"knowledge_archived"', self.source)
        self.assertIn('"knowledge_restored"', self.source)
        self.assertIn('Content is evidence-linked. Create a corrected record and relate it instead.', self.source)
        self.assertIn('SELECT ?,?,?,?,?,?,? WHERE changes() = 1', self.source)


    def test_knowledge_evaluation_is_read_only_owner_scoped_and_explicitly_limited(self):
        for fragment in [
            'const evaluationMatch = path.match(/^\\/intelligence\\/knowledge\\/([0-9a-f-]{36})\\/evaluation$/i)',
            'if (evaluationMatch && method === "GET")',
            'WHERE id = ? AND owner_uid = ?',
            'WHERE owner_uid = ?',
            '["candidate", "confirmed"].includes(item.status)',
            'reviewState',
            '"deterministic_metadata_only"',
            '"The recorded confidence score is not independently validated."',
            '"No external source retrieval, semantic fact-checking, or autonomous truth selection is performed."',
        ]:
            self.assertIn(fragment, self.source)

    def test_batched_knowledge_evaluations_are_owner_scoped_and_bounded(self):
        self.assertIn('path === "/intelligence/knowledge/evaluations" && method === "GET"', self.source)
        self.assertIn('WITH relation_edges AS (', self.source)
        self.assertIn('UNION ALL', self.source)
        self.assertIn('WHERE owner_uid = ?', self.source)
        self.assertIn('LIMIT ?', self.source)
        self.assertIn('recordedConfidenceScore: item.confidence_score', self.source)
        self.assertIn('assessment: "deterministic_metadata_only"', self.source)
        self.assertIn('Number(item.unresolved_conflict_count) > 0', self.source)


    def test_knowledge_review_queue_is_bounded_owner_scoped_and_deterministic(self):
        helper = (ROOT / "intelligence-review-queue.mjs").read_text(encoding="utf-8")
        self.assertIn('import { buildKnowledgeReviewItem } from "./intelligence-review-queue.mjs";', self.source)
        for fragment in [
            'path === "/intelligence/knowledge/review-queue" && method === "GET"',
            'WHERE k.owner_uid = ? AND (? = 1 OR k.archived_at IS NULL)',
            'LIMIT 500',
            'staleAfterDays: 180',
            'ordering: "priority_desc_then_oldest_observation"',
            'assessment: "deterministic_metadata_only"',
            '.filter(item => item.priority > 0)',
            '.slice(0, limit)',
        ]:
            self.assertIn(fragment, self.source)
        for fragment in [
            '"owner_disputed"',
            '"unresolved_conflict"',
            '"source_observation_older_than_180_days"',
            '"missing_source_reference"',
            'priorityBand: priority >= 90 ? "critical"',
            'export function buildKnowledgeReviewItem',
        ]:
            self.assertIn(fragment, helper)
        self.assertIn('No external source retrieval, semantic fact-checking, or autonomous conflict resolution is performed.', self.source)

    def test_knowledge_provenance_is_owner_reviewed_and_bounded(self):
        for fragment in [
            "source_type, source_ref, observed_at, confidence_score, verification_status",
            '"sourceType","sourceRef","observedAt","confidenceScore"',
            '"external_url"',
            "Number.isInteger(confidenceScore)",
            "confidenceScore > 100",
            'new URL(sourceRef)',
            'parsedSourceUrl.protocol === "https:"',
            '!parsedSourceUrl.username && !parsedSourceUrl.password',
            '"owner_verified"',
            '"knowledge_owner_verified"',
            '"knowledge_disputed"',
            '"knowledge_verification_reset"',
        ]:
            self.assertIn(fragment, self.source)
        self.assertIn("trg_intelligence_knowledge_provenance_guard_update",
                      (ROOT / "migrations" / "0004_intelligence_knowledge_provenance.sql").read_text(encoding="utf-8"))

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
        self.assertIn('"database_id": "8810bcb3-83e9-4297-9e07-4c2a33c4b8db"', self.config)
        self.assertNotIn('"mehran-msh-db"', self.config)
        self.assertNotIn('"ai":', self.config)
        self.assertNotRegex(self.config, r'"crons"\s*:')
        self.assertNotRegex(self.config, r'"queues"\s*:')
        self.assertNotRegex(self.config, r'"routes"\s*:')

        # Parse JSONC after removing full-line comments and validate the actual
        # binding structure, not only the presence of expected text fragments.
        parsed = json.loads("\n".join(line for line in self.config.splitlines() if not line.lstrip().startswith("//")))
        self.assertEqual(parsed.get("name"), "mehran-intelligence-staging")
        self.assertEqual(parsed.get("main"), "intelligence-staging-worker.js")
        self.assertTrue(parsed.get("workers_dev"))
        self.assertFalse(parsed.get("preview_urls"))
        self.assertEqual(set(parsed.keys()), {
            "name", "main", "compatibility_date", "workers_dev",
            "preview_urls", "d1_databases"
        })
        bindings = parsed.get("d1_databases")
        self.assertIsInstance(bindings, list)
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0].get("binding"), "DB")
        self.assertEqual(bindings[0].get("database_name"), "mehran-msh-intelligence-staging")
        self.assertEqual(bindings[0].get("database_id"), "8810bcb3-83e9-4297-9e07-4c2a33c4b8db")
        self.assertEqual(set(bindings[0].keys()), {"binding", "database_name", "database_id"})

if __name__ == "__main__":
    unittest.main(verbosity=2)
