// Deterministic test strategy derived from the declared company assessment blueprint.
// This module recommends tests; it does not execute them or infer pass/fail outcomes.
export const GAP_STRATEGY_VERSION = 1;
export const COMPANY_TEST_BLUEPRINTS = Object.freeze({
  music: {
    ownership_and_access: ["Verify owner and role boundaries", "Attempt unauthorized access to private music assets", "Confirm access revocation takes effect"],
    service_health: ["Check service health and dependency timeout handling", "Exercise unavailable storage or streaming dependency", "Verify user-safe error and recovery behavior"],
    content_integrity: ["Test metadata and media input validation", "Check upload size and content-type boundaries", "Verify untrusted metadata is rendered as text"],
    user_experience: ["Walk through browse, playback, and playlist journeys", "Test empty, loading, and playback-failure states", "Check keyboard and narrow-screen usability"]
  },
  ai: {
    model_and_provider_configuration: ["Verify configured model and provider allowlists", "Test provider timeout and fallback behavior", "Confirm unknown model identifiers are rejected"],
    data_privacy: ["Check prompt and response data minimization", "Test that one user's context is not exposed to another", "Inspect retention and deletion behavior"],
    access_control: ["Test owner and user capability boundaries", "Attempt unauthorized access to model settings", "Verify secrets are never returned to clients"],
    service_health: ["Test provider outage and rate-limit handling", "Check bounded request and response sizes", "Verify safe degraded-mode behavior"]
  },
  social: {
    authentication: ["Test registration and login validation", "Check session expiry and revocation", "Exercise credential rate limits and abuse cases"],
    authorization: ["Attempt cross-user profile and conversation access", "Test group and channel membership boundaries", "Verify blocked users cannot perform restricted actions"],
    privacy: ["Check private profile and visibility settings", "Test data export and deletion boundaries", "Verify private content is excluded from public discovery"],
    upload_security: ["Test file size, type, and extension validation", "Check generated object names and storage access controls", "Test malformed and oversized media rejection"],
    abuse_controls: ["Exercise report, block, and mute flows", "Test message and post rate limits", "Check spam and repeated-request handling"]
  },
  instruments: {
    catalog_integrity: ["Test product identifiers and required catalog fields", "Check price and inventory validation", "Verify untrusted product descriptions render safely"],
    supplier_workflows: ["Test supplier role and record access", "Exercise incomplete and conflicting supplier records", "Verify approval history is retained"],
    payments_and_orders: ["Test order totals and currency calculations", "Exercise duplicate and replayed payment notifications", "Verify order state transitions are authorized"],
    logistics: ["Test shipment status transitions", "Exercise missing and inconsistent tracking events", "Verify delivery exceptions are visible"]
  },
  robotics: {
    device_identity: ["Test device enrollment and identity verification", "Reject unknown or revoked device credentials", "Check device-to-owner association boundaries"],
    safety_boundaries: ["Test command allowlists and prohibited actions", "Verify safety interlocks reject unsafe states", "Exercise emergency stop and recovery procedures"],
    update_integrity: ["Test signed update verification", "Reject rollback and tampered update packages", "Verify update failure recovery behavior"],
    operator_access: ["Test operator role and least-privilege controls", "Attempt unauthorized command issuance", "Verify operator actions are auditable"]
  },
  security: {
    authentication: ["Test login, expiry, and revocation paths", "Exercise rate limits and brute-force resistance", "Verify session tokens are not exposed in logs"],
    authorization: ["Run cross-owner and cross-role access tests", "Attempt privilege escalation through modified requests", "Verify deny-by-default behavior"],
    auditability: ["Check audit records for sensitive state changes", "Test audit failure handling and transaction rollback", "Verify audit records cannot be silently altered"],
    secret_handling: ["Scan tracked files for accidental credentials", "Verify secrets are not returned in API responses", "Test secret rotation and invalidation procedures"],
    recovery: ["Exercise backup restoration in an isolated environment", "Verify recovery-point and recovery-time assumptions", "Test recovery access controls and audit trail"]
  },
  intelligence: {
    owner_isolation: ["Test cross-owner reads and writes are rejected", "Verify every owner query is scoped to the authenticated UID", "Test session expiry and revocation"],
    knowledge_quality: ["Test source attribution and provenance fields", "Exercise disputed and unreviewed knowledge states", "Verify unsupported claims are not promoted to verified"],
    approval_boundaries: ["Test approval scope, expiry, and one-time use", "Attempt replay and cross-capability approval use", "Verify assessment endpoints do not consume approvals"],
    assessment_integrity: ["Test unknown versus recorded evidence states", "Verify no evidence is not interpreted as a passing result", "Check assessment output is bounded and reproducible"],
    observability: ["Test safe error reporting without secret leakage", "Check audit and health signals for expected events", "Exercise rate-limit and dependency-failure visibility"]
  },
  logistics: {
    workflow_integrity: ["Test shipment state transition rules", "Reject duplicate and out-of-order workflow events", "Verify each transition is attributable"],
    tracking: ["Test tracking identifier validation", "Exercise missing and delayed tracking updates", "Verify external event authenticity checks"],
    supplier_access: ["Test supplier-specific record isolation", "Attempt unauthorized shipment updates", "Verify access removal takes effect"],
    exception_handling: ["Exercise lost, delayed, and damaged shipment cases", "Test retry and duplicate-event behavior", "Verify exception resolution is auditable"]
  },
  "customer-experience": {
    privacy: ["Test customer data visibility boundaries", "Verify sensitive fields are masked where required", "Exercise retention and deletion rules"],
    response_quality: ["Test response templates against known scenarios", "Check unsafe or unsupported claims are escalated", "Verify human review paths for sensitive cases"],
    case_access: ["Test case ownership and role permissions", "Attempt cross-customer case access", "Verify case reassignment is auditable"],
    service_continuity: ["Exercise support-channel outage behavior", "Test queue recovery and duplicate submissions", "Verify users receive clear failure states"]
  },
  labs: {
    experiment_isolation: ["Test experiment data and environment separation", "Attempt cross-project access", "Verify cleanup after experiment completion"],
    data_handling: ["Test dataset classification and access controls", "Check sensitive data is excluded from unauthorized exports", "Verify retention and deletion behavior"],
    reproducibility: ["Re-run a controlled experiment with pinned inputs", "Verify configuration and version capture", "Check result provenance and integrity"],
    release_gates: ["Test required review and approval gates", "Attempt release with missing evidence", "Verify rollback and release audit records"]
  },
  governance: {
    policy_versioning: ["Test policy version creation and immutable history", "Verify active policy selection is deterministic", "Exercise rollback to an approved prior version"],
    approval_integrity: ["Test approver identity and approval scope", "Reject expired, replayed, or out-of-scope approvals", "Verify approval records are auditable"],
    audit_trails: ["Check sensitive decisions create audit records", "Test audit failure behavior", "Verify actor, timestamp, and target attribution"],
    separation_of_duties: ["Attempt self-approval where separation is required", "Test distinct requester and approver roles", "Verify privileged actions require the correct role"]
  },
  data: {
    data_classification: ["Test classification rules for representative records", "Verify restricted data access is denied by default", "Check classification changes are auditable"],
    retention: ["Test retention deadlines and deletion workflows", "Verify legal or operational holds are respected", "Check expired data is not exposed by search"],
    backup_recovery: ["Restore a backup in an isolated test environment", "Verify restored record counts and integrity", "Test access controls after restoration"],
    owner_isolation: ["Attempt cross-owner data queries", "Verify owner identity comes from trusted session context", "Test isolation across search and export paths"]
  },
  "robot-operations": {
    device_authentication: ["Test device credential enrollment and rotation", "Reject revoked and unknown devices", "Verify mutual identity checks on reconnect"],
    command_authorization: ["Test command allowlists by operator role", "Reject replayed and unauthorized commands", "Verify command scope is bound to the target device"],
    safety_interlocks: ["Test interlocks under unsafe simulated conditions", "Verify emergency stop overrides normal commands", "Test safe recovery after interlock activation"],
    event_audit: ["Verify device and operator events are attributable", "Test tamper and missing-event detection", "Check audit failure does not silently authorize commands"]
  }
});

export function buildGapTestStrategy(moduleId, recordedRows = []) {
  if (!Object.hasOwn(COMPANY_TEST_BLUEPRINTS, moduleId)) throw new TypeError("Unknown company module.");
  const rows = new Map();
  for (const row of recordedRows) {
    if (!row || typeof row.check_id !== "string") continue;
    const key = row.check_id;
    rows.set(key, {
      findingCount: Math.max(0, Number(row.finding_count) || 0),
      openFindingCount: Math.max(0, Number(row.open_finding_count) || 0)
    });
  }
  const checks = Object.entries(COMPANY_TEST_BLUEPRINTS[moduleId]).map(([checkId, tests]) => {
    const recorded = rows.get(checkId) || { findingCount: 0, openFindingCount: 0 };
    return {
      checkId,
      evidenceState: recorded.findingCount ? "findings_recorded" : "no_recorded_finding",
      findingCount: recorded.findingCount,
      openFindingCount: recorded.openFindingCount,
      coverageSignal: "unverified",
      recommendedTests: tests,
      interpretation: recorded.findingCount
        ? "Findings are recorded for this check; review their evidence and status before selecting tests."
        : "No finding is recorded for this check; this does not mean the check passed or that no issue exists."
    };
  });
  return {
    moduleId,
    strategyVersion: GAP_STRATEGY_VERSION,
    blueprintCheckCount: checks.length,
    checksWithRecordedFindings: checks.filter(item => item.findingCount > 0).length,
    checksWithoutRecordedFindings: checks.filter(item => item.findingCount === 0).length,
    checks,
    assessmentState: "test_strategy_recommendations_only",
    evidenceCompleteness: "unverified",
    testsExecuted: false,
    executionEnabled: false,
    operationPerformed: false,
    isGapVerdict: false,
    limitations: [
      "The blueprint is a planning checklist, not proof that a control or test exists in a repository.",
      "No recorded finding means unknown or not recorded, not passed, secure, complete, or defect-free.",
      "Recorded finding counts do not establish severity, root cause, exploitability, or current validity.",
      "Recommended tests are proposals and have not been run.",
      "No repository is scanned, no external evidence is fetched, and no company or finding state is changed."
    ]
  };
}
