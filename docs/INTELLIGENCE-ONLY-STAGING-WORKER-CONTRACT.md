# INTELLIGENCE-only staging Worker: implementation contract

## Decision

Use a separate, minimal Worker. Do not deploy production `worker.js` with a different D1 binding. The production Worker has shared route preflight, SOCIAL bootstrap, a scheduled handler, and agent polling/result routes.

## Runtime boundary

- Worker source: `intelligence-staging-worker.js`.
- Worker name: `mehran-intelligence-staging`.
- Separate config: `wrangler.intelligence-staging.jsonc`; never use production `wrangler.jsonc`.
- D1 binding `DB` must target only `mehran-msh-intelligence-staging`.
- The config currently contains an unmistakable placeholder for `database_id`. It is intentionally not deployable until replaced with the verified staging database ID.
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
- `trg_intelligence_knowledge_content_immutable_with_relations`, which prevents in-place edits to evidence-linked knowledge; corrected facts must be new records with explicit relationships.

Migration 0004 `0004_intelligence_knowledge_provenance.sql` adds source type/reference, observation timestamp, bounded confidence score, and owner verification status. It enforces provenance validation and prevents rewriting provenance after evidence relationships exist while allowing separate owner review transitions.

Migrations 0000-0013 are committed on this draft branch. The owner manually applied migrations 0000-0002 to the separate staging D1 database. Remote application status for migrations 0003-0013 is unverified; do not assume they are either applied or unapplied. Verify the remote migration ledger before considering any change, and require explicit owner authorization.

## Implemented route allowlist

- `GET /health`: checks all 15 required tables, verifies the D1 foreign-key setting and checks for foreign-key violations; returns 503 when the schema is incomplete or invalid.
- `POST /session`, `GET /session`, `DELETE /session`
- `GET/POST /intelligence/tasks`: creates and lists owner-scoped queued plans only; execution is disabled.
- `GET /intelligence/capabilities`: returns the static capability policy inventory only.
- `GET/POST /intelligence/capability-approvals`, `DELETE /intelligence/capability-approvals/:id`, and `POST /intelligence/capabilities/evaluate`: owner-scoped approval records and audited assessment only. Evaluation never consumes an approval or performs an operation; `executionEnabled` remains false.
- `GET/POST /intelligence/knowledge`: GET accepts `state=active` (default), `state=archived`, or `state=all`, always scoped to the authenticated owner.
- `PUT /intelligence/knowledge/:id`: owner-scoped metadata/content update, archive, restore, and explicit `verify` / `dispute` / `unverify` review transitions. Provenance fields are returned on reads and accepted on create; linked provenance cannot be rewritten. Content edits are blocked when a relationship cites that record; create a corrected record and link it instead so evidence history is preserved.
- `GET/POST /intelligence/knowledge/relations`
- `PUT /intelligence/knowledge/relations/:id`: confirm, dismiss, or owner-selected conflict resolution.
- `GET/POST /intelligence/approvals`
- `DELETE /intelligence/approvals/:id`: revoke issued approvals.
- Approval review and replacement first transition expired issued approvals to `expired`; a D1 trigger writes an audit event for each transition.
- D1 rejects approval rows with empty/non-object/invalid JSON scope, scope JSON over 4 KB, or a lifetime outside the allowed one-hour maximum. The Worker also requires a non-empty bounded scope object.

There is no approval-consume endpoint and no task execution endpoint.

## Required security tests

Test missing owner UID, invalid/expired Pi token, wrong owner UID, hashed/revocable sessions, future/invalid session timestamps, strict JSON media types, owner-scoped reads and writes, audit atomicity, fail-closed rate limits, missing-schema 503 behavior, approval expiry/revocation/duplicate issue, bounded request bodies, database-level session/rate/memory constraints, and static absence of cron/executor/production resources.

## Current status

The isolated Worker, Wrangler staging config, expanded Intelligence review APIs, owner review ledgers, and D1-runtime test suite are present on open Draft PR119. The config still contains `REPLACE_WITH_VERIFIED_STAGING_DATABASE_ID`; the exact staging database ID has not been positively verified in this workflow. The owner previously applied migrations 0000-0002 manually; remote application status for migrations 0003-0013 is unverified and must be checked in the Cloudflare D1 console before any migration action. CI for the current PR119 head `fe55fbcb617e733865d27d61e0317c0fe500ac95` completed successfully (34/34 checks) using disposable test databases. This does not establish live D1 schema state or live Pi authentication. This does not establish live D1 schema state or live Pi authentication. Cloudflare binding, live Pi verification, and staging deployment are not done. No production database or Worker has been changed. PR119 remains Draft/open/unmerged.

## Owner memory routes

- `GET /intelligence/memory`: list only the authenticated owner's records.
- `POST /intelligence/memory`: create a bounded memory record.
- `PUT /intelligence/memory/:id`: update only an owner-owned record.
- `DELETE /intelligence/memory/:id`: delete only an owner-owned record.

Memory mutations are audited atomically with the data change; deletion audit records retain only the record identifier, not its content. No cross-owner or system-seed memory mutation route is exposed.
