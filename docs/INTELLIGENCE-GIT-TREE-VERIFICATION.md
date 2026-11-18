# MEHRAN INTELLIGENCE: Git Tree Verification Contract

**Status:** Security contract only. No GitHub write integration or code-change execution is enabled.

## Purpose

The patch envelope validator checks the proposed text artifact. It does not prove that a future Git commit contains exactly that artifact. Before any future draft-PR write, a trusted verifier must compare the pinned base commit, the candidate commit, both Git trees, and the validated envelope.

A matching SHA-256 digest is an integrity check for the envelope bytes. It is not proof that GitHub contains the same file contents, that the owner approved the patch, or that the patch is safe.

## Required trusted inputs

The verifier must obtain these values from trusted control-plane records and GitHub responses, never from model-generated task text:

- Task ID and immutable approval ID
- Approved scope digest and exact allowed-path set
- Approval status, issue time, expiry, and revocation state
- Pinned base commit SHA
- Expected isolated branch name and repository identity
- Validated patch envelope and its artifact digest

Fail closed if any value is missing, ambiguous, stale, or inconsistent.

## Commit and ancestry checks

Before accepting a candidate commit:

1. Resolve the base SHA to a commit in the expected repository.
2. Resolve the candidate SHA to a commit in the same repository.
3. Require the candidate's sole parent to be exactly the pinned base SHA. Reject merge commits, unexpected ancestry, and a changed base.
4. Require the candidate branch to be the task's isolated branch. Never accept `main`, a protected release branch, or an arbitrary branch supplied by the model.
5. Re-check approval validity and revocation immediately before any future write.

If the base branch advances, do not silently rebase or regenerate under the old approval. Block and request a new owner-approved scope/base binding.

## Git tree checks

Fetch the base and candidate commit tree objects from GitHub using the trusted repository identity and exact commit SHAs.

The verifier must:

- Require complete, non-truncated tree responses. If a recursive tree response is truncated, fetch the required subtrees individually; never treat a partial response as complete.
- Compute the actual changed-path set from the two trees, including additions, modifications, deletions, and type/mode changes.
- Require the actual changed-path set to equal the envelope's declared path set exactly. No undeclared extra files and no omitted declared files.
- Reject every deletion, rename, copy, symlink, submodule, executable file, or non-regular-file mode in this first pilot.
- Require each changed entry to be a regular blob with mode `100644`.
- Require every changed path to be under `docs/`, end in `.md`, and appear in the trusted approval's exact allowed-path set.
- For every added or modified path, fetch the blob bytes and compare them byte-for-byte with the UTF-8 content in the validated envelope. Do not compare only line counts, rendered text, or a filename.
- Verify that all unchanged paths retain the same object identity and mode between base and candidate trees, except Git tree objects necessarily re-hashed along changed directory paths.

A verifier must account for Git tree semantics, including nested directories, path byte ordering, file/directory collisions, and tree entries whose names cannot be represented safely as ordinary text. Reject ambiguous or unsupported names.

## Diff cross-check

Use GitHub's commit comparison/diff response as an independent cross-check, not as the sole source of truth.

- Require the comparison base and head to match the pinned SHAs.
- Require the diff file list and statuses to agree with the tree-derived change set.
- Reject truncated, unavailable, or oversized diff responses.
- Parse the actual unified diff and verify it represents the same additions/modifications as the validated envelope.
- If the API omits a file, reports a rename, or cannot provide enough data to prove equivalence, block the task.

## Replay and race protection

- Bind the verification result to repository ID, base SHA, candidate SHA, task ID, approval ID, scope digest, artifact digest, and verification time.
- Use a single-use task/approval execution record. A verified artifact must not be replayable for another task, branch, repository, or base commit.
- Re-fetch the candidate commit and tree immediately before any future draft-PR creation and require the SHAs to remain unchanged.
- If the branch moves, approval expires, approval is revoked, or the task is cancelled, discard the verification result and stop.
- Record only bounded metadata and a concise result. Never log credentials or raw secret-like content.

## Fail-closed outcomes

The verifier returns success only when every check passes. Otherwise it returns a bounded blocked result identifying the failed check without exposing sensitive file contents.

No automatic merge, deployment, production write, database migration, wallet action, payment action, or permission change is permitted by this contract. Draft-PR creation itself remains a separate capability requiring a separate owner-approved rollout stage.

## Explicit limitations

This document is a design contract, not an implemented verifier. The current patch guard and envelope validator do not fetch Git trees, inspect Git objects, parse GitHub diffs, compare blob bytes with a committed tree, or create branches/commits/PRs. No such capability is enabled by adding this document.
