export const EVIDENCE_DECISION_REVIEW_OUTCOMES = Object.freeze([
  "accepted", "rejected", "needs_more_info"
]);

const SOURCE_TYPES = new Set([
  "finding_metadata", "correlation_candidate", "consistency_candidate"
]);

export function buildEvidenceDecisionReviewSnapshot(recommendation) {
  if (!recommendation || !SOURCE_TYPES.has(recommendation.sourceType) ||
      typeof recommendation.sourceId !== "string" || !recommendation.sourceId ||
      recommendation.sourceId.length > 300) {
    throw new TypeError("A current, valid recommendation is required.");
  }
  const snapshot = {
    sourceType: recommendation.sourceType,
    sourceId: recommendation.sourceId,
    moduleId: String(recommendation.moduleId || ""),
    checkId: String(recommendation.checkId || ""),
    priority: String(recommendation.priority || ""),
    priorityScore: Number(recommendation.priorityScore || 0),
    recommendation: String(recommendation.recommendation || ""),
    rationale: String(recommendation.rationale || ""),
    priorOwnerOutcome: recommendation.priorOwnerOutcome || null
  };
  const snapshotJson = JSON.stringify(snapshot);
  if (snapshotJson.length > 20000) throw new RangeError("The recommendation snapshot exceeds its supported size.");
  return { snapshot, snapshotJson };
}

export function buildEvidenceDecisionReviewHistory(rows) {
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new RangeError("Decision review history must contain at most 100 records.");
  }
  const items = rows.map(row => ({
    id: String(row.id),
    reviewKeySha256: String(row.review_key_sha256),
    sourceType: String(row.source_type),
    sourceId: String(row.source_id),
    outcome: String(row.outcome),
    reason: String(row.reason),
    reviewerUid: String(row.reviewer_uid),
    reviewedAt: Number(row.reviewed_at),
    snapshotSha256: String(row.review_snapshot_sha256),
    snapshot: JSON.parse(String(row.review_snapshot_json))
  }));
  return {
    items,
    historyIsAppendOnly: true,
    decisionIsHumanAuthored: true,
    evidenceContentVerified: false,
    riskVerdict: false,
    checkPassed: false,
    executionEnabled: false,
    operationPerformed: false
  };
}
