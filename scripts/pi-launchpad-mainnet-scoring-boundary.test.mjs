import test from "node:test";
import assert from "node:assert/strict";
import { analyzeVerifiedLaunchpadOpportunity } from "./pi-launchpad-verified-analyzer.mjs";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const envelope = (networkId) => ({
  schemaVersion: 1,
  networkId,
  tokenId: "candidate-1",
  observedAt: "2026-11-26T11:00:00.000Z",
  sources: [{
    sourceId: "source-1",
    kind: "official_project",
    url: "https://minepi.com/",
    trustLevel: "publisher_claim",
    retrievedAt: "2026-11-26T11:01:00.000Z",
    evidence: []
  }]
});

test("blocks Testnet evidence before any scoring path", () => {
  assert.throws(() => analyzeVerifiedLaunchpadOpportunity({
    snapshot: { networkId: "pi-testnet", tokenId: "candidate-1" },
    envelope: envelope("pi-testnet"),
    attestations: [],
    metricAttestations: [],
    trustRecords: [],
    now: NOW
  }), /explicit pi-mainnet snapshot/);
});

test("blocks Testnet envelope even when the candidate snapshot claims Mainnet", () => {
  assert.throws(() => analyzeVerifiedLaunchpadOpportunity({
    snapshot: { networkId: "pi-mainnet", tokenId: "candidate-1" },
    envelope: envelope("pi-testnet"),
    attestations: [],
    metricAttestations: [],
    trustRecords: [],
    now: NOW
  }), /pi-mainnet evidence envelope/);
});

test("blocks missing and unknown snapshot network identities", () => {
  for (const networkId of [undefined, "stellar", ""]) {
    assert.throws(() => analyzeVerifiedLaunchpadOpportunity({
      snapshot: { networkId, tokenId: "candidate-1" },
      envelope: envelope("pi-mainnet"),
      attestations: [],
      metricAttestations: [],
      trustRecords: [],
      now: NOW
    }), /explicit pi-mainnet snapshot/);
  }
});

test("permits Mainnet identity but still yields no score without trusted evidence", () => {
  const result = analyzeVerifiedLaunchpadOpportunity({
    snapshot: { networkId: "pi-mainnet", tokenId: "candidate-1" },
    envelope: envelope("pi-mainnet"),
    attestations: [],
    metricAttestations: [],
    trustRecords: [],
    now: NOW
  });
  assert.equal(result.networkId, "pi-mainnet");
  assert.equal(result.score, null);
});
