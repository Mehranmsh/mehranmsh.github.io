import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { buildPiLaunchpadVerifiedScoringEvidence } from "./pi-launchpad-evidence-gateway.mjs";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const fingerprintSha256 = createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
const trustRecords = [{
  keyId: "auditor-a", publicKeyPem: pem, fingerprintSha256,
  issuer: "independent-auditor", allowedSourceOrigins: ["https://auditor.example"],
  allowedFields: ["teamTransparency", "utility", "sourceVerification"],
  notBefore: "2026-11-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z",
  revoked: false
}];
const envelope = () => ({
  schemaVersion: 1, tokenId: "pi-token-1", observedAt: "2026-11-26T11:00:00.000Z",
  sources: [{
    sourceId: "auditor-source", kind: "security_auditor",
    url: "https://auditor.example/report/1", trustLevel: "publisher_claim",
    retrievedAt: "2026-11-26T11:01:00.000Z",
    evidence: [
      { field: "teamTransparency", value: 88, trustLevel: "publisher_claim", observedAt: "2026-11-26T11:00:00.000Z", reference: "evidence-team-1" },
      { field: "sourceVerification", value: 100, trustLevel: "publisher_claim", observedAt: "2026-11-26T11:00:00.000Z", reference: "evidence-source-1" }
    ]
  }]
});
const canonical = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
};
const attestation = (overrides = {}) => {
  const payload = {
    issuer: "independent-auditor", tokenId: "pi-token-1",
    evidenceId: "evidence-team-1", field: "teamTransparency",
    sourceUrl: "https://auditor.example/report/1",
    observedAt: "2026-11-26T11:00:00.000Z",
    expiresAt: "2026-11-27T11:00:00.000Z", value: 88,
    ...overrides
  };
  return { keyId: "auditor-a", algorithm: "Ed25519", payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") };
};

test("only exact-match, signed, in-scope evidence becomes a component score", () => {
  const result = buildPiLaunchpadVerifiedScoringEvidence({
    envelope: envelope(), attestations: [attestation()], trustRecords, now: NOW
  });
  assert.deepEqual({ ...result.scoringEvidence }, { teamTransparency: 88 });
  assert.equal(result.acceptedCount, 1);
  assert.equal(result.rejectedCount, 0);
});

test("rejects forged verified flags, invalid signatures, and mismatched evidence", () => {
  const forged = attestation();
  forged.verified = true;
  forged.signature = "A".repeat(88);
  const mismatch = attestation({ value: 89 });
  const result = buildPiLaunchpadVerifiedScoringEvidence({
    envelope: envelope(), attestations: [forged, mismatch], trustRecords, now: NOW
  });
  assert.deepEqual({ ...result.scoringEvidence }, {});
  assert.equal(result.rejectedCount, 2);
  assert.ok(result.rejectedRecords.some(x => x.code === "signature_mismatch" || x.code === "invalid_signature_encoding"));
  assert.ok(result.rejectedRecords.some(x => x.code === "attestation_evidence_mismatch"));
});

test("never allows sourceVerification or non-scoreable metrics into component scores", () => {
  const payload = {
    issuer: "independent-auditor", tokenId: "pi-token-1",
    evidenceId: "evidence-source-1", field: "sourceVerification",
    sourceUrl: "https://auditor.example/report/1",
    observedAt: "2026-11-26T11:00:00.000Z",
    expiresAt: "2026-11-27T11:00:00.000Z", value: 100
  };
  const signed = {
    keyId: "auditor-a", algorithm: "Ed25519", payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64")
  };
  const result = buildPiLaunchpadVerifiedScoringEvidence({
    envelope: envelope(), attestations: [signed], trustRecords, now: NOW
  });
  assert.deepEqual({ ...result.scoringEvidence }, {});
  assert.equal(result.rejectedRecords[0].code, "field_not_scoreable");
});

test("rejects duplicate attestations and conflicting scores for one component", () => {
  const first = attestation();
  const duplicate = attestation({ evidenceId: "evidence-team-1" });
  const result = buildPiLaunchpadVerifiedScoringEvidence({
    envelope: envelope(), attestations: [first, duplicate], trustRecords, now: NOW
  });
  assert.deepEqual({ ...result.scoringEvidence }, {});
  assert.ok(result.rejectedRecords.some(x => x.code === "duplicate_attestation"));
});

test("fails closed when trust anchors are absent or validation is forged structurally", () => {
  assert.throws(() => buildPiLaunchpadVerifiedScoringEvidence({
    envelope: envelope(), attestations: [attestation()], trustRecords: [], now: NOW
  }), TypeError);
  assert.throws(() => buildPiLaunchpadVerifiedScoringEvidence({
    envelope: { accepted: true, tokenId: "x", sources: [], evidence: [] },
    attestations: [], trustRecords, now: NOW
  }), TypeError);
});

test("rejects stale attestations and attestations bound to another token", () => {
  const stale = attestation({ observedAt: "2026-11-20T11:00:00.000Z" });
  const wrongToken = attestation({ tokenId: "other-token" });
  const result = buildPiLaunchpadVerifiedScoringEvidence({
    envelope: envelope(), attestations: [stale, wrongToken], trustRecords, now: NOW
  });
  assert.deepEqual({ ...result.scoringEvidence }, {});
  assert.equal(result.rejectedCount, 2);
});
