const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeReference(item) {
  if (!item || typeof item.evidenceId !== "string" || !UUID.test(item.evidenceId)) {
    throw new TypeError("Correlation drift reference identity is invalid.");
  }
  return {
    evidenceId: item.evidenceId,
    findingId: String(item.findingId || ""),
    moduleId: String(item.moduleId || ""),
    checkId: String(item.checkId || ""),
    kind: String(item.kind || "other"),
    sourceRef: String(item.sourceRef || ""),
    contentDigest: item.contentDigest == null ? null : String(item.contentDigest)
  };
}

export function buildEvidenceCorrelationReviewDrift(previousSnapshot, currentReferences) {
  if (!previousSnapshot || !Array.isArray(previousSnapshot.references) ||
      previousSnapshot.references.length < 2 || previousSnapshot.references.length > 20) {
    throw new TypeError("Previous correlation review snapshot is invalid.");
  }
  if (!Array.isArray(currentReferences) || currentReferences.length > 20) {
    throw new RangeError("Current correlation references must contain at most 20 items.");
  }
  const previous = previousSnapshot.references.map(normalizeReference);
  const current = currentReferences.map(normalizeReference);
  const previousMap = new Map();
  const currentMap = new Map();
  for (const item of previous) {
    if (previousMap.has(item.evidenceId)) throw new TypeError("Previous snapshot contains duplicate evidence IDs.");
    previousMap.set(item.evidenceId, item);
  }
  for (const item of current) {
    if (currentMap.has(item.evidenceId)) throw new TypeError("Current references contain duplicate evidence IDs.");
    currentMap.set(item.evidenceId, item);
  }
  const unchanged = [];
  const changed = [];
  const added = [];
  const removed = [];
  for (const [id, item] of currentMap) {
    const old = previousMap.get(id);
    if (!old) added.push(item);
    else if (JSON.stringify(old) === JSON.stringify(item)) unchanged.push(item);
    else changed.push({ evidenceId: id, previous: old, current: item });
  }
  for (const [id, item] of previousMap) if (!currentMap.has(id)) removed.push(item);
  const sort = (a, b) => String(a.evidenceId).localeCompare(String(b.evidenceId));
  unchanged.sort(sort); added.sort(sort); removed.sort(sort); changed.sort(sort);
  return {
    unchanged, changed, added, removed,
    counts: { unchanged: unchanged.length, changed: changed.length, added: added.length, removed: removed.length },
    previousReferenceCount: previous.length,
    currentReferenceCount: current.length,
    driftDetected: changed.length + added.length + removed.length > 0,
    isRelationshipVerdict: false,
    evidenceContentVerified: false,
    sourceReachabilityChecked: false,
    checkPassed: false,
    executionEnabled: false,
    operationPerformed: false
  };
}
