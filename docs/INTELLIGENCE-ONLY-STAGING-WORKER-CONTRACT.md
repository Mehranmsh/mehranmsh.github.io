# INTELLIGENCE-only staging Worker: implementation contract

## Decision

Build a separate, minimal Worker for staging. Do not deploy production `worker.js` with a different D1 binding. The production Worker has shared route preflight, SOCIAL bootstrap, a scheduled handler, and agent polling/result routes.

## Runtime boundary

- Proposed Worker name: `mehran-intelligence-staging`.
- Separate config: `wrangler.intelligence-staging.jsonc`, not production `wrangler.jsonc`.
- D1 binding `DB` must target only `mehran-msh-intelligence-staging`.
- No cron, scheduled handler, queue consumer, agent polling, executor, or GitHub write capability.
- No production secrets, tokens, database IDs, or data.
- AI binding only after an isolated budget guard is implemented and reviewed.

## Authentication

Verify Pi access tokens server-side through the Pi Platform `/v2/me` endpoint. Never trust a client-supplied UID or username. Compare the verified UID with a separately provisioned staging-only owner UID. Fail closed if the owner UID is absent or verification fails.

Issue a cryptographically random bearer token only after verification. Store only its SHA-256 hash in `intelligence_staging_sessions`. Sessions have a bounded lifetime and explicit revocation. Production `admin_sessions` and production `MEHRAN_OWNER_PI_UID` must not be reused.

## Runtime migration

Migration `0003_intelligence_staging_runtime.sql` adds:
- `intelligence_staging_sessions`
- `intelligence_staging_audit`
- `intelligence_staging_rate_limits`
- `intelligence_owner_memory`

It is a repository migration only and has not yet been applied to Cloudflare. Apply it only after confirming the staging database ID and target.

## First route allowlist

- `GET /health`
- `POST /session`, `GET /session`, `DELETE /session`
- Owner-scoped knowledge and relationship review routes
- Owner-scoped approval ledger routes

No task-claim, scheduler, agent, MCP, deployment, payment, repository-write, or executor routes belong in this first Worker.

## Required security tests

Test missing owner UID, invalid/expired Pi token, wrong owner UID, hashed/revocable sessions, owner-scoped reads and writes, audit atomicity, fail-closed rate limits, missing-schema 503 behavior, approval expiry/revocation/duplicate/concurrent consume, bounded request bodies, and static absence of cron/executor/production bindings.

## Current status

The runtime migration and SQLite tests are committed to the PR branch. No staging Worker code, staging config, live D1 migration 0003, or deployment has been created/performed yet. The staging database ID is still needed before a binding can be safely finalized.
