import { buildEvidenceSnapshot } from "./intelligence-owner-evidence-review.mjs";

function normalizePreviousSnapshot(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError("Previous evidence snapshot must be an array of at most 100 references.");
  }
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)) {
      throw new TypeError("Previous evidence reference identity is invalid.");
    }
    if (seen.has(item.id)) throw new TypeError("Previous evidence snapshot contains duplicate IDs.");
    seen.add(item.id);
    if (typeof item.kind !== "string" || !item.kind || item.kind.length > 80) {
      throw new TypeError("Previous evidence kind metadata is invalid.");
    }
    if (item.contentDigest !== null && item.contentDigest !== undefined &&
        (typeof item.contentDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.contentDigest))) {
      throw new TypeError("Previous evidence digest metadata is invalid.");
    }
    if (item.observedAt !== null && item.observedAt !== undefined &&
        !Number.isSafeInteger(item.observedAt)) {
      throw new TypeError("Previous evidence observation time is invalid.");
    }
    return {
      id: item.id,
      kind: item.kind,
      contentDigest: item.contentDigest ?? null,
      observedAt: item.observedAt ?? null
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function buildEvidenceDrift(previousSnapshot, currentRows) {
  const current = buildEvidenceSnapshot(currentRows).evidenceRefs;
  if (previousSnapshot === null || previousSnapshot === undefined) {
    return {
      baselineAvailable: false,
      baselineEvidenceCount: 0,
      currentEvidenceCount: current.length,
      unchanged: [],
      changed: [],
      added: [],
      removed: [],
      driftDetected: false,
      driftAssessmentAvailable: false,
      limitations: ["No previous owner review snapshot exists for this finding; no drift comparison can be made."]
    };
  }
  const previous = normalizePreviousSnapshot(previousSnapshot);
  const before = new Map(previous.map(item => [item.id, item]));
  const after = new Map(current.map(item => [item.id, item]));
  const unchanged = [];
  const changed = [];
  const added = [];
  const removed = [];
  for (const [id, now] of after) {
    const old = before.get(id);
    if (!old) {
      added.push(now);
      continue;
    }
    if (old.kind === now.kind && old.contentDigest === now.contentDigest && old.observedAt === now.observedAt) {
      unchanged.push(now);
    } else {
      changed.push({ id, previous: old, current: now });
    }
  }
  for (const [id, old] of before) if (!after.has(id)) removed.push(old);
  const sort = items => items.sort((a, b) => (a.id || "").localeCompare(b.id || ""));
  sort(unchanged); sort(changed); sort(added); sort(removed);
  return {
    baselineAvailable: true,
    baselineEvidenceCount: previous.length,
    currentEvidenceCount: current.length,
    unchanged,
    changed,
    added,
    removed,
    driftDetected: changed.length + added.length + removed.length > 0,
    driftAssessmentAvailable: true,
    limitations: [
      "This compares stored evidence-reference metadata with the latest owner review snapshot only.",
      "No evidence content, source reachability, authenticity, relevance, or correctness was checked.",
      "A metadata difference is not a security finding, risk verdict, or failed check."
    ]
  };
}
