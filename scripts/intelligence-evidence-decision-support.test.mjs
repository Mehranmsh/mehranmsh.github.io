import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceDecisionSupport } from "../intelligence-evidence-decision-support.mjs";

test("builds bounded owner prompts from metadata, correlation and consistency candidates", () => {
  const result = buildEvidenceDecisionSupport({
    metadataItems: [
      { findingId: "f1", moduleId: "security", checkId: "auth", severity: "critical", metadataState: "no_evidence_references" },
      { findingId: "f2", moduleId: "music", checkId: "backup", severity: "low", metadataState: "metadata_incomplete", missingDigestCount: 1, missingObservedAtCount: 2 }
    ],
    correlationGroups: [
      { correlationType: "shared_digest", correlationKeySha256: "a".repeat(64), findingCount: 2, referenceCount: 2, referencesTruncated: false }
    ],
    consistencyCandidates: [
      { candidateType: "source_reference_digest_variance_candidate", candidateKey: "source-A", findingCount: 1, referenceCount: 2, referencesTruncated: false }
    ],
    correlationReviewHistory: [
      { correlationKeySha256: "a".repeat(64), outcome: "needs_more_info", referenceCount: 2 },
      { correlationKeySha256: "a".repeat(64), outcome: "related", referenceCount: 2 }
    ]
  });

  assert.equal(result.assessment, "owner_decision_support_advisory_only");
  assert.equal(result.summary.recommendationCount, 4);
  assert.equal(result.summary.highPriority, 1);
  assert.equal(result.summary.priorCorrelationReviewsMatched, 1);
  assert.equal(result.recommendations[0].sourceId, "f1");
  const correlation = result.recommendations.find(item => item.sourceType === "correlation_candidate");
  assert.equal(correlation.priorOwnerOutcome, "needs_more_info");
  assert.equal(result.decisionMade, false);
  assert.equal(result.evidenceContentVerified, false);
  assert.equal(result.checkPassed, false);
  assert.equal(result.findingStateChanged, false);
  assert.equal(result.companyStateChanged, false);
  assert.equal(result.executionEnabled, false);
  assert.equal(result.operationPerformed, false);
});

test("ignores malformed review history and retains explicit human decision requirement", () => {
  const result = buildEvidenceDecisionSupport({
    correlationGroups: [
      { correlationKeySha256: "bad", correlationType: "shared_digest", findingCount: 2, referenceCount: 2 }
    ],
    correlationReviewHistory: [
      { correlationKeySha256: "bad", outcome: "approved" }
    ]
  });
  assert.equal(result.recommendations[0].priorOwnerOutcome, null);
  assert.equal(result.recommendations[0].ownerDecisionRequired, true);
  assert.equal(result.decisionMade, false);
});

test("rejects unbounded input collections", () => {
  assert.throws(() => buildEvidenceDecisionSupport({ metadataItems: Array(101).fill({}) }), /bound/);
  assert.throws(() => buildEvidenceDecisionSupport({ correlationGroups: Array(51).fill({}) }), /bound/);
  assert.throws(() => buildEvidenceDecisionSupport({ consistencyCandidates: Array(51).fill({}) }), /bound/);
  assert.throws(() => buildEvidenceDecisionSupport({ correlationReviewHistory: Array(101).fill({}) }), /bound/);
});
