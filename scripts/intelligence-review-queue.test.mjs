import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeReviewItem } from "../intelligence-review-queue.mjs";

const base = {
  id: "record-1",
  title: "Company policy",
  source_type: "uploaded_document",
  source_ref: "file:policy.pdf",
  observed_at: "2026-11-01T00:00:00Z",
  confidence_score: 85,
  verification_status: "unreviewed",
  relation_count: 0,
  candidate_relation_count: 0,
  unresolved_conflict_count: 0
};

test("owner-disputed knowledge receives critical priority", () => {
  const item = buildKnowledgeReviewItem({ ...base, verification_status: "disputed" }, Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(item.priority, 100);
  assert.equal(item.priorityBand, "critical");
  assert.ok(item.reasons.includes("owner_disputed"));
});

test("unresolved conflicts outrank stale and incomplete evidence", () => {
  const item = buildKnowledgeReviewItem({
    ...base,
    observed_at: "2025-01-01T00:00:00Z",
    source_ref: "",
    unresolved_conflict_count: 1,
    candidate_relation_count: 1
  }, Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(item.priority, 90);
  assert.ok(item.reasons.includes("unresolved_conflict"));
  assert.ok(item.reasons.includes("source_observation_older_than_180_days"));
  assert.ok(item.reasons.includes("missing_source_reference"));
});

test("old observation dates are high priority, not a truth judgment", () => {
  const item = buildKnowledgeReviewItem({ ...base, observed_at: "2025-01-01T00:00:00Z", verification_status: "owner_verified" }, Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(item.priority, 75);
  assert.equal(item.assessment, "deterministic_metadata_only");
});

test("missing provenance details and candidate relations produce separate reasons", () => {
  const item = buildKnowledgeReviewItem({
    ...base,
    source_ref: "",
    observed_at: "",
    candidate_relation_count: 1
  }, Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(item.priority, 65);
  assert.ok(item.reasons.includes("missing_observation_date"));
  assert.ok(item.reasons.includes("missing_source_reference"));
  assert.ok(item.reasons.includes("candidate_relationship"));
});

test("owner-verified records without review signals are omitted by the queue caller", () => {
  const item = buildKnowledgeReviewItem({ ...base, verification_status: "owner_verified" }, Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(item.priority, 0);
  assert.deepEqual(item.reasons, []);
});

test("confidence score is carried as recorded metadata, not used to rank truth", () => {
  const low = buildKnowledgeReviewItem({ ...base, confidence_score: 1 }, Date.parse("2026-11-19T00:00:00Z"));
  const high = buildKnowledgeReviewItem({ ...base, confidence_score: 99 }, Date.parse("2026-11-19T00:00:00Z"));
  assert.equal(low.priority, high.priority);
  assert.equal(low.recordedConfidenceScore, 1);
  assert.equal(high.recordedConfidenceScore, 99);
});
