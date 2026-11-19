const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length > 501) {
    throw new RangeError("Correlation input must contain at most 501 rows.");
  }
  return rows.map(row => {
    if (!row || typeof row.id !== "string" || !UUID.test(row.id) ||
        typeof row.finding_id !== "string" || !UUID.test(row.finding_id)) {
      throw new TypeError("Evidence and finding identities must be valid UUIDs.");
    }
    const sourceRef = typeof row.source_ref === "string" ? row.source_ref : "";
    if (!sourceRef || sourceRef.length > 200 || /[\u0000-\u001f\u007f]/.test(sourceRef)) {
      throw new TypeError("Evidence source reference metadata is invalid.");
    }
    const digest = row.content_digest == null ? null : String(row.content_digest);
    if (digest !== null && !SHA256.test(digest)) {
      throw new TypeError("Evidence digest metadata is invalid.");
    }
    return {
      evidenceId: row.id,
      findingId: row.finding_id,
      moduleId: String(row.module_id || ""),
      checkId: String(row.check_id || ""),
      kind: String(row.kind || "other"),
      sourceRef,
      contentDigest: digest
    };
  }).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

function collectGroups(rows, keyOf, typeOf, maxGroups) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const candidates = [];
  for (const [key, items] of grouped) {
    const findingIds = [...new Set(items.map(item => item.findingId))].sort();
    if (findingIds.length < 2) continue;
    candidates.push({
      correlationType: typeOf(items),
      key,
      findingCount: findingIds.length,
      referenceCount: items.length,
      items
    });
  }
  candidates.sort((a, b) =>
    a.correlationType.localeCompare(b.correlationType) ||
    b.findingCount - a.findingCount ||
    a.key.localeCompare(b.key)
  );
  return {
    totalGroups: candidates.length,
    groups: candidates.slice(0, maxGroups).map(group => ({
      correlationType: group.correlationType,
      correlationKey: group.key,
      findingCount: group.findingCount,
      referenceCount: group.referenceCount,
      referencesTruncated: group.items.length > 20,
      references: group.items.slice(0, 20)
    }))
  };
}

export function buildEvidenceCorrelation(inputRows, options = {}) {
  const maxRows = Number.isSafeInteger(options.maxRows) ? options.maxRows : 500;
  const maxGroups = Number.isSafeInteger(options.maxGroups) ? options.maxGroups : 50;
  if (maxRows < 1 || maxRows > 500 || maxGroups < 1 || maxGroups > 100) {
    throw new RangeError("Correlation bounds are outside the supported range.");
  }
  const scanLimitReached = inputRows.length > maxRows;
  const rows = normalizeRows(inputRows.slice(0, maxRows));
  const sharedDigests = collectGroups(
    rows,
    row => row.contentDigest,
    () => "shared_digest"
  , maxGroups);
  const sharedSources = collectGroups(
    rows,
    row => row.sourceRef,
    items => new Set(items.map(item => item.contentDigest ?? "no_digest")).size > 1
      ? "source_reference_digest_variance_candidate"
      : "shared_source_reference",
    maxGroups
  );
  const groups = [...sharedDigests.groups, ...sharedSources.groups]
    .sort((a, b) =>
      a.correlationType.localeCompare(b.correlationType) ||
      b.findingCount - a.findingCount ||
      a.correlationKey.localeCompare(b.correlationKey)
    );
  return {
    scanLimit: maxRows,
    evidenceReferencesScanned: rows.length,
    evidenceReferenceScanLimitReached: scanLimitReached,
    coverageComplete: !scanLimitReached,
    correlationGroupLimit: maxGroups,
    totalCorrelationGroups: sharedDigests.totalGroups + sharedSources.totalGroups,
    returnedCorrelationGroups: groups.slice(0, maxGroups),
    correlationGroupsTruncated: sharedDigests.totalGroups + sharedSources.totalGroups > maxGroups,
    assessment: "cross_finding_evidence_metadata_patterns_only",
    isContradictionVerdict: false,
    evidenceContentVerified: false,
    sourceReachabilityChecked: false,
    authenticityVerified: false,
    correctnessVerified: false,
    checkPassed: false,
    executionEnabled: false,
    operationPerformed: false,
    limitations: [
      "Correlations are generated only from owner-scoped evidence-reference metadata: source reference strings, stored digests, and finding identifiers.",
      "A shared digest or source reference does not prove that two findings are related or that evidence is valid.",
      "Different stored digests for the same source reference are a metadata-variance candidate, not proof of contradiction or tampering.",
      "No evidence content is opened, no external source is contacted, and no test or company operation is executed.",
      "When the scan limit is reached, additional references may be omitted; absence of a correlation in this result is not evidence that none exists."
    ]
  };
}
