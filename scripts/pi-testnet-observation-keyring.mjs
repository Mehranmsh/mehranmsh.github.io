const KEY_ID = /^[a-zA-Z0-9._:-]{1,100}$/;

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validKey(value) {
  return (Buffer.isBuffer(value) || value instanceof Uint8Array) && value.byteLength === 32;
}

/**
 * Creates an immutable resolver over server-injected key records.
 * Key bytes are copied on input and output; this module never persists or logs them.
 */
export function createPiTestnetArchiveKeyring(configuration) {
  if (!isPlainRecord(configuration) || !Array.isArray(configuration.keys) ||
      configuration.keys.length < 1 || configuration.keys.length > 32 ||
      typeof configuration.activeKeyId !== "string" || !KEY_ID.test(configuration.activeKeyId)) {
    return Object.freeze({ accepted: false, code: "invalid_keyring_configuration" });
  }

  const activeKeyId = configuration.activeKeyId;
  const records = new Map();
  for (const record of configuration.keys) {
    if (!isPlainRecord(record) || Object.keys(record).some(key => !["keyId", "key", "revoked"].includes(key)) ||
        typeof record.keyId !== "string" || !KEY_ID.test(record.keyId) ||
        !validKey(record.key) || (record.revoked !== undefined && typeof record.revoked !== "boolean") ||
        records.has(record.keyId)) {
      return Object.freeze({ accepted: false, code: "invalid_or_duplicate_key_record" });
    }
    records.set(record.keyId, {
      key: Buffer.from(record.key),
      revoked: record.revoked === true
    });
  }

  const active = records.get(activeKeyId);
  if (!active || active.revoked) {
    return Object.freeze({ accepted: false, code: "active_key_unavailable" });
  }

  return Object.freeze({
    accepted: true,
    activeKeyId,
    keyCount: records.size,
    getActiveEncryptionKey() {
      const record = records.get(activeKeyId);
      if (!record || record.revoked) return null;
      return Object.freeze({ keyId: activeKeyId, key: Buffer.from(record.key) });
    },
    getDecryptionKey(keyId) {
      if (typeof keyId !== "string") return null;
      const record = records.get(keyId);
      if (!record || record.revoked) return null;
      return Object.freeze({ keyId, key: Buffer.from(record.key) });
    }
  });
}
