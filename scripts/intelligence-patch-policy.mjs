const MAX_PATCH_BYTES = 8192;
const ALLOWED_PATCH_PATHS = Object.freeze([
  "scripts/intelligence-capabilities.test.mjs"
]);

function fail(code) {
  return { ok: false, code };
}

function parseCount(value) {
  return value === undefined ? 1 : Number(value);
}

/**
 * Validate a proposed unified diff without applying it.
 * This first rollout deliberately permits test-only edits to one exact path.
 */
export function validatePatchProposal(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input");
  const { baseSha, targetPaths, diff, summary } = input;
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) return fail("invalid_base_sha");
  if (typeof summary !== "string" || summary.trim().length < 12 || summary.length > 500) return fail("invalid_summary");
  if (!Array.isArray(targetPaths) || targetPaths.length !== 1) return fail("invalid_target_count");
  const targetPath = targetPaths[0];
  if (typeof targetPath !== "string" || !ALLOWED_PATCH_PATHS.includes(targetPath)) return fail("path_not_allowed");
  if (typeof diff !== "string" || diff.length < 20 || new TextEncoder().encode(diff).byteLength > MAX_PATCH_BYTES) return fail("patch_size_invalid");
  if (diff.includes("\u0000") || diff.includes("\r") || !diff.endsWith("\n")) return fail("patch_encoding_invalid");

  const lines = diff.slice(0, -1).split("\n");
  if (lines.length < 4) return fail("patch_structure_invalid");
  if (lines[0] !== `--- a/${targetPath}` || lines[1] !== `+++ b/${targetPath}`) return fail("patch_path_mismatch");
  if (lines.some((line) => /^(?:diff --git |GIT binary patch|Binary files |rename (?:from|to) |copy (?:from|to) |(?:old|new) mode |deleted file mode |new file mode |similarity index |dissimilarity index )/.test(line))) {
    return fail("unsupported_patch_feature");
  }

  let index = 2;
  let hunkCount = 0;
  let additions = 0;
  let deletions = 0;
  while (index < lines.length) {
    const header = lines[index];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header);
    if (!match) return fail("invalid_hunk_header");
    hunkCount++;
    let oldRemaining = parseCount(match[2]);
    let newRemaining = parseCount(match[4]);
    if (oldRemaining < 0 || newRemaining < 0 || (oldRemaining === 0 && newRemaining === 0)) return fail("invalid_hunk_counts");
    index++;
    while (oldRemaining > 0 || newRemaining > 0) {
      if (index >= lines.length) return fail("truncated_hunk");
      const line = lines[index++];
      if (line.startsWith(" ")) {
        oldRemaining--;
        newRemaining--;
      } else if (line.startsWith("-")) {
        oldRemaining--;
        deletions++;
      } else if (line.startsWith("+")) {
        newRemaining--;
        additions++;
      } else if (line.startsWith("\\ No newline at end of file")) {
        return fail("patch_encoding_invalid");
      } else {
        return fail("invalid_hunk_line");
      }
      if (oldRemaining < 0 || newRemaining < 0) return fail("hunk_count_mismatch");
    }
  }

  if (hunkCount === 0 || (additions === 0 && deletions === 0)) return fail("empty_patch");
  return {
    ok: true,
    baseSha,
    targetPath,
    bytes: new TextEncoder().encode(diff).byteLength,
    additions,
    deletions,
    hunkCount,
    mode: "validate_only"
  };
}

export const PATCH_PROPOSAL_POLICY = Object.freeze({
  maxPatchBytes: MAX_PATCH_BYTES,
  allowedPaths: ALLOWED_PATCH_PATHS,
  appliesChanges: false,
  createsBranches: false,
  createsPullRequests: false
});
