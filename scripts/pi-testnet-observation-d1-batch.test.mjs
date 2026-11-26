import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPiTestnetArchiveReplacementJournalRecord } from "./pi-testnet-observation-replacement-journal.mjs";
import { buildPiTestnetArchiveD1ReplacementPlan, buildPiTestnetArchiveD1RecoveryReadbackPlan } from "./pi-testnet-observation-d1-batch.mjs";

const archiveScope = "pi-testnet-observations";
const archiveId = "a".repeat(64);
const sourceEnvelopeSha256 = "b".repeat(64);
const replacementEnvelope = { archiveScope, archiveId, keyId: "next-key", ciphertext: "new" };
const replacementEnvelopeJson = JSON.stringify(replacementEnvelope);
const replacementEnvelopeSha256 = createHash("sha256")
  .update(replacementEnvelopeJson, "utf8").digest("hex");
const prepared = createPiTestnetArchiveReplacementJournalRecord({
  sequence: 1, previousRecordSha256: null, archiveScope, archiveId,
  sourceEnvelopeSha256, replacementEnvelopeSha256, state: "prepared"
}).record;
const committed = createPiTestnetArchiveReplacementJournalRecord({
  sequence: 2, previousRecordSha256: prepared.recordSha256, archiveScope, archiveId,
  sourceEnvelopeSha256, replacementEnvelopeSha256, state: "committed",
  observedEnvelopeSha256: replacementEnvelopeSha256
}, prepared).record;

const input = {
  operationId: "rotation-2026-11-26-001",
  archiveScope, archiveId, sourceEnvelopeSha256, replacementEnvelopeSha256,
  replacementEnvelopeJson,
  preparedRecordJson: JSON.stringify(prepared),
  preparedRecordSha256: prepared.recordSha256,
  committedRecordJson: JSON.stringify(committed),
  committedRecordSha256: committed.recordSha256
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

test("binds retries to the exact operation payload and exposes full journal readback expectations", () => {
  const result = buildPiTestnetArchiveD1ReplacementPlan(input);
  assert.equal(result.accepted, true);
  const archiveUpdate = result.phase1[1];
  assert.match(archiveUpdate.sql, /replacement_sha256 = \?/);
  assert.match(archiveUpdate.sql, /replacement_envelope_json = \?/);
  assert.match(archiveUpdate.sql, /prepared_record_json = \?/);
  assert.match(archiveUpdate.sql, /prepared_record_sha256 = \?/);
  assert.ok(archiveUpdate.params.includes(input.replacementEnvelopeJson));
  assert.ok(archiveUpdate.params.includes(input.preparedRecordJson));
  assert.equal(result.requiredReadback.operationId, input.operationId);
  assert.equal(result.requiredReadback.expectedPreparedRecordJson, input.preparedRecordJson);
  assert.equal(result.requiredReadback.expectedCommittedRecordJson, input.committedRecordJson);
  assert.equal(result.requiredReadback.committedRecordSha256, input.committedRecordSha256);
});

test("phase two requires exact prepared operation and journal records before commit", () => {
  const result = buildPiTestnetArchiveD1ReplacementPlan(input);
  assert.equal(result.accepted, true);
  const commitOperation = result.phase2[0];
  const appendCommitted = result.phase2[1];
  for (const sql of [commitOperation.sql, appendCommitted.sql]) {
    assert.match(sql, /replacement_envelope_json = \?/);
    assert.match(sql, /prepared_record_json = \?/);
    assert.match(sql, /prepared_record_sha256 = \?/);
    assert.match(sql, /sequence = 1 AND state = 'prepared'/);
    assert.match(sql, /record_json = \?/);
    assert.match(sql, /record_sha256 = \?/);
  }
  assert.ok(commitOperation.params.includes(input.preparedRecordJson));
  assert.ok(appendCommitted.params.includes(input.preparedRecordJson));
  assert.ok(appendCommitted.params.includes(input.committedRecordJson));
  assert.ok(result.executionRules.some(rule => rule.includes("ignored uniqueness conflict is not success")));
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
    ...input, replacementEnvelopeSha256: input.sourceEnvelopeSha256
  });
  assert.equal(result.accepted, false);
});

test("rejects malformed operation identifiers and unbounded payloads", () => {
  assert.equal(buildPiTestnetArchiveD1ReplacementPlan({
    ...input, operationId: "bad id"
  }).accepted, false);
  assert.equal(buildPiTestnetArchiveD1ReplacementPlan({
    ...input, replacementEnvelopeJson: "x".repeat(7 * 1024 * 1024 + 1)
  }).accepted, false);
});

test("rejects mismatched envelope digest and unlinked journal records", () => {
  assert.equal(buildPiTestnetArchiveD1ReplacementPlan({
    ...input, replacementEnvelopeSha256: "f".repeat(64)
  }).accepted, false);
  assert.equal(buildPiTestnetArchiveD1ReplacementPlan({
    ...input, preparedRecordJson: JSON.stringify({ state: "prepared" })
  }).accepted, false);
});

test("rejects a replacement envelope for a different archive id", () => {
  const foreignEnvelope = { ...replacementEnvelope, archiveId: "c".repeat(64) };
  const foreignJson = JSON.stringify(foreignEnvelope);
  const foreignDigest = createHash("sha256").update(foreignJson, "utf8").digest("hex");
  assert.equal(buildPiTestnetArchiveD1ReplacementPlan({
    ...input,
    replacementEnvelopeJson: foreignJson,
    replacementEnvelopeSha256: foreignDigest
  }).accepted, false);
});


test("every D1 statement has an exact placeholder-to-binding count", () => {
  const result = buildPiTestnetArchiveD1ReplacementPlan(input);
  assert.equal(result.accepted, true);
  for (const [phaseName, statements] of [
    ["phase1", result.phase1],
    ["phase2", result.phase2]
  ]) {
    for (const [index, item] of statements.entries()) {
      const placeholderCount = (item.sql.match(/\?/g) || []).length;
      assert.equal(
        placeholderCount,
        item.params.length,
        `${phaseName} statement ${index + 1} has mismatched SQL bindings`
      );
    }
  }
});


test("builds read-only recovery queries for archive, exact operation, and journal state", () => {
  const result = buildPiTestnetArchiveD1RecoveryReadbackPlan(input);
  assert.equal(result.accepted, true);
  assert.equal(result.adapter, "cloudflare-d1-read-only-recovery");
  assert.equal(result.statements.length, 3);
  assert.match(result.statements[0].sql, /FROM pi_testnet_archives/);
  assert.match(result.statements[1].sql, /FROM pi_testnet_archive_replacement_ops/);
  assert.match(result.statements[1].sql, /replacement_sha256 = \?/);
  assert.match(result.statements[2].sql, /sequence IN \(1, 2\)/);
  assert.match(result.statements[2].sql, /ORDER BY sequence ASC/);
  assert.deepEqual(result.expected, {
    operationId: input.operationId,
    archiveScope: input.archiveScope,
    archiveId: input.archiveId,
    sourceEnvelopeSha256: input.sourceEnvelopeSha256,
    replacementEnvelopeSha256: input.replacementEnvelopeSha256
  });
  assert.ok(result.decisionRules.some(rule => rule.includes("matches neither source nor replacement")));
});

test("recovery readback plan rejects invalid or ambiguous operation identity", () => {
  assert.equal(buildPiTestnetArchiveD1RecoveryReadbackPlan({
    ...input, operationId: "bad operation id"
  }).accepted, false);
  assert.equal(buildPiTestnetArchiveD1RecoveryReadbackPlan({
    ...input, sourceEnvelopeSha256: input.replacementEnvelopeSha256
  }).accepted, false);
  assert.equal(buildPiTestnetArchiveD1RecoveryReadbackPlan({
    ...input, archiveId: "not-a-digest"
  }).accepted, false);
});

test("recovery readback statements bind every value and perform no writes", () => {
  const result = buildPiTestnetArchiveD1RecoveryReadbackPlan(input);
  assert.equal(result.accepted, true);
  for (const item of result.statements) {
    assert.match(item.sql.trimStart(), /^SELECT /);
    assert.equal((item.sql.match(/\?/g) || []).length, item.params.length);
    assert.equal(item.sql.includes(input.archiveScope), false);
    assert.equal(item.sql.includes(input.operationId), false);
  }
  assert.ok(result.limitation.includes("does not execute D1 reads"));
});
