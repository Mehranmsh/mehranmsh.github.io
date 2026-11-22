# MEHRAN INTELLIGENCE Execution Engine v1

## Status

Design proposal only. This document does not enable new execution capabilities, change the Worker, alter D1, or deploy anything.

## Goal

Turn an owner request into a visible, resumable sequence of bounded tasks. The system must report what it actually did, what it could not do, and what requires the owner's approval. It must not pretend that a queued plan is completed work.

## Current verified boundary

The existing task API supports only these action types:

- `project_status_report`
- `social_metrics_report`
- `service_health_report`
- `repository_quality_check`

The Cloudflare scheduled handler currently claims project and social reports. The GitHub Actions runner claims service-health and repository-quality reports. The GitHub runner is restricted to read-only operations. Generic UI tasks with an empty action type are manual records, not executable jobs.

## v1 execution model

1. **Intake**: accept an owner-authenticated request as plain text, with a strict length limit.
2. **Plan**: convert the request into a structured plan with a bounded number of steps. Planning is data generation only; it cannot call arbitrary URLs, run shell commands, edit files, or invoke tools.
3. **Classify**: every step must map to a registered capability and risk class.
4. **Authorize**:
   - Read-only, allowlisted checks may be pre-authorized.
   - Repository writes, user/account changes, secrets, payments/wallets, external messages, and deployment require explicit owner approval for the exact proposed action.
   - An approval is scoped to one immutable plan version and expires if the plan changes.
5. **Execute**: one step at a time, with a lease, idempotency key, timeout, retry ceiling, and strict input/output schema.
6. **Record**: persist step status, timestamps, bounded result, error code, attempt count, and audit event.
7. **Report**: present completed, blocked, awaiting approval, and not-yet-run steps separately.

## Initial capability registry

Allowed read-only capabilities for v1:

- `service_health_report`: inspect the fixed MEHRAN Worker health endpoint.
- `repository_quality_check`: inspect fixed public GitHub repository metadata and configured static quality signals.
- `project_status_report`: read project names/statuses from D1.
- `social_metrics_report`: read aggregate SOCIAL counts only.
- `task_plan_validate`: validate plan structure, capability names, step limits, dependencies, and risk labels. No external side effects.

No generic `shell`, `command`, `javascript`, arbitrary URL fetch, arbitrary SQL, or free-form tool execution capability is permitted.

## Suggested task/step data model

Keep the existing `intelligence_tasks` table compatible. Add a separate step table only after migration and rollback tests are written.

Suggested `intelligence_task_steps` fields:

- `id` primary key
- `task_id` foreign-key/reference to `intelligence_tasks.id`
- `step_index` integer
- `capability` registered capability identifier
- `input_json` bounded JSON validated against that capability's schema
- `risk_class` enum-like text: `read_only`, `write`, `external_side_effect`, `sensitive`
- `requires_approval` boolean
- `status` constrained to `pending`, `awaiting_approval`, `queued`, `in_progress`, `completed`, `blocked`, `cancelled`
- `attempt_count` bounded integer
- `idempotency_key` unique per step execution
- `lease_expires_at` nullable timestamp
- `result_json` bounded JSON/text
- `error_code` bounded stable code
- `created_at`, `updated_at`, `started_at`, `finished_at`

The exact schema must be reviewed against the existing D1 migration conventions before implementation. Never store access tokens, passwords, Pi wallet secrets, or raw credentials in task/step payloads or results.

## Execution invariants

- Every claim is an atomic conditional update; only one worker can own a step lease.
- Expired leases may be recovered only for registered idempotent capabilities.
- Every capability has a fixed handler, input schema, output schema, timeout, and maximum attempts.
- User-supplied text is data, never executable instructions.
- Results and logs are size-limited and redact credential-like values.
- No worker can promote a plan step's risk class or approve its own work.
- Approval binds to task ID, step ID, capability, normalized input hash, and plan version.
- Cancellation prevents new steps from starting; in-flight operations are not falsely reported as rolled back.
- No deployment or production mutation is performed by v1.

## Scheduler ownership

Do not add a third scheduler. Keep one clear owner for each capability. Before changing claim allowlists, decide whether Cloudflare Cron or GitHub Actions is the single executor for that capability. Avoid overlapping selectors. Add a scheduler heartbeat and observable run history before calling a schedule reliable.

## Required tests before implementation can be merged

1. Unknown capability is rejected.
2. Unknown input fields and oversized payloads are rejected.
3. Plan step count and dependency cycles are rejected.
4. A task with `requires_approval=true` cannot be claimed.
5. Approval for one input hash cannot authorize a modified step.
6. Concurrent workers cannot claim the same step.
7. Expired leases recover only idempotent read-only work.
8. Retry ceilings and timeouts produce a bounded blocked result.
9. Results cannot be written by an unassigned worker or for a non-running step.
10. User-provided text cannot select a shell command, SQL statement, or arbitrary URL.
11. Cancellation stops subsequent steps.
12. No secret values appear in API responses, audit records, or task output.
13. Existing v5.9 health, Pi sign-in, and SOCIAL authentication regressions remain green.
14. Migration rollback and existing task compatibility are verified.

## Rollout gates

- Gate A: design and threat model reviewed.
- Gate B: D1 migration and unit/integration tests on a feature branch.
- Gate C: draft PR review, no production changes.
- Gate D: owner explicitly approves merge.
- Gate E: deployment only after a separate explicit owner approval and post-deploy health checks.

## Known UI correction

The current Intelligence UI reportedly labels the schedule as hourly while the Worker Cron expression is every five minutes. Correct the wording only after verifying the displayed component and the actual trigger configuration. A configured Cron expression is not proof that runs are occurring; show last successful heartbeat and last run result instead.


## Existing infrastructure discovered during implementation review

Do not create parallel tables or a second project/knowledge subsystem. The repository already contains production rollout support for:

- `intelligence_projects` and `intelligence_task_dependencies` (migration 0001)
- `intelligence_knowledge` and `intelligence_owner_memory` (migration 0002)
- owner-scoped project/task triggers and knowledge/memory immutability triggers
- preflight/verify checks in `scripts/intelligence-production-d1-check.mjs`
- existing Node smoke tests in `scripts/worker-smoke.test.mjs`
- production rollout workflow `.github/workflows/intelligence-production-d1-rollout.yml`

The execution engine should extend these established project/task/dependency concepts, preserve owner scoping, and reuse the existing smoke-test and rollout validation conventions. Any new D1 table requires its own reviewed migration, preflight, verify, rollback plan, and owner approval before production execution.

## Scheduler discrepancy requiring resolution

The current Worker scheduled-handler queue SELECT and claim statements visible in `worker.js` filter to `project_status_report` and `social_metrics_report`. The separate GitHub Actions runner claims `service_health_report` and `repository_quality_check`. However, `docs/INTELLIGENCE_SCHEDULER_OPERATIONS.md` describes the Cloudflare scheduler as processing all four actions. The Worker contains handler branches for the latter two actions, but those branches are not reachable while the SELECT/claim allowlist excludes them.

Before changing any allowlist, update the operations document and tests to state the actual split, then choose a single executor owner per action. Do not broaden either executor's allowlist until overlap, claim leases, result authorization, and duplicate execution behavior are covered by tests.


## Repository and schema verification correction (2026-11-22)

A follow-up inspection of the current `main` Git tree found that the referenced production migration workflow and checker exist, but the recursive `main` tree did not contain the referenced `migrations/production/*.sql` files. The current `worker.js` also defines `ensureIntelligenceTaskTable` and `ensureIntelligenceSchedulerRunsTable`, but the inspected source does not define `intelligence_projects`, `intelligence_task_dependencies`, `intelligence_knowledge`, or `intelligence_owner_memory`.

Therefore the earlier assumption that those schema objects are present in the repository or production database is **not verified**. The rollout checker expects some of them to exist, but that expectation is not evidence of their presence. Do not create code that depends on these tables until the actual production schema and migration history are verified through the approved read-only D1 preflight workflow. Do not run any `apply-*` workflow action as part of this verification.

The first implementation milestone is now explicitly blocked on schema inventory:
1. Verify the current production schema using the existing read-only preflight mechanism, if its required credentials and protected branch are already configured.
2. Reconcile the checker, referenced migration files, deployed schema, and current Worker source.
3. Only then select the smallest compatible task-step storage design. Reuse existing tables only when their presence and ownership constraints are confirmed.


## Follow-up correction: migration files are on the rollout branch

The earlier note that migration files were missing from the repository was too broad. They are absent from `main`, but they do exist on the dedicated branch `intelligence/production-compatible-v1` at commit `3370ade4a7ba6e059ad94bbb106c5354a82d85db`. The production rollout workflow deliberately requires that branch for dispatch. Migration 0001 adds owner/project/dependency structure; migration 0002 adds owner-scoped knowledge and memory.

This confirms the files and workflow are present on the rollout branch, **not** that either migration has been applied to production. Production schema state remains unknown until a successful read-only preflight run is observed. The correct next action is `preflight-0001` on that branch, not either `apply-*` option.
