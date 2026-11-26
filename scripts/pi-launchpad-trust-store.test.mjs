import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { buildPiLaunchpadTrustStore } from "./pi-launchpad-trust-store.mjs";

const { publicKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
const now = Date.parse("2026-11-26T12:00:00.000Z");
const record = (overrides = {}) => ({
  keyId: "auditor-1", publicKeyPem: pem, fingerprintSha256: fingerprint,
  issuer: "independent-auditor", allowedSourceOrigins: ["https://auditor.example"],
  allowedFields: ["liquidity.tvlPi"], notBefore: "2026-11-01T00:00:00.000Z",
  notAfter: "2027-01-01T00:00:00.000Z", revoked: false, ...overrides
});

test("loads a valid explicitly provisioned Ed25519 key and freezes scopes", () => {
  const store = buildPiLaunchpadTrustStore([record()], { now });
  assert.equal(store.acceptedKeyCount, 1);
  assert.equal(store.keys["auditor-1"].fingerprintSha256, fingerprint);
  assert.equal(Object.isFrozen(store.keys["auditor-1"].allowedFields), true);
});

test("rejects fingerprint mismatch and non-Ed25519 keys", () => {
  const mismatch = buildPiLaunchpadTrustStore([record({ fingerprintSha256: "0".repeat(64) })], { now });
  assert.equal(mismatch.acceptedKeyCount, 0);
  assert.equal(mismatch.rejected[0].code, "fingerprint_mismatch");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  const wrongType = buildPiLaunchpadTrustStore([record({ publicKeyPem: rsa })], { now });
  assert.equal(wrongType.rejected[0].code, "invalid_public_key");
});

test("rejects expired, not-yet-valid, and revoked keys", () => {
  const expired = buildPiLaunchpadTrustStore([record({ notAfter: "2026-11-25T00:00:00.000Z" })], { now });
  assert.equal(expired.rejected[0].code, "key_outside_validity_window");
  const future = buildPiLaunchpadTrustStore([record({ notBefore: "2026-12-01T00:00:00.000Z" })], { now });
  assert.equal(future.rejected[0].code, "key_outside_validity_window");
  const revoked = buildPiLaunchpadTrustStore([record({ revoked: true })], { now });
  assert.equal(revoked.acceptedKeyCount, 0);
  assert.equal(revoked.keys["auditor-1"].revoked, true);
});

test("rejects duplicate IDs and malformed scopes", () => {
  const duplicate = buildPiLaunchpadTrustStore([record(), record()], { now });
  assert.equal(duplicate.acceptedKeyCount, 0);
  assert.ok(duplicate.rejected.some((x) => x.code === "duplicate_key_id"));
  const badScope = buildPiLaunchpadTrustStore([record({ allowedSourceOrigins: ["http://bad.example"] })], { now });
  assert.equal(badScope.rejected[0].code, "invalid_scope");
});

test("requires explicit finite time and bounded array input", () => {
  assert.throws(() => buildPiLaunchpadTrustStore([record()]), TypeError);
  assert.throws(() => buildPiLaunchpadTrustStore("not-an-array", { now }), TypeError);
});
