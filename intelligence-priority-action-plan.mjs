import { scoreFindingPriority, compareFindingPriority } from "./intelligence-finding-priority.mjs";
import { buildRemediationPlan } from "./intelligence-remediation-planner.mjs";

const MAX_CANDIDATES = 500;
const MAX_RETURNED = 100;

export function buildPriorityActionPlan(rows, limit = 25) {
  if (!Array.isArray(rows) || rows.length > MAX_CANDIDATES) {
    throw new RangeError("Priority action-plan candidate set exceeds its supported bound.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETURNED) {
    throw new RangeError("Priority action-plan limit must be from 1 to 100.");
  }

  const ranked = rows.map(row => {
    const priority = scoreFindingPriority(row);
    const remediation = buildRemediationPlan(row);
    const evidenceReferenceCount = Math.max(0, Number(row.evidence_reference_count) || 0);
    const incompleteEvidenceReferenceCount = Math.max(0, Number(row.incomplete_evidence_reference_count) || 0);
    const evidenceAssessment = evidenceReferenceCount === 0
      ? "no_evidence_references_recorded"
      : incompleteEvidenceReferenceCount > 0
        ? "evidence_metadata_incomplete"
        : "metadata_recorded_content_unverified";
    return {
      findingId: String(row.id || ""),
      moduleId: String(row.module_id || ""),
      checkId: String(row.check_id || ""),
      title: remediation.title,
      recordedSeverity: remediation.recordedSeverity,
      recordedStatus: remediation.recordedStatus,
      priorityScore: priority.priorityScore,
      priorityBand: priority.priorityBand,
      priorityReasons: priority.priorityReasons,
      evidence: {
        referenceCount: evidenceReferenceCount,
        incompleteMetadataReferenceCount: incompleteEvidenceReferenceCount,
        assessment: evidenceAssessment,
        contentVerified: false,
        sourceReachabilityChecked: false
      },
      reasonForAction: priority.priorityReasons.join(" "),
      recommendedAction: remediation.currentRecommendation,
      affectedArea: remediation.affectedArea,
      suggestedSteps: remediation.steps,
      requiredValidation: remediation.validation,
      ownerDecision: "not_recorded",
      ownerApprovalRequired: true,
      executionEnabled: false,
      operationPerformed: false,
      isRiskVerdict: false
    };
  }).sort((a, b) => {
    const left = rows.find(row => String(row.id) === a.findingId);
    const right = rows.find(row => String(row.id) === b.findingId);
    return compareFindingPriority(left, right);
  });

  const actions = ranked.slice(0, limit);
  return {
    assessment: "evidence_linked_advisory_action_plan_only",
    actions,
    summary: {
      candidateCount: rows.length,
      returnedCount: actions.length,
      highPriority: actions.filter(item => item.priorityBand === "critical" || item.priorityBand === "high").length,
      mediumPriority: actions.filter(item => item.priorityBand === "medium").length,
      lowerPriority: actions.filter(item => item.priorityBand === "low" || item.priorityBand === "informational").length,
      ownerDecisionRequired: actions.length
    },
    candidateSetBounded: rows.length === MAX_CANDIDATES,
    decisionMade: false,
    findingStateChanged: false,
    companyStateChanged: false,
    taskCreated: false,
    executionEnabled: false,
    operationPerformed: false,
    limitations: [
      "Action order is deterministic triage based on recorded severity, status, and evidence state, not a risk probability or certification.",
      "Evidence reference counts and metadata completeness do not verify evidence contents, authenticity, relevance, or correctness.",
      "No recorded finding does not mean a check passed; this plan only organizes findings already recorded by the owner.",
      "At most 500 findings are considered and at most 100 actions are returned; older candidates may be outside the bounded set.",
      "Suggested steps are advisory. No owner decision, approval, task, finding update, or company operation is created."
    ]
  };
}
