/**
 * Side-by-side comparison for supplied Pi Launchpad batch-screen results.
 * Pure local computation: no discovery, verification, network, AI, or trading.
 */
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const bounded = (value) => finite(value) && value >= 0 && value <= 100;

export const PI_LAUNCHPAD_COMPARISON_VERSION = "0.1.0";
export const PI_LAUNCHPAD_COMPARISON_MAX_ENTRIES = 500;

export function comparePiLaunchpadBatch(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch) ||
      batch.accepted !== true || !Array.isArray(batch.ranked)) {
    throw new TypeError("An accepted Pi Launchpad batch-screen result is required.");
  }
  if (batch.ranked.length > PI_LAUNCHPAD_COMPARISON_MAX_ENTRIES) {
    return Object.freeze({
      accepted: false,
      code: "comparison_limit_exceeded",
      limit: PI_LAUNCHPAD_COMPARISON_MAX_ENTRIES,
      received: batch.ranked.length
    });
  }

  const seen = new Set();
  const entries = [];
  const issues = [];
  batch.ranked.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        typeof candidate.tokenId !== "string" || !candidate.tokenId.trim()) {
      issues.push(Object.freeze({ index, reason: "invalid_ranked_candidate" }));
      return;
    }
    const tokenId = candidate.tokenId.trim();
    if (seen.has(tokenId)) {
      issues.push(Object.freeze({ index, tokenId, reason: "duplicate_token_id" }));
      return;
    }
    seen.add(tokenId);
    const report = candidate.analysisReport && typeof candidate.analysisReport === "object"
      ? candidate.analysisReport : null;
    const identityMatches = report?.identity?.tokenId === tokenId;
    const reportUsable = candidate.reportStatus === "attached_precomputed_report" &&
      identityMatches && report?.verdict && typeof report.verdict === "object";
    const verdict = reportUsable ? report.verdict : null;
    const liquidity = reportUsable && report.liquidityAssessment &&
      typeof report.liquidityAssessment === "object" ? report.liquidityAssessment : {};
    const provenance = reportUsable && report.provenance &&
      typeof report.provenance === "object" ? report.provenance : {};
    const missingComponents = reportUsable &&
      Array.isArray(report.scoreBreakdown?.missingComponents)
      ? report.scoreBreakdown.missingComponents.filter((item) => typeof item === "string").slice(0, 20)
      : null;
    const riskItems = reportUsable && Array.isArray(report.risks)
      ? report.risks.filter((item) => typeof item === "string").slice(0, 100)
      : null;
    entries.push(Object.freeze({
      rank: entries.length + 1,
      tokenId,
      symbol: typeof candidate.symbol === "string" ? candidate.symbol : null,
      classification: typeof candidate.classification === "string" ? candidate.classification : null,
      score: bounded(candidate.score) ? candidate.score : null,
      priorityScore: bounded(candidate.priorityScore) ? candidate.priorityScore : null,
      evidenceCoveragePercent: bounded(candidate.coveragePercent) ? candidate.coveragePercent : null,
      riskCount: finite(candidate.riskCount) && candidate.riskCount >= 0 ? candidate.riskCount : null,
      riskPenalty: finite(candidate.riskPenalty) && candidate.riskPenalty >= 0 ? candidate.riskPenalty : null,
      monitoringPenalty: finite(candidate.monitoringPenalty) && candidate.monitoringPenalty >= 0 ? candidate.monitoringPenalty : null,
      reportStatus: reportUsable ? "available_precomputed_report" : "report_unavailable",
      liquidity: Object.freeze({
        tvlPi: finite(liquidity.tvlPi) && liquidity.tvlPi >= 0 ? liquidity.tvlPi : null,
        volume24hPi: finite(liquidity.volume24hPi) && liquidity.volume24hPi >= 0 ? liquidity.volume24hPi : null,
        turnover24h: finite(liquidity.turnover24h) && liquidity.turnover24h >= 0 ? liquidity.turnover24h : null,
        fdvToLiquidity: finite(liquidity.fdvToLiquidity) && liquidity.fdvToLiquidity >= 0 ? liquidity.fdvToLiquidity : null
      }),
      missingComponents: missingComponents ? Object.freeze(missingComponents) : null,
      risks: riskItems ? Object.freeze(riskItems) : null,
      acceptedEvidenceRecordCount: reportUsable && finite(provenance.acceptedEvidenceRecordCount)
        ? provenance.acceptedEvidenceRecordCount : null,
      rejectedEvidenceRecordCount: reportUsable && finite(provenance.rejectedEvidenceRecordCount)
        ? provenance.rejectedEvidenceRecordCount : null,
      staleOrUndatedEvidenceCount: reportUsable && finite(provenance.staleOrUndatedEvidenceCount)
        ? provenance.staleOrUndatedEvidenceCount : null
    }));
  });

  entries.sort((a, b) =>
    (b.priorityScore ?? -1) - (a.priorityScore ?? -1) ||
    (b.evidenceCoveragePercent ?? -1) - (a.evidenceCoveragePercent ?? -1) ||
    (a.tokenId.localeCompare(b.tokenId))
  );
  const ranked = entries.map((entry, index) => Object.freeze({ ...entry, comparisonRank: index + 1 }));
  const average = (key) => {
    const values = ranked.map((entry) => entry[key]).filter(finite);
    return values.length
      ? Object.freeze({ value: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100, available: values.length, total: ranked.length })
      : Object.freeze({ value: null, available: 0, total: ranked.length });
  };
  const reportAvailableCount = ranked.filter((entry) => entry.reportStatus === "available_precomputed_report").length;

  return Object.freeze({
    accepted: true,
    comparisonVersion: PI_LAUNCHPAD_COMPARISON_VERSION,
    comparedCount: ranked.length,
    reportAvailableCount,
    reportUnavailableCount: ranked.length - reportAvailableCount,
    averages: Object.freeze({
      score: average("score"),
      priorityScore: average("priorityScore"),
      evidenceCoveragePercent: average("evidenceCoveragePercent")
    }),
    entries: Object.freeze(ranked),
    issues: Object.freeze(issues),
    notice: "This comparison orders only the supplied pre-screened analyses. Attached reports are carried through, not independently re-verified. Missing metrics remain unknown; this is not live market discovery, a safety certification, or a buy/sell recommendation."
  });
}
