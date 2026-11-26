import test from "node:test";
import assert from "node:assert/strict";
import {
  createPiTestnetArchiveReplacementJournalRecord,
  verifyPiTestnetArchiveReplacementJournal,
  classifyPiTestnetArchiveReplacementRecovery
} from "./pi-testnet-observation-replacement-journal.mjs";

const base = {
  sequence: 1, previousRecordSha256: null, archiveScope: "pi-launchpad:testnet-health",
  archiveId: "a".repeat(64), sourceEnvelopeSha256: "b".repeat(64),
  replacementEnvelopeSha256: "c".repeat(64), state: "prepared"
};
const prepared = createPiTestnetArchiveReplacementJournalRecord(base).record;

test("creates and verifies a prepared then committed hash-linked journal", () => {
  const committed = createPiTestnetArchiveReplacementJournalRecord({
    ...base, sequence: 2, previousRecordSha256: prepared.recordSha256,
    state: "committed", observedEnvelopeSha256: base.replacementEnvelopeSha256
  }, prepared);
  assert.equal(committed.accepted, true);
  const result = verifyPiTestnetArchiveReplacementJournal([prepared, committed.record]);
  assert.equal(result.accepted, true);
  assert.equal(result.state, "committed");
  assert.equal(result.recovery, "terminal");
});

test("rejects illegal transitions, broken links, and tampering", () => {
  assert.equal(createPiTestnetArchiveReplacementJournalRecord({
    ...base, sequence: 2, previousRecordSha256: prepared.recordSha256,
    state: "prepared"
  }, prepared).code, "invalid_journal_transition");
  const tampered = { ...prepared, archiveScope: "other-scope" };
  assert.equal(verifyPiTestnetArchiveReplacementJournal([tampered]).code,
    "journal_record_integrity_failed");
});

test("classifies crash recovery without guessing on unknown stored versions", () => {
  assert.equal(classifyPiTestnetArchiveReplacementRecovery(
    prepared, base.sourceEnvelopeSha256).action, "safe_to_retry_compare_and_swap");
  assert.equal(classifyPiTestnetArchiveReplacementRecovery(
    prepared, base.replacementEnvelopeSha256).action, "replacement_already_applied_record_commit");
  assert.equal(classifyPiTestnetArchiveReplacementRecovery(
    prepared, "d".repeat(64)).action, "manual_reconciliation_required");
});

test("rejects invalid initial records and incorrect observed digests", () => {
  assert.equal(createPiTestnetArchiveReplacementJournalRecord({
    ...base, sequence: 2
  }).code, "invalid_initial_journal_record");
  assert.equal(createPiTestnetArchiveReplacementJournalRecord({
    ...base, state: "committed", observedEnvelopeSha256: base.sourceEnvelopeSha256
  }).code, "invalid_journal_record");
});
