/**
 * Deterministic portfolio prioritizer for already-analyzed Pi Launchpad candidates.
 * Ranking only: no live data, network, AI, wallet, signing, trading, or prediction.
 */
export const PI_LAUNCHPAD_RANKER_VERSION = "0.1.0";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const analysis = candidate.analysis && typeof candidate.analysis === "object"
    ? candidate.analysis : candidate;
  const tokenId = typeof analysis.tokenId === "string" ? analysis.tokenId.trim() : "";
  if (!tokenId || tokenId.length > 120) return null;
  const score = analysis.score;
  const coveragePercent = analysis.coveragePercent;
  if (!finite(score) || score < 0 || score > 100 ||
      !finite(coveragePercent) || coveragePercent < 0 || coveragePercent > 100) return null;
  const classification = typeof analysis.classification === "string" ? analysis.classification : "";
  const risks = Array.isArray(analysis.risks)
    ? analysis.risks.filter((risk) => typeof risk === "string" && risk.trim()).slice(0, 50)
    : [];
  const events = Array.isArray(candidate.monitor?.events) ? candidate.monitor.events : [];
  return { tokenId, symbol: analysis.symbol ?? null, score, coveragePercent, classification, risks, events };
}

function eventPenalty(events) {
  let penalty = 0;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.severity === "critical") penalty += 20;
    else if (event.severity === "high") penalty += 10;
    else if (event.severity === "medium") penalty += 5;
  }
  return Math.min(30, penalty);
}

/**
 * candidates: analyzer results, or { analysis, monitor } records.
 * Returns ranked eligible candidates and excluded candidates with explicit reasons.
 */
export function rankPiLaunchpadPortfolio(candidates, options = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("Candidates must be an array.");
  const minCoverage = finite(options.minCoveragePercent)
    ? clamp(options.minCoveragePercent, 0, 100) : 60;
  const riskPenaltyPerFlag = finite(options.riskPenaltyPerFlag)
    ? clamp(options.riskPenaltyPerFlag, 0, 10) : 2;
  const maxRiskPenalty = finite(options.maxRiskPenalty)
    ? clamp(options.maxRiskPenalty, 0, 40) : 20;

  const ranked = [];
  const excluded = [];
  const seen = new Set();

  candidates.forEach((candidate, index) => {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) {
      excluded.push({ index, tokenId: null, reason: "invalid_or_incomplete_analysis" });
      return;
    }
    if (seen.has(normalized.tokenId)) {
      excluded.push({ index, tokenId: normalized.tokenId, reason: "duplicate_token_id" });
      return;
    }
    seen.add(normalized.tokenId);

    let reason = null;
    if (normalized.classification === "critical_risk") reason = "critical_risk";
    else if (normalized.classification === "insufficient_data") reason = "insufficient_data";
    else if (normalized.coveragePercent < minCoverage) reason = "coverage_below_minimum";
    else if (!["strong_candidate", "watchlist", "weak_candidate", "high_risk"].includes(normalized.classification)) {
      reason = "unsupported_classification";
    }

    if (reason) {
      excluded.push({ index, tokenId: normalized.tokenId, reason });
      return;
    }

    const riskPenalty = Math.min(maxRiskPenalty, normalized.risks.length * riskPenaltyPerFlag);
    const monitoringPenalty = eventPenalty(normalized.events);
    const priorityScore = Math.round(clamp(normalized.score - riskPenalty - monitoringPenalty, 0, 100) * 100) / 100;
    ranked.push({
      tokenId: normalized.tokenId,
      symbol: normalized.symbol,
      score: normalized.score,
      priorityScore,
      coveragePercent: normalized.coveragePercent,
      classification: normalized.classification,
      riskCount: normalized.risks.length,
      riskPenalty,
      monitoringPenalty
    });
  });

  ranked.sort((a, b) =>
    b.priorityScore - a.priorityScore ||
    b.coveragePercent - a.coveragePercent ||
    b.score - a.score ||
    a.tokenId.localeCompare(b.tokenId)
  );

  return Object.freeze({
    rankerVersion: PI_LAUNCHPAD_RANKER_VERSION,
    minimumCoveragePercent: minCoverage,
    ranked: Object.freeze(ranked.map((item, index) => Object.freeze({ rank: index + 1, ...item }))),
    excluded: Object.freeze(excluded.map((item) => Object.freeze(item))),
    notice: "Screening priority only, not a buy/sell signal, safety certification, price forecast, or proof of project legitimacy. No live data is fetched."
  });
}
