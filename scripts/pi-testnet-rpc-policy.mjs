
import { createHash } from "node:crypto";

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
function deepFreezeJson(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function validatePiTestnetRpcResponse(response, expectedId) {
  if (!isPlainRecord(response)) return Object.freeze({ accepted: false, code: "invalid_response" });
  if (!(typeof expectedId === "string" || Number.isSafeInteger(expectedId))) {
    return Object.freeze({ accepted: false, code: "invalid_expected_id" });
  }
  if (response.jsonrpc !== "2.0" || response.id !== expectedId) {
    return Object.freeze({ accepted: false, code: "rpc_envelope_mismatch" });
  }

  let serialized;
  try {
    serialized = JSON.stringify(response);
  } catch {
    return Object.freeze({ accepted: false, code: "unserializable_response" });
  }
  if (typeof serialized !== "string") {
    return Object.freeze({ accepted: false, code: "unserializable_response" });
  }
  if (new TextEncoder().encode(serialized).byteLength > PI_TESTNET_RPC_POLICY.maxResponseBytes) {
    return Object.freeze({ accepted: false, code: "response_too_large" });
  }

  let safeResponse;
  try {
    safeResponse = JSON.parse(serialized);
  } catch {
    return Object.freeze({ accepted: false, code: "invalid_response" });
  }
  if (Object.hasOwn(safeResponse, "error")) {
    return Object.freeze({ accepted: false, code: "rpc_error" });
  }
  if (!Object.hasOwn(safeResponse, "result")) {
    return Object.freeze({ accepted: false, code: "missing_result" });
  }

  deepFreezeJson(safeResponse.result);
  return Object.freeze({
    accepted: true,
    network: "testnet",
    result: safeResponse.result,
    responseBytes: new TextEncoder().encode(serialized).byteLength,
    trustNotice: "Opaque Testnet RPC result only. Health semantics are not interpreted. Not Mainnet evidence, not a cryptographic proof, and not eligible for Mainnet scoring."
  });
}


function isCanonicalUtcTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Creates an immutable audit observation from a validated JSON-RPC response.
 * The SHA-256 digest covers JSON.stringify(response), not original HTTP wire bytes.
 * This is a tamper-evident local record, not a Pi signature or proof of truth.
 */
export function createPiTestnetObservation(response, expectedId, retrievedAt) {
  if (!isCanonicalUtcTimestamp(retrievedAt)) {
    return Object.freeze({ accepted: false, code: "invalid_retrieval_timestamp" });
  }
  const checked = validatePiTestnetRpcResponse(response, expectedId);
  if (!checked.accepted) return checked;

  let serialized;
  try {
    serialized = JSON.stringify(response);
  } catch {
    return Object.freeze({ accepted: false, code: "unserializable_response" });
  }
  if (typeof serialized !== "string") {
    return Object.freeze({ accepted: false, code: "unserializable_response" });
  }
  const responseSha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  const observation = {
    schemaVersion: 1,
    network: "testnet",
    endpoint: PI_TESTNET_RPC_ENDPOINT,
    method: "getHealth",
    requestId: expectedId,
    retrievedAt,
    responseBytes: checked.responseBytes,
    serializedResponseSha256: responseSha256,
    result: checked.result,
    eligibleForMainnetScoring: false,
    trustNotice: "Testnet observation only. Digest covers normalized JSON serialization, not original wire bytes. No Pi signature, ledger proof, Mainnet evidence, or scoring eligibility is implied."
  };
  return Object.freeze({
    accepted: true,
    observation: deepFreezeJson(observation)
  });
}
