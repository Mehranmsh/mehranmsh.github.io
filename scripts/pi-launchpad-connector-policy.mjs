/**
 * Security contract for future Pi Launchpad source connectors.
 * Policy only: no fetch, DNS lookup, URL following, or network activity occurs here.
 */
export const PI_CONNECTOR_POLICY_VERSION = "0.1.0";
export const PI_CONNECTOR_POLICY = Object.freeze({
  methods: Object.freeze(["GET"]),
  maxResponseBytes: 256 * 1024,
  timeoutMs: 5000,
  maxRedirects: 0,
  acceptedContentTypes: Object.freeze(["application/json", "application/json; charset=utf-8"]),
  rejectPrivateNetworkTargets: true,
  rejectUserSuppliedTargets: true,
  requireExactRegisteredOriginAndPath: true,
  requireIndependentSourceApproval: true
});

/**
 * Returns a deny-by-default plan. A documentation reference is never a live
 * connector, even if its URL matches the curated source registry exactly.
 */
export function createPiConnectorPlan(source, candidateUrl, options = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return Object.freeze({ allowed: false, code: "unknown_source" });
  }
  if (options.userSuppliedTarget === true) {
    return Object.freeze({ allowed: false, code: "user_supplied_target_forbidden" });
  }
  if (source.status !== "live_approved" || source.enabledForLiveIngestion !== true ||
      source.independentApproval !== true || typeof source.connectorId !== "string" ||
      !source.connectorId.trim()) {
    return Object.freeze({ allowed: false, code: "source_not_live_approved" });
  }
  if (typeof candidateUrl !== "string") {
    return Object.freeze({ allowed: false, code: "invalid_target" });
  }
  let candidate;
  let registered;
  try {
    candidate = new URL(candidateUrl);
    registered = new URL(source.origin);
  } catch {
    return Object.freeze({ allowed: false, code: "invalid_target" });
  }
  const exactTarget = candidate.protocol === "https:" &&
    candidate.origin === registered.origin &&
    candidate.pathname === registered.pathname &&
    candidate.search === "" && candidate.hash === "" &&
    !candidate.username && !candidate.password;
  if (!exactTarget) return Object.freeze({ allowed: false, code: "target_not_exactly_registered" });
  return Object.freeze({
    allowed: true,
    connectorId: source.connectorId,
    method: "GET",
    maxResponseBytes: PI_CONNECTOR_POLICY.maxResponseBytes,
    timeoutMs: PI_CONNECTOR_POLICY.timeoutMs,
    maxRedirects: 0,
    acceptedContentTypes: PI_CONNECTOR_POLICY.acceptedContentTypes
  });
}
