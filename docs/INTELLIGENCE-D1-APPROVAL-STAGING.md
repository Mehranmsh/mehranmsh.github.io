# D1 validation runbook: MEHRAN INTELLIGENCE staging

## Safety boundary

This procedure applies only to the isolated, non-production D1 database named `mehran-msh-intelligence-staging`. The production database is `mehran-msh-db`; never select, modify, clone, or migrate it during staging work.

The production Worker configuration remains in `wrangler.jsonc` and must not be changed as part of this staging exercise.

## 1. Staging database and schema status

The owner created the separate D1 database `mehran-msh-intelligence-staging` and manually applied migrations 0000, 0001, and 0002 in order. The owner observed the four expected Intelligence tables, three triggers, and queried indexes. `PRAGMA foreign_keys;` returned `1` in the active SQL Console session and `PRAGMA foreign_key_check;` completed without violations.

Migrations 0003 through 0019 are present in the current draft branch, including owner-identity immutability (0014), task-execution lockout (0015), database-enforced capability approval allowlist (0016), append-only audit history and capability terminal timestamp guards (0017), capability approval issuance guard (0018), and dual-ledger consumption lock plus legacy approval issuance/revocation/expiry timestamp guards (0019). The owner previously applied 0000, 0001, and 0002 manually; there is no verified record in this workflow that 0003 through 0019 have been applied remotely. The exact staging database ID is still unverified, and the staging Worker has not been deployed or bound to D1. Do not infer remote schema state from the disposable SQLite CI tests.

## 2. Isolated Worker implementation

A separate Worker source file now exists at `intelligence-staging-worker.js`. It is not the production Worker and is not deployed.

Implemented routes:
- `GET /health`: verifies all 15 required tables, D1 foreign-key enforcement, and zero foreign-key violations.
- `POST/GET/DELETE /session`: server-side Pi identity verification, hashed bearer sessions, expiry and revocation.
- `GET/POST /intelligence/tasks`: owner-scoped task planning only. New tasks remain queued; response explicitly reports `executionEnabled: false`.
- Owner-scoped knowledge list/create with source type, source reference, observed timestamp, confidence assessment, and explicit owner verification/dispute/reset actions.
- Owner-scoped knowledge relationship list/propose/confirm/dismiss/resolve.
- Approval ledger list/issue/revoke. There is no consume/executor endpoint.

The Worker has bounded JSON bodies, origin restrictions, security headers, rate limiting, owner-scoped SQL, and atomic D1 batches for writes plus audit records. AI binding, cron, scheduler, task claiming, agent polling, GitHub writes, and executor are intentionally absent.

## 3. Repository validation

The disposable SQLite migration tests validate the ordered migration chain through 0019, idempotence, expected tables, foreign-key wiring, runtime support tables, both approval-ledger consumption locks, and legacy approval timestamp guards. A dedicated static Worker safety test checks Pi verification, hashed sessions, expiry/revocation, owner scoping, audit batching, bounded bodies, rate limits, and absence of production bindings/executor code. The general quality check also parses the staging Worker JavaScript.

These are repository-level checks, not a live D1 or Pi Browser integration test. The latest fully successful PR119 CI run verified here is `44791229938` for head `ef3a585b8ccd8b52152000699c8be6f8a282faa4`; all 35 workflow steps completed successfully, including the dual-ledger D1 consumption-lock test, staging Worker health/runtime tests, and the complete disposable SQLite migration chain through 0019. This does not establish the remote D1 migration state or live Pi Browser integration.

## 4. Remaining staging steps

1. Confirm the exact ID of `mehran-msh-intelligence-staging` independently before any staging deployment.
2. Verify the existing `wrangler.intelligence-staging.jsonc` still points only to the staging database name and replace its placeholder ID only after independent verification.
3. Confirm the actual remote migration state before applying any missing migrations from 0003 through 0019, in order, and only after explicit owner authorization.
4. Configure a staging-only owner UID secret; never reuse the production owner secret.
5. Deploy only after explicit owner authorization and complete code review.
6. Run live Pi token, session, owner isolation, audit atomicity, rate-limit, knowledge/relationship, and approval issue/revoke/expiry tests.

## Production boundary

Do not change the production `DB` binding, production secrets, production Worker, or cron. Do not merge, deploy, execute tasks, expose an executor, or activate an executor without separate explicit owner authorization.


## Owner memory API

The isolated Worker exposes owner-scoped `GET /intelligence/memory`, `POST /intelligence/memory`, `GET /intelligence/memory/review-queue`, and `PUT /intelligence/memory/:id`. PUT supports bounded category/content edits and the explicit `confirm`, `dispute`, `unverify`, `archive`, and `restore` transitions. Successful create/update/review/archive/restore operations are paired with audit records in the same D1 batch. Memory content is bounded to 4,000 characters per record. Archiving is reversible.

`DELETE /intelligence/memory/:id` is recognized but intentionally returns HTTP 403 without changing data. The `memory.delete` capability is absent from the Worker and policy allowlists. Migration 0016 rejects direct D1 insertion of that capability, and the health endpoint fails closed if a legacy disallowed capability record exists. Permanent deletion remains disabled. Migration 0017 makes `intelligence_staging_audit` append-only and adds database guards against future-dated, pre-issue, or premature terminal Approval timestamps. Migration 0018 rejects capability approvals whose `issued_at` is in the future or invalid, and whose expiry exceeds the allowed lifetime. Health requires both guards and rejects legacy rows with future-dated or invalid issuance timestamps. Runtime tests exercise direct D1 rejection, append-only audit enforcement, and fail-closed health behavior for legacy future-dated rows. Migration 0019 adds database-enforced consumption locks to both `intelligence_approval_ledger` and `intelligence_capability_approvals`; neither can transition to `consumed` until a separately reviewed executor design is approved. It also applies server-time issuance and terminal timestamp guards to the legacy task/repository ledger. The staging health route requires all five new triggers and fails closed if either ledger contains a consumed row or invalid lifecycle timestamps. A dedicated D1 runtime test verifies the lock and timestamp behavior against both ledgers.


## Human owner actions versus AI/agent capabilities

The staging Worker distinguishes the owner acting directly from a future AI/agent acting under delegated authority:

- Direct owner mutations are available only after the shared Pi-verified staging owner-session gate. SQL reads and writes are scoped to the authenticated owner.uid, and successful mutations are audited atomically.
- The owner may manually create/edit/review/archive/restore their own knowledge and memory records. These are explicit owner actions, not autonomous agent operations.
- Capability approval records currently support policy assessment only. POST /intelligence/capabilities/evaluate loads an approval from D1 when supplied, but never consumes it or performs a write.
- The policy's approval tier describes the future AI/agent delegation boundary. It is not currently enforced as an extra approval step on the owner's direct manual routes.
- No agent runtime, agent credential/session, agent polling route, tool bridge, approval-consumption route, or task-execution route exists. Never give the owner bearer session to an AI/agent. A future agent integration must use a separate identity and a server-enforced, one-time capability approval flow.

This distinction is intentional: the owner can operate the private staging workspace directly, while Intelligence itself remains unable to exercise those privileges autonomously. EXECUTION_ENABLED=false remains mandatory.


## Provenance cannot be self-asserted as system output

The current owner forms and API cannot create records labelled `system_observation`. Knowledge creation also rejects `uploaded_document` until a server-verified upload ingestion path exists. Current accepted manual sources are owner input, owner-linked knowledge records for memory, and validated HTTPS URLs for knowledge. Future system observations and uploaded documents must be created only by dedicated trusted server-side ingestion paths, never by accepting a client-supplied source label.
