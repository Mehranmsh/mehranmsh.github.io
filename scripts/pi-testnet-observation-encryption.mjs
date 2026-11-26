import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { verifyPiTestnetObservationArchive } from "./pi-testnet-observation-archive.mjs";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 5 * 1024 * 1024;
const KEY_ID = /^[a-zA-Z0-9._:-]{1,100}$/;
const SCOPE = /^[a-zA-Z0-9._:-]{1,100}$/;
const HEX_256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validKey(key) {
  return (Buffer.isBuffer(key) || key instanceof Uint8Array) && key.byteLength === 32;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(k =>
    JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function aadFor({ schemaVersion, algorithm, archiveScope, archiveId, keyId }) {
  return Buffer.from(canonicalJson({ schemaVersion, algorithm, archiveScope, archiveId, keyId }), "utf8");
}

function validEnvelope(envelope) {
  if (!isPlainRecord(envelope) || envelope.schemaVersion !== 1 ||
      envelope.algorithm !== ALGORITHM || typeof envelope.archiveScope !== "string" ||
      !SCOPE.test(envelope.archiveScope) || typeof envelope.archiveId !== "string" ||
      !HEX_256.test(envelope.archiveId) || typeof envelope.keyId !== "string" ||
      !KEY_ID.test(envelope.keyId) || typeof envelope.iv !== "string" ||
      !BASE64.test(envelope.iv) || typeof envelope.tag !== "string" ||
      !BASE64.test(envelope.tag) || typeof envelope.ciphertext !== "string" ||
      !BASE64.test(envelope.ciphertext)) {
    return { accepted: false, code: "invalid_encryption_envelope" };
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES ||
      iv.toString("base64") !== envelope.iv || tag.toString("base64") !== envelope.tag ||
      ciphertext.toString("base64") !== envelope.ciphertext ||
      ciphertext.length < 1 || ciphertext.length > MAX_PLAINTEXT_BYTES) {
    return { accepted: false, code: "invalid_encryption_encoding" };
  }
  return { accepted: true, iv, tag, ciphertext };
}

/**
 * Encrypts a verified Testnet archive using a caller-supplied 256-bit key.
 * Key lifecycle, storage, rotation, access control, and secret retrieval are
 * deliberately outside this module. No key is generated or persisted here.
 */
export function encryptPiTestnetObservationArchive(archive, options) {
  if (!isPlainRecord(options) || !validKey(options.key) ||
      typeof options.keyId !== "string" || !KEY_ID.test(options.keyId) ||
      typeof options.archiveScope !== "string" || !SCOPE.test(options.archiveScope)) {
    return Object.freeze({ accepted: false, code: "invalid_encryption_options" });
  }
  const verified = verifyPiTestnetObservationArchive(archive);
  if (!verified.accepted) return Object.freeze(verified);

  const plaintext = canonicalJson(archive);
  const plaintextBytes = Buffer.byteLength(plaintext, "utf8");
  if (plaintextBytes < 1 || plaintextBytes > MAX_PLAINTEXT_BYTES) {
    return Object.freeze({ accepted: false, code: "plaintext_size_exceeded" });
  }

  const metadata = {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    archiveScope: options.archiveScope,
    archiveId: digest(plaintext),
    keyId: options.keyId
  };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(options.key), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(metadata));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = Object.freeze({
    ...metadata,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  });

  return Object.freeze({
    accepted: true,
    envelope,
    plaintextBytes,
    notice: "AES-256-GCM authenticated encryption envelope only. The caller remains responsible for secure key custody, rotation, authorization, and durable storage."
  });
}

/**
 * Decrypts only with an explicitly supplied key whose ID matches the envelope.
 * Authentication failure, wrong key, altered metadata, or altered ciphertext
 * returns a generic failure and never returns partial plaintext.
 */
export function decryptPiTestnetObservationArchive(envelope, options) {
  const checked = validEnvelope(envelope);
  if (!checked.accepted) return Object.freeze(checked);
  if (!isPlainRecord(options) || !validKey(options.key) ||
      typeof options.keyId !== "string" || options.keyId !== envelope.keyId ||
      (options.archiveScope !== undefined && options.archiveScope !== envelope.archiveScope)) {
    return Object.freeze({ accepted: false, code: "invalid_decryption_options" });
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      Buffer.from(options.key),
      checked.iv,
      { authTagLength: TAG_BYTES }
    );
    decipher.setAAD(aadFor({
      schemaVersion: envelope.schemaVersion,
      algorithm: envelope.algorithm,
      archiveScope: envelope.archiveScope,
      archiveId: envelope.archiveId,
      keyId: envelope.keyId
    }));
    decipher.setAuthTag(checked.tag);
    const plaintext = Buffer.concat([
      decipher.update(checked.ciphertext),
      decipher.final()
    ]).toString("utf8");

    if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES ||
        digest(plaintext) !== envelope.archiveId) {
      return Object.freeze({ accepted: false, code: "decrypted_archive_digest_mismatch" });
    }
    const archive = JSON.parse(plaintext);
    const verified = verifyPiTestnetObservationArchive(archive);
    if (!verified.accepted) return Object.freeze({ accepted: false, code: "decrypted_archive_invalid" });
    if (canonicalJson(archive) !== plaintext) {
      return Object.freeze({ accepted: false, code: "noncanonical_decrypted_archive" });
    }
    return Object.freeze({
      accepted: true,
      archive,
      archiveId: envelope.archiveId,
      keyId: envelope.keyId,
      integrity: verified
    });
  } catch {
    return Object.freeze({ accepted: false, code: "decryption_or_authentication_failed" });
  }
}
