import { validatePatchProposal } from "./intelligence-patch-policy.mjs";

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function digestText(value) {
  const bytes = new TextEncoder().encode(value);
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function canonicalArtifactFields(value) {
  return {
    schemaVersion: 1,
    proposalId: value.proposalId,
    createdAt: value.createdAt,
    baseSha: value.baseSha,
    targetPath: value.targetPath,
    summary: value.summary,
    diffSha256: value.diffSha256,
    diff: value.diff
  };
}

export async function createPatchArtifactRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid_input" };
  }
  const validated = validatePatchProposal(input);
  if (!validated.ok) return validated;
  if (typeof input.proposalId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.proposalId)) {
    return { ok: false, code: "invalid_proposal_id" };
  }
  const createdAt = typeof input.createdAt === "string" ? input.createdAt : "";
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== createdAt) {
    return { ok: false, code: "invalid_created_at" };
  }
  const artifact = canonicalArtifactFields({
    proposalId: input.proposalId,
    createdAt,
    baseSha: validated.baseSha,
    targetPath: validated.targetPath,
    summary: input.summary.trim(),
    diffSha256: await digestText(input.diff),
    diff: input.diff
  });
  const artifactSha256 = await digestText(JSON.stringify(artifact));
  return { ok: true, artifact, artifactSha256 };
}

export async function verifyPatchArtifactRecord(record, expectedArtifactSha256) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      typeof expectedArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedArtifactSha256)) {
    return { ok: false, code: "invalid_artifact_envelope" };
  }
  const keys = Object.keys(record).sort();
  const expectedKeys = ["baseSha", "createdAt", "diff", "diffSha256", "proposalId", "schemaVersion", "summary", "targetPath"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || record.schemaVersion !== 1) {
    return { ok: false, code: "artifact_schema_mismatch" };
  }
  const validated = validatePatchProposal({
    baseSha: record.baseSha,
    summary: record.summary,
    targetPaths: [record.targetPath],
    diff: record.diff
  });
  if (!validated.ok) return validated;
  if (typeof record.createdAt !== "string") return { ok: false, code: "invalid_artifact_metadata" };
  const date = new Date(record.createdAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== record.createdAt ||
      typeof record.proposalId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.proposalId)) {
    return { ok: false, code: "invalid_artifact_metadata" };
  }
  if (await digestText(record.diff) !== record.diffSha256) {
    return { ok: false, code: "diff_digest_mismatch" };
  }
  const canonical = canonicalArtifactFields(record);
  if (await digestText(JSON.stringify(canonical)) !== expectedArtifactSha256) {
    return { ok: false, code: "artifact_digest_mismatch" };
  }
  return {
    ok: true,
    proposalId: record.proposalId,
    baseSha: record.baseSha,
    targetPath: record.targetPath,
    artifactSha256: expectedArtifactSha256,
    diffSha256: record.diffSha256,
    mode: "verify_only"
  };
}
