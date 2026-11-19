# INTELLIGENCE staging Worker dependency review

## Purpose

This is a safety inventory before creating or deploying a separate staging Worker. The four-table Intelligence schema baseline is not, by itself, a complete Worker database.

## Confirmed from the current Worker route implementation

The Intelligence routes use the shared `env.DB` binding and depend on shared application infrastructure beyond the Intelligence tables:

- Owner/admin authentication and an authenticated admin identity (`admin.uid`, `admin.username`).
- Admin audit writes through `writeAdminAudit` and the `admin_audit_log` table.
- Rate limiting through `checkRateLimit`.
- Shared Workers AI budget reservation through `reserveSocialWorkersAIBudget`.
- Workers AI binding `env.AI` for the chat/model path.
- Owner memory storage (`intelligence_owner_memory`), created through its existing helper.
- Knowledge storage (`intelligence_knowledge`) and task storage (`intelligence_tasks`).
- Approval ledger storage (`intelligence_approval_ledger`).
- Knowledge relationship storage (`intelligence_knowledge_relations`).

The Worker also includes unrelated SOCIAL and company routes that use the same DB binding. Pointing the existing full Worker at a newly-created database containing only the four Intelligence tables is therefore not a valid staging deployment plan.

## Staging safety requirements

1. Keep production `wrangler.jsonc`, production Worker, production D1 database `mehran-msh-db`, its AI binding, and its cron unchanged.
2. Do not bind the production Worker to the staging D1 database.
3. Do not deploy the full Worker against the four-table staging database.
4. Before any staging Worker deployment, choose and review one of these architectures:
   - A dedicated Intelligence-only Worker with explicitly scoped routes and a separately reviewed authentication/audit/rate-limit implementation; or
   - A complete isolated staging environment containing every required shared dependency, with non-production credentials and no production data.
5. Any new staging Worker must have its own name and config, its own D1 binding, no production cron, no production secrets, and no executor activation.
6. Live tests must prove owner isolation, audit atomicity, rate limiting, approval issue/revoke/expiry/consume behavior, and fail-closed behavior before the staging environment is considered validated.

## Current validation status

- The isolated D1 schema migrations were manually applied by the owner to the database named `mehran-msh-intelligence-staging`.
- The owner observed all four expected tables, three triggers, and the two queried indexes.
- `PRAGMA foreign_keys` returned `1` in the active Console session.
- `PRAGMA foreign_key_check` executed without reporting violations.
- GitHub Actions run `44430540145` passed the repository's disposable SQLite migration-chain and regression checks.
- These observations validate the schema setup and local CI contract only. They do not validate a deployed staging Worker, live API lifecycle, or production readiness.

## Explicitly not authorized or performed

No production database changes, production Worker binding changes, secret changes, Worker deployment, cron changes, task execution, GitHub write execution, merge, or executor activation have been performed by this review.
