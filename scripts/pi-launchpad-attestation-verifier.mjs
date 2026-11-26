/**
 * Ed25519 verification for externally signed Launchpad evidence attestations.
 * Trust anchors must be provisioned by an operator out-of-band, never from candidate input.
 * A valid signature authenticates the signer and payload; it does not prove factual truth.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";

export const PI_LAUNCHPAD_ATTESTATION_VERSION = "0.1.0";
export const PI_LAUNCHPAD_ATTESTATION_MAX_BYTES = 16384;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isIsoUtc = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function canonicalize(value, depth = 0) {
  if (depth > 12) throw new TypeError("Attestation payload nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalize(item, depth + 1)).join(",") + "]";
  if (!isObject(value)) throw new TypeError("Attestation payload contains an unsupported value.");
  const keys = Object.keys(value).sort();
  if (keys.length > 100) throw new TypeError("Attestation payload has too many fields.");
  return "{" + keys.map((key) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new TypeError("Attestation payload contains a forbidden key.");
    }
    return JSON.stringify(key) + ":" + canonicalize(value[key], depth + 1);
  }).join(",") + "}";
}

function validSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !url.hash && !url.search;
  } catch { return false; }
}

function reject(code) {
  return Object.freeze({
    accepted: false,
    verified: false,
    code,
    notice: "Evidence is not eligible for scoring."
  });
}

/**
 * Attestation shape:
 * { keyId, algorithm:"Ed25519", payload:{tokenId,evidenceId,field,sourceUrl,
 *   observedAt,expiresAt,value}, signature:base64 }
 * trustedKeys is an operator-provisioned map: keyId -> { publicKeyPem, revoked? }.
 */
export function verifyPiLaunchpadAttestation(attestation, trustedKeys, options = {}) {
  if (!isObject(attestation) || !isObject(attestation.payload) || !isObject(trustedKeys)) {
    return reject("invalid_attestation");
  }
  const now = options.now instanceof Date ? options.now.getTime() : options.now;
  if (!Number.isFinite(now)) throw new TypeError("A finite verification timestamp is required.");
  if (attestation.algorithm !== "Ed25519") return reject("unsupported_algorithm");
  if (typeof attestation.keyId !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(attestation.keyId)) {
    return reject("invalid_key_id");
  }
  if (!Object.hasOwn(trustedKeys, attestation.keyId)) return reject("untrusted_signer");
  const trustRecord = trustedKeys[attestation.keyId];
  if (!isObject(trustRecord) || trustRecord.revoked === true ||
      typeof trustRecord.publicKeyPem !== "string" || trustRecord.publicKeyPem.length > 4096) {
    return reject("unavailable_or_revoked_key");
  }

  const p = attestation.payload;
  if (typeof p.tokenId !== "string" || !p.tokenId.trim() || p.tokenId.length > 120 ||
      typeof p.evidenceId !== "string" || !p.evidenceId.trim() || p.evidenceId.length > 160 ||
      typeof p.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(p.field) ||
      !validSourceUrl(p.sourceUrl) || !isIsoUtc(p.observedAt) || !isIsoUtc(p.expiresAt) ||
      !(p.value === null || ["string", "number", "boolean"].includes(typeof p.value)) ||
      (typeof p.value === "string" && p.value.length > 500) ||
      (typeof p.value === "number" && !Number.isFinite(p.value))) {
    return reject("invalid_payload");
  }
  const observedAt = Date.parse(p.observedAt);
  const expiresAt = Date.parse(p.expiresAt);
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
    ? Math.min(options.maxAgeMs, 7 * 24 * 60 * 60 * 1000) : 24 * 60 * 60 * 1000;
  if (observedAt > now + 5 * 60 * 1000 || now - observedAt > maxAgeMs || expiresAt <= now ||
      expiresAt <= observedAt || expiresAt - observedAt > 7 * 24 * 60 * 60 * 1000) {
    return reject("stale_or_invalid_validity_window");
  }

  let signedBytes;
  try {
    signedBytes = Buffer.from(canonicalize(p), "utf8");
  } catch {
    return reject("invalid_payload_encoding");
  }
  if (signedBytes.length > PI_LAUNCHPAD_ATTESTATION_MAX_BYTES) return reject("payload_too_large");
  if (typeof attestation.signature !== "string" || attestation.signature.length > 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attestation.signature)) {
    return reject("invalid_signature_encoding");
  }

  try {
    const signature = Buffer.from(attestation.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== attestation.signature) {
      return reject("invalid_signature_encoding");
    }
    const publicKey = createPublicKey(trustRecord.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") return reject("invalid_trust_key_type");
    if (!verifySignature(null, signedBytes, publicKey, signature)) return reject("signature_mismatch");
  } catch {
    return reject("signature_verification_error");
  }

  return Object.freeze({
    accepted: true,
    verified: true,
    verifierVersion: PI_LAUNCHPAD_ATTESTATION_VERSION,
    keyId: attestation.keyId,
    tokenId: p.tokenId,
    evidenceId: p.evidenceId,
    field: p.field,
    sourceUrl: p.sourceUrl,
    observedAt: p.observedAt,
    expiresAt: p.expiresAt,
    value: p.value,
    trustMeaning: "Cryptographic signer and payload integrity verified against an operator-provisioned Ed25519 trust anchor. Factual accuracy and on-chain truth are not established."
  });
}
