const SEVERITY_WEIGHT = Object.freeze({ critical: 100, high: 80, medium: 60, low: 40, info: 20, unrated: 10 });
const OUTCOMES = new Set(["related", "unrelated", "needs_more_info"]);

function boundedArray(value, name, max) {
  if (!Array.isArray(value) || value.length > max) throw new RangeError(name + " exceeds its supported bound.");
  return value;
}

function metadataRecommendation(item) {
  const severity = String(item.severity || "unrated").toLowerCase();
  const weight = SEVERITY_WEIGHT[severity] ?? SEVERITY_WEIGHT.unrated;
  if (item.metadataState === "no_evidence_references") {
    return {
      sourceType: "finding_metadata",
      sourceId: String(item.findingId),
      moduleId: String(item.moduleId || ""),
      checkId: String(item.checkId || ""),
      priority: weight >= 80 ? "high" : "medium",
      priorityScore: weight + 15,
      recommendation: "Attach traceable evidence references, or document why this check has none.",
      rationale: "The finding currently has no recorded evidence references.",
      ownerDecisionRequired: true,
      priorOwnerOutcome: null
    };
  }
  if (item.metadataState === "metadata_incomplete") {
    return {
      sourceType: "finding_metadata",
      sourceId: String(item.findingId),
      moduleId: String(item.moduleId || ""),
      checkId: String(item.checkId || ""),
      priority: weight >= 80 ? "high" : "medium",
      priorityScore: weight + 10,
      recommendation: "Complete the missing evidence metadata, then review the updated references.",
      rationale: Number(item.missingDigestCount || 0) + " digest field(s) and " + Number(item.missingObservedAtCount || 0) + " observation timestamp(s) are missing.",
      ownerDecisionRequired: true,
      priorOwnerOutcome: null
    };
  }
  return {
    sourceType: "finding_metadata",
    sourceId: String(item.findingId),
    moduleId: String(item.moduleId || ""),
    checkId: String(item.checkId || ""),
    priority: weight >= 80 ? "high" : "low",
    priorityScore: weight,
    recommendation: "Review the recorded evidence references and confirm whether they support this finding.",
    rationale: "Metadata is recorded, but evidence content, source reachability, authenticity, and correctness remain unverified.",
    ownerDecisionRequired: true,
    priorOwnerOutcome: null
  };
}

function latestCorrelationReviews(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (!row || typeof row.correlationKeySha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.correlationKeySha256) ||
        !OUTCOMES.has(row.outcome)) continue;
    const key = row.correlationKeySha256;
    if (!latest.has(key)) latest.set(key, row);
  }
  return latest;
}

export function buildEvidenceDecisionSupport(input = {}) {
  const metadataItems = boundedArray(input.metadataItems || [], "Metadata findings", 100);
  const correlationGroups = boundedArray(input.correlationGroups || [], "Correlation groups", 50);
  const consistencyCandidates = boundedArray(input.consistencyCandidates || [], "Consistency candidates", 50);
  const reviewHistory = boundedArray(input.correlationReviewHistory || [], "Correlation review history", 100);
  const reviews = latestCorrelationReviews(reviewHistory);
  const recommendations = metadataItems.map(metadataRecommendation);

  for (const group of correlationGroups) {
    const review = typeof group.correlationKeySha256 === "string" ? reviews.get(group.correlationKeySha256) : null;
    const reviewed = !!review;
    recommendations.push({
      sourceType: "correlation_candidate",
      sourceId: String(group.correlationKeySha256 || ""),
      moduleId: "",
      checkId: String(group.correlationType || ""),
      priority: group.referencesTruncated ? "high" : "medium",
      priorityScore: group.referencesTruncated ? 75 : 65,
      recommendation: reviewed
        ? "Compare the current candidate with the prior owner review before relying on that decision."
        : "Review the shared metadata pattern and record whether the references are related, unrelated, or need more information.",
      rationale: Number(group.findingCount || 0) + " finding(s), " + Number(group.referenceCount || 0) + " reference(s); prior owner outcome: " + (review?.outcome || "none recorded") + ".",
      ownerDecisionRequired: true,
      priorOwnerOutcome: review?.outcome || null,
      reviewSnapshotReferenceCount: review ? Number(review.referenceCount || 0) : null
    });
  }

  for (const candidate of consistencyCandidates) {
    recommendations.push({
      sourceType: "consistency_candidate",
      sourceId: String(candidate.candidateKey || ""),
      moduleId: "",
      checkId: String(candidate.candidateType || ""),
      priority: candidate.referencesTruncated ? "high" : "medium",
      priorityScore: candidate.referencesTruncated ? 72 : 62,
      recommendation: "Inspect the source history and context for this metadata pattern; do not infer a conflict from digests alone.",
      rationale: Number(candidate.findingCount || 0) + " finding(s), " + Number(candidate.referenceCount || 0) + " reference(s).",
      ownerDecisionRequired: true,
      priorOwnerOutcome: null
    });
  }

  const priorityRank = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) =>
    priorityRank[a.priority] - priorityRank[b.priority] ||
    b.priorityScore - a.priorityScore ||
    a.sourceType.localeCompare(b.sourceType) ||
    a.sourceId.localeCompare(b.sourceId)
  );

  return {
    assessment: "owner_decision_support_advisory_only",
    recommendations,
    summary: {
      recommendationCount: recommendations.length,
      highPriority: recommendations.filter(item => item.priority === "high").length,
      mediumPriority: recommendations.filter(item => item.priority === "medium").length,
      lowPriority: recommendations.filter(item => item.priority === "low").length,
      priorCorrelationReviewsMatched: recommendations.filter(item => item.sourceType === "correlation_candidate" && item.priorOwnerOutcome).length,
      ownerDecisionsRequired: recommendations.length
    },
    decisionMade: false,
    ownerDecisionRequired: recommendations.length > 0,
    evidenceContentVerified: false,
    sourceReachabilityChecked: false,
    authenticityVerified: false,
    correctnessVerified: false,
    conflictVerdict: false,
    riskVerdict: false,
    checkPassed: false,
    findingStateChanged: false,
    companyStateChanged: false,
    executionEnabled: false,
    operationPerformed: false,
    limitations: [
      "Recommendations are deterministic prompts based on bounded stored metadata and owner review history; they are not findings, decisions, or risk verdicts.",
      "A prior owner outcome is historical context only. This response does not compare its saved snapshot with current evidence metadata.",
      "Evidence contents and external sources are not fetched or verified; missing records may reflect scan limits.",
      "No review is recorded, no finding or company state is changed, and no task or operation is executed."
    ]
  };
}
