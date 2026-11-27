// Safe, bounded diagnostics for semantic-analysis response validation.
// Never return or log model-generated text, source excerpts, or evidence quotes.

// Remove only findings whose evidence points outside the exact supplied source set.
// Never rewrite/guess a model-generated path; all retained evidence still passes strict validation.
export function discardFindingsWithUnknownEvidencePaths(analysis, files) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis) ||
      !Array.isArray(analysis.findings) || !Array.isArray(files)) return analysis;
  const allowedPaths = new Set(files.map(file => file?.path).filter(path => typeof path === "string"));
  const retained = analysis.findings.filter(item =>
    item && typeof item === "object" && !Array.isArray(item) &&
    Array.isArray(item.evidence) &&
    item.evidence.every(ev => ev && typeof ev === "object" && !Array.isArray(ev) &&
      typeof ev.path === "string" && allowedPaths.has(ev.path))
  );
  const discarded = retained.length !== analysis.findings.length;
  if (!discarded) return analysis;
  return {
    ...analysis,
    findings: retained,
    limitations: [
      ...(Array.isArray(analysis.limitations) ? analysis.limitations : []),
      "One or more findings were omitted because their evidence referenced a path outside the exact supplied source set."
    ].slice(0, 5)
  };
}

export function validateRepositoryAnalysis(analysis, files) {
  const fail = (code, findingIndex = null, evidenceIndex = null, field = null) => ({
    valid: false, code, findingIndex, evidenceIndex, field
  });
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis) ||
      typeof analysis.summary !== "string" || analysis.summary.length > 1600 ||
      !Array.isArray(analysis.findings) || analysis.findings.length > 8 ||
      !Array.isArray(analysis.limitations) || analysis.limitations.length > 5) {
    return fail("invalid_analysis_structure", null, null, "analysis");
  }

  const allowedPaths = new Set((Array.isArray(files) ? files : []).map(file => file?.path).filter(path => typeof path === "string"));
  for (let findingIndex = 0; findingIndex < analysis.findings.length; findingIndex++) {
    const item = analysis.findings[findingIndex];
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail("invalid_finding_shape", findingIndex, null, "finding");
    if (!["critical", "high", "medium", "low", "info"].includes(item.severity)) return fail("invalid_severity", findingIndex, null, "severity");
    if (typeof item.title !== "string" || item.title.length > 180) return fail("field_limit_exceeded", findingIndex, null, "title");
    if (typeof item.rootCause !== "string" || item.rootCause.length > 1200) return fail("field_limit_exceeded", findingIndex, null, "rootCause");
    if (typeof item.recommendation !== "string" || item.recommendation.length > 1200) return fail("field_limit_exceeded", findingIndex, null, "recommendation");
    if (!Array.isArray(item.evidence) || item.evidence.length > 5) return fail("invalid_evidence_array", findingIndex, null, "evidence");
    for (let evidenceIndex = 0; evidenceIndex < item.evidence.length; evidenceIndex++) {
      const ev = item.evidence[evidenceIndex];
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) return fail("invalid_evidence_shape", findingIndex, evidenceIndex, "evidence");
      if (typeof ev.path !== "string" || !allowedPaths.has(ev.path)) return fail("unknown_evidence_path", findingIndex, evidenceIndex, "path");
      if (typeof ev.quote !== "string" || ev.quote.length > 500) return fail("field_limit_exceeded", findingIndex, evidenceIndex, "quote");
      const source = files.find(file => file?.path === ev.path)?.excerpt;
      if (typeof source !== "string" || !source.includes(ev.quote)) return fail("quote_mismatch", findingIndex, evidenceIndex, "quote");
    }
    if (!Array.isArray(item.regressionTests) || item.regressionTests.length > 6) return fail("invalid_regression_tests", findingIndex, null, "regressionTests");
    if (!item.regressionTests.every(value => typeof value === "string" && value.length <= 300)) return fail("field_limit_exceeded", findingIndex, null, "regressionTests");
  }
  if (analysis.limitations.some(value => typeof value !== "string" || value.length > 300)) {
    return fail("field_limit_exceeded", null, null, "limitations");
  }
  return { valid: true, code: "ok", findingIndex: null, evidenceIndex: null, field: null };
}
