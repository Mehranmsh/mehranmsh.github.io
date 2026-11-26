/**
 * Pi Testnet RPC experiment boundary.
 * Pure policy and JSON-RPC envelope validation only: no network transport,
 * Mainnet support, wallet access, signing, or transaction methods.
 */
export const PI_TESTNET_RPC_ENDPOINT = "https://rpc.testnet.minepi.com";
export const PI_TESTNET_RPC_POLICY = Object.freeze({
  network: "testnet",
  endpoint: PI_TESTNET_RPC_ENDPOINT,
  allowedMethods: Object.freeze(["getHealth"]),
  maxResponseBytes: 64 * 1024,
  timeoutMs: 5000,
  maxRedirects: 0,
  readOnly: true,
  walletAccess: false,
  signing: false,
  transactions: false
});

const isPlainRecord = (value) => !!value && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function createPiTestnetRpcRequest(options = {}) {
  if (!isPlainRecord(options)) return Object.freeze({ allowed: false, code: "invalid_options" });
  if (options.network !== "testnet") return Object.freeze({ allowed: false, code: "testnet_only" });
  if (options.endpoint !== undefined && options.endpoint !== PI_TESTNET_RPC_ENDPOINT) {
    return Object.freeze({ allowed: false, code: "endpoint_not_allowlisted" });
  }
  const method = options.method ?? "getHealth";
  if (!PI_TESTNET_RPC_POLICY.allowedMethods.includes(method)) {
    return Object.freeze({ allowed: false, code: "method_not_allowlisted" });
  }
  const id = options.id ?? "pi-testnet-health-1";
  if (!(typeof id === "string" && id.length > 0 && id.length <= 80) &&
      !(Number.isSafeInteger(id) && id >= 0)) {
    return Object.freeze({ allowed: false, code: "invalid_request_id" });
  }
  return Object.freeze({
    allowed: true,
    network: "testnet",
    endpoint: PI_TESTNET_RPC_ENDPOINT,
    method,
    request: Object.freeze({ jsonrpc: "2.0", id, method, params: [] }),
    limits: PI_TESTNET_RPC_POLICY
  });
}

/**
 * Checks only the JSON-RPC envelope and request correlation.
 * A valid envelope is not proof of ledger truth or Mainnet state.
 */
export function validatePiTestnetRpcResponse(response, expectedId) {
  if (!isPlainRecord(response)) return Object.freeze({ accepted: false, code: "invalid_response" });
  if (response.jsonrpc !== "2.0" || response.id !== expectedId) {
    return Object.freeze({ accepted: false, code: "rpc_envelope_mismatch" });
  }
  if (Object.hasOwn(response, "error")) {
    return Object.freeze({ accepted: false, code: "rpc_error", error: response.error });
  }
  if (!Object.hasOwn(response, "result")) {
    return Object.freeze({ accepted: false, code: "missing_result" });
  }
  return Object.freeze({
    accepted: true,
    network: "testnet",
    result: response.result,
    trustNotice: "Testnet RPC response envelope only. Not Mainnet evidence, not a cryptographic proof, and not eligible for Mainnet scoring."
  });
}
