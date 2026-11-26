import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_TESTNET_RPC_ENDPOINT,
  PI_TESTNET_RPC_POLICY,
  createPiTestnetRpcRequest,
  validatePiTestnetRpcResponse,
  createPiTestnetObservation
} from "./pi-testnet-rpc-policy.mjs";

test("creates only the documented Testnet health request", () => {
  const plan = createPiTestnetRpcRequest({ network: "testnet" });
  assert.equal(plan.allowed, true);
  assert.equal(plan.network, "testnet");
  assert.equal(plan.endpoint, PI_TESTNET_RPC_ENDPOINT);
  assert.deepEqual(plan.request, {
    jsonrpc: "2.0", id: "pi-testnet-health-1", method: "getHealth", params: []
  });
});

test("rejects Mainnet, unknown networks, and endpoint substitution", () => {
  assert.equal(createPiTestnetRpcRequest({ network: "mainnet" }).code, "testnet_only");
  assert.equal(createPiTestnetRpcRequest({ network: "unknown" }).code, "testnet_only");
  assert.equal(createPiTestnetRpcRequest({
    network: "testnet", endpoint: "https://rpc.mainnet.minepi.com"
  }).code, "endpoint_not_allowlisted");
});

test("rejects methods beyond the narrow health read", () => {
  for (const method of ["getLedger", "sendTransaction", "submitTransaction", "getAccount"]) {
    assert.equal(createPiTestnetRpcRequest({ network: "testnet", method }).code, "method_not_allowlisted");
  }
  assert.deepEqual(PI_TESTNET_RPC_POLICY.allowedMethods, ["getHealth"]);
  assert.equal(PI_TESTNET_RPC_POLICY.walletAccess, false);
  assert.equal(PI_TESTNET_RPC_POLICY.signing, false);
  assert.equal(PI_TESTNET_RPC_POLICY.transactions, false);
});

test("validates JSON-RPC response correlation without claiming chain truth", () => {
  const result = validatePiTestnetRpcResponse(
    { jsonrpc: "2.0", id: "health-1", result: { status: "healthy" } }, "health-1"
  );
  assert.equal(result.accepted, true);
  assert.equal(result.network, "testnet");
  assert.match(result.trustNotice, /not eligible for Mainnet scoring/);
});

test("rejects malformed, mismatched, error, and result-less responses", () => {
  assert.equal(validatePiTestnetRpcResponse([], "x").code, "invalid_response");
  assert.equal(validatePiTestnetRpcResponse({ jsonrpc: "2.0", id: "wrong", result: {} }, "x").code, "rpc_envelope_mismatch");
  assert.equal(validatePiTestnetRpcResponse({ jsonrpc: "2.0", id: "x", error: { code: -1 } }, "x").code, "rpc_error");
  assert.equal(validatePiTestnetRpcResponse({ jsonrpc: "2.0", id: "x" }, "x").code, "missing_result");
});


test("rejects oversized and non-serializable response payloads", () => {
  const oversized = { jsonrpc: "2.0", id: "x", result: { data: "a".repeat(PI_TESTNET_RPC_POLICY.maxResponseBytes) } };
  assert.equal(validatePiTestnetRpcResponse(oversized, "x").code, "response_too_large");
  const cyclic = { jsonrpc: "2.0", id: "x", result: {} };
  cyclic.result.self = cyclic.result;
  assert.equal(validatePiTestnetRpcResponse(cyclic, "x").code, "unserializable_response");
});

test("returns a detached deeply frozen opaque result", () => {
  const source = { jsonrpc: "2.0", id: "x", result: { details: { status: "unknown" } } };
  const checked = validatePiTestnetRpcResponse(source, "x");
  assert.equal(checked.accepted, true);
  assert.notEqual(checked.result, source.result);
  assert.equal(Object.isFrozen(checked.result), true);
  assert.equal(Object.isFrozen(checked.result.details), true);
  assert.throws(() => { checked.result.details.status = "healthy"; }, TypeError);
  assert.match(checked.trustNotice, /Health semantics are not interpreted/);
  assert.ok(checked.responseBytes > 0 && checked.responseBytes <= PI_TESTNET_RPC_POLICY.maxResponseBytes);
});


test("creates a timestamped immutable Testnet observation with a SHA-256 digest", () => {
  const response = { jsonrpc: "2.0", id: "health-1", result: { state: "opaque" } };
  const created = createPiTestnetObservation(response, "health-1", "2026-11-26T02:40:00.000Z");
  assert.equal(created.accepted, true);
  assert.equal(created.observation.network, "testnet");
  assert.equal(created.observation.endpoint, PI_TESTNET_RPC_ENDPOINT);
  assert.equal(created.observation.method, "getHealth");
  assert.equal(created.observation.eligibleForMainnetScoring, false);
  assert.match(created.observation.serializedResponseSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(created.observation), true);
  assert.equal(Object.isFrozen(created.observation.result), true);
  assert.match(created.observation.trustNotice, /not original wire bytes/);
  assert.equal(response.result.state, "opaque");
});

test("rejects invalid timestamps and invalid RPC envelopes when creating observations", () => {
  assert.equal(createPiTestnetObservation(
    { jsonrpc: "2.0", id: "x", result: {} }, "x", "2026-02-30T00:00:00.000Z"
  ).code, "invalid_retrieval_timestamp");
  assert.equal(createPiTestnetObservation(
    { jsonrpc: "2.0", id: "wrong", result: {} }, "x", "2026-11-26T02:40:00.000Z"
  ).code, "rpc_envelope_mismatch");
  assert.equal(createPiTestnetObservation(
    { jsonrpc: "2.0", id: "x", result: {} }, "x", "2026-11-26"
  ).code, "invalid_retrieval_timestamp");
});
