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

  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "MEHRAN-INTELLIGENCE-Patch-Generator"
  };
  let mainResponse;
  try {
    mainResponse = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/commits/main`, { headers });
  } catch {
    return fail("main_commit_lookup_failed");
  }
  if (!mainResponse.ok) return fail("main_commit_lookup_failed");
  const mainCommit = await mainResponse.json();
  if (mainCommit?.sha !== baseSha) return fail("stale_base_sha");

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
  const source = await sourceResponse.text();
  if (!source.trim() || new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    return fail("source_size_invalid");
  }

  const prompt = buildPatchGenerationPrompt({ baseSha, objective, source });
  if (!prompt.ok) return prompt;

  let budget;
  try {
    budget = await reserveBudget(250);
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
    generated = JSON.parse(raw);
  } catch {
    return fail("model_output_not_json");
  }
  if (!generated || typeof generated !== "object" || Array.isArray(generated) ||
      Object.keys(generated).sort().join(",") !== "diff,summary" ||
      typeof generated.summary !== "string" || typeof generated.diff !== "string") {
    return fail("model_output_schema_invalid");
  }

  let finalMainResponse;
  try {
    finalMainResponse = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/commits/main`, { headers });
  } catch {
    return fail("main_commit_recheck_failed");
  }
  if (!finalMainResponse.ok) return fail("main_commit_recheck_failed");
  const finalMainCommit = await finalMainResponse.json();
  if (finalMainCommit?.sha !== baseSha) return fail("stale_base_sha");

  const sourceLineCount = source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
  const validated = validateGeneratedPatch({
    baseSha,
    sourceLineCount,
    summary: generated.summary,
    diff: generated.diff
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
      diff: generated.diff
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
  reservedCreditsPerAttempt: 250,
  requiresExactCurrentMainSha: true,
  storesArtifact: false,
  appliesPatch: false,
  createsPullRequest: false
});
