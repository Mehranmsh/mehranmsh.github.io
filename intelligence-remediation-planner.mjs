const BASE_STEPS = Object.freeze([
  { id: "confirm", title: "Confirm the finding", detail: "Review the recorded evidence and reproduce the reported condition in an isolated staging environment." },
  { id: "scope", title: "Define the change boundary", detail: "Identify the exact affected component and document what must remain unchanged." },
  { id: "design", title: "Prepare a minimal remediation", detail: "Draft the smallest change that addresses the finding; do not modify production or unrelated modules." },
  { id: "review", title: "Perform an independent review", detail: "Check authorization, owner isolation, privacy, failure handling, and rollback implications before implementation." },
  { id: "validate", title: "Validate in staging", detail: "Run focused regression, security, and failure-path tests; retain the results as reviewable evidence." },
  { id: "approve", title: "Request owner decision", detail: "Present the proposed diff, test results, residual risks, and rollback plan for explicit owner approval." }
]);

const MODULE_GUIDANCE = Object.freeze({
  music: { area: "music services and content workflows", validation: ["content ownership and access tests", "audio delivery and metadata integrity tests", "service availability and user-flow regression"] },
  ai: { area: "AI provider configuration, prompts, and data boundaries", validation: ["provider configuration validation", "prompt and output boundary tests", "privacy and access-control regression"] },
  social: { area: "social identity, posts, messaging, and user media", validation: ["authentication and authorization tests", "cross-user privacy and access isolation tests", "upload validation and abuse-control tests"] },
  instruments: { area: "instrument catalog, supplier, order, and logistics workflows", validation: ["catalog integrity tests", "supplier and order authorization tests", "payment-state and fulfillment consistency tests"] },
  robotics: { area: "robot identity, safety policy, updates, and operator controls", validation: ["device identity and command authorization tests", "safety interlock and emergency-stop tests", "signed update and rollback tests"] },
  security: { area: "authentication, authorization, audit, secrets, and recovery", validation: ["negative authorization tests", "audit completeness and tamper-resistance tests", "secret handling and recovery exercises"] },
  intelligence: { area: "Intelligence ownership boundaries, knowledge, approvals, and observability", validation: ["owner-isolation tests", "approval-boundary and non-execution tests", "audit and assessment-integrity tests"] },
  logistics: { area: "tracking, supplier access, and exception workflows", validation: ["tracking-state transition tests", "supplier access isolation tests", "exception and retry-path tests"] },
  "customer-experience": { area: "customer records, support cases, and service continuity", validation: ["case-level authorization tests", "privacy and retention checks", "service continuity and response-quality regression"] },
  labs: { area: "experiment isolation, data handling, and release gates", validation: ["experiment isolation tests", "reproducibility checks", "release-gate and data-handling tests"] },
  governance: { area: "policy versions, approvals, audit trails, and separation of duties", validation: ["policy version integrity tests", "approval separation-of-duties tests", "audit trail completeness tests"] },
  data: { area: "data classification, retention, backup, and owner isolation", validation: ["classification and access-control tests", "retention enforcement tests", "backup restoration and owner-isolation tests"] },
  "robot-operations": { area: "robot authentication, command authorization, safety interlocks, and event audit", validation: ["device authentication tests", "command allowlist and operator authorization tests", "safety interlock and event-audit tests"] }
});

const CHECK_GUIDANCE = Object.freeze({
  authentication: "Verify identity proof, session lifecycle, credential handling, and rejection of invalid or expired sessions.",
  authorization: "Verify every sensitive operation checks the authenticated owner's identity and the minimum required permission.",
  privacy: "Trace collection, display, retention, and deletion paths; test that another user cannot access the data.",
  upload_security: "Validate file size, type, content, storage permissions, and unsafe filename handling before accepting media.",
  abuse_controls: "Review rate limits, reporting paths, spam controls, and safe handling of repeated failed requests.",
  secret_handling: "Inventory secret access, remove client exposure, restrict runtime access, and test rotation without logging secret values.",
  auditability: "Ensure sensitive state changes produce attributable, append-only audit records and fail safely if auditing fails.",
  approval_boundaries: "Confirm approval is scoped, expires, is consumed once where required, and cannot authorize a different operation.",
  owner_isolation: "Test positive and negative cases with separate owner identities across reads, writes, aggregates, and related records.",
  safety_boundaries: "Verify command allowlists, safe defaults, physical interlocks, emergency-stop behavior, and operator override boundaries.",
  device_identity: "Verify device identity is authenticated and bound to the expected owner and registered hardware.",
  device_authentication: "Reject unknown, revoked, or incorrectly bound device credentials before accepting any command.",
  command_authorization: "Require an authorized operator, explicit command allowlist, and safe state preconditions for every command.",
  data_privacy: "Minimize collected data, restrict access by purpose, and test retention and deletion behavior.",
  service_health: "Measure expected service behavior, failure modes, recovery, and user-visible degraded states.",
  content_integrity: "Verify content metadata, ownership, versioning, and delivery integrity.",
  payments_and_orders: "Verify order state transitions, idempotency, authorization, and reconciliation before any payment workflow changes.",
  update_integrity: "Require trusted update provenance, integrity verification, staged rollout, and rollback validation.",
  safety_interlocks: "Test interlock conditions and prove unsafe commands remain blocked under failure and restart scenarios."
});

function cleanText(value, max = 240) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export function buildRemediationPlan(finding) {
  const moduleId = MODULE_GUIDANCE[finding?.module_id] ? finding.module_id : "intelligence";
  const module = MODULE_GUIDANCE[moduleId];
  const checkId = cleanText(finding?.check_id, 80);
  const checkDetail = CHECK_GUIDANCE[checkId] || "Inspect the module's documented control, reproduce the finding, and identify the smallest safe correction.";
  const severity = ["critical", "high", "medium", "low", "info", "unrated"].includes(finding?.severity) ? finding.severity : "unrated";
  const status = ["open", "accepted", "mitigated", "resolved", "false_positive"].includes(finding?.status) ? finding.status : "open";
  const riskLevel = severity === "critical" || severity === "high" ? "high" : severity === "medium" ? "medium" : "low";
  const title = cleanText(finding?.title, 180) || "Untitled finding";
  const recommendation = cleanText(finding?.recommendation, 500);
  const steps = BASE_STEPS.map((step, index) => ({
    order: index + 1,
    id: step.id,
    title: step.title,
    detail: step.id === "confirm" ? checkDetail : step.detail
  }));
  return {
    findingId: cleanText(finding?.id, 100),
    moduleId,
    checkId,
    title,
    recordedSeverity: severity,
    recordedStatus: status,
    currentRecommendation: recommendation || "No owner-authored recommendation is recorded; investigate before selecting a change.",
    affectedArea: module.area,
    riskLevel,
    riskRationale: riskLevel === "high"
      ? "The recorded severity is critical or high; prioritize careful isolation, independent review, and rollback readiness."
      : riskLevel === "medium"
        ? "The recorded severity is medium; validate impact and dependencies before selecting the smallest safe change."
        : "The recorded severity is low, informational, or unrated; confirm impact before assigning implementation effort.",
    prerequisites: [
      "Owner confirms the finding is still applicable.",
      "Relevant staging environment and test data are available.",
      "A rollback or recovery approach is documented before implementation.",
      "Any required access or policy decision is explicitly approved by the owner."
    ],
    steps,
    affectedAreas: [module.area, "staging test suite", "owner review and audit trail"],
    validation: module.validation,
    dependencies: [
      "Confirm the finding's evidence and current system behavior.",
      "Inspect the actual repository and runtime configuration before naming files or proposing a code diff.",
      "Check for shared components or downstream modules that could be affected."
    ],
    ownerDecisionsRequired: [
      "Confirm whether the finding is valid and in scope.",
      "Approve the exact proposed change after reviewing its diff and test results.",
      "Decide whether residual risk is acceptable."
    ],
    planStatus: "advisory_only",
    executionEnabled: false,
    operationPerformed: false,
    isRiskVerdict: false,
    limitations: [
      "This is a structured remediation outline, not an automatically verified diagnosis.",
      "No repository files, external evidence, credentials, or production systems are inspected by this planner.",
      "Affected areas are module-level guidance, not verified file paths.",
      "No code, database, configuration, or company state is changed."
    ]
  };
}
