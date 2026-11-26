import test from "node:test";
import assert from "node:assert/strict";
import { buildPiLaunchpadEvidenceRegistry } from "./pi-launchpad-evidence-registry.mjs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const NOW = Date.parse("2026-11-26T18:00:00.000Z");
const envelope = () => ({
  schemaVersion: 1,
  networkId: "pi-mainnet",
  tokenId: "asset:issuer:PIEX",
  observedAt: "2026-11-26T17:30:00.000Z",
  sources: [{
    sourceId: "project-site",
    kind: "official_project",
    url: "https://project.example/token",
    trustLevel: "publisher_claim",
    retrievedAt: "2026-11-26T17:31:00.000Z",
    evidence: [{
      field: "utility",
      value: 75,
      trustLevel: "publisher_claim",
      observedAt: "2026-11-26T17:30:00.000Z",
      reference: "project-utility-1"
    }]
  }]
});

test("projects complete provenance with explicit unverified and blocked states", () => {
  const result = buildPiLaunchpadEvidenceRegistry({ envelope: envelope(), now: NOW });
  assert.equal(result.accepted, true);
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.networkId, "pi-mainnet");
  assert.equal(record.assetIdentifier, "asset:issuer:PIEX");
  assert.equal(record.evidenceType, "official_project_claim");
  assert.equal(record.source.sourceId, "project-site");
  assert.equal(record.observedAt, "2026-11-26T17:30:00.000Z");
  assert.equal(record.verificationStatus, "unverified");
  assert.equal(record.chainVerificationStatus, "not_verified");
  assert.equal(record.scoringStatus, "blocked_pending_independent_chain_verification");
  assert.equal(result.summary.unverified, 1);
});

test("record identifiers are deterministic and change when evidence identity changes", () => {
  const first = buildPiLaunchpadEvidenceRegistry({ envelope: envelope(), now: NOW });
  const same = buildPiLaunchpadEvidenceRegistry({ envelope: envelope(), now: NOW + 1000 });
  const changed = envelope();
  changed.sources[0].evidence[0].reference = "project-utility-2";
  const other = buildPiLaunchpadEvidenceRegistry({ envelope: changed, now: NOW });
  assert.equal(first.records[0].recordId, same.records[0].recordId);
  assert.notEqual(first.records[0].recordId, other.records[0].recordId);
});

test("a valid signature changes signer status only, never chain verification or scoring", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const fingerprintSha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const trustRecords = [{
    keyId: "auditor-key",
    publicKeyPem: pem,
    fingerprintSha256,
    issuer: "auditor",
    allowedSourceOrigins: ["https://project.example"],
    allowedFields: ["utility"],
    notBefore: "2026-11-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    revoked: false
  }];
  const payload = {
    issuer: "auditor",
    networkId: "pi-mainnet",
    tokenId: "asset:issuer:PIEX",
    evidenceId: "project-utility-1",
    field: "utility",
    sourceUrl: "https://project.example/token",
    observedAt: "2026-11-26T17:30:00.000Z",
    expiresAt: "2026-11-27T17:30:00.000Z",
    value: 75
  };
  const canonical = (v) => v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
    : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  const attestation = {
    keyId: "auditor-key",
    algorithm: "Ed25519",
    payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64")
  };
  const result = buildPiLaunchpadEvidenceRegistry({
    envelope: envelope(), attestations: [attestation], trustRecords, now: NOW
  });
  const record = result.records[0];
  assert.equal(record.verificationStatus, "signature_verified");
  assert.equal(record.chainVerificationStatus, "not_verified");
  assert.equal(record.scoringStatus, "blocked_pending_independent_chain_verification");
  assert.equal(result.summary.signatureVerified, 1);
});

test("rejects malformed envelopes without producing records", () => {
  const invalid = envelope();
  invalid.networkId = "pi-testnet?";
  const result = buildPiLaunchpadEvidenceRegistry({ envelope: invalid, now: NOW });
  assert.equal(result.accepted, false);
  assert.equal(result.records.length, 0);
  assert.equal(result.summary.total, 0);
});

test("rejects malformed registry arguments rather than silently guessing time", () => {
  assert.throws(() => buildPiLaunchpadEvidenceRegistry({ envelope: envelope() }), TypeError);
});
