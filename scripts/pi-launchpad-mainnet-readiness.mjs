/**
 * Fail-closed readiness gate for a future Pi Mainnet Launchpad data connector.
 *
 * This validates trusted operator-supplied source documentation and review
 * metadata. It does not discover endpoints, fetch data, authenticate a source,
 * prove ledger truth, or enable a connector by itself.
 */
export const PI_MAINNET_READINESS_GATE_VERSION = "0.1.0";

const OFFICIAL_DOC_HOSTS = new Set(["minepi.com", "developers.minepi.com"]);
const REQUIRED_RESOURCES = Object.freeze(["ledger", "assets", "pools", "trades"]);
const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,120}$/;
const READ_ONLY_METHOD = /^(get|read|query)[A-Z0-9][a-zA-Z0-9]*$/;

const isRecord = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const hasText = (value, max = 1000) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function parseHttpsUrl(value) {
  if (!hasText(value, 2048)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Required input must come from trusted server-side operator configuration.
 * A successful result is only permission to proceed to a separate connector
 * implementation/review. It never performs or authorizes network I/O itself.
 */
export function assessPiMainnetConnectorReadiness(input) {
  if (!isRecord(input)) {
    return Object.freeze({
      readyForReadOnlyConnector: false,
      code: "invalid_readiness_record",
      blockers: Object.freeze(["A plain operator readiness record is required."])
    });
  }

  const blockers = [];
  const documentation = parseHttpsUrl(input.documentationUrl);
  const endpoint = parseHttpsUrl(input.endpointUrl);

  if (input.networkId !== "pi-mainnet") {
    blockers.push("networkId must be explicitly pi-mainnet; Testnet evidence cannot satisfy this gate.");
  }
  if (!SAFE_ID.test(input.sourceId ?? "")) {
    blockers.push("A stable sourceId is required.");
  }
  if (!SAFE_ID.test(input.connectorId ?? "")) {
    blockers.push("A stable connectorId is required.");
  }
  if (!documentation || !OFFICIAL_DOC_HOSTS.has(documentation.hostname)) {
    blockers.push("documentationUrl must be an exact HTTPS page hosted by minepi.com or developers.minepi.com.");
  }
  if (!endpoint || endpoint.hostname.includes("testnet")) {
    blockers.push("endpointUrl must be a valid HTTPS endpoint without credentials, query, fragment, custom port, or Testnet hostname.");
  }
  if (input.endpointDocumentedExactly !== true) {
    blockers.push("The exact endpoint URL must be explicitly published in official Pi documentation.");
  }
  if (!hasText(input.protocolVersion, 80)) {
    blockers.push("The supported Mainnet protocol version must be documented.");
  }
  if (!isRecord(input.ledgerIdentity) ||
      !Number.isSafeInteger(input.ledgerIdentity.sequence) ||
      input.ledgerIdentity.sequence < 1 ||
      !HEX_256.test(input.ledgerIdentity.hash ?? "")) {
    blockers.push("A known-good Mainnet fixture must include a positive ledger sequence and 64-character ledger hash.");
  }
  if (!hasText(input.finalitySemantics, 2000)) {
    blockers.push("Canonical ledger/finality semantics must be documented.");
  }
  if (!Array.isArray(input.resourceCoverage) ||
      REQUIRED_RESOURCES.some((resource) => !input.resourceCoverage.includes(resource))) {
    blockers.push("Documented data coverage must include ledger, assets, pools, and trades.");
  }
  if (!Array.isArray(input.readOnlyMethods) || input.readOnlyMethods.length < 1 ||
      input.readOnlyMethods.length > 30 ||
      input.readOnlyMethods.some((method) => !SAFE_ID.test(method) || !READ_ONLY_METHOD.test(method)) ||
      new Set(input.readOnlyMethods).size !== input.readOnlyMethods.length) {
    blockers.push("An explicit bounded list of documented read-only methods is required.");
  }
  if (input.writeMethodsExcluded !== true) {
    blockers.push("The connector must explicitly exclude all state-changing and transaction-submission methods.");
  }
  if (!hasText(input.authenticationRequirements, 2000)) {
    blockers.push("Authentication requirements must be documented.");
  }
  if (!hasText(input.rateLimitPolicy, 2000)) {
    blockers.push("Rate limits and retry policy must be documented.");
  }
  if (input.independentApproval !== true) {
    blockers.push("Independent technical and security approval is required.");
  }
  if (!SAFE_ID.test(input.reviewerId ?? "")) {
    blockers.push("A recorded independent reviewer ID is required.");
  }
  if (typeof input.reviewedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(input.reviewedAt) ||
      !Number.isFinite(Date.parse(input.reviewedAt))) {
    blockers.push("A valid UTC review timestamp is required.");
  }

  const accepted = blockers.length === 0;
  return Object.freeze({
    gateVersion: PI_MAINNET_READINESS_GATE_VERSION,
    readyForReadOnlyConnector: accepted,
    code: accepted ? "mainnet_source_ready_for_separate_connector_review" : "mainnet_source_not_ready",
    blockers: Object.freeze(blockers),
    networkId: accepted ? "pi-mainnet" : null,
    sourceId: accepted ? input.sourceId : null,
    connectorId: accepted ? input.connectorId : null,
    notice: "Readiness metadata is not proof of source authenticity or on-chain truth. This gate performs no network requests, creates no connector, and never enables writes."
  });
}

export const PI_MAINNET_READINESS_REQUIREMENTS = Object.freeze({
  officialDocumentationHosts: Object.freeze([...OFFICIAL_DOC_HOSTS]),
  requiredResources: REQUIRED_RESOURCES,
  networkId: "pi-mainnet",
  readOnlyOnly: true,
  requiresIndependentApproval: true
});
