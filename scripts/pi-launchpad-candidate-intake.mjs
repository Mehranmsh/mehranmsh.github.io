/**
 * Manual Pi Launchpad candidate intake.
 * Validates and deduplicates operator-supplied candidate records only.
 * No crawler, network request, trust promotion, scoring, or wallet action.
 */
export const PI_LAUNCHPAD_CANDIDATE_INTAKE_VERSION = "0.1.0";
export const PI_LAUNCHPAD_CANDIDATE_INTAKE_MAX = 500;
const MAX_SOURCES = 10;
const text = (v, max) => typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null;

function safeReference(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        !url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
        url.hostname.endsWith(".local") || url.hostname.includes(":") ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ||
        url.hostname.startsWith("[") || !url.hostname.includes(".")) return null;
    return url.href;
  } catch { return null; }
}

export function preparePiLaunchpadCandidateIntake(input, options = {}) {
  if (!Array.isArray(input)) throw new TypeError("Candidate intake must be an array.");
  const requestedLimit = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? options.maxCandidates : PI_LAUNCHPAD_CANDIDATE_INTAKE_MAX;
  const limit = Math.min(requestedLimit, PI_LAUNCHPAD_CANDIDATE_INTAKE_MAX);
  if (input.length > limit) return Object.freeze({
    accepted: false, code: "candidate_limit_exceeded", limit, received: input.length
  });

  const candidates = [], rejected = [], seen = new Set();
  input.forEach((record, index) => {
    const reject = (reason) => rejected.push(Object.freeze({ index, reason }));
    if (!record || typeof record !== "object" || Array.isArray(record)) return reject("invalid_record");
    const tokenId = text(record.tokenId, 180);
    const name = text(record.name, 100);
    if (!tokenId) return reject("missing_or_invalid_token_id");
    if (!name) return reject("missing_or_invalid_name");
    if (seen.has(tokenId)) return reject("duplicate_token_id");
    seen.add(tokenId);

    const symbol = record.symbol === undefined || record.symbol === null
      ? null : text(record.symbol, 24);
    if (record.symbol !== undefined && record.symbol !== null && !symbol) return reject("invalid_symbol");

    const suppliedSources = record.references === undefined ? [] : record.references;
    if (!Array.isArray(suppliedSources) || suppliedSources.length > MAX_SOURCES) return reject("invalid_reference_list");
    const references = [];
    for (const ref of suppliedSources) {
      const url = safeReference(ref);
      if (!url) return reject("unsafe_or_invalid_reference");
      if (!references.includes(url)) references.push(url);
    }
    const claimedNetworkId = record.claimedNetworkId === undefined ? "pi-mainnet" : record.claimedNetworkId;
    if (claimedNetworkId !== "pi-mainnet") return reject("unsupported_network_claim");

    candidates.push(Object.freeze({
      tokenId, name, symbol, claimedNetworkId,
      networkVerification: "unverified",
      evidenceStatus: "not_submitted",
      scoringStatus: "blocked_pending_verified_evidence",
      references: Object.freeze(references)
    }));
  });

  return Object.freeze({
    accepted: true,
    intakeVersion: PI_LAUNCHPAD_CANDIDATE_INTAKE_VERSION,
    received: input.length,
    candidateCount: candidates.length,
    rejectedCount: rejected.length,
    candidates: Object.freeze(candidates),
    rejected: Object.freeze(rejected),
    notice: "Manual intake only. The Pi Mainnet network value is an operator-supplied claim, not verified chain identity. Candidates are not scored, fetched, or promoted to trusted evidence."
  });
}
