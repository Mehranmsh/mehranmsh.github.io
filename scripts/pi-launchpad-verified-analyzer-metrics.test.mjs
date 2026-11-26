import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { analyzeVerifiedLaunchpadOpportunity } from "./pi-launchpad-verified-analyzer.mjs";

const now = Date.parse("2026-11-26T12:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const fingerprintSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
const trustRecords = [{
  keyId: "indexer", publicKeyPem: pem, fingerprintSha256, issuer: "trusted-indexer",
  allowedSourceOrigins: ["https://indexer.example"],
  allowedFields: ["utility", "liquidity.tvlPi", "liquidity.volume24hPi", "liquidity.lockedPercent", "market.fdvPi", "holders.top10Percent"],
  notBefore: "2026-11-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", revoked: false
}];
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
  : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
const fields = [
  ["utility", 80, "score-1"],
  ["liquidity.tvlPi", 12000, "metric-1"],
  ["liquidity.volume24hPi", 2400, "metric-2"],
  ["liquidity.lockedPercent", 90, "metric-3"],
  ["market.fdvPi", 50000, "metric-4"],
  ["holders.top10Percent", 35, "metric-5"]
];
const envelope = () => ({
  schemaVersion: 1, networkId: "pi-mainnet", tokenId: "pi-token-1", observedAt: "2026-11-26T11:00:00.000Z",
  sources: [{
    sourceId: "indexer", kind: "dex_indexer", url: "https://indexer.example/snapshot",
    trustLevel: "publisher_claim", retrievedAt: "2026-11-26T11:01:00.000Z",
    evidence: fields.map(([field, value, reference]) => ({ field, value,
      trustLevel: "publisher_claim", observedAt: "2026-11-26T11:00:00.000Z", reference }))
  }]
});
const signed = ([field, value, evidenceId]) => {
  const payload = { issuer: "trusted-indexer", networkId: "pi-mainnet", tokenId: "pi-token-1", evidenceId, field,
    sourceUrl: "https://indexer.example/snapshot", observedAt: "2026-11-26T11:00:00.000Z",
    expiresAt: "2026-11-27T11:00:00.000Z", value };
  return { keyId: "indexer", algorithm: "Ed25519", payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") };
};

test("verified analyzer uses attested Pi metrics and ignores forged snapshot metric values", () => {
  const result = analyzeVerifiedLaunchpadOpportunity({
    snapshot: { networkId: "pi-mainnet", tokenId: "pi-token-1", symbol: "PIT",
      fdvPi: 1, liquidity: { tvlPi: 999999, volume24hPi: 0, lockedPercent: 0 },
      holders: { top10Percent: 99 } },
    envelope: envelope(),
    attestations: [signed(fields[0])],
    metricAttestations: fields.slice(1).map(signed),
    trustRecords, now
  });
  assert.equal(result.liquidity.tvlPi, 12000);
  assert.equal(result.liquidity.volume24hPi, 2400);
  assert.equal(result.liquidity.score, 55);
  assert.equal(result.componentScores.liquidity, 55);
  assert.equal(result.verifiedMetrics.acceptedCount, 5);
  assert.equal(result.verifiedEvidence.acceptedCount, 1);
  assert.equal(result.risks.some(x => x.includes("Top 10 holders")), false);
});
