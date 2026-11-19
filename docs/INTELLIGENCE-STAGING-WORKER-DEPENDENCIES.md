# INTELLIGENCE staging Worker dependency review

## Purpose

This is a safety inventory before creating or deploying a separate staging Worker. The four-table Intelligence schema baseline is not, by itself, a complete Worker database.

## Confirmed from the current Worker route implementation

The Intelligence routes use the shared `env.DB` binding and depend on shared application infrastructure beyond the Intelligence tables:

- **Route preflight:** requests under `/admin/`, `/intelligence/`, and `/mcp` first call `ensureSocialTables(env)` and `ensureAdminSessionTable(env)`. This is a direct dependency on shared SOCIAL schema/bootstrap code before Intelligence route handling.
- **Owner/admin authentication:** `verifyAdmin` reads `admin_sessions`, validates the bearer-token hash, checks revocation/expiry and the 12-hour session age, and fails closed unless `MEHRAN_OWNER_PI_UID` is configured and matches the session UID. The username alone is not an owner credential.
- **Admin audit:** `writeAdminAudit` writes to `admin_audit_log`; several Intelligence mutations also write audit rows in the same D1 batch as the mutation.
- **Rate limiting:** `checkRateLimit` uses shared database-backed limits and is called throughout the Intelligence routes.
- **AI budget reservation:** `reserveSocialWorkersAIBudget` calls `ensureSocialTables` and reserves from `workers_ai_daily_budget`, with a distinct Intelligence budget cap.
- **Workers AI:** chat/model routes use `env.AI`.
- **Owner memory:** `intelligence_owner_memory` is created through `ensureIntelligenceMemoryTable` and is not one of the four tables in the staging migration chain.
- **Intelligence data:** `intelligence_knowledge`, `intelligence_tasks`, `intelligence_approval_ledger`, and `intelligence_knowledge_relations`.

The Worker also includes unrelated SOCIAL and company routes that use the same DB binding. Pointing the existing full Worker at a newly-created database containing only the four Intelligence tables is therefore not a valid staging deployment plan. Even the route preflight bootstraps shared SOCIAL and admin-session schema before the Intelligence handler runs.

## Architecture decision required before deployment

Do not copy production admin sessions, owner secrets, user records, AI budget rows, or audit history into staging. Do not point staging at the production database to borrow authentication or shared tables.

The preferred direction is a dedicated Intelligence-only staging Worker with:
- a deliberately small route allowlist, rather than the full production Worker router;
- a separately reviewed owner-authentication flow and staging-only session store;
- independent audit and rate-limit tables;
- a staging-only AI budget guard and explicitly configured AI binding;
- the four Intelligence migrations plus a reviewed owner-memory migration;
- no agent polling/result endpoints and no task execution path until separately authorized.

A complete isolated copy of all shared dependencies is an alternative, but it is larger, harder to review, and must contain no production data. Either approach requires its own security review before deployment.

## Staging safety requirements

1. Keep production `wrangler.jsonc`, production Worker, production D1 database `mehran-msh-db`, its AI binding, and its cron unchanged.
2. Do not bind the production Worker to the staging D1 database.
3. Do not deploy the full Worker against the four-table staging database.
4. Any new staging Worker must have its own name and config, its own D1 binding, no production cron, no production secrets, and no executor activation.
5. Live tests must prove owner isolation, audit atomicity, rate limiting, AI budget boundaries, approval issue/revoke/expiry/consume behavior, and fail-closed behavior before the staging environment is considered validated.

## Current validation status

- The owner created the isolated D1 database named `mehran-msh-intelligence-staging` and manually applied migrations 0000, 0001, and 0002 in order.
- The owner observed the four expected Intelligence tables, three triggers, and the two queried indexes.
- `PRAGMA foreign_keys` returned `1` in the active Console session.
- `PRAGMA foreign_key_check` completed without reporting violations.
- GitHub Actions run `44430782945` passed on PR33 head `d297334d8a03a2ab37deb212dd802b366be2f4cd`.
- These observations validate the schema setup and repository CI contract only. They do not validate a deployed staging Worker or live API lifecycle.

## Explicitly not authorized or performed

No production database changes, production Worker binding changes, secret changes, Worker deployment, cron changes, task execution, merge, or executor activation have been performed by this review.
