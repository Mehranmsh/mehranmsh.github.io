# D1 validation runbook: MEHRAN INTELLIGENCE staging

## Safety boundary

This procedure applies only to the isolated, non-production D1 database named `mehran-msh-intelligence-staging`. The production database is `mehran-msh-db`; never select, modify, clone, or migrate it during staging work.

The production Worker configuration remains in `wrangler.jsonc` and must not be changed as part of this staging exercise.

## 1. Staging database and schema status

The owner created the separate D1 database `mehran-msh-intelligence-staging` and manually applied migrations 0000, 0001, and 0002 in order. The owner observed the four expected Intelligence tables, three triggers, and queried indexes. `PRAGMA foreign_keys;` returned `1` in the active SQL Console session and `PRAGMA foreign_key_check;` completed without violations.

Migration 0003, `migrations/0003_intelligence_staging_runtime.sql`, was subsequently added to the repository. It has **not** been applied to Cloudflare D1. It creates only isolated staging session, audit, rate-limit, and owner-memory tables. Do not apply it until the target database identity is confirmed.

The database ID has not yet been independently recorded in this repository, and no Worker has been bound to this database.

## 2. Repository validation

GitHub Actions run `44430782945` passed on the earlier PR33 head. The current branch has since gained additional runtime migration and test changes; their CI result must be checked separately before relying on them.

The disposable SQLite tests validate the ordered migration chain, idempotence, expected tables, foreign-key wiring, and regression checks. This is not a live D1 Worker integration test.

## 3. Worker isolation requirements

Do not point the existing full Worker at this staging database. The full Worker also serves unrelated SOCIAL/company routes and its Intelligence paths depend on shared admin authentication, `admin_audit_log`, rate limiting, AI budget accounting, Workers AI, and owner-memory storage.

Use a dedicated Intelligence-only staging Worker with independently reviewed owner authentication, audit, rate limiting, AI controls, and isolated storage. Do not copy production sessions, owner secrets, user records, AI budget rows, or audit history.

## 4. Live validation still required

After the isolated Worker is implemented and reviewed, live D1/API tests must cover owner authentication, owner isolation, audit atomicity, rate limiting, AI budget boundaries, approval issue/list/revoke/expiry/consume semantics, concurrent consume attempts, and relationship state transitions.

## Production boundary

Do not change the production `DB` binding, production secrets, production Worker, or cron. Do not deploy, merge, execute tasks, expose an executor, or activate an executor without separate explicit owner authorization.
