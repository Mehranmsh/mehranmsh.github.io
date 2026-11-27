/**
 * Bounded batch orchestration for already-produced Pi Launchpad analyses.
 * This is not a live discovery crawler and does not fetch or authenticate evidence.
 */
import { rankPiLaunchpadPortfolio } from "./pi-launchpad-portfolio-ranker.mjs";
import { comparePiLaunchpadBatch } from "./pi-launchpad-comparison.mjs";

export const PI_LAUNCHPAD_BATCH_VERSION = "0.1.0";
export const PI_LAUNCHPAD_BATCH_MAX_CANDIDATES = 500;

export function screenPiLaunchpadBatch(input, options = {}) {
  if (!Array.isArray(input)) throw new TypeError("Batch input must be an array.");
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? Math.min(options.maxCandidates, PI_LAUNCHPAD_BATCH_MAX_CANDIDATES)
    : PI_LAUNCHPAD_BATCH_MAX_CANDIDATES;
  if (input.length > maxCandidates) {
    return Object.freeze({
      accepted: false,
      code: "batch_limit_exceeded",
      limit: maxCandidates,
      received: input.length
    });
  }

  const normalized = [];
  const inputIssues = [];
  const ids = new Set();

  input.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      inputIssues.push({ index, reason: "invalid_candidate_record" });
      return;
    }
    const analysis = item.analysis && typeof item.analysis === "object" ? item.analysis : item;
    const tokenId = typeof analysis.tokenId === "string" ? analysis.tokenId.trim() : "";
    if (!tokenId) {
      inputIssues.push({ index, reason: "missing_token_id" });
      return;
    }
    if (ids.has(tokenId)) {
      inputIssues.push({ index, tokenId, reason: "duplicate_token_id" });
      return;
    }
    ids.add(tokenId);
    normalized.push(item);
  });

  const portfolio = rankPiLaunchpadPortfolio(normalized, options);
  const analysesByTokenId = new Map(normalized.map((item) => {
    const analysis = item.analysis && typeof item.analysis === "object" ? item.analysis : item;
    return [analysis.tokenId.trim(), analysis];
  }));
  const rankedWithReports = portfolio.ranked.map((candidate) => {
    const analysis = analysesByTokenId.get(candidate.tokenId);
    const report = analysis?.analysisReport;
    const reportMatches = report && typeof report === "object" &&
      report.identity?.tokenId === candidate.tokenId &&
      typeof report.generatedAt === "string" &&
      typeof report.verdict?.classification === "string";
    return Object.freeze({
      ...candidate,
      analysisReport: reportMatches ? report : null,
      reportStatus: reportMatches ? "attached_precomputed_report" : "report_unavailable"
    });
  });
  const comparison = comparePiLaunchpadBatch({ accepted: true, ranked: rankedWithReports });
  const classifications = {
    strong_candidate: 0,
    watchlist: 0,
    weak_candidate: 0,
    high_risk: 0,
    critical_risk: 0,
    insufficient_data: 0,
    invalid_or_unclassified: 0
  };
  let totalCoverage = 0;
  let coverageCount = 0;
  let totalScore = 0;
  let scoreCount = 0;

  for (const item of normalized) {
    const analysis = item.analysis && typeof item.analysis === "object" ? item.analysis : item;
    const classification = Object.hasOwn(classifications, analysis.classification)
      ? analysis.classification : "invalid_or_unclassified";
    classifications[classification] += 1;
    if (typeof analysis.coveragePercent === "number" &&
        Number.isFinite(analysis.coveragePercent) &&
        analysis.coveragePercent >= 0 && analysis.coveragePercent <= 100) {
      totalCoverage += analysis.coveragePercent;
      coverageCount += 1;
    }
    if (typeof analysis.score === "number" && Number.isFinite(analysis.score) &&
        analysis.score >= 0 && analysis.score <= 100) {
      totalScore += analysis.score;
      scoreCount += 1;
    }
  }

  return Object.freeze({
    accepted: true,
    batchVersion: PI_LAUNCHPAD_BATCH_VERSION,
    received: input.length,
    uniqueCandidates: normalized.length,
    malformedRecords: inputIssues.filter((issue) => issue.reason !== "duplicate_token_id").length,
    duplicateCount: inputIssues.filter((issue) => issue.reason === "duplicate_token_id").length,
    eligibleCount: portfolio.ranked.length,
    excludedCount: portfolio.excluded.length,
    averageEvidenceCoverage: coverageCount ? Math.round(totalCoverage / coverageCount * 100) / 100 : null,
    averageRawScore: scoreCount ? Math.round(totalScore / scoreCount * 100) / 100 : null,
    classifications: Object.freeze(classifications),
    ranked: Object.freeze(rankedWithReports),
    comparison,
    excluded: Object.freeze([
      ...portfolio.excluded,
      ...inputIssues.map((issue) => Object.freeze({
        index: issue.index,
        tokenId: issue.tokenId ?? null,
        reason: issue.reason
      }))
    ]),
    notice: "Batch screening summarizes supplied analyses only. Attached reports are carried through from the analysis input and are not re-verified here. This module does not discover projects, verify evidence, fetch live Pi data, or recommend trades."
  });
}
