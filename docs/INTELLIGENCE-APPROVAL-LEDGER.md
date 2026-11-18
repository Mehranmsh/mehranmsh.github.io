# MEHRAN INTELLIGENCE: Durable Approval Ledger

## Status

Stage 1 foundation. The D1 table and indexes are present, along with owner-authenticated read and revoke routes. Approval issuance and consumption are deliberately not implemented. The ledger does not create patches, write to GitHub, or enable a code-change executor. A row in this table is not permission to execute anything.

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

## Implemented foundation

- Owner-only read route: `GET /intelligence/approvals`, scoped to the authenticated owner UID and limited to 50 records.
- Owner-only revoke route: `DELETE /intelligence/approvals/:id`, conditional on the owner UID, `status='issued'`, and a future expiry. A zero-row transition returns HTTP 409.
- Internal-only `consumeIntelligenceApproval` primitive: validates the fixed repository, isolated branch pattern, commit SHA, scope digest, task ID, and owner UID. It marks expired records and then attempts one conditional SQL update that binds approval ID, task, owner, repository, branch, base SHA, scope digest, issued state, revocation state, and expiry. It requires an accepted, unblocked `documentation_patch_proposal` task assigned to Intelligence or Shared. Exactly one changed row is required.
- The consume primitive has no HTTP or MCP caller and is not reachable from the current agent runner. It is preparatory code, not an active execution capability.

## Remaining protocol before activation

1. Owner-only issue route (not implemented): verify the admin session, target task, repository identity, branch naming policy, pinned base SHA, path allowlist, scope size, and expiry. Reject any model-supplied approval state.
2. Canonicalize scope deterministically, hash it with SHA-256, and store the exact canonical JSON and digest.
3. Future executor: obtain approval context from the trusted Worker database, never from model output or a task description.
4. Re-fetch and re-verify the repository base, branch, exact changed paths, patch bytes, and diff immediately before any GitHub write. Never reuse a consumed approval.
5. Audit issue, revoke, failed consumption, and successful consumption without logging secrets or patch contents.

## Non-negotiable boundaries

- MCP and the model cannot issue, approve, revoke, or consume records.
- A task's `requires_approval` flag is not a substitute for a ledger record.
- No arbitrary shell commands, direct writes to main, merge, deployment, wallet/payment actions, or user-data migrations.
- Initial code-change scope remains documentation-only Markdown under the strict allowlist.
- Separate owner review is required before enabling approval issuance, one-time consumption, or any executor.

## Current limitation

The D1 schema, owner-scoped read endpoint, conditional revocation endpoint, and an internal-only atomic consume primitive are present. There is intentionally no issue endpoint and no caller for the consume primitive. Therefore no approval can currently be created or consumed through the API, and the ledger is not an operational authorization mechanism. Existing read-only tasks continue to use their separate pre-authorization policy. The code-change executor remains disabled.
