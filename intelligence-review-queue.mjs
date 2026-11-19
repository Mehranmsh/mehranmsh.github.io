export function buildKnowledgeReviewItem(item, nowMs = Date.now()) {
  const reasons = [];
  const disputed = item.verification_status === "disputed";
  const ownerVerified = item.verification_status === "owner_verified";
  const unresolvedConflicts = Number(item.unresolved_conflict_count) || 0;
  const candidateRelations = Number(item.candidate_relation_count) || 0;
  const observedAt = typeof item.observed_at === "string" ? Date.parse(item.observed_at) : NaN;
  const missingObservationDate = !item.observed_at;
  const stale = Number.isFinite(observedAt) && observedAt < nowMs - 180 * 24 * 60 * 60 * 1000;
  const missingSourceReference = item.source_type !== "owner_input" && !item.source_ref;
  if (disputed) reasons.push("owner_disputed");
  if (unresolvedConflicts > 0) reasons.push("unresolved_conflict");
  if (candidateRelations > 0) reasons.push("candidate_relationship");
  if (stale) reasons.push("source_observation_older_than_180_days");
  if (missingObservationDate) reasons.push("missing_observation_date");
  if (missingSourceReference) reasons.push("missing_source_reference");
  if (!ownerVerified && !disputed) reasons.push("owner_verification_needed");
  let priority = 0;
  if (disputed) priority = Math.max(priority, 100);
  if (unresolvedConflicts > 0) priority = Math.max(priority, 90);
  if (stale) priority = Math.max(priority, 75);
  if (missingObservationDate || missingSourceReference) priority = Math.max(priority, 65);
  if (candidateRelations > 0) priority = Math.max(priority, 55);
  if (!ownerVerified && !disputed) priority = Math.max(priority, 45);
  return {
    id: item.id,
    title: item.title,
    sourceType: item.source_type,
    observedAt: item.observed_at,
    verificationStatus: item.verification_status,
    priority,
    priorityBand: priority >= 90 ? "critical" : priority >= 70 ? "high" : priority >= 55 ? "medium" : "normal",
    reasons,
    relationCount: Number(item.relation_count) || 0,
    recordedConfidenceScore: item.confidence_score,
    assessment: "deterministic_metadata_only"
  };
}
