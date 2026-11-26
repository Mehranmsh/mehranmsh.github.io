import { createHash } from "node:crypto";
import {
  createPiTestnetArchiveReplacementJournalRecord,
  verifyPiTestnetArchiveReplacementJournal
} from "./pi-testnet-observation-replacement-journal.mjs";

const HEX_256 = /^[a-f0-9]{64}$/;

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function envelopeDigest(envelope) {
  return createHash("sha256").update(JSON.stringify(envelope), "utf8").digest("hex");
}

/**
 * Runs the replacement protocol against an injected transaction provider.
 *
 * Required provider contract:
 * - supportsAtomicTransactions === true (a declared capability, not proof)
 * - withTransaction(callback) MUST commit only when callback resolves and
 *   MUST roll back every write when callback throws/rejects.
 * - Transaction methods below MUST use the same transaction/session.
 *
 * The adapter must independently implement and test those guarantees.
 * This module has no database binding and performs no storage I/O itself.
 */
export async function executePiTestnetArchiveReplacementTransaction(input, provider) {
  if (!isPlainRecord(input) || !isPlainRecord(input.principal) ||
      input.principal.authenticated !== true ||
      input.principal.role !== "archive_admin" ||
      typeof input.principal.principalId !== "string" ||
      input.principal.principalId.length < 1 ||
      input.principal.principalId.length > 128 ||
      !isPlainRecord(input.intent) ||
      input.intent.operation !== "compare_and_swap_replace" ||
      typeof input.intent.archiveScope !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.intent.archiveScope) ||
      typeof input.intent.archiveId !== "string" || !HEX_256.test(input.intent.archiveId) ||
      !HEX_256.test(input.intent.expectedCurrentEnvelopeSha256) ||
      !HEX_256.test(input.intent.replacementEnvelopeSha256) ||
      !isPlainRecord(input.intent.replacementEnvelope) ||
      input.intent.replacementEnvelope.archiveScope !== input.intent.archiveScope ||
      envelopeDigest(input.intent.replacementEnvelope) !== input.intent.replacementEnvelopeSha256 ||
      !isPlainRecord(provider) || provider.supportsAtomicTransactions !== true ||
      typeof provider.withTransaction !== "function") {
    return Object.freeze({ accepted: false, code: "invalid_transaction_contract_or_input" });
  }

  const requiredMethods = [
    "assertAuthorized", "readCurrentEnvelope", "readJournal",
    "appendJournalRecord", "compareAndSwapEnvelope"
  ];

  const result = await provider.withTransaction(async transaction => {
    if (!isPlainRecord(transaction) ||
        requiredMethods.some(method => typeof transaction[method] !== "function")) {
      throw new Error("atomic_transaction_methods_missing");
    }

    // Re-authorize inside the same transaction immediately before state access.
    const authorized = await transaction.assertAuthorized(
      input.principal,
      input.intent.archiveScope
    );
    if (authorized !== true) throw new Error("archive_admin_authorization_failed");

    const [currentEnvelope, existingJournal] = await Promise.all([
      transaction.readCurrentEnvelope(input.intent.archiveScope, input.intent.archiveId),
      transaction.readJournal(input.intent.archiveScope, input.intent.archiveId)
    ]);

    if (!isPlainRecord(currentEnvelope) || currentEnvelope.archiveScope !== input.intent.archiveScope) {
      throw new Error("current_envelope_missing_or_wrong_scope");
    }
    if (!Array.isArray(existingJournal) || existingJournal.length !== 0) {
      throw new Error("replacement_journal_already_exists");
    }

    const currentDigest = envelopeDigest(currentEnvelope);
    if (currentDigest !== input.intent.expectedCurrentEnvelopeSha256) {
      throw new Error("compare_and_swap_source_conflict");
    }

    const preparedResult = createPiTestnetArchiveReplacementJournalRecord({
      sequence: 1,
      previousRecordSha256: null,
      archiveScope: input.intent.archiveScope,
      archiveId: input.intent.archiveId,
      sourceEnvelopeSha256: currentDigest,
      replacementEnvelopeSha256: input.intent.replacementEnvelopeSha256,
      state: "prepared"
    });
    if (!preparedResult.accepted) throw new Error("prepared_journal_record_invalid");

    await transaction.appendJournalRecord(
      input.intent.archiveScope,
      input.intent.archiveId,
      preparedResult.record
    );

    const swapped = await transaction.compareAndSwapEnvelope({
      archiveScope: input.intent.archiveScope,
      archiveId: input.intent.archiveId,
      expectedEnvelopeSha256: currentDigest,
      replacementEnvelope: input.intent.replacementEnvelope
    });
    if (swapped !== true) throw new Error("compare_and_swap_failed");

    const readBack = await transaction.readCurrentEnvelope(
      input.intent.archiveScope,
      input.intent.archiveId
    );
    if (!isPlainRecord(readBack) ||
        readBack.archiveScope !== input.intent.archiveScope ||
        envelopeDigest(readBack) !== input.intent.replacementEnvelopeSha256) {
      throw new Error("replacement_readback_verification_failed");
    }

    const committedResult = createPiTestnetArchiveReplacementJournalRecord({
      sequence: 2,
      previousRecordSha256: preparedResult.record.recordSha256,
      archiveScope: input.intent.archiveScope,
      archiveId: input.intent.archiveId,
      sourceEnvelopeSha256: currentDigest,
      replacementEnvelopeSha256: input.intent.replacementEnvelopeSha256,
      state: "committed",
      observedEnvelopeSha256: input.intent.replacementEnvelopeSha256
    }, preparedResult.record);
    if (!committedResult.accepted) throw new Error("committed_journal_record_invalid");

    await transaction.appendJournalRecord(
      input.intent.archiveScope,
      input.intent.archiveId,
      committedResult.record
    );

    const finalJournal = await transaction.readJournal(
      input.intent.archiveScope,
      input.intent.archiveId
    );
    const verifiedJournal = verifyPiTestnetArchiveReplacementJournal(finalJournal);
    if (!verifiedJournal.accepted || verifiedJournal.state !== "committed" ||
        verifiedJournal.recordCount !== 2) {
      throw new Error("committed_journal_readback_failed");
    }

    return Object.freeze({
      accepted: true,
      action: "replacement_committed_atomically",
      archiveId: input.intent.archiveId,
      archiveScope: input.intent.archiveScope,
      replacementEnvelopeSha256: input.intent.replacementEnvelopeSha256,
      journalRecordCount: verifiedJournal.recordCount
    });
  });

  return Object.freeze({
    ...result,
    transactionProviderContract: "adapter_declared_atomicity_requires_independent_verification",
    notice: "The transaction provider must guarantee rollback on every thrown error. No concrete database adapter is included."
  });
}
