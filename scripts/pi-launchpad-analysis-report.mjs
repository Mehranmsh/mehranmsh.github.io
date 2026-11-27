/**
 * Explainable, provenance-aware report builder for Pi Launchpad analyses.
 * Pure formatting/derivation only. It does not verify evidence or fetch data.
 */
import { LAUNCHPAD_SCORE_WEIGHTS } from "./pi-launchpad-analyzer.mjs";

const COMPONENT_LABELS = Object.freeze({
  utility: "Product utility",
  teamTransparency: "Team transparency",
  tokenomics: "Tokenomics",
  marketActivity: "Market activity",
  liquidity: "Liquidity quality",
  contractSecurity: "Contract security",
  sourceVerification: "Source verification"
});
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const isoTime = (value) => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};
const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

function classificationReason(analysis) {
  if (analysis.classification === "critical_risk") return "A critical risk flag was detected; the score is capped at 25.";
  if (analysis.classification === "insufficient_data") return "Available evidence is insufficient to support a reliable classification.";
  if (analysis.classification === "strong_candidate") return "The score is at least 80 with sufficient evidence coverage.";
  if (analysis.classification === "watchlist") return "The score is between 65 and 79; continued monitoring is warranted.";
  if (analysis.classification === "weak_candidate") return "The score is between 45 and 64; material weaknesses remain.";
  if (analysis.classification === "high_risk") return "The score is below 45.";
  return "No recognized classification reason is available.";
}

export function buildPiLaunchpadAnalysisReport(analysis, {
  verifiedEvidence,
  verifiedMetrics,
  now,
  maxEvidenceAgeDays = 7
} = {}) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    throw new TypeError("A Launchpad analysis result is required.");
  }
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!finite(timestamp)) throw new TypeError("A finite report timestamp is required.");
  if (!finite(maxEvidenceAgeDays) || maxEvidenceAgeDays < 0 || maxEvidenceAgeDays > 365) {
    throw new RangeError("maxEvidenceAgeDays must be between 0 and 365.");
  }

  const components = Object.entries(LAUNCHPAD_SCORE_WEIGHTS).map(([key, weight]) => {
    const value = analysis.componentScores?.[key];
    const available = finite(value) && value >= 0 && value <= 100;
    const contribution = available && finite(analysis.score)
      ? Math.round((value * weight / Object.entries(LAUNCHPAD_SCORE_WEIGHTS)
          .reduce((sum, [field]) => {
            const score = analysis.componentScores?.[field];
            return sum + (finite(score) && score >= 0 && score <= 100
              ? LAUNCHPAD_SCORE_WEIGHTS[field] : 0);
          }, 0)) * 100) / 100
      : null;
    return Object.freeze({
      key,
      label: COMPONENT_LABELS[key],
      weightPercent: weight,
      score: available ? value : null,
      weightedContribution: contribution,
      status: available ? "scored" : "missing"
    });
  });

  const accepted = [
    ...(Array.isArray(verifiedEvidence?.acceptedRecords) ? verifiedEvidence.acceptedRecords : []),
    ...(Array.isArray(verifiedMetrics?.acceptedRecords) ? verifiedMetrics.acceptedRecords : [])
  ];
  const rejected = [
    ...(Array.isArray(verifiedEvidence?.rejectedRecords) ? verifiedEvidence.rejectedRecords : []),
    ...(Array.isArray(verifiedMetrics?.rejectedRecords) ? verifiedMetrics.rejectedRecords : [])
  ];
  const maxAgeMs = maxEvidenceAgeDays * 24 * 60 * 60 * 1000;
  const evidenceFreshness = accepted.map((record) => {
    const observed = isoTime(record.observedAt);
    const ageMs = observed === null ? null : Math.max(0, timestamp - observed);
    return Object.freeze({
      evidenceId: typeof record.evidenceId === "string" ? record.evidenceId : null,
      field: typeof record.field === "string" ? record.field : null,
      sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : null,
      issuer: typeof record.issuer === "string" ? record.issuer : null,
      observedAt: observed === null ? null : new Date(observed).toISOString(),
      ageHours: ageMs === null ? null : Math.round(ageMs / 3600000 * 10) / 10,
      freshness: ageMs === null ? "unknown_timestamp" : ageMs <= maxAgeMs ? "fresh_by_policy" : "stale_by_policy",
      cryptographicallyVerified: record.cryptographicallyVerified === true
    });
  });
  const staleEvidenceCount = evidenceFreshness.filter((item) =>
    item.freshness === "stale_by_policy" || item.freshness === "unknown_timestamp"
  ).length;
  const missingComponents = components.filter((item) => item.status === "missing").map((item) => item.key);
  const liquidity = analysis.liquidity ?? {};
  const liquidityNotes = [];
  if (!finite(liquidity.tvlPi)) liquidityNotes.push("TVL is unavailable; liquidity quality cannot be scored.");
  if (!finite(liquidity.volume24hPi)) liquidityNotes.push("24-hour volume is unavailable.");
  if (!finite(liquidity.turnover24h)) liquidityNotes.push("Turnover cannot be calculated without both volume and TVL.");
  if (!finite(liquidity.fdvToLiquidity)) liquidityNotes.push("FDV-to-liquidity ratio is unavailable.");
  if (finite(liquidity.turnover24h) && liquidity.turnover24h > 5) liquidityNotes.push("Turnover exceeds 5x TVL and reduces the liquidity score.");
  if (finite(liquidity.fdvToLiquidity) && liquidity.fdvToLiquidity > 20) liquidityNotes.push("FDV exceeds 20x TVL and reduces the liquidity score.");
  if (finite(liquidity.fdvToLiquidity) && liquidity.fdvToLiquidity > 30) liquidityNotes.push("FDV exceeds 30x TVL and triggers a risk flag.");

  return freeze({
    reportVersion: "0.1.0",
    generatedAt: new Date(timestamp).toISOString(),
    identity: Object.freeze({
      tokenId: typeof analysis.tokenId === "string" ? analysis.tokenId : null,
      symbol: typeof analysis.symbol === "string" ? analysis.symbol : null
    }),
    verdict: Object.freeze({
      score: finite(analysis.score) ? analysis.score : null,
      classification: typeof analysis.classification === "string" ? analysis.classification : "unknown",
      confidence: typeof analysis.confidence === "string" ? analysis.confidence : "unknown",
      evidenceCoveragePercent: finite(analysis.coveragePercent) ? analysis.coveragePercent : null,
      explanation: classificationReason(analysis)
    }),
    scoreBreakdown: Object.freeze({
      method: "Weighted average over available components only; missing components are not treated as zero.",
      components: Object.freeze(components),
      missingComponents: Object.freeze(missingComponents)
    }),
    liquidityAssessment: Object.freeze({
      tvlPi: finite(liquidity.tvlPi) ? liquidity.tvlPi : null,
      volume24hPi: finite(liquidity.volume24hPi) ? liquidity.volume24hPi : null,
      turnover24h: finite(liquidity.turnover24h) ? liquidity.turnover24h : null,
      fdvToLiquidity: finite(liquidity.fdvToLiquidity) ? liquidity.fdvToLiquidity : null,
      score: finite(liquidity.score) ? liquidity.score : null,
      notes: Object.freeze(liquidityNotes)
    }),
    risks: Object.freeze(Array.isArray(analysis.risks) ? analysis.risks.slice(0, 100) : []),
    provenance: Object.freeze({
      acceptedAttestationCount: accepted.length,
      rejectedAttestationCount: rejected.length,
      acceptedEvidence: Object.freeze(evidenceFreshness),
      staleOrUndatedEvidenceCount: staleEvidenceCount,
      rejectedReasons: Object.freeze(rejected.map((item) => Object.freeze({
        evidenceId: typeof item.evidenceId === "string" ? item.evidenceId : null,
        code: typeof item.code === "string" ? item.code : "unknown_rejection"
      }))),
      freshnessPolicyDays: maxEvidenceAgeDays,
      cryptographicNotice: "A valid signature establishes signer identity and payload integrity only. It does not independently prove factual accuracy or on-chain truth."
    }),
    limitations: Object.freeze([
      ...(Array.isArray(analysis.limitations) ? analysis.limitations : []),
      "This report explains supplied analysis results; it does not fetch live Pi Launchpad or DEX data.",
      "Missing contract-security and source-verification evidence remains unknown, not safe or verified.",
      "Evidence freshness is a policy label based on observedAt, not proof that the underlying claim remains true."
    ])
  });
}
