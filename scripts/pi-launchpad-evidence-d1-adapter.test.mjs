import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPiLaunchpadEvidenceD1InsertPlan,
  verifyPiLaunchpadEvidenceD1ReadBack
} from "./pi-launchpad-evidence-d1-adapter.mjs";

const record = () => ({
  recordId: "plev_0123456789abcdef0123456789abcdef",
  evidenceId: "evidence-1",
  networkId: "pi-mainnet",
  assetIdentifier: "asset:issuer:PIEX",
  evidenceType: "official_project_claim",
  field: "utility",
  value: { score: 75, label: "claimed" },
  source: {
    sourceId: "project-site",
    kind: "official_project",
    url: "https://project.example/token",
    claimedTrustLevel: "publisher_claim",
    retrievedAt: "2026-11-26T17:31:00.000Z"
  },
  observedAt: "2026-11-26T17:30:00.000Z",
  verificationStatus: "unverified",
  verificationDetail: "Claim only",
  chainVerificationStatus: "not_verified",
  scoringStatus: "blocked_pending_independent_chain_verification",
  attestation: null,
  registryVersion: "0.1.0"
});
const CREATED = "2026-11-26T18:00:00.000Z";

test("builds parameterized insert and read-back statements without executing them", () => {
  const plan = buildPiLaunchpadEvidenceD1InsertPlan({ record: record(), createdAt: CREATED });
  assert.equal(plan.accepted, true);
  assert.equal(plan.statements.length, 2);
  assert.match(plan.statements[0].sql, /ON CONFLICT\\(record_id\\) DO NOTHING/);
  assert.match(plan.statements[1].sql, /SELECT record_id/);
  assert.equal(plan.statements[0].params[0], record().recordId);
  assert.equal(plan.expectedRow.chain_verification_status, "not_verified");
  assert.equal(plan.expectedRow.scoring_status, "blocked_pending_independent_chain_verification");
  assert.ok(!("execute" in plan));
});

test("canonical serialization is stable across object key order", () => {
  const a = record();
  const b = record();
  b.value = { label: "claimed", score: 75 };
  const pa = buildPiLaunchpadEvidenceD1InsertPlan({ record: a, createdAt: CREATED });
  const pb = buildPiLaunchpadEvidenceD1InsertPlan({ record: b, createdAt: CREATED });
  assert.equal(pa.expectedRow.value_json, pb.expectedRow.value_json);
});

test("rejects invalid network, elevated chain status, and malformed timestamps", () => {
  for (const mutate of [
    r => { r.networkId = "ethereum"; },
    r => { r.chainVerificationStatus = "verified"; },
    r => { r.scoringStatus = "ready"; },
    r => { r.observedAt = "not-a-date"; }
  ]) {
    const invalid = record();
    mutate(invalid);
    assert.equal(buildPiLaunchpadEvidenceD1InsertPlan({ record: invalid, createdAt: CREATED }).accepted, false);
  }
});

test("rejects non-JSON values and sparse arrays", () => {
  const circular = record();
  circular.value = {};
  circular.value.self = circular.value;
  assert.equal(buildPiLaunchpadEvidenceD1InsertPlan({ record: circular, createdAt: CREATED }).code, "invalid_evidence_d1_json");
  const sparse = record();
  sparse.value = [];
  sparse.value[1] = "gap";
  assert.equal(buildPiLaunchpadEvidenceD1InsertPlan({ record: sparse, createdAt: CREATED }).code, "invalid_evidence_d1_json");
});

test("read-back accepts exact duplicate and rejects conflicting stored content", () => {
  const plan = buildPiLaunchpadEvidenceD1InsertPlan({ record: record(), createdAt: CREATED });
  assert.equal(verifyPiLaunchpadEvidenceD1ReadBack(plan.expectedRow, { ...plan.expectedRow }).accepted, true);
  const conflict = { ...plan.expectedRow, value_json: "{\"score\":99}" };
  assert.deepEqual(verifyPiLaunchpadEvidenceD1ReadBack(plan.expectedRow, conflict), {
    accepted: false, code: "d1_record_conflict"
  });
  assert.equal(verifyPiLaunchpadEvidenceD1ReadBack(plan.expectedRow, null).accepted, false);
});

test("rejects invalid planner timestamp and tampered record identity", () => {
  assert.equal(buildPiLaunchpadEvidenceD1InsertPlan({ record: record(), createdAt: "yesterday" }).accepted, false);
  const invalid = record();
  invalid.recordId = "plev_not-a-digest";
  assert.equal(buildPiLaunchpadEvidenceD1InsertPlan({ record: invalid, createdAt: CREATED }).accepted, false);
});
