# INTELLIGENCE-only staging Worker: implementation contract

## Decision

Build a separate, minimal Worker for staging. Do not deploy the production `worker.js` with a different D1 binding. The production Worker has shared route preflight, SOCIAL bootstrap, a scheduled handler, and agent polling/result routes. Those paths are outside the staging scope and must not be copied into the staging runtime.

## Runtime boundary

- Worker name: `mehran-intelligence-staging` (proposed; not yet created).
- Config file: `wrangler.intelligence-staging.jsonc` (separate from `wrangler.jsonc`).
- D1 binding: `DB` → only `mehran-msh-intelligence-staging`.
- No `triggers.crons`, no scheduled handler, no queue consumer, no agent polling endpoint.
- No production secrets, tokens, database IDs, or data.
- Workers AI binding may be added only after an isolated budget guard and staging AI limits are implemented and reviewed.
- No executor, no automatic task execution, and no GitHub write capability.

## Authentication design

Use Pi Platform server-side verification, but do not accept a client-supplied username or UID as proof of identity. The Worker must validate the Pi access token server-side, then compare the verified UID against a staging-only owner UID configuration. The staging owner UID value must be provisioned separately and must never be copied from an unverified request.

Issue a cryptographically random bearer session token only after successful Pi verification. Store only its SHA-256 hash in a dedicated staging session table. Sessions must have bounded lifetime, explicit revocation, constant-time token-hash comparison where applicable, and owner UID binding. Fail closed when the owner UID is absent or Pi verification is unavailable.

The existing production `admin_sessions` table and production `MEHRAN_OWNER_PI_UID` secret must not be reused or exposed to staging. Do not copy production sessions.

## Minimal staging schema additions

The current four migrations provide tasks, knowledge, approval ledger, and knowledge relationships. Before Worker implementation, add a separately reviewed migration for:
- `intelligence_staging_sessions`: token hash, owner UID, created/expiry/revocation timestamps;
- `intelligence_staging_audit`: append-only audit events scoped to owner UID;
- `intelligence_staging_rate_limits`: bounded request counters/windows;
- `intelligence_owner_memory`: owner-scoped memory records and lookup index.

Do not silently create tables at request time. Migrations are explicit, versioned, and run only against the isolated staging database.

## Route allowlist for first milestone

Only implement the endpoints needed for safe owner validation and read/write review:
- `GET /health`: returns service status and schema readiness without exposing secrets or account data.
- `POST /session`: verifies Pi access token and creates staging-only owner session.
- `GET /session`: validates current staging session.
- `DELETE /session`: revokes current staging session.
- `GET /intelligence/knowledge`: owner-scoped list.
- `POST /intelligence/knowledge`: validated owner-scoped insert plus audit in one D1 batch.
- `GET /intelligence/knowledge/relations`: owner-scoped list.
- `POST /intelligence/knowledge/relations`: candidate-only relationship creation plus audit in one D1 batch.
- `PUT /intelligence/knowledge/relations/:id`: explicit owner review transition plus audit in one D1 batch.
- `GET /intelligence/approvals`: owner-scoped ledger view.
- `POST /intelligence/approvals`: issue a bounded approval record, but do not connect it to an executor.
- `DELETE /intelligence/approvals/:id`: revoke an unused, unexpired owner-scoped approval.

No task-claim, scheduler, agent, MCP, deployment, payment, repository-write, or executor routes belong in this first staging Worker.

## Required tests before any deployment

1. No owner UID configured → session creation fails closed.
2. Invalid, expired, or unverifiable Pi token → no session.
3. A valid Pi token for a different UID → forbidden.
4. Session token stored only as a hash; revoked/expired sessions fail.
5. Every knowledge, relation, and approval query is owner-scoped.
6. Cross-owner IDs cannot be read, changed, revoked, or consumed.
7. Audit failure rolls back the associated mutation.
8. Rate-limit storage failure blocks protected writes.
9. Missing schema returns a controlled 503; request handling never runs DDL.
10. Approval expiry, revocation, duplicate active grants, and concurrent consume attempts are covered.
11. Unknown routes/methods fail closed; request bodies and result sizes are bounded.
12. Static inspection confirms no cron, no executor, no agent routes, no production binding, and no production secrets.

## Current status

This is an implementation contract, not a deployed Worker. No staging config or code has been created from it yet. The staging database ID is not available in the repository, so a final D1 binding cannot be safely authored. No production resource has been changed.
