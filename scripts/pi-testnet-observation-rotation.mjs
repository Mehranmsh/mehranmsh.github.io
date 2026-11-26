import {
  decryptPiTestnetObservationArchive,
  encryptPiTestnetObservationArchive
} from "./pi-testnet-observation-encryption.mjs";

/**
 * Re-encrypts one verified archive with the keyring's active key.
 * The caller remains responsible for safely persisting the new envelope.
 */
export function rotatePiTestnetObservationArchive(envelope, options) {
  if (!options || typeof options !== "object" || !options.keyring ||
      options.keyring.accepted !== true ||
      typeof options.archiveScope !== "string" ||
      !envelope || envelope.archiveScope !== options.archiveScope) {
    return Object.freeze({ accepted: false, code: "invalid_rotation_options" });
  }

  const oldKey = options.keyring.getDecryptionKey(envelope.keyId);
  const newKey = options.keyring.getActiveEncryptionKey();
  if (!oldKey) return Object.freeze({ accepted: false, code: "source_key_unavailable" });
  if (!newKey) return Object.freeze({ accepted: false, code: "active_key_unavailable" });
  if (oldKey.keyId === newKey.keyId) {
    return Object.freeze({ accepted: false, code: "already_using_active_key" });
  }

  const decrypted = decryptPiTestnetObservationArchive(envelope, {
    key: oldKey.key,
    keyId: oldKey.keyId,
    archiveScope: options.archiveScope
  });
  if (!decrypted.accepted) {
    return Object.freeze({ accepted: false, code: "source_decryption_failed" });
  }

  const encrypted = encryptPiTestnetObservationArchive(decrypted.archive, {
    key: newKey.key,
    keyId: newKey.keyId,
    archiveScope: options.archiveScope
  });
  if (!encrypted.accepted) {
    return Object.freeze({ accepted: false, code: "destination_encryption_failed" });
  }

  const verified = decryptPiTestnetObservationArchive(encrypted.envelope, {
    key: newKey.key,
    keyId: newKey.keyId,
    archiveScope: options.archiveScope
  });
  if (!verified.accepted || verified.archiveId !== decrypted.archiveId) {
    return Object.freeze({ accepted: false, code: "rotated_envelope_verification_failed" });
  }

  return Object.freeze({
    accepted: true,
    envelope: encrypted.envelope,
    previousKeyId: oldKey.keyId,
    activeKeyId: newKey.keyId,
    archiveId: decrypted.archiveId,
    notice: "Rotation produced and verified a new envelope in memory only. Persist it atomically through a separately reviewed storage adapter."
  });
}
