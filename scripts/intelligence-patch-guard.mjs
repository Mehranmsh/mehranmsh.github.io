const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 180 * 1024;
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

function hasUnpairedSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a proposed set of text-file changes before it can become a patch
 * artifact. This function does not write files, execute code, or call GitHub.
 *
 * Input entries: { path, content, status, mode }
 * Both status and mode are mandatory. Only added/modified regular Markdown
 * files under docs/ are accepted in this pilot.
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

    const segments = path.split("/");
    const hasUnsafeSegment = segments.some(part =>
      part.length === 0 ||
      part === "." ||
      part === ".." ||
      /[. ]$/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)
    );
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      hasUnsafeSegment ||
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(path)
    ) {
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

    if (!["added", "modified"].includes(file.status)) {
      errors.push(`Missing or unsupported change status for ${path}.`);
      continue;
    }
    if (file.mode !== "100644") {
      errors.push(`Missing or unsupported regular-file mode for ${path}.`);
      continue;
    }
    if (typeof file.content !== "string" || hasUnpairedSurrogate(file.content)) {
      errors.push(`Only valid UTF-8 text content is accepted for ${path}.`);
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

  if (totalBytes > MAX_TOTAL_BYTES) errors.push("Patch exceeds the 180 KiB total-content limit.");
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
