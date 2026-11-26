import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_TESTNET_RPC_ENDPOINT,
  PI_TESTNET_RPC_POLICY,
  createPiTestnetRpcRequest,
  validatePiTestnetRpcResponse
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
