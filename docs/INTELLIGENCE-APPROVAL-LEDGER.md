# MEHRAN INTELLIGENCE: Durable Approval Ledger

## Status

Stage 1 schema foundation only. This change creates a D1 table and indexes. It does not issue approvals, consume approvals, create patches, write to GitHub, or enable a code-change executor. No caller can treat a row in this table as permission until owner-only issue/revoke routes and an atomic, task-bound consumption protocol are implemented and tested.

## Record binding

Each future approval record is intended to bind all of the following:
- A unique, unguessable approval ID.
- One exact Intelligence task ID.
- The authenticated owner UID and username that issued it.
- The exact repository, isolated branch, and pinned base commit SHA.
- Canonical scope JSON and its SHA-256 digest.
- Issued and expiry timestamps.
- A single state: issued, revoked, consumed, or expired.
- Revocation and consumption timestamps, plus the consuming service identity.

The D1 schema stores these fields in `intelligence_approval_ledger`. Foreign-key enforcement must be enabled and verified in the database connection before relying on the task relationship.

## Required protocol before activation

1. Owner-only issue route: verify the admin session, target task, repository identity, branch naming policy, pinned base SHA, path allowlist, scope size, and expiry. Reject any model-supplied approval state.
2. Canonicalize scope deterministically, hash it with SHA-256, and store the exact canonical JSON and digest.
3. Owner-only revoke route: conditional update from issued to revoked, only before consumption.
4. Future executor: obtain approval context from the trusted Worker database, never from model output or a task description.
5. Immediately before any write, atomically consume with a single conditional SQL UPDATE requiring matching approval ID, task ID, owner, repository, branch, base SHA, scope digest, status='issued', no revocation, and expires_at > current time. Require exactly one changed row. A zero-row result is a hard stop.
6. Re-fetch and re-verify the repository base, branch, exact changed paths, patch bytes, and diff immediately before the write. Never reuse a consumed approval.
7. Audit issue, revoke, failed consumption, and successful consumption without logging secrets or patch contents.

## Non-negotiable boundaries

- MCP and the model cannot issue, approve, revoke, or consume records.
- A task's `requires_approval` flag is not a substitute for a ledger record.
- No arbitrary shell commands, direct writes to main, merge, deployment, wallet/payment actions, or user-data migrations.
- Initial code-change scope remains documentation-only Markdown under the strict allowlist.
- Separate owner review is required before enabling approval routes or any executor.

## Current limitation

Only the D1 schema and indexes are added in this stage. The ledger is not yet an operational authorization mechanism. Existing read-only tasks continue to use their separate pre-authorization policy. The code-change executor remains disabled.
