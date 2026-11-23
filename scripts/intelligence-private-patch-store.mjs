import { verifyPatchArtifactRecord } from "./intelligence-patch-artifact.mjs";

const REPORTS_REPOSITORY = "Mehranmsh/mehran-intelligence-reports";
const API_ROOT = "https://api.github.com";
const MAX_ARTIFACT_BYTES = 16384;

function fail(code) {
  return { stored: false, code };
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function getPrivatePatchArtifactPath(record) {
  const date = new Date(record.createdAt);
  const year = date.toISOString().slice(0, 4);
  const month = date.toISOString().slice(5, 7);
  return `patch-proposals/${year}/${month}/${record.proposalId}.json`;
}

function headers(token, json = false) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "MEHRAN-INTELLIGENCE-Patch-Artifact-Store",
    ...(json ? { "Content-Type": "application/json" } : {})
  };
}

async function verifyExisting(response, expectedSha256) {
  const payload = await response.json();
  if (payload?.encoding !== "base64" || typeof payload.content !== "string") {
    return fail("existing_artifact_unreadable");
  }
  let existing;
  try {
    existing = JSON.parse(decodeBase64Utf8(payload.content));
  } catch {
    return fail("existing_artifact_invalid_json");
  }
  const verified = await verifyPatchArtifactRecord(existing, expectedSha256);
  if (!verified.ok) return fail("artifact_id_conflict");
  return { stored: true, alreadyExists: true, path: payload.path, artifactSha256: expectedSha256 };
}

/**
 * Create-only storage in the private reports repository.
 * Existing proposal IDs are accepted only when their full digest matches.
 */
export async function storePrivatePatchArtifact({
  token,
  artifact,
  artifactSha256,
  fetchImpl = fetch
} = {}) {
  if (typeof token !== "string" || token.trim().length < 40) return fail("store_not_configured");
  const verified = await verifyPatchArtifactRecord(artifact, artifactSha256);
  if (!verified.ok) return fail("artifact_validation_failed");
  const serialized = JSON.stringify(artifact, null, 2) + "\n";
  if (new TextEncoder().encode(serialized).byteLength > MAX_ARTIFACT_BYTES) return fail("artifact_size_exceeded");

  const path = getPrivatePatchArtifactPath(artifact);
  const url = `${API_ROOT}/repos/${REPORTS_REPOSITORY}/contents/${path}`;
  const requestHeaders = headers(token.trim());
  const existing = await fetchImpl(url, { method: "GET", headers: requestHeaders });
  if (existing.ok) return verifyExisting(existing, artifactSha256);
  if (existing.status !== 404) return fail("artifact_lookup_failed");

  const write = await fetchImpl(url, {
    method: "PUT",
    headers: headers(token.trim(), true),
    body: JSON.stringify({
      message: `Store INTELLIGENCE patch proposal ${artifact.proposalId}`,
      content: encodeBase64Utf8(serialized)
    })
  });
  if (write.ok) {
    return { stored: true, alreadyExists: false, path, artifactSha256 };
  }
  if (write.status === 422) {
    const raced = await fetchImpl(url, { method: "GET", headers: requestHeaders });
    if (raced.ok) return verifyExisting(raced, artifactSha256);
  }
  return fail("artifact_write_failed");
}

export async function verifyPrivatePatchArtifactAtPath({
  token,
  path,
  artifactSha256,
  fetchImpl = fetch
} = {}) {
  if (typeof token !== "string" || token.trim().length < 40 ||
      typeof path !== "string" || !/^patch-proposals\\/\\d{4}\\/\\d{2}\\/[a-f0-9-]{36}\\.json$/.test(path) ||
      typeof artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifactSha256)) {
    return fail("invalid_artifact_lookup");
  }
  const url = `${API_ROOT}/repos/${REPORTS_REPOSITORY}/contents/${path}`;
  const response = await fetchImpl(url, { method: "GET", headers: headers(token.trim()) });
  if (response.status === 404) return fail("artifact_not_found");
  if (!response.ok) return fail("artifact_lookup_failed");
  const verified = await verifyExisting(response, artifactSha256);
  if (!verified.stored || verified.path !== path) return fail("artifact_id_conflict");
  return verified;
}

export const PRIVATE_PATCH_ARTIFACT_STORE_POLICY = Object.freeze({
  repository: REPORTS_REPOSITORY,
  pathPrefix: "patch-proposals/",
  createOnly: true,
  overwritesExisting: false,
  maxArtifactBytes: MAX_ARTIFACT_BYTES
});
