# D1 validation runbook: MEHRAN INTELLIGENCE staging

## Safety boundary

This procedure applies only to the isolated, non-production D1 database named `mehran-msh-intelligence-staging`. The production database is `mehran-msh-db`; never select, modify, clone, or migrate it during staging work.

The production Worker configuration remains in `wrangler.jsonc` and must not be changed as part of this staging exercise.

## 1. Staging database and schema status

The owner created the separate D1 database `mehran-msh-intelligence-staging` and manually applied migrations 0000, 0001, and 0002 in order. The owner observed the four expected Intelligence tables, three triggers, and queried indexes. `PRAGMA foreign_keys;` returned `1` in the active SQL Console session and `PRAGMA foreign_key_check;` completed without violations.

Migrations 0003, 0004, and 0005 are committed but have **not** been applied to Cloudflare D1. Migration 0003 creates isolated staging sessions, audit, rate-limit, and owner-memory tables. Migration 0004 adds bounded knowledge provenance fields and database-level provenance guards. Migration 0005 adds private projects, task-to-project association, and dependency constraints. Apply them in order only after the target database ID is confirmed.

The staging database ID has not yet been independently recorded. No Worker has been bound to it.

## 2. Isolated Worker implementation

A separate Worker source file now exists at `intelligence-staging-worker.js`. It is not the production Worker and is not deployed.

Implemented routes:
- `GET /health`: verifies the complete eight-table schema.
- `POST/GET/DELETE /session`: server-side Pi identity verification, hashed bearer sessions, expiry and revocation.
- `GET/POST /intelligence/tasks`: owner-scoped task planning only. New tasks remain queued; response explicitly reports `executionEnabled: false`.
- Owner-scoped knowledge list/create with source type, source reference, observed timestamp, confidence assessment, and explicit owner verification/dispute/reset actions.
- Owner-scoped knowledge relationship list/propose/confirm/dismiss/resolve.
- Approval ledger list/issue/revoke. There is no consume/executor endpoint.

The Worker has bounded JSON bodies, origin restrictions, security headers, rate limiting, owner-scoped SQL, and atomic D1 batches for writes plus audit records. AI binding, cron, scheduler, task claiming, agent polling, GitHub writes, and executor are intentionally absent.

## 3. Repository validation

The disposable SQLite migration tests validate the ordered migration chain, idempotence, expected tables, foreign-key wiring, and runtime support tables. A dedicated static Worker safety test checks Pi verification, hashed sessions, expiry/revocation, owner scoping, audit batching, bounded bodies, rate limits, and absence of production bindings/executor code. The general quality check also parses the staging Worker JavaScript.

These are repository-level checks, not a live D1 or Pi Browser integration test. The newest CI run must be checked after the latest commit before calling this code validated.

## 4. Remaining staging steps

1. Confirm the exact ID of `mehran-msh-intelligence-staging`.
2. Create a separate `wrangler.intelligence-staging.jsonc` using only that ID and a separate Worker name.
3. Apply migrations 0003, 0004, and 0005 in order, only to that confirmed staging database, and only after separate explicit authorization for each live migration operation.
4. Configure a staging-only owner UID secret; never reuse the production owner secret.
5. Deploy only after explicit owner authorization and complete code review.
6. Run live Pi token, session, owner isolation, audit atomicity, rate-limit, knowledge/relationship, and approval issue/revoke/expiry tests.

## Production boundary

Do not change the production `DB` binding, production secrets, production Worker, or cron. Do not merge, deploy, execute tasks, expose an executor, or activate an executor without separate explicit owner authorization.


## Owner memory API

The isolated Worker exposes owner-scoped `GET/POST /intelligence/memory` and `PUT /intelligence/memory/:id` routes. Each write is paired with an audit record in the same D1 batch. Memory content is bounded to 4,000 characters per record.
