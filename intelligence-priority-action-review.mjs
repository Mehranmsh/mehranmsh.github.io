export const PRIORITY_ACTION_REVIEW_OUTCOMES = Object.freeze([
  "accepted", "rejected", "needs_more_info"
]);

export function buildPriorityActionReviewSnapshot(action) {
  if (!action || typeof action.findingId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(action.findingId) ||
      typeof action.moduleId !== "string" || !action.moduleId ||
      typeof action.checkId !== "string" || !action.checkId) {
    throw new TypeError("A current priority action with a valid finding identity is required.");
  }
  const snapshot = {
    findingId: action.findingId,
    moduleId: action.moduleId,
    checkId: action.checkId,
    title: String(action.title || ""),
    recordedSeverity: String(action.recordedSeverity || ""),
    recordedStatus: String(action.recordedStatus || ""),
    priorityScore: Number(action.priorityScore || 0),
    priorityBand: String(action.priorityBand || ""),
    priorityReasons: Array.isArray(action.priorityReasons) ? action.priorityReasons.map(String) : [],
    evidence: {
      referenceCount: Number(action.evidence?.referenceCount || 0),
      incompleteMetadataReferenceCount: Number(action.evidence?.incompleteMetadataReferenceCount || 0),
      assessment: String(action.evidence?.assessment || ""),
      contentVerified: false,
      sourceReachabilityChecked: false
    },
    reasonForAction: String(action.reasonForAction || ""),
    recommendedAction: String(action.recommendedAction || ""),
    affectedArea: String(action.affectedArea || ""),
    suggestedSteps: Array.isArray(action.suggestedSteps) ? action.suggestedSteps.map(String) : [],
    requiredValidation: Array.isArray(action.requiredValidation) ? action.requiredValidation.map(String) : []
  };
  const snapshotJson = JSON.stringify(snapshot);
  if (snapshotJson.length > 20000) {
    throw new RangeError("Priority action review snapshot exceeds its supported size.");
  }
  return { snapshot, snapshotJson };
}

export function buildPriorityActionReviewHistory(rows) {
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new RangeError("Priority action review history must contain at most 100 records.");
  }
  const items = rows.map(row => ({
    id: String(row.id),
    actionKeySha256: String(row.action_key_sha256),
    findingId: String(row.finding_id),
    moduleId: String(row.module_id),
    checkId: String(row.check_id),
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
    findingStateChanged: false,
    companyStateChanged: false,
    executionEnabled: false,
    operationPerformed: false
  };
}

export async function buildPriorityActionReviewIntegrity(rows, sha256Hex) {
  if (!Array.isArray(rows) || rows.length > 100 || typeof sha256Hex !== "function") {
    throw new RangeError("Priority action review integrity requires at most 100 rows and a SHA-256 function.");
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
      snapshot.findingId === String(row.finding_id) &&
      snapshot.moduleId === String(row.module_id) &&
      snapshot.checkId === String(row.check_id);
    const reviewerMatchesOwner = String(row.reviewer_uid) === String(row.owner_uid);
    let status = "integrity_match";
    if (!snapshotJsonValid) status = "invalid_snapshot_json";
    else if (!snapshotHashMatches) status = "snapshot_hash_mismatch";
    else if (!snapshotIdentityMatches) status = "snapshot_identity_mismatch";
    else if (!reviewerMatchesOwner) status = "reviewer_owner_mismatch";
    items.push({
      id: String(row.id),
      findingId: String(row.finding_id),
      outcome: String(row.outcome),
      reviewedAt: Number(row.reviewed_at),
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
    assessment: "stored_priority_action_review_snapshot_metadata_integrity_only",
    decisionTruthVerified: false,
    findingStateChanged: false,
    companyStateChanged: false,
    executionEnabled: false,
    operationPerformed: false
  };
}
