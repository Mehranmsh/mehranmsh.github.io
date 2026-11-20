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

Migrations 0000-0019 are committed on this draft branch. A read-only inventory of the separate staging D1 database found the four base tables (`intelligence_tasks`, `intelligence_knowledge`, `intelligence_approval_ledger`, and `intelligence_knowledge_relations`), their base indexes, and three base relationship triggers. The `d1_migrations` ledger table was absent. The inventory is strongly consistent with migrations 0000-0002 being present and migrations 0003-0013 not yet reflected in the schema; because there is no migration ledger, this is a schema-based assessment, not proof of exact migration history. Do not apply migrations based on inference. Re-verify the full schema and obtain explicit owner authorization before any remote migration action.

## Implemented route allowlist

- `GET /health`: public bootstrap check that validates all required tables, triggers, columns, the D1 foreign-key setting, and foreign-key violations; it also rejects any pre-existing task row that is not an unclaimed queued plan, including legacy claim metadata or action payloads. Returns 503 when the schema is incomplete, invalid, or contains execution-state residue. Requests are rate-limited per client IP (30 per 60-second window) so the unauthenticated bootstrap route cannot be used for unbounded schema-query load.
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
- Approval review and replacement first transition expired issued approvals to `expired`; a D1 trigger writes an audit event for each transition. Migration 0019 adds database-level consumption locks to both approval ledgers, so direct D1 writes cannot mark either ledger `consumed` while executor implementation remains unapproved. It adds legacy task/repository approval issuance and terminal timestamp guards, requires revocation strictly after issuance and before expiry in both ledgers, and makes health reject pre-existing consumed or invalid lifecycle rows.
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

The isolated Worker, Wrangler staging config, separate Pi staging-session flow, owner review APIs, and D1-runtime test suite are present on open Draft PR119. The config still contains `REPLACE_WITH_VERIFIED_STAGING_DATABASE_ID`; the exact staging database ID has not been positively verified in this workflow. The current read-only staging D1 schema inventory is documented above; the missing migration ledger prevents definitive migration-history claims. The latest recorded GitHub Actions run must always be checked against the current PR head; CI uses disposable test databases and does not establish live D1 schema state or live Pi authentication. The staging Worker URL remains intentionally empty in the frontend. Cloudflare binding, owner UID secret provisioning, live Pi verification, and staging deployment are not done. No production database or Worker has been changed. PR119 remains Draft/open/unmerged.

## Owner memory routes

- `GET /intelligence/memory`: list only the authenticated owner's records, with active/archived/all filters and bounded pagination.
- `POST /intelligence/memory`: create a bounded memory record with validated provenance and an atomic audit record.
- `GET /intelligence/memory/review-queue`: list the authenticated owner's unreviewed or disputed active records.
- `PUT /intelligence/memory/:id`: update category/content, or perform the explicit owner review transitions `confirm`, `dispute`, `unverify`, `archive`, and `restore`. Every successful mutation is owner-scoped and committed atomically with its audit record. Archive is reversible.
- `DELETE /intelligence/memory/:id`: deliberately fails closed with HTTP 403. Permanent deletion remains disabled; approval records are not an authorization path for deletion. The `memory.delete` capability is absent from the policy and Worker allowlists. Migration 0016 adds a D1 insert trigger that rejects it even for direct SQL writes, and `/health` fails closed if a legacy row with a disallowed capability exists. There is no approval-consumption route. Migration 0017 makes the shared audit table append-only at the database layer and rejects future-dated, pre-issue, or premature terminal Approval timestamps. `/health` also checks for invalid legacy Approval lifecycle rows and requires these triggers. Migration 0018 protects capability-approval issuance timestamps. Migration 0019 blocks consumption in both approval ledgers and adds server-time issuance, revocation, and expiry guards to the legacy task/repository ledger, with revocation bounded to the interval before expiry in both ledgers. `/health` requires all five new triggers and returns 503 if it detects a consumed row or invalid legacy lifecycle timestamps.

No cross-owner memory mutation route is exposed.


## Human owner actions versus AI/agent capabilities

The current write APIs are owner-facing controls, not agent tools. Every route other than the public bootstrap/session routes passes the shared verifySession gate before route dispatch. The session is issued only after server-side Pi identity verification and a match to the separately configured staging owner UID. Mutating SQL statements additionally bind the authenticated owner.uid; caller-supplied owner IDs are not accepted as authority.

Accordingly, the authenticated owner may manually create or review knowledge and memory, manage relationships, and archive/restore records through the owner UI. These actions are audited and owner-scoped. They do not represent autonomous AI permission and do not consume capability approvals.

The capability policy is reserved for assessing future AI/agent-delegated requests. POST /intelligence/capabilities/evaluate loads any presented approval from D1 and returns an assessment only. It does not authorize a direct route, consume an approval, or perform the requested operation. Approval-tier labels therefore must not be described as a live approval gate on the owner's direct manual routes.

There is currently no agent runtime, agent credential/session, agent polling route, tool bridge, approval-consumption route, or task-execution route in the staging Worker. The owner session must never be handed to an AI/agent. Before any future AI integration, add a separate agent identity and server-enforced capability boundary; do not reuse the owner's bearer token. Keep EXECUTION_ENABLED=false.


## Owner-entered provenance limits

Owner-facing create routes accept only provenance that the current interface can substantiate:

- Memory accepts `owner_input` and an owner-scoped `knowledge_record` link. It does not accept `system_observation`.
- Knowledge accepts `owner_input` and validated HTTPS `external_url`. It does not accept `system_observation` or `uploaded_document` until a server-verified observation or document-ingestion pipeline exists.
- A manual owner payload cannot label its own content as a system observation or as an uploaded file. Such records require a future trusted server-side ingestion path with independently verified provenance.
