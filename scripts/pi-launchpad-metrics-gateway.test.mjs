import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { buildPiLaunchpadVerifiedMetrics } from "./pi-launchpad-metrics-gateway.mjs";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const fingerprintSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
const fields = ["liquidity.tvlPi", "liquidity.volume24hPi", "liquidity.lockedPercent", "market.fdvPi", "holders.top10Percent"];
const trustRecords = [{
  keyId: "indexer-a", publicKeyPem: pem, fingerprintSha256, issuer: "independent-indexer",
  allowedSourceOrigins: ["https://indexer.example"], allowedFields: [...fields, "utility", "liquidity.pricePi"],
  notBefore: "2026-11-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", revoked: false
}];
const specs = [
  ["liquidity.tvlPi", 12000, ["liquidity", "tvlPi"]],
  ["liquidity.volume24hPi", 2500, ["liquidity", "volume24hPi"]],
  ["liquidity.lockedPercent", 75, ["liquidity", "lockedPercent"]],
  ["market.fdvPi", 90000, ["fdvPi"]],
  ["holders.top10Percent", 42, ["holders", "top10Percent"]]
];
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
  : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
const envelope = (selected = specs) => ({
  schemaVersion: 1, networkId: "pi-mainnet", tokenId: "pi-token-1", observedAt: "2026-11-26T11:00:00.000Z",
  sources: [{ sourceId: "indexer", kind: "dex_indexer", url: "https://indexer.example/snapshot",
    trustLevel: "publisher_claim", retrievedAt: "2026-11-26T11:01:00.000Z",
    evidence: selected.map(([field, value], i) => ({ field, value, trustLevel: "publisher_claim",
      observedAt: "2026-11-26T11:00:00.000Z", reference: "metric-" + i }))
  }]
});
const attestations = (selected = specs) => selected.map(([field, value], i) => {
  const payload = { issuer: "independent-indexer", networkId: "pi-mainnet", tokenId: "pi-token-1", evidenceId: "metric-" + i,
    field, sourceUrl: "https://indexer.example/snapshot", observedAt: "2026-11-26T11:00:00.000Z",
    expiresAt: "2026-11-27T11:00:00.000Z", value };
  return { keyId: "indexer-a", algorithm: "Ed25519", payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") };
});

test("maps all five separately allowlisted signed metrics into exact Pi snapshot paths", () => {
  const result = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(), attestations: attestations(), trustRecords, now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(result.verifiedMetrics)), {
    liquidity: { tvlPi: 12000, volume24hPi: 2500, lockedPercent: 75 },
    fdvPi: 90000, holders: { top10Percent: 42 }
  });
  assert.equal(result.acceptedCount, 5);
  assert.equal(result.rejectedCount, 0);
});

test("rejects out-of-range percentage metrics and negative Pi amounts", () => {
  const selected = [["liquidity.lockedPercent", 101], ["holders.top10Percent", -1], ["market.fdvPi", -1]];
  const result = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(selected), attestations: attestations(selected), trustRecords, now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(result.verifiedMetrics)), {});
  assert.equal(result.rejectedCount, 3);
  assert.ok(result.rejectedRecords.every(x => x.code === "metric_out_of_range"));
});

test("does not accept component scores or unrecognized metric fields", () => {
  const selected = [["utility", 99], ["liquidity.pricePi", 1]];
  const result = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(selected), attestations: attestations(selected), trustRecords, now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(result.verifiedMetrics)), {});
  assert.ok(result.rejectedRecords.every(x => x.code === "field_not_metric"));
});

test("rejects mismatched token, source, timestamp, and value bindings", () => {
  const selected = [specs[0]];
  const signed = attestations(selected);
  signed[0].payload.value = 12001;
  const result = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(selected), attestations: signed, trustRecords, now: NOW });
  assert.equal(result.acceptedCount, 0);
  assert.ok(result.rejectedRecords.some(x => x.code === "signature_mismatch"));
});

test("fails closed without operator trust anchors and rejects duplicate references", () => {
  const selected = [specs[0]];
  const noTrust = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(selected), attestations: attestations(selected), trustRecords: [], now: NOW });
  assert.equal(noTrust.acceptedCount, 0);
  assert.equal(noTrust.rejectedRecords[0].code, "untrusted_signer");
  const duplicate = [...attestations(selected), ...attestations(selected)];
  const result = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(selected), attestations: duplicate, trustRecords, now: NOW });
  assert.equal(result.acceptedCount, 1);
  assert.ok(result.rejectedRecords.some(x => x.code === "duplicate_attestation"));
});

test("rejects conflicting attestations for the same metric", () => {
  const selected = [["liquidity.tvlPi", 100], ["liquidity.tvlPi", 200]];
  const result = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(selected), attestations: attestations(selected), trustRecords, now: NOW });
  assert.equal(result.acceptedCount, 0);
  assert.ok(result.rejectedRecords.some(x => x.code === "conflicting_metric_attestations"));
});

test("deep-freezes nested verified metric objects", () => {
  const result = buildPiLaunchpadVerifiedMetrics({ envelope: envelope(), attestations: attestations(), trustRecords, now: NOW });
  assert.equal(Object.isFrozen(result.verifiedMetrics), true);
  assert.equal(Object.isFrozen(result.verifiedMetrics.liquidity), true);
  assert.throws(() => { result.verifiedMetrics.liquidity.tvlPi = 1; }, TypeError);
  assert.equal(result.verifiedMetrics.liquidity.tvlPi, 12000);
});
