import { createHash } from "node:crypto";
import { decryptPiTestnetObservationArchive } from "./pi-testnet-observation-encryption.mjs";

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Prepares a compare-and-swap replacement intent after verifying both envelopes.
 * It performs no read, write, transaction, or persistence operation.
 */
export function preparePiTestnetArchiveReplacementIntent(sourceEnvelope, replacementEnvelope, options) {
  if (!isPlainRecord(options) || typeof options.archiveScope !== "string" ||
      typeof options.expectedCurrentEnvelopeSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(options.expectedCurrentEnvelopeSha256) ||
      !options.keyring || options.keyring.accepted !== true ||
      typeof options.keyring.getDecryptionKey !== "function") {
    return Object.freeze({ accepted: false, code: "invalid_replacement_intent_options" });
  }
  if (!isPlainRecord(sourceEnvelope) || !isPlainRecord(replacementEnvelope) ||
      sourceEnvelope.archiveScope !== options.archiveScope ||
      replacementEnvelope.archiveScope !== options.archiveScope ||
      sourceEnvelope.keyId === replacementEnvelope.keyId) {
    return Object.freeze({ accepted: false, code: "invalid_replacement_envelopes" });
  }

  const sourceKey = options.keyring.getDecryptionKey(sourceEnvelope.keyId);
  const replacementKey = options.keyring.getDecryptionKey(replacementEnvelope.keyId);
  if (!sourceKey || !replacementKey) {
    return Object.freeze({ accepted: false, code: "replacement_key_unavailable" });
  }
  const source = decryptPiTestnetObservationArchive(sourceEnvelope, {
    key: sourceKey.key, keyId: sourceKey.keyId, archiveScope: options.archiveScope
  });
  const replacement = decryptPiTestnetObservationArchive(replacementEnvelope, {
    key: replacementKey.key, keyId: replacementKey.keyId, archiveScope: options.archiveScope
  });
  if (!source.accepted || !replacement.accepted) {
    return Object.freeze({ accepted: false, code: "replacement_envelope_verification_failed" });
  }
  if (source.archiveId !== replacement.archiveId) {
    return Object.freeze({ accepted: false, code: "archive_identity_changed" });
  }

  const sourceSerialized = JSON.stringify(sourceEnvelope);
  const replacementSerialized = JSON.stringify(replacementEnvelope);
  const actualSourceDigest = sha256(sourceSerialized);
  if (actualSourceDigest !== options.expectedCurrentEnvelopeSha256) {
    return Object.freeze({ accepted: false, code: "source_version_mismatch" });
  }

  return Object.freeze({
    accepted: true,
    intent: Object.freeze({
      operation: "compare_and_swap_replace",
      archiveScope: options.archiveScope,
      archiveId: source.archiveId,
      expectedCurrentEnvelopeSha256: actualSourceDigest,
      replacementEnvelopeSha256: sha256(replacementSerialized),
      replacementEnvelope: Object.freeze({ ...replacementEnvelope }),
      previousKeyId: sourceEnvelope.keyId,
      replacementKeyId: replacementEnvelope.keyId
    }),
    notice: "Verified compare-and-swap intent only. A storage adapter must atomically compare the current envelope digest and replace it, or leave the original unchanged."
  });
}
