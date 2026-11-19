#!/usr/bin/env python3
"""Static safety contract for the isolated Intelligence staging Worker."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "intelligence-staging-worker.js"
CONFIG = ROOT / "wrangler.intelligence-staging.jsonc"

class StagingWorkerSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SOURCE.read_text(encoding="utf-8")
        cls.config = CONFIG.read_text(encoding="utf-8")

    def test_health_requires_the_capability_approval_ledger(self):
        match = re.search(
            r'const required = \[(.*?)\];',
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "Health route must declare its required schema tables.")
        required_tables = set(re.findall(r'"([a-z_]+)"', match.group(1)))
        self.assertIn("intelligence_capability_approvals", required_tables)
        self.assertIn("const schemaReady = missing.length === 0 && foreignKeysEnabled && violationCount === 0", self.source)

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
        start = self.source.index('if (path === "/intelligence/findings/priorities" && method === "GET")')
        end = self.source.index('if (path === "/intelligence/findings" && method === "GET")', start)
        route = self.source[start:end]
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

    def test_memory_deletion_is_owner_scoped_and_audited(self):
        self.assertIn('if (memoryDeleteMatch && method === "DELETE")', self.source)
        self.assertIn('DELETE FROM intelligence_owner_memory WHERE id=? AND owner_uid=?', self.source)
        self.assertIn('"owner_memory_deleted"', self.source)
        self.assertIn('SELECT ?,?,?,?,?,?,? WHERE changes() = 1', self.source)

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
        route_start = self.source.index('if (path === "/intelligence/company/assessment-coverage" && method === "GET")')
        route_end = self.source.index('if (path === "/intelligence/findings" && method === "GET")', route_start)
        route = self.source[route_start:route_end]
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
        route_start = self.source.index('if (path === "/intelligence/company/dependency-impact" && method === "GET")')
        route_end = self.source.index('if (path === "/intelligence/findings" && method === "GET")', route_start)
        route = self.source[route_start:route_end]
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
        route_start = self.source.index('if (path === "/intelligence/company/gap-test-strategy" && method === "GET")')
        route_end = self.source.index('if (path === "/intelligence/findings" && method === "GET")', route_start)
        route = self.source[route_start:route_end]
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

    def test_staging_wrangler_config_is_isolated_and_not_deployable_yet(self):
        self.assertIn('"name": "mehran-intelligence-staging"', self.config)
        self.assertIn('"main": "intelligence-staging-worker.js"', self.config)
        self.assertIn('"database_name": "mehran-msh-intelligence-staging"', self.config)
        self.assertIn('"database_id": "REPLACE_WITH_VERIFIED_STAGING_DATABASE_ID"', self.config)
        self.assertIn("migrations 0000-0008", self.config)
        self.assertNotIn('"mehran-msh-db"', self.config)
        self.assertNotIn('"ai":', self.config)
        self.assertNotRegex(self.config, r'"crons"\s*:')
        self.assertNotRegex(self.config, r'"queues"\s*:')
        self.assertNotRegex(self.config, r'"routes"\s*:')

if __name__ == "__main__":
    unittest.main(verbosity=2)
