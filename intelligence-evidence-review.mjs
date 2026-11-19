export const EVIDENCE_REVIEW_VERSION = "metadata_review_v1";

export function classifyEvidenceMetadata(row) {
  const evidenceCount = Number(row.evidence_count) || 0;
  const missingDigestCount = Number(row.missing_digest_count) || 0;
  const missingObservedAtCount = Number(row.missing_observed_at_count) || 0;
  const duplicateDigestCount = Number(row.duplicate_digest_count) || 0;
  let metadataState = "metadata_recorded_unverified";
  if (evidenceCount === 0) metadataState = "no_evidence_references";
  else if (missingDigestCount > 0 || missingObservedAtCount > 0) metadataState = "metadata_incomplete";
  return {
    findingId: row.id,
    moduleId: row.module_id,
    checkId: row.check_id,
    severity: row.severity,
    findingStatus: row.status,
    declaredEvidenceState: row.evidence_state,
    evidenceCount,
    missingDigestCount,
    missingObservedAtCount,
    duplicateDigestCount,
    metadataState,
    contentVerified: false,
    sourceReachabilityChecked: false,
    checkPassed: false
  };
}

export function buildEvidenceMetadataReview(rows) {
  const items = rows.map(classifyEvidenceMetadata);
  return {
    reviewVersion: EVIDENCE_REVIEW_VERSION,
    items,
    summary: {
      findingsReviewed: items.length,
      withoutEvidenceReferences: items.filter(x => x.metadataState === "no_evidence_references").length,
      withIncompleteMetadata: items.filter(x => x.metadataState === "metadata_incomplete").length,
      withMetadataRecordedButUnverified: items.filter(x => x.metadataState === "metadata_recorded_unverified").length,
      duplicateDigestReferences: items.reduce((sum, x) => sum + x.duplicateDigestCount, 0)
    },
    evidenceValidity: "unverified",
    contentVerified: false,
    sourceReachabilityChecked: false,
    checkPassed: false,
    executionEnabled: false,
    operationPerformed: false,
    limitations: [
      "This review evaluates recorded metadata only; it does not read evidence contents or fetch source references.",
      "A recorded digest is not recomputed or compared with source content.",
      "Metadata completeness does not establish authenticity, relevance, correctness, or a passing check.",
      "Duplicate digests are signals for owner review, not proof of duplicate or invalid evidence."
    ]
  };
}
