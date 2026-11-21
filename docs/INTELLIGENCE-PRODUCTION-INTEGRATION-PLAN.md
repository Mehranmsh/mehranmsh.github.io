# MEHRAN INTELLIGENCE production integration plan

## Safety boundary
This work is isolated on `intelligence/production-compatible-v1`. It does not change `main`, deploy a Worker, or execute SQL against Cloudflare D1. The staging migrations 0000-0005 remain staging-only.

## Confirmed production contract
- Admin authentication returns both the verified Pi `uid` and username.
- The accepted administrator username is currently `mehranmsh`.
- Existing `intelligence_tasks.created_by` stores the username, not the Pi UID.
- Existing task history and the `created_by` field must remain intact.
- Production chat already uses Workers AI and must be retained.
- Current chat has no retrieval from the staging knowledge or owner-memory tables.
- Agent execution remains disabled. Project/task coordination is metadata and planning only.

## Compatibility design
1. Add nullable `intelligence_tasks.owner_uid` and `project_id`; do not rewrite `created_by`.
2. New tasks store `created_by=admin.username` and `owner_uid=admin.uid`.
3. Legacy tasks are assigned `owner_uid` only through an authenticated, audited owner migration using the verified session UID. Never infer a UID from a client-supplied value.
4. All new project, knowledge, memory, relation, and dependency records are scoped by `owner_uid`.
5. The project API must query task ownership through `owner_uid`, not `created_by`.
6. Existing generic `projects` records and APIs remain unchanged. Intelligence projects use their own `intelligence_projects` table.
7. Keep the existing Workers AI chat and extend its context through bounded, owner-scoped retrieval only after the knowledge schema is integrated.
8. Keep approval gates and execution disabled. No deployment, account mutation, wallet action, or external side effect is enabled by this integration.

## Migration
`migrations/production/0001_intelligence_owner_projects.sql` is a proposed additive migration. It assumes `ensureIntelligenceTaskTable` has already created `intelligence_tasks`. It is not approved for production execution until the live D1 schema, table existence, foreign-key behavior, and migration history are inspected.

## Required code work before production
- Extend task insert paths to populate `owner_uid`.
- Implement an authenticated one-time legacy ownership backfill, with an audit event and idempotent guard.
- Adapt the project/dependency API to `owner_uid` and the production audit table, rather than staging-only audit tables.
- Add knowledge and owner-memory routes with strict owner filters, size limits, rate limits, and audit logging.
- Add retrieval to `/intelligence/chat` with source metadata and explicit uncertainty. Do not treat provenance metadata as proof that a claim is true.
- Add tests for cross-owner isolation, legacy rows, dependency cycles, completed-task guards, approval boundaries, and prompt-injection handling.
- Inspect live D1 schema before any SQL execution. Do not deploy automatically.

## Known incompatibility in staging 0005
Staging 0005 joins and guards task ownership by comparing `intelligence_tasks.created_by` to `owner_uid`. That is invalid for production because `created_by` is a username. Do not apply staging 0005 to production.

\n## Legacy task ownership backfill endpoint\n\nThe production Worker branch includes an owner-authenticated preview and explicit confirmation route:\n- `GET /intelligence/migration/legacy-tasks/preview` reports eligible legacy rows, rows excluded because their creator differs, and rows already owned. It performs no writes.\n- `POST /intelligence/migration/legacy-tasks/confirm` requires the exact confirmation string `ASSIGN_LEGACY_TASKS_TO_MY_PI_UID`. The UID is taken only from the verified admin session.\n- The update is idempotent and limited to rows with `owner_uid IS NULL` and `created_by=admin.username`. Other creators are never reassigned. The update and audit record run in one D1 batch.\n- This endpoint is inert until the ownership migration exists. It does not deploy itself, apply SQL, or enable agent execution. Do not call the confirmation route until live D1 schema and the preview counts have been reviewed.\n