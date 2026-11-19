# D1 validation runbook: MEHRAN INTELLIGENCE staging

## Safety boundary

This procedure applies only to the isolated, non-production D1 database named `mehran-msh-intelligence-staging`. The production database is `mehran-msh-db`; never select, modify, clone, or migrate it during staging work.

The production Worker configuration remains in `wrangler.jsonc` and must not be changed as part of this staging exercise.

## 1. Staging database and schema status

The owner created the separate D1 database `mehran-msh-intelligence-staging` and manually applied these migrations in order:

1. `migrations/0000_intelligence_staging_baseline.sql`
2. `migrations/0001_intelligence_approval_ledger.sql`
3. `migrations/0002_intelligence_knowledge_relations.sql`

The owner observed the four expected tables (`intelligence_tasks`, `intelligence_knowledge`, `intelligence_approval_ledger`, and `intelligence_knowledge_relations`) and three relationship/ownership triggers. The inspected indexes included `idx_intelligence_approval_active_task` and `idx_intelligence_knowledge_relation_unique`.

The owner also reported:
- `PRAGMA foreign_keys;` returned `1` in the active SQL Console session.
- `PRAGMA foreign_key_check;` completed without reporting violations.

These are owner-reported Cloudflare Console observations. The database ID has not yet been independently recorded in this repository, and the Worker has not been bound to this database.

## 2. Repository validation

GitHub Actions run `44430782945` passed on the latest PR33 head commit `d297334d8a03a2ab37deb212dd802b366be2f4cd`.

The disposable SQLite tests verify the ordered migration chain, idempotence, expected tables, foreign-key wiring, and regression checks. This is useful schema-contract coverage, but it is not a live D1 Worker integration test.

## 3. Worker isolation requirements

Do not point the existing full Worker at this four-table staging database. The full Worker also serves unrelated SOCIAL/company routes and its Intelligence paths depend on shared admin authentication, `admin_audit_log`, rate limiting, AI budget accounting, Workers AI, and owner-memory storage.

Before a staging Worker can be deployed, its architecture must be reviewed. It must be either:
- a dedicated Intelligence-only Worker with independently reviewed owner authentication, audit, rate limiting, AI controls, and isolated storage; or
- a complete isolated staging environment with every required dependency and non-production credentials, containing no production data.

Any staging Worker must have a separate Worker name and config, a binding that points only to `mehran-msh-intelligence-staging`, no production cron, no production secrets, and no executor activation.

## 4. Live validation still required

After the isolated Worker architecture is implemented and reviewed, live D1/API tests must cover:
- owner authentication and strict owner-data isolation;
- audit atomicity and fail-closed behavior;
- rate limiting and AI budget boundaries;
- approval issue, owner-scoped list, revoke, expiry, duplicate-active-grant rejection, invalid-task rejection, and exactly-one successful consume under concurrent attempts;
- relationship API ownership and state-transition rules.

The staging database schema being present does not mean these live API lifecycle tests have passed.

## Production boundary

Do not change the production `DB` binding, production secrets, production Worker, or cron. Do not deploy, merge, execute tasks, expose an executor, or activate an executor as part of this staging exercise without a separate explicit owner authorization.
