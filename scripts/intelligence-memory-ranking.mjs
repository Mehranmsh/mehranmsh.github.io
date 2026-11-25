const MEMORY_TYPES = new Set(["episodic", "semantic", "procedural", "decision", "working", "evaluation"]);
const BLOCKED_SENSITIVITY = new Set(["secret", "credential", "wallet", "financial", "private_social"]);
const DEFAULT_LIMITS = Object.freeze({ maxItems: 12, maxChars: 6000, maxItemChars: 1200 });

function normalizeMemoryType(value) {
  const type = String(value || "");
  if (MEMORY_TYPES.has(type)) return type;
  const legacy = {
    architecture: "semantic", constraint: "decision", goal: "semantic",
    preference: "decision", progress: "episodic", workflow: "procedural", project: "semantic"
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

function normalizeSearchText(value) {
  return String(value || "").toLocaleLowerCase().normalize("NFKC")
    .replace(/[\u064a\u0649]/g, "ی").replace(/[\u0643]/g, "ک")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[\u200c\u200d]/g, " ").replace(/\s+/g, " ").trim();
}

function queryTokens(value) {
  return new Set(normalizeSearchText(value).split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 1).slice(0, 32));
}

function containsSensitivePersonalData(value) {
  const text = String(value || "").toLowerCase();
  return /(?:\b(?:password|passphrase|api[_ -]?key|private[_ -]?key|seed phrase|recovery phrase|mnemonic)\b|\b(?:wallet|bank|card)\s+(?:address|balance|number|details|credentials)\b|\b(?:my|personal)\s+(?:wallet|bank|account|balance|transactions?)\b|\b(?:credit|debit)\s+card\b)/i.test(text);
}

function relevanceScore(record, query, normalizedQuery) {
  if (!query.size) return 0;
  const searchableText = [record.memory_key, record.memory_type, record.content].join(" ");
  const content = queryTokens(searchableText);
  let matched = 0;
  for (const token of query) if (content.has(token)) matched++;
  const tokenCoverage = matched / query.size;
  const phraseMatch = normalizedQuery.length > 3 &&
    normalizeSearchText(record.content).includes(normalizedQuery);
  // Keep the phrase bonus below saturation so it can distinguish exact order.
  return (tokenCoverage * 0.85) + (phraseMatch ? 0.15 : 0);
}

/**
 * Resolve only owner-authored, explicit memory relations.
 * A newer record may supersede an older key; conflicts remain visible.
 */
export function analyzeMemoryRelations(records) {
  if (!Array.isArray(records)) return { supersededKeys: new Set(), conflictedKeys: new Set() };
  const byOwnerAndKey = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const owner = typeof record.owner_uid === "string" ? record.owner_uid.trim() : "";
    const key = typeof record.memory_key === "string" ? record.memory_key.trim() : "";
    if (!owner || !key) continue;
    byOwnerAndKey.set(JSON.stringify([owner, key]), record);
  }

  const supersededKeys = new Set();
  const conflictedKeys = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const owner = typeof record.owner_uid === "string" ? record.owner_uid.trim() : "";
    const key = typeof record.memory_key === "string" ? record.memory_key.trim() : "";
    if (!owner || !key || record.relation_confirmed !== true || record.relation_confirmed_by !== owner) continue;
    const updatedAt = timestamp(record.updated_at);
    const supersedes = [record.supersedes_key, record.supersedes_memory_key]
      .filter(value => typeof value === "string" && value.trim())
      .map(value => value.trim());
    for (const oldKey of new Set(supersedes)) {
      const prior = byOwnerAndKey.get(JSON.stringify([owner, oldKey]));
      const priorAt = timestamp(prior?.updated_at);
      if (prior && oldKey !== key && updatedAt !== null && priorAt !== null && updatedAt > priorAt) {
        supersededKeys.add(JSON.stringify([owner, oldKey]));
      }
    }
    const references = Array.isArray(record.conflicts_with)
      ? record.conflicts_with
      : (typeof record.conflicts_with === "string" ? [record.conflicts_with] : []);
    for (const otherKey of references) {
      if (typeof otherKey !== "string" || !otherKey.trim()) continue;
      const other = byOwnerAndKey.get(JSON.stringify([owner, otherKey.trim()]));
      if (other && otherKey.trim() !== key) {
        conflictedKeys.add(JSON.stringify([owner, key]));
        conflictedKeys.add(JSON.stringify([owner, otherKey.trim()]));
      }
    }
  }
  return { supersededKeys, conflictedKeys };
}

/** Selects bounded, owner-scoped memory context without inference or I/O. */
export function selectMemoryContext(records, options = {}) {
  const ownerUid = typeof options.ownerUid === "string" ? options.ownerUid.trim() : "";
  const now = timestamp(options.now) ?? Date.now();
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? Math.min(options.maxItems, 50) : DEFAULT_LIMITS.maxItems;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? Math.min(options.maxChars, 20_000) : DEFAULT_LIMITS.maxChars;
  const maxItemChars = Number.isInteger(options.maxItemChars) && options.maxItemChars > 0 ? Math.min(options.maxItemChars, 4000) : DEFAULT_LIMITS.maxItemChars;
  const normalizedQuery = normalizeSearchText(options.query);
  const query = queryTokens(normalizedQuery);
  if (!ownerUid || !Array.isArray(records)) return [];

  const candidates = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (record.owner_uid !== ownerUid || record.deleted_at || record.superseded_by ||\n        relations.supersededKeys.has(JSON.stringify([ownerUid, String(record.memory_key || "").trim()]))) continue;
    if (record.status && record.status !== "active") continue;
    if (BLOCKED_SENSITIVITY.has(String(record.sensitivity || "").toLowerCase())) continue;
    if (containsSensitivePersonalData(record.content) || containsSensitivePersonalData(record.memory_key)) continue;
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
    const trust = record.source === "project_baseline" || record.source === "owner_confirmed" ? 1 : finiteUnit(record.source_trust, 0.5);
    const recency = recencyScore(updatedAt, now);
    const baseScore = (importance * 0.35) + (confidence * 0.25) + (trust * 0.20) + (recency * 0.20);
    const relevance = relevanceScore({ ...record, memory_type: memoryType }, query, normalizedQuery);
    const score = query.size ? (baseScore * 0.75) + (relevance * 0.25) : baseScore;
    candidates.push({
      memory_key: key, memory_type: memoryType, content: content.slice(0, maxItemChars),
      source: provenance.slice(0, 120), confidence, importance, relevance,\n      relation_status: relations.conflictedKeys.has(JSON.stringify([ownerUid, key])) ? "conflict" : "current",
      updated_at: new Date(updatedAt).toISOString(), score
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at) || a.memory_key.localeCompare(b.memory_key));
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
