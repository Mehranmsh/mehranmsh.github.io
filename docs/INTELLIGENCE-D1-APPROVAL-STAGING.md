# D1 validation runbook: Intelligence approval ledger

## Safety boundary

This branch adds a repeatable schema migration and verification guidance only. It does not bind a staging database, change the production Worker, run a migration, or create approval records.

**Never run this migration against `mehran-msh-db` for testing.** The production Worker currently points to that database. Create a separate D1 database (for example, `mehran-msh-approval-staging`) and use a separate staging Worker environment/binding before running any integration test.

## Apply to an isolated database

1. Create a new D1 database in the Cloudflare dashboard. Do not reuse or clone production credentials.
2. Create a staging Worker environment with a D1 binding named `DB` that points only to the new database. Keep production bindings unchanged.
3. Ensure the staging database has the prerequisite `intelligence_tasks` table with the same primary-key type and semantics as the application schema.
4. Apply `migrations/0001_intelligence_approval_ledger.sql` to the staging database using the Cloudflare D1 migration workflow.
5. Inspect `PRAGMA table_info(intelligence_approval_ledger)`, `PRAGMA foreign_key_list(intelligence_approval_ledger)`, and `PRAGMA index_list(intelligence_approval_ledger)`. Verify the partial unique index exists.
6. Run the lifecycle integration tests only against staging: issue, owner-scoped list, revoke, expiry, duplicate active grant rejection, wrong-owner rejection, invalid task rejection, and exactly-one successful consume under concurrent attempts.
7. Verify the task foreign key is enforced by attempting an insert with a nonexistent task ID inside a rollback-safe test transaction or disposable test database.

## Schema parity

The SQL intentionally mirrors `ensureIntelligenceApprovalLedgerTable` in `worker.js`. Both paths use the same columns, status constraint, foreign key, two lookup indexes, and partial unique index. `IF NOT EXISTS` makes applying the migration before the Worker's lazy bootstrap safe.

## Not yet validated

No staging D1 database has been created or connected by this change. No migration has been applied, and no lifecycle integration test has been run against D1. Do not describe the approval ledger as end-to-end tested until those steps pass.

## Production boundary

Do not change the production `DB` binding, run `wrangler d1 migrations apply` against `mehran-msh-db`, deploy the Worker, expose a consume route, or enable a code executor as part of this staging exercise. Those require separate review and explicit owner authorization.
