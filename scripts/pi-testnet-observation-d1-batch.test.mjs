import test from "node:test";
import assert from "node:assert/strict";
import { buildPiTestnetArchiveD1ReplacementPlan } from "./pi-testnet-observation-d1-batch.mjs";

const input = {
  operationId: "rotation-2026-11-26-001",
  archiveScope: "pi-testnet-observations",
  archiveId: "a".repeat(64),
  sourceEnvelopeSha256: "b".repeat(64),
  replacementEnvelopeSha256: "c".repeat(64),
  replacementEnvelopeJson: JSON.stringify({ archiveScope: "pi-testnet-observations", ciphertext: "new" }),
  preparedRecordJson: JSON.stringify({ state: "prepared", recordSha256: "d".repeat(64) }),
  preparedRecordSha256: "d".repeat(64),
  committedRecordJson: JSON.stringify({ state: "committed", recordSha256: "e".repeat(64) }),
  committedRecordSha256: "e".repeat(64)
};

test("builds a two-phase D1 plan with atomic batch boundaries", () => {
  const result = buildPiTestnetArchiveD1ReplacementPlan(input);
  assert.equal(result.accepted, true);
  assert.equal(result.adapter, "cloudflare-d1-batch");
  assert.equal(result.phase1.length, 3);
  assert.equal(result.phase2.length, 2);
  assert.match(result.phase1[0].sql, /INSERT INTO pi_testnet_archive_replacement_ops/);
  assert.match(result.phase1[1].sql, /UPDATE pi_testnet_archives/);
  assert.match(result.phase1[2].sql, /INSERT INTO pi_testnet_archive_replacement_journal/);
  assert.match(result.phase2[0].sql, /SET state = 'committed'/);
  assert.match(result.phase2[1].sql, /sequence, state, record_json, record_sha256/);
  assert.equal(result.requiredReadback.expectedEnvelopeSha256, input.replacementEnvelopeSha256);
  assert.ok(result.limitation.includes("not one interactive transaction"));
});

test("all D1 statements use bound values rather than interpolated user data", () => {
  const result = buildPiTestnetArchiveD1ReplacementPlan(input);
  for (const item of [...result.phase1, ...result.phase2]) {
    assert.ok(item.sql.includes("?"));
    assert.ok(Array.isArray(item.params));
    assert.equal(item.sql.includes(input.archiveScope), false);
    assert.equal(item.sql.includes(input.operationId), false);
  }
});

test("rejects identical source and replacement digests", () => {
  const result = buildPiTestnetArchiveD1ReplacementPlan({
    ...input,
    replacementEnvelopeSha256: input.sourceEnvelopeSha256
  });
  assert.deepEqual(result, { accepted: false, code: "invalid_d1_replacement_plan_input" });
});

test("rejects malformed operation identifiers and unbounded payloads", () => {
  assert.equal(buildPiTestnetArchiveD1ReplacementPlan({
    ...input, operationId: "bad id"
  }).accepted, false);
  assert.equal(buildPiTestnetArchiveD1ReplacementPlan({
    ...input, replacementEnvelopeJson: "x".repeat(7 * 1024 * 1024 + 1)
  }).accepted, false);
});
