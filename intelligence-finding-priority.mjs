const SEVERITY_POINTS = Object.freeze({
  critical: 100, high: 80, medium: 60, low: 40, info: 20, unrated: 10
});
const STATUS_ADJUSTMENT = Object.freeze({
  open: 10, accepted: 0, mitigated: -15, resolved: -25, false_positive: -40
});
const EVIDENCE_ADJUSTMENT = Object.freeze({ missing: 10, insufficient: 5, sufficient: 0 });
const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3, info: 4, unrated: 5 });

export function scoreFindingPriority(finding) {
  const severity = Object.hasOwn(SEVERITY_POINTS, finding?.severity) ? finding.severity : "unrated";
  const status = Object.hasOwn(STATUS_ADJUSTMENT, finding?.status) ? finding.status : "open";
  const evidenceState = Object.hasOwn(EVIDENCE_ADJUSTMENT, finding?.evidence_state) ? finding.evidence_state : "missing";
  const severityPoints = SEVERITY_POINTS[severity];
  const statusAdjustment = STATUS_ADJUSTMENT[status];
  const evidenceAdjustment = EVIDENCE_ADJUSTMENT[evidenceState];
  const score = Math.max(0, Math.min(120, severityPoints + statusAdjustment + evidenceAdjustment));
  const priorityBand = score >= 100 ? "critical" : score >= 80 ? "high" :
    score >= 60 ? "medium" : score >= 40 ? "low" : "informational";
  return {
    priorityScore: score,
    priorityBand,
    priorityReasons: [
      "Severity " + severity + " contributes " + severityPoints + " points.",
      "Status " + status + " adjusts the score by " + statusAdjustment + ".",
      "Evidence state " + evidenceState + " adjusts attention by " + evidenceAdjustment + "."
    ],
    triageModel: "deterministic_metadata_v1",
    isRiskVerdict: false
  };
}

export function compareFindingPriority(a, b) {
  const left = scoreFindingPriority(a);
  const right = scoreFindingPriority(b);
  if (right.priorityScore !== left.priorityScore) return right.priorityScore - left.priorityScore;
  const severityDifference = (SEVERITY_ORDER[a?.severity] ?? 5) - (SEVERITY_ORDER[b?.severity] ?? 5);
  if (severityDifference) return severityDifference;
  const updatedDifference = String(b?.updated_at || "").localeCompare(String(a?.updated_at || ""));
  return updatedDifference || String(a?.id || "").localeCompare(String(b?.id || ""));
}
