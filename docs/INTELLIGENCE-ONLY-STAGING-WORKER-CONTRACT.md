# INTELLIGENCE-only staging Worker: implementation contract

## Decision

Use a separate, minimal Worker. Do not deploy production `worker.js` with a different D1 binding. The production Worker has shared route preflight, SOCIAL bootstrap, a scheduled handler, and agent polling/result routes.

## Runtime boundary

- Worker source: `intelligence-staging-worker.js`.
- Proposed Worker name: `mehran-intelligence-staging`.
- Future separate config: `wrangler.intelligence-staging.jsonc`, not production `wrangler.jsonc`.
- D1 binding `DB` must target only `mehran-msh-intelligence-staging`.
- No cron, scheduled handler, queue consumer, agent polling, executor, or GitHub write capability.
- No production secrets, tokens, database IDs, or data.
- No AI binding until a separate budget guard is implemented and reviewed.

## Authentication

Verify Pi access tokens server-side through the Pi Platform `/v2/me` endpoint. Never trust a client-supplied UID or username. Compare the verified UID with a separately provisioned staging-only owner UID. Fail closed if the owner UID is absent or verification fails.

Issue a cryptographically random bearer token only after verification. Store only its SHA-256 hash in `intelligence_staging_sessions`. Sessions have a 12-hour maximum lifetime and explicit revocation. Production `admin_sessions` and production `MEHRAN_OWNER_PI_UID` must not be reused.

## Runtime migration

Migration `0003_intelligence_staging_runtime.sql` adds:
- `intelligence_staging_sessions`
- `intelligence_staging_audit`
- `intelligence_staging_rate_limits`
- `intelligence_owner_memory`

It is committed but has not been applied to Cloudflare. Apply it only after confirming the staging database ID and target.

## Implemented route allowlist

- `GET /health`: checks all eight required tables.
- `POST /session`, `GET /session`, `DELETE /session`
- `GET/POST /intelligence/tasks`: creates and lists owner-scoped queued plans only; execution is disabled.
- `GET/POST /intelligence/knowledge`
- `GET/POST /intelligence/knowledge/relations`
- `PUT /intelligence/knowledge/relations/:id`: confirm, dismiss, or owner-selected conflict resolution.
- `GET/POST /intelligence/approvals`
- `DELETE /intelligence/approvals/:id`: revoke issued approvals.

There is no approval-consume endpoint and no task execution endpoint.

## Required security tests

Test missing owner UID, invalid/expired Pi token, wrong owner UID, hashed/revocable sessions, owner-scoped reads and writes, audit atomicity, fail-closed rate limits, missing-schema 503 behavior, approval expiry/revocation/duplicate issue, bounded request bodies, and static absence of cron/executor/production resources.

## Current status

The isolated Worker source and static safety tests are committed to PR33. The staging Wrangler config, live D1 migration 0003, Cloudflare binding, live Pi verification, and deployment are not done. The staging database ID is still required before the binding can be safely finalized.
