# D1 validation runbook: MEHRAN INTELLIGENCE staging

## Safety boundary

This procedure is for a completely separate, empty, non-production D1 database. The production database is named `mehran-msh-db` and must not be selected, modified, cloned, or migrated during this exercise.

The staging baseline contains only empty prerequisite tables. It creates no admin, owner, session, task, knowledge, approval, or relationship records.

## 1. Create the isolated database

1. Open the Cloudflare dashboard and select the account that owns the MEHRAN Worker.
2. Open **Workers & Pages → D1 SQL Database** (the menu wording may vary).
3. Choose **Create database**.
4. Set the database name to `mehran-msh-intelligence-staging`.
5. Before confirming, verify the name is not `mehran-msh-db`.
6. Create it. Do not change any Worker binding or environment.

At this point, stop and verify the database name in the D1 database list. The production Worker must remain bound to its existing database.

## 2. Apply the staging-only schema in order

Open the new staging database's SQL console and execute the complete contents of these files, one at a time, in this exact order:

1. `migrations/0000_intelligence_staging_baseline.sql`
2. `migrations/0001_intelligence_approval_ledger.sql`
3. `migrations/0002_intelligence_knowledge_relations.sql`

The first file creates only the prerequisite `intelligence_tasks` and `intelligence_knowledge` tables and their lookup indexes. The next files add the approval ledger and knowledge relationships. Do not execute these files in the production database.

## 3. Verify schema

In the staging SQL console, run:

```sql
PRAGMA foreign_keys;
PRAGMA table_info(intelligence_tasks);
PRAGMA table_info(intelligence_knowledge);
PRAGMA table_info(intelligence_approval_ledger);
PRAGMA table_info(intelligence_knowledge_relations);
PRAGMA foreign_key_list(intelligence_approval_ledger);
PRAGMA foreign_key_list(intelligence_knowledge_relations);
PRAGMA index_list(intelligence_approval_ledger);
PRAGMA index_list(intelligence_knowledge_relations);
PRAGMA foreign_key_check;
```

Confirm the approval ledger references `intelligence_tasks`, the relationship table references `intelligence_knowledge`, the partial unique approval index exists, and `foreign_key_check` returns no rows.

## 4. Current validation boundary

The repository's disposable SQLite suite verifies the ordered migration chain, idempotence, schema presence, and foreign-key wiring. It is not a substitute for a live D1 test.

No staging D1 database has yet been created or connected by this code change. No migration has been applied to Cloudflare. Do not describe the system as end-to-end D1 validated until the owner has completed the isolated steps and the live lifecycle tests pass.

## Production boundary

Do not bind the staging database to the production Worker, change production secrets, deploy a Worker, or run any migration against `mehran-msh-db`. Staging Worker configuration and live D1 lifecycle tests require a separate review after schema verification. Executor activation remains disabled.
