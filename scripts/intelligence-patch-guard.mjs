const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 200 * 1024;
const MAX_FILE_BYTES = 40 * 1024;
const ALLOWED_PATH = /^docs\/[A-Za-z0-9._/-]+\.md$/;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i
];

function fail(errors) {
  return { ok: false, errors, fileCount: 0, totalBytes: 0 };
}

/**
 * Validate a proposed set of text-file changes before it can become a patch
 * artifact. This function does not write files, execute code, or call GitHub.
 *
 * Input entries: { path, content, status?, mode? }
 * Only new/modified Markdown files under docs/ are accepted in this pilot.
 */
export function validateIntelligencePatch(files) {
  if (!Array.isArray(files)) return fail(["Patch files must be an array."]);
  if (files.length === 0) return fail(["Patch must contain at least one file."]);
  if (files.length > MAX_FILES) return fail([`Patch exceeds the ${MAX_FILES}-file limit.`]);

  const errors = [];
  const seen = new Set();
  let totalBytes = 0;

  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      errors.push("Each patch entry must be an object.");
      continue;
    }

    const path = file.path;
    if (typeof path !== "string" || path.length === 0) {
      errors.push("Every patch entry must have a non-empty path.");
      continue;
    }

    if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === "." || part === "..") || /[\u0000-\u001f]/.test(path)) {
      errors.push(`Unsafe path rejected: ${path.slice(0, 120)}`);
      continue;
    }
    if (!ALLOWED_PATH.test(path)) {
      errors.push(`Path is outside the documentation-only allowlist: ${path.slice(0, 120)}`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`Duplicate path rejected: ${path}`);
      continue;
    }
    seen.add(path);

    if (file.status !== undefined && !["added", "modified"].includes(file.status)) {
      errors.push(`Unsupported change status for ${path}.`);
      continue;
    }
    if (file.mode !== undefined && file.mode !== "100644") {
      errors.push(`Unsupported file mode for ${path}.`);
      continue;
    }
    if (typeof file.content !== "string") {
      errors.push(`Only UTF-8 text content is accepted for ${path}.`);
      continue;
    }

    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) errors.push(`File exceeds the 40 KiB limit: ${path}`);
    totalBytes += bytes;

    if (SECRET_PATTERNS.some(pattern => pattern.test(file.content))) {
      errors.push(`Potential credential material detected in ${path}.`);
    }
    if (file.content.includes("\u0000")) {
      errors.push(`Binary/NUL content rejected in ${path}.`);
    }
  }

  if (totalBytes > MAX_TOTAL_BYTES) errors.push("Patch exceeds the 200 KiB total-content limit.");
  return {
    ok: errors.length === 0,
    errors,
    fileCount: files.length,
    totalBytes
  };
}

export const INTELLIGENCE_PATCH_LIMITS = Object.freeze({
  maxFiles: MAX_FILES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
  allowedPathDescription: "Markdown files under docs/ only"
});
