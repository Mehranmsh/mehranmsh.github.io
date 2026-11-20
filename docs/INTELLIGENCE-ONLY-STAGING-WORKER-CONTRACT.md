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
- `GET /intelligence/findings`, `GET /intelligence/findings/priority`, and the associated assessment, remediation-plan, dependency-impact, gap-test-strategy, evidence-review, correlation, consistency, and decision-support routes provide owner-scoped analysis; they do not execute checks or mutate company state.
- `GET/POST /intelligence/findings/priority-action-reviews`, `GET /intelligence/findings/priority-action-reviews/integrity`: append-only, owner-scoped human review records. POST recomputes the current owner-scoped action plan and rejects stale or foreign action keys; history and integrity queries filter by the authenticated owner. These reviews do not update findings or execute actions.
- The staging Worker exports only a `fetch` handler. It has no `scheduled` handler, queue consumer, task claimant, approval-consumption route, or task-execution route. Task creation records queued plans only.

There is no approval-consume endpoint and no task execution endpoint.

## Dedicated Pi staging session flow

- The Intelligence page has its own Connect with Pi flow and uses the official Pi SDK to obtain a short-lived access token for server-side verification.
- Before opening the Pi approval prompt, the UI calls the staging `/health` route and requires `schemaReady=true` and `executor=false`.
- The access token is sent only to the dedicated staging Worker's `POST /session`; it is not written to browser storage. Only the separate 12-hour staging bearer token is stored under `msh_intelligence_staging_session`.
- Session restoration and revocation use only the staging Worker's `GET/DELETE /session` routes. The staging token is never copied into production admin or SOCIAL storage.
- The frontend staging URL is intentionally an empty placeholder. Do not configure it until the staging Worker is deployed against the verified staging database and its owner UID secret and origin allowlist are confirmed.
- The Intelligence page no longer loads production admin overview or production project data. Its API namespace is routed only to the dedicated staging URL.
- Production MCP controls, scheduler history, and task-status mutation controls are absent from the staging UI. The Task Hub records plans only; it does not approve, claim, cancel, or execute them.
- The AI chat control is disabled and the staging Worker exposes no chat route or AI binding. Reconsider this only after a separate budget guard and AI integration review.

## Frontend connection boundary

- The shared dashboard API helper routes every `/intelligence/` request exclusively through `intelligenceStagingRequest`; it never sends those requests to the production `AUTH_WORKER`. The staging request helper fails closed unless the URL matches the dedicated HTTPS `mehran-intelligence-staging.*.workers.dev` hostname pattern.
- The production admin session token must never be reused as a staging Intelligence session. The staging Worker requires its own Pi `POST /session` verification and separately stored, revocable session token.
- Keep the dedicated-hostname allowlist and separate Pi-session lifecycle in place. Do not route Intelligence requests through the production Worker as a temporary workaround.
- Existing production admin and project API requests remain separate; this boundary applies specifically to the `/intelligence/` API namespace.

## Required security tests

Test missing owner UID, invalid/expired Pi token, wrong owner UID, hashed/revocable sessions, future/invalid session timestamps, strict JSON media types, owner-scoped reads and writes, audit atomicity, fail-closed rate limits, missing-schema 503 behavior, approval expiry/revocation/duplicate issue, bounded request bodies, database-level session/rate/memory constraints, and static absence of cron/executor/production resources.

## Current status

The isolated Worker, Wrangler staging config, expanded Intelligence review APIs, owner review ledgers, and D1-runtime test suite are present on open Draft PR119. The config still contains `REPLACE_WITH_VERIFIED_STAGING_DATABASE_ID`; the exact staging database ID has not been positively verified in this workflow. The owner previously applied migrations 0000-0002 manually; remote application status for migrations 0003-0013 is unverified and must be checked in the Cloudflare D1 console before any migration action. CI run `44656626336` for PR119 head `6f51a56555aea7b0c6c34ac9de6e0f843f9e9954` completed successfully; all 34 workflow steps passed using disposable test databases. Later commits may trigger new runs; always verify the latest head before treating it as validated. This does not establish live D1 schema state or live Pi authentication. Cloudflare binding, live Pi verification, and staging deployment are not done. No production database or Worker has been changed. PR119 remains Draft/open/unmerged.

## Owner memory routes

- `GET /intelligence/memory`: list only the authenticated owner's records.
- `POST /intelligence/memory`: create a bounded memory record.
- `PUT /intelligence/memory/:id`: update only an owner-owned record.
- `DELETE /intelligence/memory/:id`: delete only an owner-owned record.

Memory mutations are audited atomically with the data change; deletion audit records retain only the record identifier, not its content. No cross-owner or system-seed memory mutation route is exposed.
