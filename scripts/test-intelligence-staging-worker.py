#!/usr/bin/env python3
"""Static safety contract for the isolated Intelligence staging Worker."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "intelligence-staging-worker.js"
CONFIG = ROOT / "wrangler.intelligence-staging.jsonc"
OWNER_REVIEW_MODULE = ROOT / "intelligence-owner-evidence-review.mjs"
PRIORITY_ACTION_PLAN_MODULE = ROOT / "intelligence-priority-action-plan.mjs"
PRIORITY_ACTION_REVIEW_MODULE = ROOT / "intelligence-priority-action-review.mjs"
INDEX_HTML = ROOT / "index.html"

class StagingWorkerSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SOURCE.read_text(encoding="utf-8")
        cls.config = CONFIG.read_text(encoding="utf-8")
        cls.owner_review_module = OWNER_REVIEW_MODULE.read_text(encoding="utf-8")
        cls.priority_action_plan_module = PRIORITY_ACTION_PLAN_MODULE.read_text(encoding="utf-8")
        cls.priority_action_review_module = PRIORITY_ACTION_REVIEW_MODULE.read_text(encoding="utf-8")
        cls.index_html = INDEX_HTML.read_text(encoding="utf-8")

    def route_block(self, marker):
        start = self.source.index(marker)
        end = self.source.find("\n  if (path ===", start + len(marker))
        if end < 0:
            end = len(self.source)
        return self.source[start:end]

    def test_health_requires_the_capability_approval_ledger(self):
        match = re.search(
            r'const required = \[(.*?)\];',
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "Health route must declare its required schema tables.")
        required_tables = set(re.findall(r'"([a-z_]+)"', match.group(1)))
        self.assertIn("intelligence_capability_approvals", required_tables)
        self.assertIn("intelligence_finding_reviews", required_tables)
        self.assertIn("intelligence_evidence_correlation_reviews", required_tables)
        self.assertIn("intelligence_evidence_decision_reviews", required_tables)
        health_line = next((line.strip() for line in self.source.splitlines() if "const schemaReady =" in line), "")
        self.assertIn("missing.length === 0", health_line)
        self.assertIn("missingTriggers.length === 0", health_line)
        self.assertIn("missingColumns.length === 0", health_line)
        self.assertIn("foreignKeysEnabled", health_line)
        self.assertIn("violationCount === 0", health_line)
        self.assertIn('intelligence_knowledge: ["source_type", "source_ref", "observed_at", "confidence_score", "verification_status"]', self.source)
        self.assertIn('intelligence_owner_memory: ["memory_kind", "source_type", "source_ref", "confidence_score", "review_status", "reviewed_at", "archived_at"]', self.source)
        self.assertIn("missingTriggers", self.source)
        self.assertIn("missingColumns", self.source)

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
            'WHERE owner_uid = ?\n        AND (? = \'all\' OR (? = \'archived\' AND archived_at IS NOT NULL) OR (? = \'active\' AND archived_at IS NULL))',
        ]:
            self.assertIn(fragment, self.source)

    def test_audit_uses_database_batch_and_conditional_state_change(self):
        self.assertIn('await env.DB.batch([', self.source)
        self.assertIn('INSERT INTO intelligence_staging_audit', self.source)
        self.assertGreaterEqual(self.source.count('WHERE changes() = 1'), 4)
        self.assertIn('knowledge_relation_', self.source)
        self.assertIn('{ confirm: "knowledge_relation_confirmed", dismiss: "knowledge_relation_dismissed", resolve: "knowledge_relation_resolved" }', self.source)
        self.assertIn('approval_revoked', self.source)


    def test_owner_evidence_review_api_is_owner_scoped_and_append_only(self):
        history_marker = 'if (path === "/intelligence/findings/reviews" && method === "GET")'
        history_start = self.source.index(history_marker)
        post_start = self.source.index('const ownerReviewMatch = path.match(', history_start)
        history_route = self.source[history_start:post_start]
        post_end = self.source.find('\n  if (path ===', post_start)
        post_route = self.source[post_start:post_end]
        for fragment in [
            'WHERE owner_uid = ? AND finding_id = ?',
            'LIMIT ?',
            'append_only_owner_review_history',
        ]:
            self.assertIn(fragment, history_route)
        for fragment in [
            'OWNER_EVIDENCE_REVIEW_OUTCOMES.includes(body.outcome)',
            'Object.keys(body).some(key => !["outcome", "reason"].includes(key))',
            'WHERE id = ? AND owner_uid = ? LIMIT 1',
            'WHERE finding_id = ? AND owner_uid = ?',
            'evidenceCount > 100',
            'buildEvidenceSnapshot(evidenceRows.results || [])',
            'reviewer_uid, outcome, reason',
            'reviewId, findingId, owner.uid, owner.uid, body.outcome',
            'historyIsAppendOnly: true',
            'operationPerformed: true',
        ]:
            self.assertIn(fragment, post_route)
        for forbidden in ['request.json', 'body.ownerUid', 'body.reviewerUid', 'DELETE FROM intelligence_finding_reviews', 'UPDATE intelligence_finding_reviews']:
            self.assertNotIn(forbidden, post_route)
        self.assertIn('intelligence_finding_reviews', self.source)
        self.assertIn('buildEvidenceSnapshot', self.source)
        for fragment in [
            'historyIsAppendOnly: true',
            'evidenceContentVerified: false',
            'checkPassed: false',
            'executionEnabled: false',
        ]:
            self.assertIn(fragment, self.owner_review_module)

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

    def test_remediation_plans_api_is_owner_scoped_bounded_and_read_only(self):
        start = self.source.index('if (path === "/intelligence/findings/remediation-plans" && method === "GET")')
        end = self.source.index('if (path === "/intelligence/findings/priorities" && method === "GET")', start)
        route = self.source[start:end]
        for fragment in [
            'allowedParams = new Set(["module", "limit"])',
            'WHERE owner_uid = ? AND (? = \'\' OR module_id = ?)',
            '.bind(owner.uid, moduleId, moduleId).all()',
            'LIMIT 500',
            'buildRemediationPlan(item)',
            'assessment: "advisory_remediation_planning_only"',
            'plannerVersion: "deterministic_remediation_v1"',
            'executionEnabled: false',
            'operationPerformed: false',
            'No task is created',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE ", "DELETE FROM", "request.json"]:
            self.assertNotIn(forbidden, route)
        self.assertIn('import { buildRemediationPlan } from "./intelligence-remediation-planner.mjs";', self.source)

    def test_remediation_planner_has_explicit_owner_gates_and_no_execution(self):
        planner = (ROOT / "intelligence-remediation-planner.mjs").read_text(encoding="utf-8")
        for fragment in [
            'export function buildRemediationPlan',
            'ownerDecisionsRequired',
            'riskRationale',
            'prerequisites',
            'validation',
            'planStatus: "advisory_only"',
            'executionEnabled: false',
            'operationPerformed: false',
            'isRiskVerdict: false',
            'Affected areas are module-level guidance',
        ]:
            self.assertIn(fragment, planner)
        for forbidden in ['fetch(', 'fetch (', 'writeFile', 'exec(', 'spawn(', 'INSERT INTO', 'UPDATE ', 'DELETE FROM']:
            self.assertNotIn(forbidden, planner)

    def test_remediation_planner_builds_deterministic_module_specific_guidance(self):
        script = """
          import assert from 'node:assert/strict';
          import { buildRemediationPlan } from './intelligence-remediation-planner.mjs';
          const social = buildRemediationPlan({id:'f-1',module_id:'social',check_id:'upload_security',severity:'high',status:'open',title:'Upload validation',recommendation:'Validate file content.'});
          const socialAgain = buildRemediationPlan({id:'f-1',module_id:'social',check_id:'upload_security',severity:'high',status:'open',title:'Upload validation',recommendation:'Validate file content.'});
          assert.deepEqual(social, socialAgain);
          assert.equal(social.moduleId, 'social');
          assert.equal(social.riskLevel, 'high');
          assert.match(social.steps[0].detail, /file size, type, content/i);
          assert.ok(social.validation.some(x => /upload validation/i.test(x)));
          assert.equal(social.executionEnabled, false);
          assert.equal(social.operationPerformed, false);
          assert.equal(social.isRiskVerdict, false);
          assert.ok(social.ownerDecisionsRequired.length >= 2);
          const unknown = buildRemediationPlan({id:'f-2',module_id:'not-a-module',check_id:'not-a-check',severity:'unrated'});
          assert.equal(unknown.moduleId, 'intelligence');
          assert.equal(unknown.steps.length, 6);
          assert.ok(unknown.limitations.some(x => /not verified file paths/i.test(x)));
        """
        result = subprocess.run(["node", "--input-type=module", "-e", script],
                                cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_finding_priority_api_is_owner_scoped_bounded_and_read_only(self):
        route = self.route_block('if (path === "/intelligence/findings/priorities" && method === "GET")')
        for fragment in [
            'WHERE owner_uid = ? AND (? = \'\' OR module_id = ?)',
            '.bind(owner.uid, moduleId, moduleId).all()',
            'allowedParams = new Set(["module", "limit"])',
            'limit > 100',
            'LIMIT 500',
            'scoreFindingPriority(item)',
            '.sort(compareFindingPriority)',
            'candidateSetBounded: scanned.length === 500',
            'assessment: "deterministic_metadata_triage_only"',
            'executionEnabled: false',
            'operationPerformed: false',
            'isRiskVerdict: false',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE ", "DELETE FROM", "request.json"]:
            self.assertNotIn(forbidden, route)
        self.assertIn('import { scoreFindingPriority, compareFindingPriority } from "./intelligence-finding-priority.mjs";', self.source)

    def test_finding_priority_model_has_deterministic_expected_scores(self):
        script = """
          import assert from 'node:assert/strict';
          import { scoreFindingPriority, compareFindingPriority } from './intelligence-finding-priority.mjs';
          const critical = {id:'a',severity:'critical',status:'open',evidence_state:'missing'};
          const high = {id:'b',severity:'high',status:'open',evidence_state:'sufficient'};
          const mitigated = {id:'c',severity:'medium',status:'mitigated',evidence_state:'sufficient'};
          assert.equal(scoreFindingPriority(critical).priorityScore, 120);
          assert.equal(scoreFindingPriority(critical).priorityBand, 'critical');
          assert.equal(scoreFindingPriority(high).priorityScore, 90);
          assert.equal(scoreFindingPriority(mitigated).priorityScore, 45);
          assert.equal(scoreFindingPriority(critical).isRiskVerdict, false);
          assert.deepEqual([mitigated, high, critical].sort(compareFindingPriority).map(x=>x.id), ['a','b','c']);
        """
        result = subprocess.run(["node", "--input-type=module", "-e", script],
                                cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_findings_api_is_read_only_owner_scoped_and_bounded(self):
        start = self.source.index('if (path === "/intelligence/findings" && method === "GET")')
        end = self.source.index('if (path === "/intelligence/capabilities" && method === "GET")', start)
        route = self.source[start:end]
        self.assertIn('WHERE f.owner_uid = ?', route)
        self.assertIn('e.owner_uid = f.owner_uid', route)
        self.assertIn('allowedParams = new Set(["module", "severity", "status", "limit", "offset"])', route)
        self.assertIn('limit > 100', route)
        self.assertIn('offset > 10000', route)
        self.assertIn('LIMIT ? OFFSET ?', route)
        self.assertIn('executionEnabled: false', route)
        self.assertIn('assessment: "recorded_findings_only"', route)
        self.assertNotIn('request.json', route)
        self.assertNotIn('INSERT INTO', route)
        self.assertNotIn('UPDATE ', route)
        self.assertNotIn('DELETE ', route)
        self.assertIn('path === "/intelligence/findings"', self.source)

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

    def test_owner_memory_governance_routes_are_owner_scoped_and_audited(self):
        for fragment in [
            'memory_kind, source_type, source_ref',
            'confidence_score, review_status, reviewed_at, archived_at',
            'state = url.searchParams.get("state") || "active"',
            '["active", "archived", "all"]',
            'path === "/intelligence/memory/review-queue" && method === "GET"',
            'owner_memory_confirmed',
            'owner_memory_disputed',
            'owner_memory_archived',
            'owner_memory_restored',
            'hasOwnProperty.call(body, "action")',
            '!["confirm", "dispute", "unverify", "archive", "restore"].includes(action)',
            'sourceType === "knowledge_record" && !uuid(sourceRef)',
            'reviewStatus: "unreviewed"',
            'assessment: "owner_review_state_only"',
        ]:
            self.assertIn(fragment, self.source)
        self.assertIn('trg_intelligence_owner_memory_provenance_immutable', (ROOT / "migrations" / "0005_intelligence_owner_memory_governance.sql").read_text(encoding="utf-8"))

    def test_capability_policy_routes_are_owner_scoped_and_assessment_only(self):
        self.assertIn('import { evaluateCapabilityRequest, listCapabilityPolicy } from "./intelligence-capability-policy.mjs";', self.source)
        self.assertIn('path === "/intelligence/capabilities" && method === "GET"', self.source)
        self.assertIn('path === "/intelligence/capabilities/evaluate" && method === "POST"', self.source)
        self.assertIn('Object.keys(body).some(key => !["capability", "approvalId"].includes(key))', self.source)
        self.assertIn('path === "/intelligence/capability-approvals" && method === "GET"', self.source)
        self.assertIn('path === "/intelligence/capability-approvals" && method === "POST"', self.source)
        self.assertIn('if (capabilityApprovalMatch && method === "DELETE")', self.source)
        self.assertIn('serverVerified: true', self.source)
        self.assertIn('approvalConsumed: false', self.source)
        self.assertIn('intelligence_capability_approvals', self.source)
        self.assertIn('approvalConsumed: false', self.source)
        self.assertIn('approvalPresented: Boolean(body.approvalId)', self.source)
        self.assertIn('WHERE id=? AND owner_uid=?', self.source)
        self.assertIn('ownerAuthenticated: true', self.source)
        self.assertIn('sessionValid: true', self.source)
        self.assertIn('ownerId: owner.uid', self.source)
        self.assertIn('scope: "owner_staging"', self.source)
        self.assertIn('operationPerformed: false', self.source)
        self.assertIn('assessmentOnly: true', self.source)
        self.assertIn('audit(env.DB, owner.uid, "capability_assessed"', self.source)
        self.assertIn('Capability assessment could not be safely audited.', self.source)
        self.assertIn('auditRecorded: true', self.source)
        self.assertIn('executionEnabled: false', self.source)

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

    def test_knowledge_get_is_owner_scoped_and_paginates_with_bounded_offset(self):
        for fragment in [
            'const rawOffset = url.searchParams.get("offset") || "0";',
            'Number.isSafeInteger(offset)',
            'offset > 10000',
            'ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
            'hasMore: scanned.length > limit',
            'nextOffset: offset + items.length',
        ]:
            self.assertIn(fragment, self.source)

    def test_knowledge_provenance_is_owner_reviewed_and_bounded(self):
        for fragment in [
            "source_type, source_ref, observed_at, confidence_score, verification_status",
            '"sourceType","sourceRef","observedAt","confidenceScore"',
            '"external_url"',
            "typeof confidenceScore !== \"number\"",
            "Number.isSafeInteger(confidenceScore)",
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

    def test_memory_and_review_queue_reads_are_bounded_and_paginated(self):
        for fragment in [
            'const rawOffset = url.searchParams.get("offset") || "0";',
            'offset > 10000',
            'ORDER BY updated_at DESC, id DESC LIMIT 101 OFFSET ?',
            "ORDER BY CASE review_status WHEN 'disputed' THEN 0 WHEN 'unreviewed' THEN 1 ELSE 2 END,",
            "AND review_status IN ('disputed','unreviewed')",
            'LIMIT 101 OFFSET ?',
            'hasMore: scanned.length > 100 && offset + items.length < 10000',
            'nextOffset: scanned.length > 100 && offset + items.length < 10000 ? offset + items.length : null',
        ]:
            self.assertIn(fragment, self.source)

    def test_permanent_memory_deletion_fails_closed_until_approval_gating_exists(self):
        self.assertIn('if (memoryDeleteMatch && method === "DELETE")', self.source)
        self.assertIn('Permanent memory deletion is disabled pending approval-gated controls.', self.source)
        self.assertNotIn('DELETE FROM intelligence_owner_memory', self.source)

    def test_approval_expiry_uses_strict_tested_parser(self):
        self.assertIn('import { parseApprovalLifetime } from "./intelligence-approval-input.mjs";', self.source)
        self.assertIn('const approvalLifetime = parseApprovalLifetime(body.expiresInSeconds);', self.source)
        self.assertIn('const expiresIn = approvalLifetime.seconds;', self.source)

    def test_expired_approval_is_read_only_on_get_and_audited_before_replacement(self):
        self.assertIn("CASE WHEN status='issued' AND expires_at<=? THEN 'expired' ELSE status END AS status", self.source)
        self.assertIn("UPDATE intelligence_approval_ledger SET status='expired' WHERE task_id=? AND owner_uid=? AND status='issued' AND expires_at<=?", self.source)
        self.assertIn("approval_expiry_sweep", self.source)
        self.assertIn("SELECT ?,?,?,?,?,?,? WHERE changes() > 0", self.source)
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

    def test_assessment_coverage_is_owner_scoped_read_only_and_never_reports_pass(self):
        route = self.route_block('if (path === "/intelligence/company/assessment-coverage" && method === "GET")')
        for fragment in [
            "FROM intelligence_findings",
            "WHERE owner_uid = ?",
            ".bind(owner.uid).all()",
            "GROUP BY module_id, check_id",
            'recordState: counts.findingCount ? "findings_recorded" : "no_recorded_findings"',
            'scope: "authenticated_owner_staging_only"',
            'assessment: "blueprint_coverage_and_recorded_findings_only"',
            "executionEnabled: false",
            "operationPerformed: false",
            "checksWithoutRecordedFindings",
            "No recorded finding does not mean a check passed",
            "An evidence-sufficient finding is not a check-pass certification",
            "No check is executed",
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE intelligence_", "DELETE FROM"]:
            self.assertNotIn(forbidden, route)

    def test_assessment_coverage_blueprints_include_all_thirteen_company_modules(self):
        route_start = self.source.index('if (path === "/intelligence/company/assessment-coverage" && method === "GET")')
        route_end = self.source.index('if (path === "/intelligence/findings" && method === "GET")', route_start)
        route = self.source[route_start:route_end]
        module_ids = [
            "music", "ai", "social", "instruments", "robotics", "security",
            "intelligence", "logistics", "customer-experience", "labs",
            "governance", "data", "robot-operations"
        ]
        for module_id in module_ids:
            self.assertRegex(route, rf'id: "{re.escape(module_id)}"')
        self.assertEqual(len(re.findall(r'\{ id: "[a-z-]+", checks: \[', route)), 13)
        self.assertEqual(route.count("checks: ["), 13)
        self.assertIn("blueprintVersion: 1", route)

    def test_dependency_impact_catalog_is_bounded_explicit_and_non_executing(self):
        route = self.route_block('if (path === "/intelligence/company/dependency-impact" && method === "GET")')
        for fragment in [
            'new Set(["module"])',
            'COMPANY_MODULES.includes(moduleId)',
            'analyzeDependencyImpact(moduleId)',
            'scope: "authenticated_owner_staging_only"',
            'assessment: "provisional_declared_dependency_impact_only"',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE intelligence_", "DELETE FROM"]:
            self.assertNotIn(forbidden, route)
        helper = ROOT / "intelligence-dependency-impact.mjs"
        self.assertTrue(helper.exists())
        script = """
          import assert from "node:assert/strict";
          import { analyzeDependencyImpact, COMPANY_MODULES, MODULE_DEPENDENCIES } from "./intelligence-dependency-impact.mjs";
          assert.equal(COMPANY_MODULES.length, 13);
          assert.equal(new Set(COMPANY_MODULES).size, 13);
          assert.ok(MODULE_DEPENDENCIES.length >= 25);
          const social = analyzeDependencyImpact("social");
          assert.ok(social.directDependencies.includes("security"));
          assert.ok(social.directDependencies.includes("data"));
          const security = analyzeDependencyImpact("security");
          assert.ok(security.affectedModules.some(item => item.moduleId === "social"));
          assert.ok(security.affectedModules.some(item => item.moduleId === "music"));
          const robot = analyzeDependencyImpact("robotics");
          assert.ok(robot.affectedModules.some(item => item.moduleId === "robot-operations"));
          assert.equal(security.isRuntimeDependencyProof, false);
          assert.equal(security.isImpactVerdict, false);
          assert.equal(security.executionEnabled, false);
          assert.equal(security.operationPerformed, false);
          assert.equal(security.graphCompleteness, "unverified");
          assert.throws(() => analyzeDependencyImpact("unknown"), /Unknown company module/);
          for (const result of [social, security, robot]) {
            assert.equal(new Set(result.affectedModules.map(item => item.moduleId)).size, result.affectedModules.length);
            assert.ok(result.affectedModules.every(item => item.depth >= 1));
          }
        """
        subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True)

    def test_gap_test_strategy_is_owner_scoped_read_only_and_does_not_infer_pass(self):
        route = self.route_block('if (path === "/intelligence/company/gap-test-strategy" && method === "GET")')
        for fragment in [
            'new Set(["module"])',
            'COMPANY_MODULES.includes(moduleId)',
            'WHERE owner_uid = ? AND module_id = ?',
            '.bind(owner.uid, moduleId).all()',
            'buildGapTestStrategy(moduleId, rows.results || [])',
            'scope: "authenticated_owner_staging_only"',
            'assessment: "blueprint_gap_signals_and_test_recommendations_only"',
            'executionEnabled: false',
            'operationPerformed: false',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE intelligence_", "DELETE FROM"]:
            self.assertNotIn(forbidden, route)
        helper = ROOT / "intelligence-gap-test-strategy.mjs"
        self.assertTrue(helper.exists())
        script = """
          import assert from "node:assert/strict";
          import { buildGapTestStrategy, COMPANY_TEST_BLUEPRINTS } from "./intelligence-gap-test-strategy.mjs";
          assert.equal(Object.keys(COMPANY_TEST_BLUEPRINTS).length, 13);
          const social = buildGapTestStrategy("social", [
            {check_id:"authentication", finding_count:2, open_finding_count:1}
          ]);
          assert.equal(social.blueprintCheckCount, 5);
          const auth = social.checks.find(item => item.checkId === "authentication");
          const privacy = social.checks.find(item => item.checkId === "privacy");
          assert.equal(auth.evidenceState, "findings_recorded");
          assert.equal(auth.findingCount, 2);
          assert.equal(auth.openFindingCount, 1);
          assert.ok(auth.recommendedTests.length >= 3);
          assert.equal(privacy.evidenceState, "no_recorded_finding");
          assert.match(privacy.interpretation, /does not mean.*passed/i);
          assert.equal(social.evidenceCompleteness, "unverified");
          assert.equal(social.testsExecuted, false);
          assert.equal(social.executionEnabled, false);
          assert.equal(social.operationPerformed, false);
          assert.equal(social.isGapVerdict, false);
          assert.throws(() => buildGapTestStrategy("unknown"), /Unknown company module/);
          for (const moduleId of Object.keys(COMPANY_TEST_BLUEPRINTS)) {
            const result = buildGapTestStrategy(moduleId);
            assert.ok(result.blueprintCheckCount > 0);
            assert.ok(result.checks.every(item => item.coverageSignal === "unverified"));
            assert.ok(result.checks.every(item => item.recommendedTests.length >= 3));
          }
        """
        subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True)

    def test_evidence_drift_api_is_owner_scoped_bounded_and_read_only(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-drift" && method === "GET")')
        for fragment in [
            'new Set(["findingId"])',
            'WHERE id = ? AND owner_uid = ? LIMIT 1',
            '.bind(findingId, owner.uid).first()',
            'WHERE finding_id = ? AND owner_uid = ?',
            'ORDER BY reviewed_at DESC, id DESC',
            'latestReview.evidence_snapshot_sha256',
            'buildEvidenceDrift(baseline, evidenceRows.results || [])',
            'assessment: "metadata_snapshot_drift_only"',
            'evidenceContentVerified: false',
            'sourceReachabilityChecked: false',
            'checkPassed: false',
            'isRiskVerdict: false',
            'executionEnabled: false',
            'operationPerformed: false',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE intelligence_", "DELETE FROM"]:
            self.assertNotIn(forbidden, route)
        helper = ROOT / "intelligence-evidence-drift.mjs"
        self.assertTrue(helper.exists())

    def test_evidence_consistency_api_is_owner_scoped_bounded_and_read_only(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-consistency" && method === "GET")')
        for fragment in [
            'new Set(["module"])',
            'COMPANY_MODULES.includes(moduleId)',
            'e.owner_uid = ? AND f.owner_uid = ?',
            'f.id = e.finding_id AND f.owner_uid = e.owner_uid',
            'ORDER BY e.id ASC',
            'LIMIT 501',
            'buildEvidenceConsistency(rows.results || [], { maxRows: 500, maxGroups: 50 })',
            'scope: "authenticated_owner_staging_only"',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE intelligence_", "DELETE FROM"]:
            self.assertNotIn(forbidden, route)
        self.assertIn('import { buildEvidenceConsistency } from "./intelligence-evidence-consistency.mjs";', self.source)
        helper = ROOT / "intelligence-evidence-consistency.mjs"
        self.assertTrue(helper.exists())
        helper_source = helper.read_text()
        for fragment in [
            'assessment:"stored_evidence_metadata_consistency_candidates_only"',
            'isConflictVerdict:false',
            'isContradictionVerdict:false',
            'evidenceContentVerified:false',
            'sourceReachabilityChecked:false',
            'checkPassed:false',
            'executionEnabled:false',
            'operationPerformed:false',
        ]:
            self.assertIn(fragment, helper_source)

    def test_evidence_correlation_api_is_owner_scoped_bounded_and_read_only(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-correlations" && method === "GET")')
        for fragment in [
            'new Set(["module"])',
            'e.owner_uid = ? AND f.owner_uid = ?',
            'f.id = e.finding_id AND f.owner_uid = e.owner_uid',
            'ORDER BY e.id ASC',
            'LIMIT 501',
            'buildEvidenceCorrelation(rows.results || [], { maxRows: 500, maxGroups: 50 })',
            'scope: "authenticated_owner_staging_only"',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', "INSERT INTO", "UPDATE intelligence_", "DELETE FROM"]:
            self.assertNotIn(forbidden, route)
        helper = ROOT / "intelligence-evidence-correlation.mjs"
        self.assertTrue(helper.exists())
        helper_source = helper.read_text()
        for fragment in [
            'assessment: "cross_finding_evidence_metadata_patterns_only"',
            'isContradictionVerdict: false',
            'evidenceContentVerified: false',
            'sourceReachabilityChecked: false',
            'checkPassed: false',
            'executionEnabled: false',
            'operationPerformed: false',
        ]:
            self.assertIn(fragment, helper_source)

    def test_correlation_review_history_api_is_owner_scoped_bounded_and_read_only(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-correlations/reviews" && method === "GET")')
        for fragment in [
            'new Set(["correlationKeySha256", "limit"])',
            'WHERE owner_uid = ? AND (? = \'\' OR correlation_key_sha256 = ?)',
            'ORDER BY reviewed_at DESC, id DESC',
            'LIMIT ?',
            'buildEvidenceCorrelationReviewHistory(rows.results || [])',
            'scope: "authenticated_owner_staging_only"',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'INSERT INTO', 'UPDATE intelligence_', 'DELETE FROM']:
            self.assertNotIn(forbidden, route)

    def test_correlation_review_post_recomputes_current_owner_pattern_and_appends_owner_decision(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-correlations/reviews" && method === "POST")')
        for fragment in [
            '["correlationType", "correlationKey", "outcome", "reason"]',
            'EVIDENCE_CORRELATION_TYPES.includes(body.correlationType)',
            'EVIDENCE_CORRELATION_REVIEW_OUTCOMES.includes(body.outcome)',
            'e.owner_uid = ? AND f.owner_uid = ?',
            'buildEvidenceCorrelation(rows.results || [], { maxRows: 500, maxGroups: 50 })',
            'item.correlationType === body.correlationType && item.correlationKey === body.correlationKey',
            'group.referencesTruncated',
            'buildEvidenceCorrelationReviewSnapshot(group.references)',
            'reviewId, owner.uid, owner.uid, body.correlationType',
            'INSERT INTO intelligence_evidence_correlation_reviews',
            'relationshipFactVerified: false',
            'evidenceContentVerified: false',
            'checkPassed: false',
            'executionEnabled: false',
            'operationPerformed: true',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['body.ownerUid', 'body.reviewerUid', 'UPDATE intelligence_', 'DELETE FROM']:
            self.assertNotIn(forbidden, route)
        helper = ROOT / "intelligence-evidence-correlation-review.mjs"
        migration = ROOT / "migrations" / "0011_intelligence_evidence_correlation_reviews.sql"
        self.assertTrue(helper.exists())
        self.assertTrue(migration.exists())
        migration_source = migration.read_text()
        self.assertIn("trg_intelligence_correlation_review_immutable", migration_source)
        self.assertIn("trg_intelligence_correlation_review_no_delete", migration_source)
        self.assertIn("trg_intelligence_correlation_review_audit_insert", migration_source)

    def test_evidence_decision_support_api_remains_owner_scoped_and_bounded(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-decision-support" && method === "GET")')
        self.assertIn('new Set(["module"])', route)
        self.assertIn('COMPANY_MODULES.includes(moduleId)', route)
        self.assertIn('loadOwnerEvidenceDecisionSupport(env, owner.uid, moduleId)', route)
        helper_start = self.source.index("async function loadOwnerEvidenceDecisionSupport(")
        helper_end = self.source.index("async function handle(", helper_start)
        helper = self.source[helper_start:helper_end]
        for fragment in [
            'f.owner_uid = ?', 'e.owner_uid = ? AND f.owner_uid = ?',
            'LIMIT 101', 'LIMIT 501', 'LIMIT 100',
            'buildEvidenceDecisionSupport({',
            'review_key_sha256', 'reviewKey',
            'findingsReviewLimitReached', 'evidenceReferenceScanLimitReached',
            'priorDecisionOutcomes: {',
            'item.priorDecisionOutcome === "accepted"',
            'item.priorDecisionOutcome === "rejected"',
            'item.priorDecisionOutcome === "needs_more_info"',
            'unreviewed: recommendations.filter(item => !item.priorDecisionOutcome).length',
        ]:
            self.assertIn(fragment, helper)
        self.assertIn('import { buildEvidenceDecisionSupport } from "./intelligence-evidence-decision-support.mjs";', self.source)

    def test_evidence_decision_review_integrity_api_is_owner_scoped_bounded_and_read_only(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-decision-reviews/integrity" && method === "GET")')
        for fragment in [
            'new Set(["limit"])',
            'WHERE owner_uid = ?',
            'ORDER BY reviewed_at DESC, id DESC',
            'LIMIT ?',
            'buildEvidenceDecisionReviewIntegrity(rows, async value =>',
            'truncated',
            'scope: "authenticated_owner_staging_only"',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['method === "POST"', 'method === "PUT"', 'method === "DELETE"', 'INSERT INTO', 'UPDATE intelligence_', 'DELETE FROM']:
            self.assertNotIn(forbidden, route)
        self.assertIn('buildEvidenceDecisionReviewIntegrity } from "./intelligence-evidence-decision-review.mjs";', self.source)
        helper = ROOT / "intelligence-evidence-decision-review.mjs"
        helper_source = helper.read_text()
        for fragment in [
            'stored_decision_snapshot_metadata_integrity_only',
            'snapshotHashMismatches',
            'snapshotIdentityMismatches',
            'reviewerOwnerMismatches',
            'evidenceContentVerified: false',
            'sourceReachabilityChecked: false',
            'decisionTruthVerified: false',
            'checkPassed: false',
            'executionEnabled: false',
        ]:
            self.assertIn(fragment, helper_source)

    def test_decision_snapshot_integrity_dashboard_is_private_read_only_and_uses_safe_dom(self):
        for element_id in [
            "intelDecisionIntegrityPanel",
            "refreshIntelDecisionIntegrityBtn",
            "intelDecisionIntegrityStatus",
            "intelDecisionIntegritySummary",
            "intelDecisionIntegrityList",
        ]:
            self.assertIn(f'id="{element_id}"', self.index_html)
        self.assertIn('/intelligence/findings/evidence-decision-reviews/integrity?limit=50', self.index_html)
        self.assertIn('data.scope!=="authenticated_owner_staging_only"', self.index_html)
        self.assertIn('data.truncated?', self.index_html)
        self.assertIn('evidence content, source availability, authenticity, correctness, or decision truth', self.index_html)
        start = self.index_html.index("function renderIntelDecisionIntegritySummary(")
        loader_start = self.index_html.index("async function loadIntelDecisionIntegrity()", start)
        end = self.index_html.index("function renderIntelCompanyReadiness(", loader_start)
        renderer_code = self.index_html[start:loader_start]
        loader_code = self.index_html[loader_start:end]
        for fragment in [
            "document.createElement(",
            "textContent",
            "replaceChildren()",
            "addEventListener(\"click\",loadIntelDecisionIntegrity)",
        ]:
            self.assertIn(fragment, renderer_code + loader_code)
        for forbidden in ["innerHTML", "insertAdjacentHTML"]:
            self.assertNotIn(forbidden, renderer_code + loader_code)
        for forbidden in ["method:\"POST\"", "method:\"PUT\"", "method:\"DELETE\""]:
            self.assertNotIn(forbidden, loader_code)
        self.assertIn('if((name==="admin"||name==="intelligence")&&(!piUser||!piUser.isAdmin))', self.index_html)

    def test_evidence_decision_review_api_is_owner_scoped_current_and_append_only(self):
        route = self.route_block('if (path === "/intelligence/findings/evidence-decision-reviews" && method === "POST")')
        for fragment in [
            '["reviewKey", "outcome", "reason"]',
            'EVIDENCE_DECISION_REVIEW_OUTCOMES.includes(body.outcome)',
            'loadOwnerEvidenceDecisionSupport(env, owner.uid, "")',
            'candidate.reviewKey === body.reviewKey',
            'buildEvidenceDecisionReviewSnapshot(item)',
            'INSERT INTO intelligence_evidence_decision_reviews',
            'reviewId, owner.uid, owner.uid',
            'findingStateChanged: false',
            'companyStateChanged: false',
            'executionEnabled: false',
            'operationPerformed: true',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ['body.ownerUid', 'body.reviewerUid', 'UPDATE intelligence_', 'DELETE FROM']:
            self.assertNotIn(forbidden, route)
        history = self.route_block('if (path === "/intelligence/findings/evidence-decision-reviews" && method === "GET")')
        self.assertIn('WHERE owner_uid = ?', history)
        self.assertIn('LIMIT ?', history)
        migration = ROOT / "migrations" / "0012_intelligence_evidence_decision_reviews.sql"
        helper = ROOT / "intelligence-evidence-decision-review.mjs"
        self.assertTrue(migration.exists())
        self.assertTrue(helper.exists())
        migration_source = migration.read_text()
        for trigger in [
            "trg_intelligence_decision_review_audit_insert",
            "trg_intelligence_decision_review_immutable",
            "trg_intelligence_decision_review_no_delete",
        ]:
            self.assertIn(trigger, migration_source)

    def test_company_assessment_overview_is_owner_only_read_only_and_partial_failure_safe(self):
        registry_start = self.source.index('if (path === "/intelligence/company/modules"')
        registry_end = self.source.index('if (path === "/intelligence/company/assessment-coverage"', registry_start)
        registry_route = self.source[registry_start:registry_end]
        self.assertEqual(registry_route.count("success: true"), 1)
        self.assertIn('scope: "authenticated_owner_staging_only"', registry_route)
        for element_id in [
            "intelCompanyReadinessPanel",
            "refreshIntelCompanyReadinessBtn",
            "intelCompanyReadinessStatus",
            "intelCompanyReadinessSummary",
            "intelCompanyReadinessSources",
        ]:
            self.assertIn(f'id="{element_id}"', self.index_html)
        start = self.index_html.index("function renderIntelCompanyReadiness(")
        end = self.index_html.index("async function loadProjects()", start)
        panel_code = self.index_html[start:end]
        for endpoint in [
            "/intelligence/company/assessment-coverage",
            "/intelligence/findings/priorities?limit=100",
            "/intelligence/findings/remediation-plans?limit=100",
            "/intelligence/company/modules",
            "/intelligence/company/dependency-impact?module=",
            "/intelligence/company/gap-test-strategy?module=",
            "/intelligence/findings/evidence-decision-support",
            "/intelligence/findings/evidence-decision-reviews/integrity?limit=100",
        ]:
            self.assertIn(endpoint, panel_code)
        self.assertIn('if(data.scope!=="authenticated_owner_staging_only")', panel_code)
        for fragment in [
            "Promise.allSettled",
            "authenticated_owner_staging_only",
            "Unavailable",
            "no check is passed by absence",
            "not a risk verdict",
            "no task or change is created",
            "not owner decisions or factual verdicts",
            "replaceChildren()",
            "document.createElement(",
            "textContent",
            "addEventListener(\"click\",loadIntelCompanyReadiness)",
        ]:
            self.assertIn(fragment, panel_code)
        for forbidden in ["innerHTML", "insertAdjacentHTML"]:
            self.assertNotIn(forbidden, panel_code)
        company_loader_start = self.index_html.index("async function loadIntelCompanyReadiness()")
        company_loader_end = self.index_html.index('$("refreshIntelCompanyReadinessBtn")?.addEventListener', company_loader_start)
        company_loader = self.index_html[company_loader_start:company_loader_end]
        for forbidden in ['method:"POST"', 'method:"PUT"', 'method:"DELETE"', "innerHTML", "insertAdjacentHTML"]:
            self.assertNotIn(forbidden, company_loader)
        self.assertIn('if((name==="admin"||name==="intelligence")&&(!piUser||!piUser.isAdmin))', self.index_html)

    def test_priority_action_plan_is_owner_scoped_bounded_and_advisory(self):
        route = self.route_block('if (path === "/intelligence/findings/priority-action-plan" && method === "GET")')
        for fragment in [
            'new Set(["module", "limit"])',
            'COMPANY_MODULES.includes(moduleId)',
            'LIMIT 500',
            'WHERE f.owner_uid = ?',
            'e.owner_uid = f.owner_uid',
            'buildPriorityActionPlan(rows, limit)',
            'authenticated_owner_staging_only',
            'Priority action-plan limit must be an integer from 1 to 100',
        ]:
            self.assertIn(fragment, route)
        for forbidden in ["INSERT INTO", "UPDATE intelligence_", "DELETE FROM", "env.AI", "fetch("]:
            self.assertNotIn(forbidden, route)
        for fragment in [
            "scoreFindingPriority",
            "buildRemediationPlan",
            "MAX_CANDIDATES = 500",
            "MAX_RETURNED = 100",
            "ownerDecision: \"not_recorded\"",
            "ownerApprovalRequired: true",
            "contentVerified: false",
            "sourceReachabilityChecked: false",
            "taskCreated: false",
            "executionEnabled: false",
            "operationPerformed: false",
        ]:
            self.assertIn(fragment, self.priority_action_plan_module)
        for forbidden in ["INSERT INTO", "UPDATE ", "DELETE ", "fetch("]:
            self.assertNotIn(forbidden, self.priority_action_plan_module)

    def test_priority_action_plan_dashboard_uses_safe_owner_scoped_rendering(self):
        panel_start = self.index_html.index('id="intelPriorityActionPlanPanel"')
        panel_end = self.index_html.index('<div class="panel intelligence-memory">', panel_start)
        panel = self.index_html[panel_start:panel_end]
        self.assertIn('id="intelPriorityActionModule"', panel)
        self.assertIn('id="intelPriorityActionPlanList"', panel)
        self.assertIn('Owner review is required', panel)
        function_start = self.index_html.index("function renderIntelPriorityActionPlan(data)")
        function_end = self.index_html.index('async function loadIntelCompanyReadiness()', function_start)
        renderer = self.index_html[function_start:function_end]
        self.assertIn('createElement("article")', renderer)
        self.assertIn("textContent", renderer)
        self.assertIn('"/intelligence/findings/priority-action-plan"', renderer)
        self.assertIn('authenticated_owner_staging_only', renderer)
        self.assertNotIn("innerHTML", renderer)
        self.assertNotIn("insertAdjacentHTML", renderer)
        self.assertIn('method:"POST"', renderer)
        self.assertIn('"/intelligence/findings/priority-action-reviews"', renderer)
        self.assertIn("loadIntelPriorityActionPlan()", self.index_html)


    def test_intelligence_ui_fails_closed_until_staging_worker_is_connected(self):
        api_start = self.index_html.index("async function api(path,options={})")
        api_end = self.index_html.index("\n\n", api_start)
        api_helper = self.index_html[api_start:api_end]
        self.assertIn('if(path.startsWith("/intelligence/"))return intelligenceStagingRequest(path,options);', api_helper)
        staging_start = self.index_html.index("async function intelligenceStagingRequest")
        staging_end = self.index_html.index("\nfunction updateIntelligenceStagingSessionUI", staging_start)
        staging = self.index_html[staging_start:staging_end]
        self.assertIn('if(!hasValidIntelligenceStagingUrl())throw new Error(', staging)
        self.assertIn('function hasValidIntelligenceStagingUrl(){return /^https:\\/\\/mehran-intelligence-staging\\.[a-z0-9-]+\\.workers\\.dev$/.test(INTELLIGENCE_STAGING_WORKER_URL)}', self.index_html)
        self.assertIn('tokenOverride', staging)
        self.assertLess(staging.index('if(!hasValidIntelligenceStagingUrl())'), staging.index('fetch(INTELLIGENCE_STAGING_WORKER_URL+path'))
        self.assertIn('const INTELLIGENCE_STAGING_WORKER_URL=""', self.index_html)
        self.assertIn('INTELLIGENCE_STAGING_SESSION_KEY="msh_intelligence_staging_session"', self.index_html)
        self.assertNotIn('fetch(AUTH_WORKER+path', staging)
        load_start = self.index_html.index("async function loadIntelligence(){")
        load_end = self.index_html.index("\nasync function loadIntelligenceTasks()", load_start)
        load_ui = self.index_html[load_start:load_end]
        self.assertIn('intelligenceStagingRequest("/session")', load_ui)
        self.assertNotIn('api("/admin/overview")', load_ui)
        self.assertNotIn('api("/projects")', load_ui)

    def test_intelligence_module_has_no_production_admin_mcp_or_scheduler_calls(self):
        start = self.index_html.index("async function loadIntelligence(){")
        end = self.index_html.index("\nasync function loadProjects()", start)
        module = self.index_html[start:end]
        for forbidden in ['api("/admin/', 'api("/projects"', 'api("/mcp"', 'fetch(AUTH_WORKER', 'loadIntelligenceSchedulerRuns', 'updateIntelligenceTask']:
            self.assertNotIn(forbidden, module)
        self.assertIn("No production MCP request is sent from this page", self.index_html)
        self.assertNotIn("sendIntelligenceMessage", self.index_html)
        self.assertIn('id="intelSendBtn" disabled', self.index_html)
        self.assertNotIn('path === "/intelligence/chat"', self.source)

    def test_staging_branch_does_not_reintroduce_the_intelligence_agent_workflow(self):
        workflow = ROOT / ".github" / "workflows" / "intelligence-agent.yml"
        self.assertFalse(workflow.exists(), "The disabled Intelligence Agent workflow must stay absent from staging branches.")

    def test_intelligence_pi_session_is_separate_and_access_token_is_not_persisted(self):
        connect_start = self.index_html.index("async function connectIntelligenceStagingSession")
        connect_end = self.index_html.index("\nasync function disconnectIntelligenceStagingSession", connect_start)
        connect = self.index_html[connect_start:connect_end]
        self.assertIn('intelligenceStagingRequest("/health",{auth:false})', connect)
        self.assertIn('health.schemaReady!==true||health.executor!==false', connect)
        self.assertIn('method:"DELETE",tokenOverride:issued.token', connect)
        self.assertLess(connect.index('intelligenceStagingRequest("/health",{auth:false})'), connect.index('window.Pi.authenticate(["username"]'))
        self.assertIn("let intelligenceStagingConnecting=false", self.index_html)
        self.assertIn("if(intelligenceStagingConnecting||getIntelligenceStagingToken())return;", connect)
        self.assertIn("intelligenceStagingConnecting=true", connect)
        self.assertIn('window.Pi.authenticate(["username"]', connect)
        self.assertIn('intelligenceStagingRequest("/session",{method:"POST",auth:false', connect)
        self.assertIn('body:JSON.stringify({accessToken:auth.accessToken})', connect)
        self.assertIn('localStorage.setItem(INTELLIGENCE_STAGING_SESSION_KEY,issued.token)', connect)
        self.assertNotIn('localStorage.setItem(ADMIN_SESSION_KEY', connect)
        self.assertNotIn('localStorage.setItem(SOCIAL_TOKEN_KEY', connect)
        self.assertNotIn('localStorage.setItem(INTELLIGENCE_STAGING_SESSION_KEY,auth.accessToken)', connect)
        self.assertIn('intelligenceStagingRequest("/session")', connect)
        self.assertIn('intelligenceStagingRequest("/session",{method:"DELETE"})', self.index_html)

    def test_priority_action_owner_review_ui_is_owner_scoped_and_non_executing(self):
        self.assertIn('id="refreshIntelPriorityActionReviewIntegrityBtn"', self.index_html)
        self.assertIn('id="intelPriorityActionReviewIntegrityStatus"', self.index_html)
        start = self.index_html.index("async function loadIntelPriorityActionReviewHistory")
        end = self.index_html.index("async function loadIntelPriorityActionPlan()", start)
        ui = self.index_html[start:end]
        renderer_start = self.index_html.index("function renderIntelPriorityActionPlan(data)")
        renderer_end = self.index_html.index("async function loadIntelPriorityActionReviewHistory", renderer_start)
        renderer = self.index_html[renderer_start:renderer_end]
        for fragment in [
            '"/intelligence/findings/priority-action-reviews?actionKey="',
            '"/intelligence/findings/priority-action-reviews/integrity?limit=100"',
            'authenticated_owner_staging_only',
            "Boolean(data.truncated)",
            "older records were not included",
            "integrityProblems===0&&!incompleteScan",
            'textContent'
        ]:
            self.assertIn(fragment, ui)
        for fragment in [
            'method:"POST"',
            'actionKey:action.actionKey',
            'moduleId:action.moduleId',
            'outcome:outcome.value',
            'reasonInput.value.trim()',
            '"/intelligence/findings/priority-action-reviews"',
            'Execution: disabled.'
        ]:
            self.assertIn(fragment, renderer)
        self.assertNotIn("innerHTML", ui + renderer)
        self.assertNotIn("insertAdjacentHTML", ui + renderer)

    def test_priority_action_review_is_owner_scoped_append_only_and_stale_safe(self):
        self.assertIn('"intelligence_priority_action_reviews"', self.source)
        plan = self.route_block('if (path === "/intelligence/findings/priority-action-plan" && method === "GET")')
        self.assertIn("buildPriorityActionReviewSnapshot(action)", plan)
        self.assertIn("action.actionKey = await sha256Hex", plan)

        post = self.route_block('if (path === "/intelligence/findings/priority-action-reviews" && method === "POST")')
        for fragment in [
            '["actionKey", "moduleId", "outcome", "reason"]',
            'PRIORITY_ACTION_REVIEW_OUTCOMES.includes(body.outcome)',
            'WHERE f.owner_uid = ?',
            'LIMIT 500',
            'rows.length >= 500',
            'buildPriorityActionPlan(rows, 100)',
            'buildPriorityActionReviewSnapshot(action)',
            'actionKey === body.actionKey',
            'INSERT INTO intelligence_priority_action_reviews',
            'reviewId, owner.uid, owner.uid',
            'findingStateChanged: false',
            'companyStateChanged: false',
            'executionEnabled: false',
            'operationPerformed: true',
        ]:
            self.assertIn(fragment, post)
        for forbidden in ['body.ownerUid', 'body.reviewerUid', 'UPDATE intelligence_', 'DELETE FROM']:
            self.assertNotIn(forbidden, post)

        history = self.route_block('if (path === "/intelligence/findings/priority-action-reviews" && method === "GET")')
        self.assertIn('WHERE owner_uid = ?', history)
        self.assertIn('LIMIT ?', history)
        integrity = self.route_block('if (path === "/intelligence/findings/priority-action-reviews/integrity" && method === "GET")')
        self.assertIn('WHERE owner_uid = ?', integrity)
        self.assertIn('buildPriorityActionReviewIntegrity(rows, sha256Hex)', integrity)

        for fragment in [
            'accepted', 'rejected', 'needs_more_info',
            'reviewerMatchesOwner', 'snapshotHashMatches',
            'findingStateChanged: false', 'companyStateChanged: false',
            'executionEnabled: false'
        ]:
            self.assertIn(fragment, self.priority_action_review_module)
        for forbidden in ['fetch(', 'INSERT INTO', 'UPDATE ', 'DELETE ']:
            self.assertNotIn(forbidden, self.priority_action_review_module)

        migration = ROOT / "migrations" / "0013_intelligence_priority_action_reviews.sql"
        self.assertTrue(migration.exists())
        migration_source = migration.read_text(encoding="utf-8")
        for fragment in [
            'FOREIGN KEY(finding_id, owner_uid)',
            'CHECK(reviewer_uid = owner_uid)',
            'CHECK(outcome IN (\'accepted\',\'rejected\',\'needs_more_info\'))',
            'trg_intelligence_priority_action_review_audit_insert',
            'trg_intelligence_priority_action_review_immutable',
            'trg_intelligence_priority_action_review_no_delete'
        ]:
            self.assertIn(fragment, migration_source)

    def test_staging_wrangler_config_is_isolated_and_not_deployable_yet(self):
        self.assertIn('"name": "mehran-intelligence-staging"', self.config)
        self.assertIn('"main": "intelligence-staging-worker.js"', self.config)
        self.assertIn('"database_name": "mehran-msh-intelligence-staging"', self.config)
        self.assertIn('"database_id": "REPLACE_WITH_VERIFIED_STAGING_DATABASE_ID"', self.config)
        self.assertIn("migrations through 0015", self.config)
        self.assertNotIn('"mehran-msh-db"', self.config)
        self.assertNotIn('"ai":', self.config)
        self.assertNotRegex(self.config, r'"crons"\s*:')
        self.assertNotRegex(self.config, r'"queues"\s*:')
        self.assertNotRegex(self.config, r'"routes"\s*:')

    def test_intelligence_dashboard_loads_company_assessment_overview_automatically(self):
        start = self.index_html.index("async function loadIntelligence(){")
        end = self.index_html.index("\nasync function loadIntelligenceTasks()", start)
        loader = self.index_html[start:end]
        self.assertIn("loadIntelCompanyReadiness()", loader)
        self.assertIn("loadIntelPriorityActionPlan()", loader)
        self.assertIn("loadIntelDecisionIntegrity()", loader)


    def test_ai_proposal_design_defines_immutable_snapshots_and_append_only_events(self):
        design = (ROOT / "docs" / "INTELLIGENCE-AI-PROPOSAL-ONLY-DESIGN.md").read_text(encoding="utf-8")
        for fragment in [
            "The proposal payload is immutable after intake.",
            "separate append-only event ledger",
            "transactionally maintained projection",
            "pending to accepted, rejected, expired, or superseded",
            "server-assigned timestamps",
            "client-supplied authority fields are rejected",
            "unique constraint or equivalent conditional write",
        ]:
            self.assertIn(fragment, design)
        self.assertIn("## Implementation gate", design)
        self.assertIn("explicitly authorize that specific staging-only implementation step", design)


    def test_owner_manual_writes_are_separate_from_future_agent_capabilities(self):
        # All business routes are behind the Pi-verified staging owner session.
        gate = 'const owner = await verifySession(request, env);'
        self.assertIn(gate, self.source)
        gate_positions = [match.start() for match in re.finditer(re.escape(gate), self.source)]
        self.assertGreaterEqual(len(gate_positions), 3)
        # The third occurrence is the shared gate after the session-only routes.
        gate_index = gate_positions[2]
        auth_check = self.source.index('if (!owner) return fail("Authentication required.", 401);', gate_index)
        for marker in [
            'if (path === "/intelligence/memory" && method === "POST")',
            'if (path === "/intelligence/knowledge" && method === "POST")',
            'if (path === "/intelligence/knowledge/relations" && method === "POST")',
        ]:
            self.assertGreater(self.source.index(marker), auth_check)
            route = self.route_block(marker)
            self.assertIn("owner.uid", route)

        # Capability evaluation only assesses a server-side approval.
        evaluation = self.route_block('if (path === "/intelligence/capabilities/evaluate" && method === "POST")')
        for fragment in [
            'WHERE id=? AND owner_uid=?',
            'serverVerified: true',
            'assessmentOnly: true',
            'operationPerformed: false',
            'executionEnabled: false',
            'capability_assessed',
        ]:
            self.assertIn(fragment, evaluation)
        for forbidden in ['consumed_at =', 'consumed_by =', 'executeTask(', 'claimTask(']:
            self.assertNotIn(forbidden, evaluation)

        policy = (ROOT / "intelligence-capability-policy.mjs").read_text(encoding="utf-8")
        self.assertIn("future AI/agent-delegated requests", policy)
        self.assertIn("Current owner-facing write routes are direct, human-initiated actions", policy)
        self.assertIn("export const EXECUTION_ENABLED = false;", policy)

        # Staging exposes no agent identity, agent session, or agent route.
        for forbidden in [
            'path.startsWith("/agent/',
            'path === "/agent/',
            'agentSession',
            'AGENT_TOKEN',
            'env.AI',
            'scheduled(',
            'waitUntil(',
        ]:
            self.assertNotIn(forbidden, self.source)



    def test_ai_proposal_design_specifies_canonical_hash_encoding(self):
        design = (ROOT / "docs" / "INTELLIGENCE-AI-PROPOSAL-ONLY-DESIGN.md").read_text(encoding="utf-8")
        for fragment in [
            "RFC 8785 JSON Canonicalization Scheme (JCS)",
            "Reject duplicate object member names",
            "UTF-8",
            "SHA-256",
            "canonicalization version",
            "Never hash client-provided canonical JSON",
            "Unicode edge cases, duplicate keys, numeric boundary cases",
        ]:
            self.assertIn(fragment, design)


    def test_ai_proposal_design_blocks_untrusted_url_fetch_and_double_acceptance(self):
        design = (ROOT / "docs" / "INTELLIGENCE-AI-PROPOSAL-ONLY-DESIGN.md").read_text(encoding="utf-8")
        for fragment in [
            "A URL in a proposal is an inert reference",
            "must not fetch it, follow redirects",
            "private network addresses",
            "DNS/IP validation on every hop",
            "two concurrent accept attempts result in exactly one successful commit",
            "compare-and-swap",
            "If any condition fails, no canonical record",
            "payload change, or target-version change",
        ]:
            self.assertIn(fragment, design)

    def test_ai_proposal_design_requires_database_enforced_atomic_acceptance(self):
        design = (ROOT / "docs" / "INTELLIGENCE-AI-PROPOSAL-ONLY-DESIGN.md").read_text(encoding="utf-8")
        for fragment in [
            "D1 batch can keep statements atomic",
            "UPDATE",
            "matches zero rows is still a successful SQL statement",
            "Do not rely on checking `meta.changes` after a D1 batch has already committed",
            "all roll back",
            "Enforce uniqueness in the schema",
            "genuinely overlapping requests",
            "deliberately failing final statement",
            "Keep proposals review-only",
        ]:
            self.assertIn(fragment, design)

if __name__ == "__main__":
    unittest.main(verbosity=2)
