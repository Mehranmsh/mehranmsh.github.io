import test from "node:test";
import assert from "node:assert/strict";
import { runIntelligenceAI } from "./intelligence-ai-router.mjs";

test("router falls through from exhausted Workers AI budget to Groq", async () => {
  const previousFetch = globalThis.fetch;
  let workersCalls = 0;
  let groqCalls = 0;
  globalThis.fetch = async (url, options) => {
    groqCalls++;
    assert.equal(String(url), "https://api.groq.com/openai/v1/chat/completions");
    assert.match(options.headers.Authorization, /^Bearer /);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
    }), { status: 200 });
  };
  try {
    const result = await runIntelligenceAI({
      env: {
        AI: { async run() { workersCalls++; throw new Error("must not run"); } },
        GROQ_API_KEY: "g".repeat(40),
        MEHRAN_INTELLIGENCE_GROQ_MODEL: "test-model",
        MEHRAN_INTELLIGENCE_PROVIDER_ORDER: "cloudflare,groq"
      },
      messages: [{ role: "user", content: "test" }],
      reserveWorkersBudget: async () => ({ allowed: false }),
      workersBudgetCredits: 25
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "groq");
    assert.deepEqual(JSON.parse(result.text), { ok: true });
    assert.deepEqual(result.attemptedProviders, ["cloudflare", "groq"]);
    assert.equal(workersCalls, 0);
    assert.equal(groqCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("router uses Gemini response parsing and JSON mode when configured", async () => {
  const previousFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "{\"summary\":\"ok\"}" }] } }]
    }), { status: 200 });
  };
  try {
    const result = await runIntelligenceAI({
      env: {
        GEMINI_API_KEY: "k".repeat(40),
        MEHRAN_INTELLIGENCE_GEMINI_FREE_ONLY: "true",
        MEHRAN_INTELLIGENCE_GEMINI_MODEL: "gemini-test",
        MEHRAN_INTELLIGENCE_PROVIDER_ORDER: "gemini"
      },
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "analyze" }
      ],
      responseFormat: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "gemini");
    assert.match(captured.url, /gemini-test:generateContent$/);
    assert.equal(captured.body.generationConfig.responseMimeType, "application/json");
    assert.equal(captured.url.includes("key="), false);
    assert.equal(captured.body.systemInstruction.parts[0].text, "system prompt");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("router skips unconfigured providers without making outbound requests", async () => {
  const result = await runIntelligenceAI({
    env: { MEHRAN_INTELLIGENCE_PROVIDER_ORDER: "groq,gemini,openrouter" },
    messages: [{ role: "user", content: "test" }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "all_configured_providers_unavailable");
  assert.deepEqual(result.attemptedProviders, []);
});

test("router falls through on provider rate limits without exposing provider response bodies", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: "private provider detail" } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    const result = await runIntelligenceAI({
      env: {
        GROQ_API_KEY: "g".repeat(40),
        OPENROUTER_API_KEY: "o".repeat(40),
        MEHRAN_INTELLIGENCE_GROQ_MODEL: "groq-model",
        MEHRAN_INTELLIGENCE_OPENROUTER_MODEL: "openrouter-model:free",
        MEHRAN_INTELLIGENCE_PROVIDER_ORDER: "groq,openrouter"
      },
      messages: [{ role: "user", content: "test" }]
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "openrouter");
    assert.equal(result.failures, undefined);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
