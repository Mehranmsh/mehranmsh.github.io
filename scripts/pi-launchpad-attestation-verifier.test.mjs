import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyPiLaunchpadAttestation } from "./pi-launchpad-attestation-verifier.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trustedKeys = { "test-auditor": { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) } };
const now = Date.parse("2026-11-26T12:00:00.000Z");
const payload = {
  tokenId: "pi-token-1", evidenceId: "evidence-1", field: "liquidity.tvlPi",
  sourceUrl: "https://auditor.example/report/1",
  observedAt: "2026-11-26T11:00:00.000Z",
  expiresAt: "2026-11-27T11:00:00.000Z",
  value: 12500
};
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const signed = (p = payload) => ({
  keyId: "test-auditor", algorithm: "Ed25519", payload: p,
  signature: sign(null, Buffer.from(canonical(p)), privateKey).toString("base64")
});

test("accepts a valid signature from a provisioned Ed25519 trust anchor", () => {
  const result = verifyPiLaunchpadAttestation(signed(), trustedKeys, { now });
  assert.equal(result.accepted, true);
  assert.equal(result.verified, true);
  assert.equal(result.value, 12500);
  assert.equal(result.tokenId, "pi-token-1");
});

test("rejects unknown, revoked, or wrong-type trust anchors", () => {
  assert.equal(verifyPiLaunchpadAttestation(signed(), {}, { now }).code, "untrusted_signer");
  assert.equal(verifyPiLaunchpadAttestation(signed(), {
    "test-auditor": { ...trustedKeys["test-auditor"], revoked: true }
  }, { now }).code, "unavailable_or_revoked_key");
});

test("rejects tampered payload and malformed signature", () => {
  const tampered = signed();
  tampered.payload.value = 999999;
  assert.equal(verifyPiLaunchpadAttestation(tampered, trustedKeys, { now }).code, "signature_mismatch");
  const malformed = signed();
  malformed.signature = "not-base64!";
  assert.equal(verifyPiLaunchpadAttestation(malformed, trustedKeys, { now }).code, "invalid_signature_encoding");
});

test("rejects stale, expired, future, and overlong validity windows", () => {
  const stale = { ...payload, observedAt: "2026-11-20T11:00:00.000Z" };
  assert.equal(verifyPiLaunchpadAttestation(signed(stale), trustedKeys, { now }).code, "stale_or_invalid_validity_window");
  const expired = { ...payload, expiresAt: "2026-11-26T11:30:00.000Z" };
  assert.equal(verifyPiLaunchpadAttestation(signed(expired), trustedKeys, { now }).code, "stale_or_invalid_validity_window");
  const tooLong = { ...payload, expiresAt: "2026-12-05T11:00:00.000Z" };
  assert.equal(verifyPiLaunchpadAttestation(signed(tooLong), trustedKeys, { now }).code, "stale_or_invalid_validity_window");
});

test("rejects unsafe URLs, invalid payloads, and non-object inputs", () => {
  const unsafe = { ...payload, sourceUrl: "http://auditor.example/report/1" };
  assert.equal(verifyPiLaunchpadAttestation(signed(unsafe), trustedKeys, { now }).code, "invalid_payload");
  assert.equal(verifyPiLaunchpadAttestation(null, trustedKeys, { now }).code, "invalid_attestation");
  assert.throws(() => verifyPiLaunchpadAttestation(signed(), trustedKeys), TypeError);
});

test("rejects inherited-property records at the trust boundary", () => {
  const inheritedPayload = Object.assign(Object.create({ tokenId: "spoofed" }), {
    evidenceId: "evidence-1", field: "liquidity.tvlPi",
    sourceUrl: "https://auditor.example/report/1",
    observedAt: payload.observedAt, expiresAt: payload.expiresAt, value: 1
  });
  const forged = signed();
  forged.payload = inheritedPayload;
  assert.equal(verifyPiLaunchpadAttestation(forged, trustedKeys, { now }).code, "invalid_attestation");
});
