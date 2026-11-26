import { validatePatchProposal } from "./intelligence-patch-policy.mjs";

/**
 * Apply only the currently approved append-only test patch to an in-memory
 * source string. This helper never reads or writes the filesystem.
 */
export function applyValidatedPatchInMemory(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "invalid_input" };
  const { baseSha, expectedBaseSha, source, targetPath, summary, diff } = input;
  if (typeof expectedBaseSha !== "string" || !/^[a-f0-9]{40}$/.test(expectedBaseSha) ||
      baseSha !== expectedBaseSha) return { ok: false, code: "stale_base_sha" };
  if (typeof source !== "string" || !source.endsWith("\n") ||
      new TextEncoder().encode(source).byteLength > 128 * 1024) return { ok: false, code: "invalid_source" };
  const validated = validatePatchProposal({ baseSha, targetPaths: [targetPath], summary, diff });
  if (!validated.ok) return validated;
  if (validated.deletions !== 0 || validated.hunkCount !== 1) {
    return { ok: false, code: "patch_not_append_only" };
  }

  const lines = diff.slice(0, -1).split("\n");
  const sourceLines = source.slice(0, -1).split("\n");
  if (sourceLines.length > 20000) return { ok: false, code: "invalid_source" };
  const header = /^@@ -(\d+),0 \+(\d+),(\d+) @@$/.exec(lines[2] || "");
  if (!header || Number(header[1]) !== sourceLines.length ||
      Number(header[2]) !== sourceLines.length + 1 ||
      Number(header[3]) !== validated.additions ||
      lines.slice(3).some(line => !line.startsWith("+") || line.startsWith("+++"))) {
    return { ok: false, code: "patch_not_appended_at_eof" };
  }

  const additions = lines.slice(3).map(line => line.slice(1));
  const output = [...sourceLines, ...additions].join("\n") + "\n";
  return {
    ok: true,
    content: output,
    targetPath,
    baseSha,
    additions: additions.length,
    mode: "in_memory_only"
  };
}

export { readBoundedResponse } from "./intelligence-bounded-response.mjs";
