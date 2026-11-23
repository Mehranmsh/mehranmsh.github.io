import { buildPatchGenerationPrompt, validateGeneratedPatch } from "./intelligence-patch-generation.mjs";
import { createPatchArtifactRecord } from "./intelligence-patch-artifact.mjs";

const REPOSITORY = "Mehranmsh/mehranmsh.github.io";
const TARGET_PATH = "scripts/intelligence-capabilities.test.mjs";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_SOURCE_BYTES = 128 * 1024;

function fail(code) {
  return { ok: false, code };
}

function extractModelText(result) {
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.output_text === "string") return result.output_text;
  return "";
}

function extractJsonObject(raw) {
  if (typeof raw !== "string") return "";
  const text = raw.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "").trim();
  if (!text) return "";
  if (text.startsWith("{") && text.endsWith("}")) return text;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (character === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, index + 1);
    }
  }
  return "";
}

async function fetchCurrentMainCommit(fetchImpl) {
  const url = `https://api.github.com/repos/${REPOSITORY}/commits/main`;
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "MEHRAN-INTELLIGENCE-Patch-Generator"
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(8000)
      });
      if (response.ok) {
        const payload = await response.json();
        if (typeof payload?.sha === "string" && /^[a-f0-9]{40}$/.test(payload.sha)) {
          return { ok: true, sha: payload.sha };
        }
        break;
      }
      if (response.status < 500 && response.status !== 429) break;
      try { await response.body?.cancel(); } catch {}
    } catch {
      // Try the bounded alternate public ref source below after the API retries.
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }

  // GitHub's REST API can intermittently return 502 from Workers even while
  // the public repository is healthy. The Atom feed is an independent,
  // read-only source; accept only a syntactically valid commit SHA.
  try {
    const feed = await fetchImpl(`https://github.com/${REPOSITORY}/commits/main.atom`, {
      headers: {
        "Accept": "application/atom+xml, application/xml, text/xml",
        "User-Agent": "MEHRAN-INTELLIGENCE-Patch-Generator"
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!feed.ok) return fail("main_commit_lookup_failed");
    const body = await feed.text();
    const match = body.match(/Grit::Commit\/([a-f0-9]{40})/);
    if (match) return { ok: true, sha: match[1] };
  } catch {
    // Fail closed if neither independent source can establish the current ref.
  }
  return fail("main_commit_lookup_failed");
}

async function readBoundedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try { await reader.cancel(); } catch {}
    return null;
  }
}

/**
 * Generate one bounded proposal from the exact current main commit.
 * The returned artifact is validated but not stored or applied.
 */
export async function generatePatchArtifact({
  env,
  baseSha,
  objective,
  reserveBudget,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  proposalId = () => crypto.randomUUID()
} = {}) {
  if (!env || !env.AI || typeof env.AI.run !== "function") return fail("ai_unavailable");
  if (typeof reserveBudget !== "function") return fail("budget_guard_unavailable");
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) return fail("invalid_base_sha");

  const mainCommit = await fetchCurrentMainCommit(fetchImpl);
  if (!mainCommit.ok) return mainCommit;
  if (mainCommit.sha !== baseSha) return fail("stale_base_sha");

  let sourceResponse;
  try {
    sourceResponse = await fetchImpl(
      `https://raw.githubusercontent.com/${REPOSITORY}/${baseSha}/${TARGET_PATH}`,
      { headers: { "Accept": "text/plain" } }
    );
  } catch {
    return fail("source_fetch_failed");
  }
  if (!sourceResponse.ok) return fail("source_fetch_failed");
  const source = await readBoundedText(sourceResponse, MAX_SOURCE_BYTES);
  if (source === null || !source.trim()) return fail("source_size_invalid");

  const prompt = buildPatchGenerationPrompt({ baseSha, objective, source });
  if (!prompt.ok) return prompt;

  let budget;
  try {
    budget = await reserveBudget(100);
  } catch {
    return fail("ai_budget_guard_failed");
  }
  if (!budget?.allowed) return fail("ai_budget_exhausted");

  let modelResult;
  try {
    modelResult = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      max_tokens: 2200,
      temperature: 0.1
    });
  } catch {
    return fail("model_request_failed");
  }
  if (Array.isArray(modelResult?.errors) && modelResult.errors.length) {
    return fail("model_returned_error");
  }

  const raw = extractModelText(modelResult);
  if (!raw || raw.length > 24000) return fail("model_output_invalid");
  let generated;
  try {
    generated = JSON.parse(extractJsonObject(raw));
  } catch {
    return fail("model_output_not_json");
  }
  if (!generated || typeof generated !== "object" || Array.isArray(generated) ||
      Object.keys(generated).sort().join(",") !== "diff,summary" ||
      typeof generated.summary !== "string" || typeof generated.diff !== "string") {
    return fail("model_output_schema_invalid");
  }

  const finalMainCommit = await fetchCurrentMainCommit(fetchImpl);
  if (!finalMainCommit.ok) return fail("main_commit_recheck_failed");
  if (finalMainCommit.sha !== baseSha) return fail("stale_base_sha");

  const sourceLineCount = source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
  // Canonicalize harmless transport formatting from model output before strict validation.
  // Preserve patch content; reject lone carriage returns and malformed no-newline markers.
  if (/\r(?!\n)/.test(generated.diff)) return fail("model_diff_encoding_invalid");
  const canonicalDiff = generated.diff.replace(/\r\n/g, "\n");
  const normalizedDiff = canonicalDiff.endsWith("\n") ? canonicalDiff : canonicalDiff + "\n";
  const validated = validateGeneratedPatch({
    baseSha,
    sourceLineCount,
    summary: generated.summary,
    diff: normalizedDiff
  });
  if (!validated.ok) return validated;

  let artifact;
  try {
    artifact = await createPatchArtifactRecord({
      proposalId: proposalId(),
      createdAt: now(),
      baseSha,
      targetPaths: [TARGET_PATH],
      summary: generated.summary,
      diff: normalizedDiff
    });
  } catch {
    return fail("artifact_creation_failed");
  }
  if (!artifact?.ok) return artifact;

  return {
    ok: true,
    artifact: artifact.artifact,
    artifactSha256: artifact.artifactSha256,
    validation: validated,
    model: MODEL,
    mode: "generate_validate_only"
  };
}

export const PATCH_GENERATION_SERVICE_POLICY = Object.freeze({
  repository: REPOSITORY,
  targetPath: TARGET_PATH,
  model: MODEL,
  maxSourceBytes: MAX_SOURCE_BYTES,
  reservedCreditsPerAttempt: 100,
  requiresExactCurrentMainSha: true,
  storesArtifact: false,
  appliesPatch: false,
  createsPullRequest: false
});
