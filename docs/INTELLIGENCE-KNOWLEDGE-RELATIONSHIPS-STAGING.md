# INTELLIGENCE knowledge relationships: isolated staging checklist

## Current status

The Worker route tests use a deterministic mock D1 binding. The migration lifecycle tests use disposable in-memory SQLite. These checks do not establish that Cloudflare D1 has been migrated or that the routes have been exercised against a live Worker.

Do not apply this migration to `mehran-msh-db` or deploy this branch to production.

## Required isolated environment

1. Create a separate Cloudflare D1 database, for example `mehran-msh-knowledge-staging`.
2. Create or use a dedicated Worker staging environment. Bind its `DB` binding only to the new staging database.
3. Confirm that the staging database contains the prerequisite `intelligence_knowledge` table and the matching owner UID / archived-at columns. The relationship migration has foreign keys to that table.
4. Deploy only to the staging Worker after reviewing the branch and its secrets. Never copy production API secrets into a disposable test environment unless separately authorized.
5. Apply `migrations/0002_intelligence_knowledge_relationships.sql` to that staging database only.

## Schema verification

Run these checks in the staging D1 console:

- `PRAGMA table_info(intelligence_knowledge_relationships)`
- `PRAGMA foreign_key_list(intelligence_knowledge_relationships)`
- `PRAGMA index_list(intelligence_knowledge_relationships)`
- `PRAGMA foreign_key_check`

Confirm the directional columns, status/relation constraints, three knowledge foreign keys plus resolution foreign key, unique pair/type index, and owner/status index.

## Route lifecycle checks

Use a staging admin session and disposable knowledge records belonging to the staging owner. Never use real company decisions as test fixtures.

1. Unauthenticated GET/POST/PUT requests must be rejected.
2. GET returns only relationships where `owner_uid` equals the authenticated owner.
3. A `conflicts_with` relation has no direction fields. A `supersedes` or `supports` relation must identify distinct `directionFromId` and `directionToId` values, both belonging to the linked pair.
4. INTELLIGENCE proposals must quote an exact snippet from each active owner-owned source entry. A missing, archived, cross-owner, system-seed, or modified source must prevent insertion.
5. New INTELLIGENCE proposals must be stored as `candidate`, with `proposed_by='intelligence'`. They must not change either knowledge entry.
6. Owner confirm, dismiss, and conflict resolve actions must be owner-scoped and audited. Resolve must choose one of the two active linked records and must be rejected for `supports` and `supersedes`.
7. Update either source knowledge entry after a relationship is confirmed/resolved. The API and chat context must mark that relationship stale. Reaffirming a stale confirmed relation must require owner action; a stale resolved conflict can only be reopened by the owner, and the previous resolution must remain in the audit log.
8. A candidate whose exact evidence no longer matches both current knowledge entries must not be confirmable.
9. Verify a second owner cannot read, confirm, dismiss, or resolve the first owner's relationships.
10. Verify both original knowledge records remain present after confirmation, dismissal, and resolution.

## Private dashboard checks

1. Sign in through the staging Pi/admin flow and open the private Intelligence page.
2. Confirm the relationship panel loads only after administrator authentication and is not visible as a public route.
3. Create one symmetric conflict and one directional supersedes/supports relation; verify source/target labels are correct.
4. Confirm and dismiss candidates, resolve a confirmed conflict, then change a linked knowledge entry and verify the stale warning appears.
5. Reaffirm a stale confirmed relation and reopen a stale resolved conflict. Verify the activity log labels each owner action.
6. Verify all user-provided titles, evidence and snippets render as text, not executable HTML.

## Exit criteria

Do not consider the feature staging-verified until the live D1 lifecycle, owner-isolation checks, Worker route checks, private dashboard checks, and audit records all pass. Production migration and deployment require a separate explicit owner decision after staging evidence is reviewed.

## Rollback

If a staging check fails, stop the staging Worker and discard or recreate only the dedicated staging database. Do not attempt rollback by editing or deleting production knowledge records.