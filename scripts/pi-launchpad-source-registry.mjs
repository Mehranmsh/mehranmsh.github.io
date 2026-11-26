/**
 * Curated source registry for Pi Launchpad intelligence.
 * Entries are documentation/discovery references, not live data connectors.
 * No network requests are made by this module.
 */
export const PI_SOURCE_REGISTRY_VERSION = "0.1.0";

const entries = [
  {
    id: "pi_official_launchpad_design",
    name: "Pi Network Launchpad design",
    kind: "official_project",
    origin: "https://minepi.com/blog/pi-launchpad/",
    domain: "minepi.com",
    status: "documentation_only",
    enabledForLiveIngestion: false,
    supportedClaims: ["launchpad_mechanism", "product_first_expectations", "ecosystem_token_design"],
    limitations: ["Not a live token feed", "Does not prove a project's current status or eligibility"]
  },
  {
    id: "pi_official_dex_amm_testnet",
    name: "Pi Network DEX and AMM testnet announcement",
    kind: "official_project",
    origin: "https://minepi.com/blog/dex-amm-token-creation/",
    domain: "minepi.com",
    status: "documentation_only",
    enabledForLiveIngestion: false,
    supportedClaims: ["testnet_dex_amm_capabilities", "protocol_level_feature_context"],
    limitations: ["Historical testnet announcement", "Not evidence of current Mainnet pool state"]
  },
  {
    id: "pi_official_mainnet_timeline",
    name: "Pi Network Launchpad and DEX Mainnet timeline",
    kind: "official_project",
    origin: "https://minepi.com/blog/ecosystem-summit-begins/",
    domain: "minepi.com",
    status: "documentation_only",
    enabledForLiveIngestion: false,
    supportedClaims: ["published_mainnet_timeline"],
    limitations: ["Announcement timeline can change", "Not an operational API"]
  },
  {
    id: "pi_developer_docs",
    name: "Pi Network developer documentation",
    kind: "official_project",
    origin: "https://developers.minepi.com/",
    domain: "developers.minepi.com",
    status: "documentation_only",
    enabledForLiveIngestion: false,
    supportedClaims: ["documented_developer_interfaces", "official_platform_api_contracts"],
    limitations: ["Must inspect specific API documentation before implementation", "No DEX indexer endpoint assumed"]
  },
  {
    id: "pi_official_rpc_testnet_announcement",
    name: "Pi Network Testnet RPC announcement",
    kind: "official_project",
    origin: "https://minepi.com/blog/rpc-server/",
    domain: "minepi.com",
    status: "documentation_only",
    enabledForLiveIngestion: false,
    supportedClaims: ["testnet_rpc_documentation_context"],
    limitations: ["Announcement described Testnet RPC", "Does not authorize Mainnet RPC assumptions"]
  }
];

export const PI_LAUNCHPAD_SOURCE_REGISTRY = Object.freeze(entries.map((entry) =>
  Object.freeze({ ...entry, supportedClaims: Object.freeze([...entry.supportedClaims]), limitations: Object.freeze([...entry.limitations]) })
));

const byId = new Map(PI_LAUNCHPAD_SOURCE_REGISTRY.map((entry) => [entry.id, entry]));

export function getPiLaunchpadSource(sourceId) {
  return byId.get(sourceId) ?? null;
}

/**
 * Check whether a reference matches a curated documentation source.
 * This is a metadata match only, never proof of authenticity or truth.
 */
export function matchPiLaunchpadSourceReference(sourceId, candidateUrl) {
  const entry = getPiLaunchpadSource(sourceId);
  if (!entry || typeof candidateUrl !== "string") return Object.freeze({ matched: false, liveIngestionAllowed: false, reason: "unknown_source" });
  let candidate;
  try { candidate = new URL(candidateUrl); } catch {
    return Object.freeze({ matched: false, liveIngestionAllowed: false, reason: "invalid_url" });
  }
  const expected = new URL(entry.origin);
  const matched = candidate.protocol === "https:" &&
    candidate.hostname === expected.hostname &&
    candidate.origin === expected.origin &&
    candidate.pathname === expected.pathname &&
    !candidate.username && !candidate.password;
  return Object.freeze({
    matched,
    sourceId: entry.id,
    liveIngestionAllowed: false,
    reason: matched ? "curated_documentation_reference_only" : "reference_not_in_registry"
  });
}
