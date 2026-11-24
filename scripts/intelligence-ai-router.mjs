const DEFAULT_PROVIDER_ORDER = Object.freeze(["cloudflare", "groq", "gemini", "openrouter"]);
const MAX_RESPONSE_BYTES = 96 * 1024;

function bounded(value, max = 240) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function parseProviderOrder(value) {
  if (typeof value !== "string" || !value.trim()) return [...DEFAULT_PROVIDER_ORDER];
  const requested = value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  const valid = requested.filter((item, index) =>
    DEFAULT_PROVIDER_ORDER.includes(item) && requested.indexOf(item) === index
  );
  return valid.length ? valid : [...DEFAULT_PROVIDER_ORDER];
}

function extractText(provider, payload) {
  if (provider === "cloudflare") {
    const value = payload?.response ?? payload?.result?.response ?? payload?.output_text ?? "";
    return typeof value === "string" ? value : value && typeof value === "object" ? JSON.stringify(value) : "";
  }
  if (provider === "gemini") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) return parts.map(part => typeof part?.text === "string" ? part.text : "").join("");
    return "";
  }
  const message = payload?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map(part => typeof part?.text === "string" ? part.text : "").join("");
  }
  return typeof payload?.output_text === "string" ? payload.output_text : "";
}

function safeProviderError(provider, status, code) {
  return {
    provider,
    status: Number.isInteger(status) ? status : null,
    code: bounded(code || (status === 429 ? "rate_limited" : "provider_unavailable"), 80)
  };
}

async function readJsonBounded(response) {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("provider_response_too_large");
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw new Error("provider_response_too_large");
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw new Error("provider_invalid_json"); }
}

function buildRequest(provider, env, input) {
  const modelNames = {
    groq: bounded(env.MEHRAN_INTELLIGENCE_GROQ_MODEL, 120),
    gemini: bounded(env.MEHRAN_INTELLIGENCE_GEMINI_MODEL, 120),
    openrouter: bounded(env.MEHRAN_INTELLIGENCE_OPENROUTER_MODEL, 160)
  };
  if (provider === "cloudflare") {
    const model = bounded(env.MEHRAN_INTELLIGENCE_MODEL, 120) || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    if (!env.AI || typeof env.AI.run !== "function") return null;
    return { model, run: () => env.AI.run(model, {
      messages: input.messages,
      ...(input.responseFormat ? { response_format: { type: "json_object" } } : {}),
      temperature: input.temperature ?? 0,
      max_tokens: input.maxTokens ?? 1600
    }) };
  }
  const model = modelNames[provider];
  if (!model) return null;
  if (provider === "groq") {
    const key = env.GROQ_API_KEY;
    if (typeof key !== "string" || key.length < 20) return null;
    return {
      model,
      run: () => fetchProvider("https://api.groq.com/openai/v1/chat/completions", key, {
        model, messages: input.messages, max_tokens: input.maxTokens ?? 1600,
        temperature: input.temperature ?? 0,
        ...(input.responseFormat ? { response_format: { type: "json_object" } } : {})
      })
    };
  }
  if (provider === "gemini") {
    const key = env.GEMINI_API_KEY;
    if (typeof key !== "string" || key.length < 20) return null;
    const system = input.messages.find(message => message.role === "system")?.content || "";
    const contents = input.messages.filter(message => message.role !== "system").map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: String(message.content ?? "") }]
    }));
    return {
      model,
      run: () => fetchProvider(
        "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) +
          ":generateContent?key=" + encodeURIComponent(key),
        "",
        {
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents,
          generationConfig: {
            maxOutputTokens: input.maxTokens ?? 1600,
            temperature: input.temperature ?? 0,
            ...(input.responseFormat ? { responseMimeType: "application/json" } : {})
          }
        },
        true
      )
    };
  }
  if (provider === "openrouter") {
    const key = env.OPENROUTER_API_KEY;
    if (typeof key !== "string" || key.length < 20) return null;
    return {
      model,
      run: () => fetchProvider("https://openrouter.ai/api/v1/chat/completions", key, {
        model, messages: input.messages, max_tokens: input.maxTokens ?? 1600,
        temperature: input.temperature ?? 0,
        ...(input.responseFormat ? { response_format: { type: "json_object" } } : {})
      })
    };
  }
  return null;
}

async function fetchProvider(url, key, payload, isGemini = false) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key && !isGemini ? { Authorization: "Bearer " + key } : {})
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35000)
  });
  const data = await readJsonBounded(response);
  if (!response.ok) {
    const providerCode = data?.error?.code || data?.error?.status || data?.error?.type || "http_error";
    const error = new Error("provider_http_" + response.status);
    error.providerStatus = response.status;
    error.providerCode = bounded(providerCode, 80);
    throw error;
  }
  return data;
}

/**
 * Try configured inference providers in order. Only provider availability and
 * quota failures are treated as failover conditions; all output still requires
 * the caller's independent schema/evidence validation.
 */
export async function runIntelligenceAI({
  env,
  messages,
  operation = "inference",
  maxTokens = 1600,
  temperature = 0,
  responseFormat = true,
  workersBudgetCredits = 0,
  reserveWorkersBudget,
  releaseWorkersBudget
} = {}) {
  if (!env || !Array.isArray(messages) || !messages.length) {
    return { ok: false, code: "invalid_request", attemptedProviders: [] };
  }
  const attemptedProviders = [];
  const failures = [];
  for (const provider of parseProviderOrder(env.MEHRAN_INTELLIGENCE_PROVIDER_ORDER)) {
    const request = buildRequest(provider, env, { messages, maxTokens, temperature, responseFormat });
    if (!request) continue;
    let reservation = null;
    if (provider === "cloudflare" && workersBudgetCredits > 0) {
      try {
        reservation = await reserveWorkersBudget?.(workersBudgetCredits);
      } catch {
        failures.push(safeProviderError(provider, null, "budget_guard_failed"));
        attemptedProviders.push(provider);
        continue;
      }
      if (!reservation?.allowed) {
        failures.push(safeProviderError(provider, 429, "workers_ai_budget_exhausted"));
        attemptedProviders.push(provider);
        continue;
      }
    }
    attemptedProviders.push(provider);
    const startedAt = Date.now();
    try {
      const payload = await request.run();
      if (provider === "cloudflare" && Array.isArray(payload?.errors) && payload.errors.length) {
        const error = new Error("workers_ai_model_error");
        error.providerStatus = 503;
        error.providerCode = "workers_ai_model_error";
        throw error;
      }
      const text = extractText(provider, payload);
      if (!text || text.length > 24000) throw new Error("provider_empty_or_oversized_output");
      return {
        ok: true, provider, model: request.model, text, raw: payload,
        elapsedMs: Date.now() - startedAt, attemptedProviders
      };
    } catch (error) {
      if (provider === "cloudflare" && reservation) {
        try { await releaseWorkersBudget?.(reservation); } catch {}
      }
      const status = Number.isInteger(error?.providerStatus) ? error.providerStatus : null;
      const code = error?.providerCode || error?.message || "provider_failure";
      failures.push(safeProviderError(provider, status, code));
    }
  }
  return {
    ok: false,
    code: "all_configured_providers_unavailable",
    operation: bounded(operation, 80),
    attemptedProviders,
    failures
  };
}

export const INTELLIGENCE_AI_PROVIDER_ORDER = DEFAULT_PROVIDER_ORDER;
