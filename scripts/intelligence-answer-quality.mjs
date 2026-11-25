const MAX_INTELLIGENCE_ANSWER_CHARS = 12000;

export function normalizeIntelligenceAnswer(value) {
  if (typeof value !== "string") return { ok: false, text: "", reason: "not_text" };
  const text = value
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!text) return { ok: false, text: "", reason: "empty" };
  if (text.length > MAX_INTELLIGENCE_ANSWER_CHARS) return { ok: false, text: "", reason: "too_long" };
  return { ok: true, text, reason: null };
}

export { MAX_INTELLIGENCE_ANSWER_CHARS };
