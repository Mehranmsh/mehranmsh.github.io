# MEHRAN INTELLIGENCE: Durable Approval Ledger

## Status

Stage 1 issuance foundation. The D1 table and indexes are present, along with owner-authenticated read, issue, and revoke routes plus an internal-only atomic consume primitive. Issuance records a narrowly scoped, short-lived owner grant only for an already owner-approved documentation proposal. The ledger does not create patches, write to GitHub, or enable a code-change executor. A row in this table is not permission to execute anything.

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

- Owner-only issue route: `POST /intelligence/approvals`. It accepts only task ID, isolated branch, pinned base SHA, Markdown path list, and bounded expiry. It derives owner UID/username from the authenticated admin session, hardcodes the repository, canonicalizes and hashes scope, limits scope to 1-5 safe `docs/*.md` paths, rejects active duplicate grants, and audits issuance. A partial unique index on `(task_id, owner_uid)` for `status='issued'`, together with expiry cleanup and a conditional insert response, closes concurrent duplicate-issuance races.
- Owner-only read route: `GET /intelligence/approvals`, scoped to the authenticated owner UID and limited to 50 records.
- Owner-only revoke route: `DELETE /intelligence/approvals/:id`, conditional on the owner UID, `status='issued'`, and a future expiry. A zero-row transition returns HTTP 409.
- Internal-only `consumeIntelligenceApproval` primitive: validates the fixed repository, isolated branch pattern, commit SHA, scope digest, task ID, and owner UID. It uses the Worker server clock, marks expired records, and then attempts one conditional SQL update that binds approval ID, task, owner, repository, branch, base SHA, scope digest, issued state, revocation state, and expiry. It requires an accepted, unblocked `documentation_patch_proposal` task assigned to Intelligence or Shared. Exactly one changed row is required.
- The consume primitive has no HTTP or MCP caller and is not reachable from the current agent runner. It is preparatory code, not an active execution capability.
- The private Intelligence Task Hub UI can select an accepted documentation proposal, collect the allowed paths, pin a base commit, choose a 5-60 minute expiry, issue a grant, list the owner's recent grants, and revoke an active grant. The UI uses the existing authenticated Worker API for ledger actions; its optional base-SHA helper performs only a public GitHub GET request.

## Remaining protocol before activation

1. The owner must first approve the documentation proposal task in Task Hub. The scoped-grant panel then issues a short-lived grant for the exact paths, branch, and pinned base commit.
2. The scope is canonicalized deterministically and hashed with SHA-256; the exact canonical JSON and digest are stored.
3. A future executor must obtain approval context from the trusted Worker database, never from model output or a task description.
4. Re-fetch and re-verify the repository base, branch, exact changed paths, patch bytes, and diff immediately before any GitHub write. Never reuse a consumed approval.
5. Audit issue, revoke, failed consumption, and successful consumption without logging secrets or patch contents.
6. Before production use, exercise issue/list/revoke/expiry against a non-production D1 database and verify database foreign-key behavior.

## Non-negotiable boundaries

- MCP and the model cannot issue, approve, revoke, or consume records.
- A task's `requires_approval` flag is not a substitute for a ledger record.
- No arbitrary shell commands, direct writes to main, merge, deployment, wallet/payment actions, or user-data migrations.
- Initial code-change scope remains documentation-only Markdown under the strict allowlist.
- Separate owner review is required before enabling one-time consumption or any executor. The existing issuance UI and routes remain inert with respect to code execution.

## Current limitation

The D1 schema, owner-scoped read/issue/revoke endpoints, a private Task Hub issuance/revocation UI, and an internal-only atomic consume primitive are present. The UI and routes have passed repository CI static/smoke checks, but issuance has not yet been exercised against the live production D1 database. No HTTP/MCP/agent route calls the consume primitive. Therefore the grant is not yet an operational execution authorization mechanism. The documentation proposal task type is intentionally excluded from the agent queue. Existing read-only tasks continue to use their separate pre-authorization policy. The code-change executor remains disabled.
