export const OWNER_EVIDENCE_REVIEW_OUTCOMES = Object.freeze([
  "accepted",
  "rejected",
  "needs_more_info"
]);

export function buildEvidenceSnapshot(rows) {
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new RangeError("Evidence snapshot must contain at most 100 references.");
  }
  const evidenceRefs = rows.map(row => {
    if (!row || typeof row.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)) {
      throw new TypeError("Evidence reference identity is invalid.");
    }
    const observedAt = row.observed_at == null ? null : Number(row.observed_at);
    if (observedAt !== null && !Number.isSafeInteger(observedAt)) {
      throw new TypeError("Evidence observation time is invalid.");
    }
    const digest = row.content_digest == null ? null : String(row.content_digest);
    if (digest !== null && !/^[0-9a-f]{64}$/.test(digest)) {
      throw new TypeError("Evidence digest metadata is invalid.");
    }
    return {
      id: row.id,
      kind: String(row.kind || "other"),
      contentDigest: digest,
      observedAt
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    evidenceRefs,
    evidenceSnapshotJson: JSON.stringify(evidenceRefs),
    evidenceCount: evidenceRefs.length
  };
}

export function buildOwnerEvidenceReviewHistory(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Review history must be an array.");
  return {
    items: rows.map(row => ({
      id: row.id,
      findingId: row.finding_id,
      outcome: row.outcome,
      reason: row.reason,
      reviewerUid: row.reviewer_uid,
      reviewedAt: Number(row.reviewed_at),
      evidenceCount: Number(row.evidence_count),
      evidenceSnapshotSha256: row.evidence_snapshot_sha256,
      evidenceSnapshot: JSON.parse(row.evidence_snapshot_json)
    })),
    historyIsAppendOnly: true,
    evidenceContentVerified: false,
    sourceReachabilityChecked: false,
    checkPassed: false,
    executionEnabled: false,
    operationPerformed: false
  };
}
