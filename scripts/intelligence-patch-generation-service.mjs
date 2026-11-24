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

export function normalizeGeneratedDiff(diff) {
  if (typeof diff !== "string" || /\r(?!\n)/.test(diff)) return null;
  const normalized = diff.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : normalized + "\n";
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
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "MEHRAN-INTELLIGENCE-Patch-Generator"
  };
  const sources = [
    {
      url: `https://api.github.com/repos/${REPOSITORY}/commits/main`,
      read: async response => (await response.json())?.sha
    },
    {
      url: `https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`,
      read: async response => (await response.json())?.object?.sha
    },
    {
      url: `https://github.com/${REPOSITORY}/commits/main.atom`,
      headers: {
        "Accept": "application/atom+xml, application/xml, text/xml",
        "User-Agent": "MEHRAN-INTELLIGENCE-Patch-Generator"
      },
      read: async response => {
        const body = await response.text();
        return body.match(/Grit::Commit\/([a-f0-9]{40})/)?.[1];
      }
    }
  ];

  // Query independent read-only GitHub ref endpoints concurrently. This avoids
  // serial timeout stacking while retaining exact-SHA verification and fail-closed
  // behavior when sources disagree or none can establish the current ref.
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = await Promise.all(sources.map(async source => {
      try {
        const response = await fetchImpl(source.url, {
          headers: source.headers || headers,
          signal: AbortSignal.timeout(6000)
        });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch {}
          return null;
        }
        const sha = await source.read(response);
        return typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
      } catch {
        return null;
      }
    }));
    const unique = [...new Set(observed.filter(Boolean))];
    if (unique.length === 1) return { ok: true, sha: unique[0] };
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
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
export function canonicalizeAppendOnlyHunkHeader(diff, sourceLineCount) {
  if (typeof diff !== "string" || !Number.isInteger(sourceLineCount) || sourceLineCount < 1) return diff;
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  const target = "--- a/scripts/intelligence-capabilities.test.mjs";
  const replacement = "+++ b/scripts/intelligence-capabilities.test.mjs";
  if (lines.length < 4 || lines[0] !== target || lines[1] !== replacement) return diff;
  const payload = lines.slice(3);
  // Model output commonly includes unchanged context lines even though this
  // capability is additions-only. Context is safe to discard; deletions,
  // metadata, blank payload lines, and extra file headers remain a hard stop.
  if (!payload.length || payload.some(line =>
    line.startsWith("-") || line.startsWith("+++") || line.length === 0 ||
    (!line.startsWith("+") && !line.startsWith(" "))
  )) return diff;
  const additions = payload.filter(line => line.startsWith("+"));
  if (!additions.length) return diff;
  lines.splice(3, lines.length - 3, ...additions);
  lines[2] = `@@ -${sourceLineCount},0 +${sourceLineCount + 1},${additions.length} @@`;
  return lines.join("\n") + "\n";
}

export function inspectGeneratedDiffShape(diff) {
  if (typeof diff !== "string") return { reason: "not_string" };
  const lines = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const exactPath = lines[0] === "--- a/scripts/intelligence-capabilities.test.mjs" &&
    lines[1] === "+++ b/scripts/intelligence-capabilities.test.mjs";
  const payload = lines.slice(3);
  const additions = payload.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = payload.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
  const contexts = payload.filter(line => line.startsWith(" ")).length;
  const blank = payload.filter(line => line.length === 0).length;
  const metadata = payload.filter(line => /^(?:diff --git |index |\\\\ No newline)/.test(line)).length;
  let reason = "eligible_for_header_repair";
  if (!exactPath) reason = "path_mismatch";
  else if (lines.length < 4) reason = "missing_hunk_or_payload";
  else if (payload.some(line => line.startsWith("+++"))) reason = "extra_file_header";
  else if (deletions || contexts || blank || metadata || payload.some(line => !line.startsWith("+"))) {
    reason = "contains_non_addition";
  }
  return {
    reason,
    lineCount: lines.length,
    exactPath,
    thirdLineLooksLikeHunk: /^@@ /.test(lines[2] || ""),
    additions,
    deletions,
    contexts,
    blankPayloadLines: blank,
    metadataLines: metadata
  };
}

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
      Object.keys(generated).sort().join(",") !== "summary,testLines" ||
      typeof generated.summary !== "string" || !Array.isArray(generated.testLines) ||
      generated.testLines.length < 1 || generated.testLines.length > 60 ||
      generated.testLines.some(line => typeof line !== "string" || /[\r\n]/.test(line) || new TextEncoder().encode(line).byteLength > 500) ||
      new TextEncoder().encode(generated.testLines.join("\n")).byteLength > 7000) {
    return fail("model_output_schema_invalid");
  }

  const finalMainCommit = await fetchCurrentMainCommit(fetchImpl);
  if (!finalMainCommit.ok) return fail("main_commit_recheck_failed");
  if (finalMainCommit.sha !== baseSha) return fail("stale_base_sha");

  const sourceLineCount = source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
  // The model returns source lines only. Build every diff header and prefix
  // deterministically so model formatting can never create malformed hunks.
  const canonicalDiff = [
    `--- a/${TARGET_PATH}`,
    `+++ b/${TARGET_PATH}`,
    `@@ -${sourceLineCount},0 +${sourceLineCount + 1},${generated.testLines.length} @@`,
    ...generated.testLines.map(line => "+" + line),
    ""
  ].join("\n");
  const validated = validateGeneratedPatch({
    baseSha,
    sourceLineCount,
    summary: generated.summary,
    diff: canonicalDiff
  });
  if (!validated.ok) {
    return {
      ...validated,
      diagnostic: {
        stage: "generated_diff_validation",
        shape: inspectGeneratedDiffShape(canonicalDiff),
        canonicalizerApplied: false
      }
    };
  }

  let artifact;
  try {
    artifact = await createPatchArtifactRecord({
      proposalId: proposalId(),
      createdAt: now(),
      baseSha,
      targetPaths: [TARGET_PATH],
      summary: generated.summary,
      diff: canonicalDiff
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
