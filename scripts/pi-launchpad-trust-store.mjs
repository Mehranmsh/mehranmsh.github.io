/**
 * Operator-side trust-store loader for Pi Launchpad attestations.
 * This module does not ship trust anchors. It validates explicit configuration
 * supplied out-of-band and fingerprints each Ed25519 public key.
 */
import { createHash, createPublicKey } from "node:crypto";

export const PI_LAUNCHPAD_TRUST_STORE_VERSION = "0.1.0";
const isPlainRecord = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isIsoUtc = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function reject(keyId, code) {
  return Object.freeze({ keyId: typeof keyId === "string" ? keyId : null, accepted: false, code });
}

/**
 * Each record must include:
 * keyId, publicKeyPem, fingerprintSha256 (lowercase hex), issuer,
 * allowedSourceOrigins, allowedFields, notBefore, notAfter, revoked.
 */
export function buildPiLaunchpadTrustStore(records, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : options.now;
  if (!Number.isFinite(now)) throw new TypeError("A finite trust-store validation timestamp is required.");
  if (!Array.isArray(records) || records.length > 100) {
    throw new TypeError("Trust-store records must be an array of at most 100 entries.");
  }

  const keys = Object.create(null);
  const rejected = [];
  const seen = new Set();

  for (const record of records) {
    const keyId = isPlainRecord(record) ? record.keyId : null;
    if (!isPlainRecord(record) || typeof keyId !== "string" ||
        !/^[a-zA-Z0-9._-]{1,80}$/.test(keyId)) {
      rejected.push(reject(keyId, "invalid_record"));
      continue;
    }
    if (seen.has(keyId)) {
      rejected.push(reject(keyId, "duplicate_key_id"));
      delete keys[keyId];
      continue;
    }
    seen.add(keyId);

    if (record.revoked !== true && record.revoked !== false) {
      rejected.push(reject(keyId, "invalid_revocation_state"));
      continue;
    }
    if (typeof record.publicKeyPem !== "string" || record.publicKeyPem.length > 4096 ||
        typeof record.fingerprintSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.fingerprintSha256) ||
        typeof record.issuer !== "string" || !record.issuer.trim() || record.issuer.length > 120 ||
        !Array.isArray(record.allowedSourceOrigins) || record.allowedSourceOrigins.length < 1 ||
        record.allowedSourceOrigins.length > 20 ||
        !Array.isArray(record.allowedFields) || record.allowedFields.length < 1 ||
        record.allowedFields.length > 50 ||
        !isIsoUtc(record.notBefore) || !isIsoUtc(record.notAfter) ||
        Date.parse(record.notAfter) <= Date.parse(record.notBefore)) {
      rejected.push(reject(keyId, "invalid_key_metadata"));
      continue;
    }

    let publicKey;
    let fingerprint;
    try {
      publicKey = createPublicKey(record.publicKeyPem);
      if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("Ed25519 key required.");
      const der = publicKey.export({ type: "spki", format: "der" });
      fingerprint = createHash("sha256").update(der).digest("hex");
    } catch {
      rejected.push(reject(keyId, "invalid_public_key"));
      continue;
    }
    if (fingerprint !== record.fingerprintSha256) {
      rejected.push(reject(keyId, "fingerprint_mismatch"));
      continue;
    }

    const origins = [];
    let badOrigin = false;
    for (const origin of record.allowedSourceOrigins) {
      if (typeof origin !== "string") { badOrigin = true; break; }
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" || parsed.origin !== origin ||
            parsed.pathname !== "/" || parsed.search || parsed.hash ||
            parsed.username || parsed.password || parsed.port) {
          badOrigin = true;
          break;
        }
        origins.push(origin);
      } catch { badOrigin = true; break; }
    }
    const fields = record.allowedFields.filter((field) =>
      typeof field === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(field));
    if (badOrigin || origins.length !== record.allowedSourceOrigins.length ||
        new Set(origins).size !== origins.length ||
        fields.length !== record.allowedFields.length || new Set(fields).size !== fields.length) {
      rejected.push(reject(keyId, "invalid_scope"));
      continue;
    }

    if (record.revoked) {
      keys[keyId] = Object.freeze({ publicKeyPem: record.publicKeyPem, issuer: record.issuer,
        allowedSourceOrigins: Object.freeze(origins), allowedFields: Object.freeze(fields), revoked: true });
      rejected.push(reject(keyId, "key_revoked"));
      continue;
    }
    if (now < Date.parse(record.notBefore) || now >= Date.parse(record.notAfter)) {
      rejected.push(reject(keyId, "key_outside_validity_window"));
      continue;
    }

    keys[keyId] = Object.freeze({
      publicKeyPem: record.publicKeyPem,
      issuer: record.issuer,
      allowedSourceOrigins: Object.freeze(origins),
      allowedFields: Object.freeze(fields),
      revoked: false,
      fingerprintSha256: fingerprint
    });
  }

  return Object.freeze({
    version: PI_LAUNCHPAD_TRUST_STORE_VERSION,
    keys: Object.freeze(keys),
    acceptedKeyCount: Object.keys(keys).filter((id) => keys[id].revoked !== true).length,
    rejected: Object.freeze(rejected)
  });
}
