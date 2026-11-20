# INTELLIGENCE project and task coordination proposal

Status: design proposal only. No schema migration, Worker route, scheduler, executor, or production change is included.

## 1. Current baseline

The isolated staging schema currently contains `intelligence_tasks`, owner-scoped knowledge and knowledge relations, approval records, staging sessions, audit, rate-limit records, and owner memory.

The current staging task API supports only:
- Owner-scoped task listing, limited to 100 rows.
- Task planning with title, description, priority, and an approval flag.
- New tasks enter `queued`.
- Responses explicitly return `executionEnabled: false`.

The current task row already has `assigned_to`, `action_type`, `action_payload`, `requires_approval`, `status`, and claim-related columns inherited from the baseline. The staging API does not expose action payloads or claim operations. No project table or task-dependency relation currently exists.

## 2. Goals

Add a private, owner-scoped project layer so INTELLIGENCE can:
- Organize work into company projects and module initiatives.
- Break projects into bounded tasks with explicit deliverables.
- Represent prerequisite relationships between tasks.
- Show blockers, progress, and audit history without executing work.
- Preserve human approval as a separate, explicit authorization boundary.

Non-goals:
- No autonomous task execution, agent polling, scheduling, cron, queue consumer, GitHub write access, deployment, financial action, or Pi transaction.
- No cross-owner collaboration or public user-facing project board in this phase.
- No automatic task completion based only on dependency state.
- No automatic truth decisions from knowledge relations.

## 3. Proposed data model

### A. `intelligence_projects`

Proposed columns:
- `id TEXT PRIMARY KEY`
- `owner_uid TEXT NOT NULL`
- `name TEXT NOT NULL` (1-120 characters after normalization)
- `description TEXT NOT NULL DEFAULT ''` (maximum 3,000 characters)
- `module_key TEXT NOT NULL` (allowlisted company module identifier, maximum 40 characters)
- `status TEXT NOT NULL` constrained to `planned`, `active`, `paused`, `completed`, `archived`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `archived_at TEXT`

Indexes:
- `(owner_uid, status, updated_at DESC)`
- `(owner_uid, module_key, updated_at DESC)`

### B. Task-to-project association

Preferred initial approach: add nullable `project_id TEXT` to `intelligence_tasks`, plus an index on `(created_by, project_id, status, created_at)`.

The migration must add database triggers that reject a task association unless the referenced project exists and `project.owner_uid = task.created_by`. It must also reject changing a task's creator while it is associated with a project, changing a project's owner while tasks remain attached, or moving a task in a way that invalidates the owner/project scope of existing dependency edges. Project deletion should be restricted while tasks reference it; archival is the normal lifecycle operation.

Project completion must be guarded at the database boundary: a project cannot transition to `completed` while any attached task is not `completed`. New or updated tasks cannot be attached to a completed project unless they are already completed. Reopening a project remains an explicit owner action and must be audited by the API.

This avoids a separate join table while the product has one owner per task. Revisit a join table only if multi-project task reuse becomes a real requirement.

### C. `intelligence_task_dependencies`

Proposed columns:
- `id TEXT PRIMARY KEY`
- `owner_uid TEXT NOT NULL`
- `task_id TEXT NOT NULL`
- `depends_on_task_id TEXT NOT NULL`
- `dependency_type TEXT NOT NULL DEFAULT 'blocks'`, initially allowlisted to `blocks`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

Constraints and indexes:
- Foreign keys to both task IDs with `ON DELETE RESTRICT`.
- `task_id <> depends_on_task_id`.
- Unique edge `(owner_uid, task_id, depends_on_task_id, dependency_type)`.
- Lookup indexes on `(owner_uid, task_id)` and `(owner_uid, depends_on_task_id)`.
- Insert/update triggers must ensure both tasks belong to the same owner, and if either task has a project, both tasks must belong to the same project.
- The Worker must reject self-dependencies and cycles before insert. The database trigger should enforce owner/project boundaries independently of Worker validation. A recursive CTE cycle guard should also be considered in D1-compatible SQL and tested against the actual SQLite/D1 engine before adoption.

## 4. Task lifecycle and dependency semantics

Keep the existing task status vocabulary compatible with the inspected production Worker. Its collaboration tools explicitly allow `queued`, `accepted`, `in_progress`, `blocked`, `awaiting_approval`, `completed`, and `cancelled`. Some older internal execution paths also write `failed` for scheduler-run records, but that is not an established task status in the current collaboration-tool allowlist. Do not add a database CHECK constraint or rename statuses until every task writer, reader, admin UI, and legacy API has been inventoried. Treat `failed` as a possible legacy task value only if a full data/schema audit confirms it exists.

Dependency semantics:
- A prerequisite counts as successfully satisfied only when its task status is `completed`.
- A prerequisite in `queued`, `accepted`, `in_progress`, `awaiting_approval`, `blocked`, or `cancelled` is not satisfied. A blocked/cancelled prerequisite should surface an explicit owner decision, not trigger automatic execution or silent dependency removal.
- A dependency edge is descriptive coordination metadata, not permission to execute.
- Marking a project completed must be rejected if any non-archived task is not `completed` or has unresolved blockers.
- Completing a task is a manual owner action in this phase and must be audited.
- Reopening a completed task is also a manual, audited action.

Execution-boundary note: the inspected production Worker currently has an unconditional early return at the start of its `scheduled()` handler and returns HTTP 410 for `/agent/v1/` API paths. The older scheduler processing code remains below the return but is unreachable in the current source. This source inspection is not a live deployed-runtime audit. The project/task proposal must not remove or bypass either guard.

The API should return derived blocker summaries, not persist a duplicate `blocked` flag that can drift out of sync with dependency rows.

## 5. Proposed read/write API

Owner-authenticated, staging-only routes:
- `GET /intelligence/projects` with bounded filters and pagination.
- `POST /intelligence/projects` to create a project.
- `GET /intelligence/projects/:id` for project details and bounded task summary.
- `PUT /intelligence/projects/:id` for allowlisted metadata/status changes.
- `GET /intelligence/tasks/:id/dependencies` to list prerequisites and dependents.
- `POST /intelligence/tasks/:id/dependencies` to add one dependency edge.
- `DELETE /intelligence/tasks/:id/dependencies/:dependencyId` to remove an edge.
- `PUT /intelligence/tasks/:id/project` to associate or detach a task from a project.

Every write must be owner-scoped and paired with an audit row in the same D1 batch. Return 404 for records outside the owner scope to avoid disclosing their existence. Reject unknown request keys, cap request bodies, cap list sizes, and use stable ordering.

Do not expose `action_payload`, agent claim IDs, raw approval scope hashes, or service credentials in project/task read responses.

## 6. Audit events

Suggested events:
- `project_created`, `project_updated`, `project_archived`, `project_restored`
- `task_project_assigned`, `task_project_unassigned`
- `task_dependency_added`, `task_dependency_removed`
- `task_manually_completed`, `task_manually_reopened`

Audit details should contain bounded identifiers and changed field names, not full private descriptions, credentials, or arbitrary payloads.

## 7. Approval and module boundaries

Project membership does not grant authority. A task's `assigned_to` value is routing metadata, not an execution permission. `requires_approval` remains a planning attribute until a separate, reviewed executor exists.

Module keys must come from a server-side allowlist, initially including the known MEHRAN MSH modules. A project in one module must not gain access to another module's private records merely because it is linked to a shared project. Cross-module visibility should be explicit and read-only by default.

## 8. Migration and validation plan

Do not write or apply a migration until the proposal is reviewed against all current production and staging task writers/readers.

Required tests in disposable SQLite:
1. Full migrations 0000-0004 apply in order and remain idempotent.
2. Project owner isolation for every list, read, update, and association route.
3. Task association rejects another owner's project.
4. Dependency rejects missing tasks, cross-owner tasks, cross-project tasks, self-edge, duplicate edge, and cycles.
5. Dependency deletion and task/project archival preserve referential integrity.
6. Audit row is committed atomically with every successful mutation and absent when the state change affects zero rows.
7. Bounded pagination, stable ordering, malformed payload, and unknown-key rejection.
8. Existing task planning, approval ledger, knowledge, session, and owner-isolation tests remain green.
9. Staging UI displays project progress and blockers without offering an execution control.

## 9. Delivery sequence

1. Complete review of this proposal and current task status vocabulary.
2. Add disposable SQLite schema tests for proposed constraints.
3. Add additive migration only after tests and review pass.
4. Add owner-scoped read routes.
5. Add audited project/task/dependency writes.
6. Add a private staging UI view.
7. Run full CI and review the diff.
8. Only then consider a separate, explicitly authorized staging D1 migration and deployment.

## 10. Safety decision

This proposal deliberately separates planning from doing. INTELLIGENCE may organize work, explain dependencies, identify blockers, and prepare approval requests. It must not interpret a planned task, project status, module assignment, or approval flag as permission to execute external actions.
