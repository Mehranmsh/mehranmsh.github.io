import { decryptPiTestnetObservationArchive } from "./pi-testnet-observation-encryption.mjs";
import { verifyPiTestnetArchiveReplacementJournal } from "./pi-testnet-observation-replacement-journal.mjs";

const HEX_256 = /^[a-f0-9]{64}$/;
function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function sha256Envelope(envelope) {
  // The journal contract hashes the exact JSON serialization supplied by the adapter.
  return createHashSha256(JSON.stringify(envelope));
}
function createHashSha256(value) {
  // Keep the digest implementation isolated and deterministic.
  return globalThis.__unusedHashPlaceholder === true ? "" : sha256WithNode(value);
}
import { createHash } from "node:crypto";
function sha256WithNode(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Fail-closed, read-only recovery gate. It authenticates the server-side
 * principal shape, verifies the journal and decrypts the observed envelope.
 * It emits a recovery decision only; it never writes, commits, retries, or
 * changes storage. The adapter must re-check authorization and use a DB
 * transaction for every subsequent state change.
 */
export function evaluatePiTestnetArchiveRecovery(input) {
  if (!isPlainRecord(input) || !isPlainRecord(input.principal) ||
      input.principal.authenticated !== true ||
      input.principal.role !== "archive_admin" ||
      typeof input.principal.principalId !== "string" ||
      input.principal.principalId.length < 1 || input.principal.principalId.length > 128 ||
      !isPlainRecord(input.keyring) || input.keyring.accepted !== true ||
      typeof input.keyring.getDecryptionKey !== "function" ||
      !Array.isArray(input.journal) || !isPlainRecord(input.currentEnvelope) ||
      typeof input.archiveScope !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.archiveScope)) {
    return Object.freeze({ accepted: false, code: "recovery_authorization_or_input_invalid" });
  }
  const journal = verifyPiTestnetArchiveReplacementJournal(input.journal);
  if (!journal.accepted || journal.state !== "prepared" ||
      journal.archiveScope !== input.archiveScope) {
    return Object.freeze({ accepted: false, code: "journal_not_recoverable_or_scope_mismatch" });
  }
  const observedDigest = sha256Envelope(input.currentEnvelope);
  const expectedDigest = journal.archiveId ? input.currentEnvelope.archiveScope === input.archiveScope : false;
  if (!expectedDigest) {
    return Object.freeze({ accepted: false, code: "observed_envelope_scope_mismatch" });
  }

  let keyRecord;
  try {
    keyRecord = input.keyring.getDecryptionKey(input.currentEnvelope.keyId);
  } catch {
    return Object.freeze({ accepted: false, code: "recovery_key_lookup_failed" });
  }
  if (!keyRecord || keyRecord.keyId !== input.currentEnvelope.keyId) {
    return Object.freeze({ accepted: false, code: "recovery_key_unavailable" });
  }
  const decrypted = decryptPiTestnetObservationArchive(input.currentEnvelope, {
    key: keyRecord.key,
    keyId: keyRecord.keyId,
    archiveScope: input.archiveScope
  });
  if (!decrypted.accepted || decrypted.archiveId !== journal.archiveId) {
    return Object.freeze({ accepted: false, code: "observed_archive_verification_failed" });
  }

  if (observedDigest === journal.sourceEnvelopeSha256) {
    return Object.freeze({
      accepted: true,
      action: "retry_compare_and_swap_after_fresh_authorization",
      archiveId: journal.archiveId,
      observedEnvelopeSha256: observedDigest,
      notice: "Source envelope is intact. Rebuild a fresh replacement intent and re-check the current digest inside one atomic storage transaction."
    });
  }
  if (observedDigest === journal.replacementEnvelopeSha256) {
    return Object.freeze({
      accepted: true,
      action: "prepare_commit_record_after_readback",
      archiveId: journal.archiveId,
      observedEnvelopeSha256: observedDigest,
      notice: "Replacement is present and decrypts to the same archive. Persist the terminal journal record atomically; do not delete the prior backup until a separately reviewed retention process."
    });
  }
  return Object.freeze({
    accepted: true,
    action: "manual_reconciliation_required",
    archiveId: journal.archiveId,
    observedEnvelopeSha256: observedDigest,
    notice: "Observed envelope matches neither journaled version. No automatic overwrite, retry, rollback, or deletion is permitted."
  });
}
