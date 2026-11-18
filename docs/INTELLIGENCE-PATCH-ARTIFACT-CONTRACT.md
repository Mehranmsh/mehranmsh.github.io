# MEHRAN INTELLIGENCE: Patch Artifact Contract

**Status:** Specification only. This document does not enable patch generation, filesystem writes, GitHub writes, or execution.

## Purpose

Define a deterministic, reviewable envelope for a future patch proposal. The envelope must prove which owner-approved task, scope, base commit, and exact file contents it represents. A valid envelope is necessary but not sufficient for execution.

## Trust requirements

- The task approval is created and verified by the authenticated owner control plane, never by the model or the runner.
- The approval is bound to an immutable task ID, approval ID, exact scope digest, exact base commit SHA, allowed path set, and expiration.
- Any change to task scope, paths, base SHA, or approval state invalidates the envelope.
- The patch generator receives no GitHub write token, Cloudflare secret, Pi wallet credential, or production credential.
- The task description is untrusted data. It is never interpreted as a command or executable instruction.
- The artifact is treated as untrusted until independently validated against the actual base Git tree and actual resulting diff.

## Proposed envelope

The following is a conceptual JSON shape, not an enabled API:

```json
{
  "protocolVersion": 1,
  "taskId": "opaque-task-id",
  "approval": {
    "approvalId": "opaque-owner-approval-id",
    "approvedAt": "2026-11-18T12:00:00Z",
    "expiresAt": "2026-11-18T12:30:00Z",
    "scopeSha256": "64 lowercase hexadecimal characters",
    "baseSha": "40 lowercase hexadecimal characters"
  },
  "baseSha": "40 lowercase hexadecimal characters",
  "files": [
    {
      "path": "docs/proposal.md",
      "status": "added",
      "mode": "100644",
      "content": "UTF-8 text content"
    }
  ],
  "artifactSha256": "64 lowercase hexadecimal characters"
}
```

All values above are examples of field formats, not real credentials or approval records.

## Canonical digest rules

The artifact digest must be computed over a canonical serialization that excludes the `artifactSha256` field itself.

1. Encode the canonical serialization as UTF-8.
2. Use deterministic JSON serialization with lexicographically sorted object keys, no insignificant whitespace, and no Unicode normalization performed implicitly.
3. Preserve array order only where the schema explicitly defines it. For `files`, sort by exact UTF-8 path bytes before serialization.
4. Reject duplicate paths before computing the digest.
5. Hash the canonical bytes with SHA-256.
6. Compare digests using a constant-time comparison where a secret or authorization decision is involved. The digest itself is an integrity identifier, not a secret or an authorization token.

The scope digest is computed separately from a canonical representation of the approved task scope, including the exact allowlisted paths and base SHA. The approval service, not the model, is authoritative for this value.

## Required validation sequence

1. Authenticate the agent service identity.
2. Fetch the task and approval state from the trusted control plane.
3. Confirm the task is still approved, not cancelled, not expired, and assigned to the intended agent.
4. Confirm the approval ID, task ID, scope digest, exact allowed paths, and base SHA match the control-plane record.
5. Confirm the checked-out Git commit equals the approved base SHA.
6. Validate the envelope schema and reject unknown fields.
7. Validate every path, status, file mode, content encoding, file count, and byte limit using the patch guard.
8. Read the actual base Git tree and independently confirm each declared status. An `added` path must not exist at the base; a `modified` path must exist as a regular file at the base.
9. Construct the candidate patch in an isolated workspace and inspect the actual Git diff. Reject undeclared changes, deletions, renames, symlinks, submodules, executable modes, and any mismatch between declared and actual files.
10. Run dedicated secret scanning and trusted, server-selected tests. Do not accept test commands from task text or artifact fields.
11. Re-check cancellation, approval expiry, and scope immediately before any future external write.
12. Produce a review report containing only bounded metadata, digests, test outcomes, and a blocked reason. Do not include secrets or unnecessary file contents.

## Replay and race protection

- Approval IDs are single-task, single-scope authorizations.
- A task may produce at most one active patch artifact for a given approval ID and base SHA.
- Reusing an approval ID with a different digest, path set, base SHA, or task ID is a hard failure.
- The control plane must atomically claim the task and record the artifact digest before a later stage can act on it.
- Expired, revoked, cancelled, or superseded approvals cannot be revived by replaying an old artifact.
- A new base commit requires a new owner approval.

## Failure behavior

Fail closed. If any source of truth is unavailable, inconsistent, or ambiguous, do not generate a GitHub write, do not widen scope, and do not silently retry with weaker checks. Mark the task blocked with a concise reason and preserve the audit trail.

## Important limitations

- A SHA-256 digest proves integrity of the serialized artifact, not that its contents are safe.
- A valid envelope does not prove the owner approved it; approval must be checked against the authenticated control-plane record.
- The current patch guard does not parse Git objects, inspect a real Git diff, scan secrets comprehensively, or validate approval records.
- The current agent runner does not consume this envelope and has no code-change execution capability.
- GitHub branch creation, pull-request creation, merging, and deployment remain disabled for this proposal workflow.

## Acceptance criteria before implementation

- A schema validator rejects missing, extra, malformed, and wrongly typed fields.
- Canonical serialization has fixed test vectors and digest tests.
- Approval binding tests cover task mismatch, scope mismatch, path mismatch, base mismatch, expiry, revocation, and cancellation.
- Git-tree tests cover added versus modified files and reject symlinks, submodules, executable modes, deletions, and undeclared changes.
- Secret scanning is a separate required gate with documented limits.
- A threat-model review is completed before any write credential is introduced.
- Stage 2 artifact-only execution and Stage 3 draft-PR creation require separate owner-approved implementation changes.
