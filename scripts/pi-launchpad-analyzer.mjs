/**
 * MEHRAN INTELLIGENCE: deterministic Pi Launchpad opportunity screening.
 * Pure local computation. No network, wallet, signing, trading, or AI calls.
 * Inputs must come from separately verified data adapters; unknowns stay unknown.
 */
export const LAUNCHPAD_ANALYZER_VERSION = "0.1.0";
export const LAUNCHPAD_SCORE_WEIGHTS = Object.freeze({
  utility: 20,
  teamTransparency: 15,
  tokenomics: 15,
  marketActivity: 10,
  liquidity: 15,
  contractSecurity: 15,
  sourceVerification: 10
});

const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const scoreValue = (v) => finite(v) && v >= 0 && v <= 100 ? v : null;

function ratio(numerator, denominator) {
  return finite(numerator) && finite(denominator) && denominator > 0
    ? numerator / denominator
    : null;
}

function assessLiquidity(snapshot) {
  const pool = snapshot.liquidity || {};
  const tvl = finite(pool.tvlPi) && pool.tvlPi >= 0 ? pool.tvlPi : null;
  const volume = finite(pool.volume24hPi) && pool.volume24hPi >= 0 ? pool.volume24hPi : null;
  const turnover = ratio(volume, tvl);
  const fdvToLiquidity = ratio(snapshot.fdvPi, tvl);
  let score = null;
  if (tvl !== null) {
    score = tvl >= 100000 ? 90 : tvl >= 25000 ? 75 : tvl >= 5000 ? 55 : tvl >= 1000 ? 35 : 15;
    if (turnover !== null && turnover > 5) score -= 15;
    if (fdvToLiquidity !== null && fdvToLiquidity > 20) score -= 15;
    score = clamp(score);
  }
  return { tvlPi: tvl, volume24hPi: volume, turnover24h: turnover, fdvToLiquidity, score };
}

function collectRisks(snapshot, liquidity) {
  const risks = [];
  const flags = Array.isArray(snapshot.riskFlags) ? snapshot.riskFlags : [];
  for (const flag of flags) {
    if (typeof flag === "string" && flag.trim()) risks.push(flag.trim().slice(0, 120));
  }
  if (snapshot.contract?.verified === false) risks.push("Contract source is reported unverified");
  if (snapshot.contract?.ownerRenounced === false && snapshot.contract?.ownerPrivilegesReviewed !== true) {
    risks.push("Owner privileges have not been reviewed");
  }
  if (finite(snapshot.holders?.top10Percent) && snapshot.holders.top10Percent > 60) {
    risks.push("Top 10 holders control more than 60% of supply");
  }
  if (finite(snapshot.liquidity?.lockedPercent) && snapshot.liquidity.lockedPercent < 50) {
    risks.push("Less than 50% of reported liquidity is locked");
  }
  if (liquidity.fdvToLiquidity !== null && liquidity.fdvToLiquidity > 30) {
    risks.push("FDV is more than 30x reported pool liquidity");
  }
  return [...new Set(risks)];
}

export function analyzeLaunchpadOpportunity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("A token snapshot object is required.");
  }
  const snapshot = input;
  const scores = {
    utility: scoreValue(snapshot.evidence?.utility),
    teamTransparency: scoreValue(snapshot.evidence?.teamTransparency),
    tokenomics: scoreValue(snapshot.evidence?.tokenomics),
    marketActivity: scoreValue(snapshot.evidence?.marketActivity),
    contractSecurity: scoreValue(snapshot.evidence?.contractSecurity),
    sourceVerification: scoreValue(snapshot.evidence?.sourceVerification)
  };
  const liquidity = assessLiquidity(snapshot);
  scores.liquidity = liquidity.score;

  let earned = 0;
  let availableWeight = 0;
  for (const [key, weight] of Object.entries(LAUNCHPAD_SCORE_WEIGHTS)) {
    const value = scores[key];
    if (value !== null) {
      earned += value * weight;
      availableWeight += weight;
    }
  }
  const coveragePercent = Math.round(availableWeight / 100 * 100);
  const rawScore = availableWeight ? Math.round(earned / availableWeight) : null;
  const risks = collectRisks(snapshot, liquidity);
  const criticalRisk = risks.some((r) => /rug|honeypot|malicious|exploit|fake team|stolen/i.test(r));
  const score = rawScore === null ? null : criticalRisk ? Math.min(rawScore, 25) : rawScore;
  const confidence = coveragePercent >= 85 ? "high" : coveragePercent >= 60 ? "medium" : "low";
  const classification = score === null ? "insufficient_data"
    : criticalRisk ? "critical_risk"
    : coveragePercent < 40 ? "insufficient_data"
    : score >= 80 ? "strong_candidate"
    : score >= 65 ? "watchlist"
    : score >= 45 ? "weak_candidate"
    : "high_risk";

  return Object.freeze({
    analyzerVersion: LAUNCHPAD_ANALYZER_VERSION,
    tokenId: typeof snapshot.tokenId === "string" ? snapshot.tokenId.slice(0, 120) : null,
    symbol: typeof snapshot.symbol === "string" ? snapshot.symbol.slice(0, 24) : null,
    score,
    classification,
    confidence,
    coveragePercent,
    componentScores: Object.freeze(scores),
    liquidity: Object.freeze(liquidity),
    risks: Object.freeze(risks),
    limitations: Object.freeze([
      "This is a screening score, not a prediction or investment recommendation.",
      "No live Pi DEX/Launchpad data is fetched by this module.",
      "Unverified or missing evidence is not treated as a positive signal."
    ])
  });
}
