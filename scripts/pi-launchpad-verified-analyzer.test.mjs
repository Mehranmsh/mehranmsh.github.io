import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { analyzeVerifiedLaunchpadOpportunity } from "./pi-launchpad-verified-analyzer.mjs";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const fingerprintSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
const trustRecords = [{
  keyId: "auditor-a", publicKeyPem: pem, fingerprintSha256,
  issuer: "independent-auditor", allowedSourceOrigins: ["https://auditor.example"],
  allowedFields: ["utility"], notBefore: "2026-11-01T00:00:00.000Z",
  notAfter: "2027-01-01T00:00:00.000Z", revoked: false
}];
const envelope = () => ({
  schemaVersion: 1, networkId: "pi-mainnet", tokenId: "pi-token-1", observedAt: "2026-11-26T11:00:00.000Z",
  sources: [{
    sourceId: "auditor", kind: "security_auditor", url: "https://auditor.example/report",
    trustLevel: "publisher_claim", retrievedAt: "2026-11-26T11:01:00.000Z",
    evidence: [{ field: "utility", value: 92, trustLevel: "publisher_claim",
      observedAt: "2026-11-26T11:00:00.000Z", reference: "utility-report-1" }]
  }]
});
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
  : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
const attestation = () => {
  const payload = {
    issuer: "independent-auditor", networkId: "pi-mainnet", tokenId: "pi-token-1", evidenceId: "utility-report-1",
    field: "utility", sourceUrl: "https://auditor.example/report",
    observedAt: "2026-11-26T11:00:00.000Z", expiresAt: "2026-11-27T11:00:00.000Z", value: 92
  };
  return { keyId: "auditor-a", algorithm: "Ed25519", payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") };
};

test("feeds only verified evidence into analyzer and leaves unsigned metrics unknown", () => {
  const result = analyzeVerifiedLaunchpadOpportunity({
    snapshot: {
      networkId: "pi-mainnet", tokenId: "pi-token-1", symbol: "PIT",
      evidence: { utility: 100, teamTransparency: 100, sourceVerification: 100 },
      fdvPi: 1, liquidity: { tvlPi: 999999, lockedPercent: 100 },
      holders: { top10Percent: 1 }, riskFlags: ["fake positive risk"]
    },
    envelope: envelope(), attestations: [attestation()], trustRecords, now: NOW
  });
  assert.equal(result.componentScores.utility, 92);
  assert.equal(result.componentScores.teamTransparency, null);
  assert.equal(result.componentScores.sourceVerification, null);
  assert.equal(result.componentScores.liquidity, null);
  assert.equal(result.liquidity.tvlPi, null);
  assert.equal(result.verifiedEvidence.acceptedCount, 1);
});

test("rejects a snapshot whose token identity differs from the signed envelope", () => {
  assert.throws(() => analyzeVerifiedLaunchpadOpportunity({
    snapshot: { networkId: "pi-mainnet", tokenId: "other-token" }, envelope: envelope(),
    attestations: [attestation()], trustRecords, now: NOW
  }), /does not match/);
});

test("does not produce scores when there are no trusted attestations", () => {
  const result = analyzeVerifiedLaunchpadOpportunity({
    snapshot: { networkId: "pi-mainnet", tokenId: "pi-token-1", evidence: { utility: 100 } },
    envelope: envelope(), attestations: [], trustRecords: [], now: NOW
  });
  assert.equal(result.score, null);
  assert.equal(result.componentScores.utility, null);
});
