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


// Verify only the stored decision snapshot's metadata integrity. This does not
// authenticate the underlying evidence, its source, or the truth of a decision.
export async function buildEvidenceDecisionReviewIntegrity(rows, sha256Hex) {
  if (!Array.isArray(rows) || rows.length > 100 || typeof sha256Hex !== "function") {
    throw new RangeError("Integrity review requires at most 100 rows and a SHA-256 function.");
  }
  const items = [];
  for (const row of rows) {
    const snapshotJson = String(row.review_snapshot_json ?? "");
    const expectedHash = String(row.review_snapshot_sha256 ?? "");
    const computedHash = await sha256Hex(snapshotJson);
    let snapshot = null;
    let snapshotJsonValid = false;
    try {
      const parsed = JSON.parse(snapshotJson);
      snapshotJsonValid = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
      if (snapshotJsonValid) snapshot = parsed;
    } catch {
      snapshotJsonValid = false;
    }
    const snapshotHashMatches = /^[0-9a-f]{64}$/.test(expectedHash) &&
      /^[0-9a-f]{64}$/.test(String(computedHash)) && expectedHash === computedHash;
    const snapshotIdentityMatches = snapshotJsonValid &&
      snapshot.sourceType === String(row.source_type) &&
      snapshot.sourceId === String(row.source_id);
    const reviewerMatchesOwner = String(row.reviewer_uid) === String(row.owner_uid);
    let status = "integrity_match";
    if (!snapshotJsonValid) status = "invalid_snapshot_json";
    else if (!snapshotHashMatches) status = "snapshot_hash_mismatch";
    else if (!snapshotIdentityMatches) status = "snapshot_identity_mismatch";
    else if (!reviewerMatchesOwner) status = "reviewer_owner_mismatch";
    items.push({
      id: String(row.id),
      sourceType: String(row.source_type),
      sourceId: String(row.source_id),
      outcome: String(row.outcome),
      reviewedAt: Number(row.reviewed_at),
      expectedSnapshotHash: expectedHash,
      computedSnapshotHash: String(computedHash),
      snapshotJsonValid,
      snapshotHashMatches,
      snapshotIdentityMatches,
      reviewerMatchesOwner,
      status
    });
  }
  return {
    items,
    summary: {
      recordsScanned: items.length,
      integrityMatches: items.filter(item => item.status === "integrity_match").length,
      snapshotHashMismatches: items.filter(item => item.status === "snapshot_hash_mismatch").length,
      invalidSnapshotJson: items.filter(item => item.status === "invalid_snapshot_json").length,
      snapshotIdentityMismatches: items.filter(item => item.status === "snapshot_identity_mismatch").length,
      reviewerOwnerMismatches: items.filter(item => item.status === "reviewer_owner_mismatch").length
    },
    assessment: "stored_decision_snapshot_metadata_integrity_only",
    evidenceContentVerified: false,
    sourceReachabilityChecked: false,
    decisionTruthVerified: false,
    checkPassed: false,
    executionEnabled: false,
    operationPerformed: false
  };
}
