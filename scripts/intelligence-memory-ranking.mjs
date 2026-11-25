const MEMORY_TYPES = new Set(["episodic", "semantic", "procedural", "decision", "working", "evaluation"]);
const BLOCKED_SENSITIVITY = new Set(["secret", "credential", "wallet", "financial", "private_social"]);
const DEFAULT_LIMITS = Object.freeze({ maxItems: 12, maxChars: 6000, maxItemChars: 1200 });

function normalizeMemoryType(value) {
  const type = String(value || "");
  if (MEMORY_TYPES.has(type)) return type;
  const legacy = {
    architecture: "semantic",
    constraint: "decision",
    goal: "semantic",
    preference: "decision",
    workflow: "procedural",
    project: "semantic"
  };
  return legacy[type] || "";
}

function finiteUnit(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recencyScore(updatedAt, now) {
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000);
  return Math.exp(-ageDays / 45);
}

/**
 * Selects a bounded, owner-scoped memory context without inference or I/O.
 * Records lacking provenance, valid timestamps, or an allowed type are excluded.
 */
export function selectMemoryContext(records, options = {}) {
  const ownerUid = typeof options.ownerUid === "string" ? options.ownerUid.trim() : "";
  const now = timestamp(options.now) ?? Date.now();
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? Math.min(options.maxItems, 50) : DEFAULT_LIMITS.maxItems;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? Math.min(options.maxChars, 20_000) : DEFAULT_LIMITS.maxChars;
  const maxItemChars = Number.isInteger(options.maxItemChars) && options.maxItemChars > 0
    ? Math.min(options.maxItemChars, 4000) : DEFAULT_LIMITS.maxItemChars;

  if (!ownerUid || !Array.isArray(records)) return [];

  const candidates = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (record.owner_uid !== ownerUid) continue;
    if (record.deleted_at || record.superseded_by) continue;
    if (record.status && record.status !== "active") continue;
    if (BLOCKED_SENSITIVITY.has(String(record.sensitivity || "").toLowerCase())) continue;
    const memoryType = normalizeMemoryType(record.memory_type || record.category);
    if (!memoryType) continue;

    const key = typeof record.memory_key === "string" ? record.memory_key.trim() : "";
    const content = typeof record.content === "string" ? record.content.trim() : "";
    const provenance = typeof record.source === "string" ? record.source.trim() : "";
    const updatedAt = timestamp(record.updated_at);
    if (!key || !content || !provenance || updatedAt === null || updatedAt > now) continue;

    const expiresAt = record.expires_at ? timestamp(record.expires_at) : null;
    if (record.expires_at && (expiresAt === null || expiresAt <= now)) continue;

    const rawImportance = Number(record.importance);
    const importance = finiteUnit(Number.isFinite(rawImportance) && rawImportance > 1 ? rawImportance / 5 : rawImportance);
    const confidence = finiteUnit(record.confidence, 0.5);
    const trust = record.source === "project_baseline" || record.source === "owner_confirmed"
      ? 1 : finiteUnit(record.source_trust, 0.5);
    const recency = recencyScore(updatedAt, now);
    const score = (importance * 0.35) + (confidence * 0.25) + (trust * 0.20) + (recency * 0.20);

    candidates.push({
      memory_key: key,
      memory_type: memoryType,
      content: content.slice(0, maxItemChars),
      source: provenance.slice(0, 120),
      confidence,
      importance,
      updated_at: new Date(updatedAt).toISOString(),
      score
    });
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    b.updated_at.localeCompare(a.updated_at) ||
    a.memory_key.localeCompare(b.memory_key)
  );

  const selected = [];
  let usedChars = 0;
  for (const item of candidates) {
    if (selected.length >= maxItems) break;
    const cost = item.memory_key.length + item.memory_type.length + item.content.length + item.source.length;
    if (usedChars + cost > maxChars) continue;
    selected.push(item);
    usedChars += cost;
  }
  return selected;
}
