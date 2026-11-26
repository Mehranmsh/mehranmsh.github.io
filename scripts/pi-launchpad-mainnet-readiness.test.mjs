import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_MAINNET_READINESS_REQUIREMENTS,
  assessPiMainnetConnectorReadiness
} from "./pi-launchpad-mainnet-readiness.mjs";

const valid = {
  networkId: "pi-mainnet",
  sourceId: "pi-mainnet-rpc-official",
  connectorId: "pi-mainnet-readonly-v1",
  documentationUrl: "https://minepi.com/blog/future-mainnet-rpc/",
  endpointUrl: "https://rpc.mainnet.minepi.com",
  endpointDocumentedExactly: true,
  protocolVersion: "Protocol-28",
  ledgerIdentity: { sequence: 123456, hash: "a".repeat(64) },
  finalitySemantics: "Fixture is tied to a canonical closed ledger; finality and hash validation rules are documented.",
  resourceCoverage: ["ledger", "assets", "pools", "trades"],
  readOnlyMethods: ["getHealth", "getLedger", "getAccount"],
  writeMethodsExcluded: true,
  authenticationRequirements: "Public read-only access with documented server-side credentials policy.",
  rateLimitPolicy: "Documented request budget, timeout, and retry-after handling.",
  independentApproval: true,
  reviewerId: "security-review-01",
  reviewedAt: "2026-11-26T12:00:00Z"
};

test("readiness requirements are Mainnet-only and require independent review", () => {
  assert.equal(PI_MAINNET_READINESS_REQUIREMENTS.networkId, "pi-mainnet");
  assert.equal(PI_MAINNET_READINESS_REQUIREMENTS.readOnlyOnly, true);
  assert.equal(PI_MAINNET_READINESS_REQUIREMENTS.requiresIndependentApproval, true);
  assert.deepEqual(PI_MAINNET_READINESS_REQUIREMENTS.requiredResources,
    ["ledger", "assets", "pools", "trades"]);
});

test("complete trusted operator record passes only to separate connector review", () => {
  const result = assessPiMainnetConnectorReadiness(valid);
  assert.equal(result.readyForReadOnlyConnector, true);
  assert.equal(result.networkId, "pi-mainnet");
  assert.equal(result.sourceId, valid.sourceId);
  assert.ok(result.notice.includes("creates no connector"));
});

test("current Testnet RPC cannot satisfy the Mainnet readiness gate", () => {
  const result = assessPiMainnetConnectorReadiness({
    ...valid,
    networkId: "pi-testnet",
    endpointUrl: "https://rpc.testnet.minepi.com"
  });
  assert.equal(result.readyForReadOnlyConnector, false);
  assert.ok(result.blockers.some((item) => item.includes("pi-mainnet")));
  assert.ok(result.blockers.some((item) => item.includes("Testnet hostname")));
});

test("rejects unofficial documentation and endpoints not explicitly documented", () => {
  for (const patch of [
    { documentationUrl: "https://minepi.com.attacker.example/rpc" },
    { documentationUrl: "http://minepi.com/rpc" },
    { endpointDocumentedExactly: false },
    { endpointUrl: "https://rpc.mainnet.minepi.com/path?target=127.0.0.1" },
    { endpointUrl: "https://user:pass@rpc.mainnet.minepi.com" },
    { endpointUrl: "http://rpc.mainnet.minepi.com" }
  ]) {
    assert.equal(assessPiMainnetConnectorReadiness({ ...valid, ...patch }).readyForReadOnlyConnector, false);
  }
});

test("rejects missing protocol, finality, ledger identity, or required data coverage", () => {
  const cases = [
    { protocolVersion: "" },
    { finalitySemantics: "" },
    { ledgerIdentity: { sequence: 0, hash: "a".repeat(64) } },
    { ledgerIdentity: { sequence: 1, hash: "not-a-hash" } },
    { resourceCoverage: ["ledger", "assets", "pools"] }
  ];
  for (const patch of cases) {
    assert.equal(assessPiMainnetConnectorReadiness({ ...valid, ...patch }).readyForReadOnlyConnector, false);
  }
});

test("requires a bounded explicit read-only method list and write exclusion", () => {
  for (const patch of [
    { readOnlyMethods: [] },
    { readOnlyMethods: ["getHealth", "bad method"] },
    { readOnlyMethods: Array(31).fill("getHealth") },
    { writeMethodsExcluded: false }
  ]) {
    assert.equal(assessPiMainnetConnectorReadiness({ ...valid, ...patch }).readyForReadOnlyConnector, false);
  }
});

test("requires independent approval, reviewer identity, and valid UTC review time", () => {
  for (const patch of [
    { independentApproval: false },
    { reviewerId: "" },
    { reviewedAt: "yesterday" }
  ]) {
    assert.equal(assessPiMainnetConnectorReadiness({ ...valid, ...patch }).readyForReadOnlyConnector, false);
  }
});

test("returns every blocker instead of accepting a partially documented source", () => {
  const result = assessPiMainnetConnectorReadiness({ networkId: "pi-testnet" });
  assert.equal(result.readyForReadOnlyConnector, false);
  assert.ok(result.blockers.length >= 10);
  assert.equal(result.networkId, null);
});

test("does not mutate the operator-supplied record", () => {
  const input = structuredClone(valid);
  assessPiMainnetConnectorReadiness(input);
  assert.deepEqual(input, valid);
});

test("rejects non-record input", () => {
  assert.equal(assessPiMainnetConnectorReadiness(null).code, "invalid_readiness_record");
  assert.equal(assessPiMainnetConnectorReadiness([]).readyForReadOnlyConnector, false);
});
