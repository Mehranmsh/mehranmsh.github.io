# MEHRAN INTELLIGENCE Execution Protocol v1

Status: implementation contract. This document defines the required operating protocol; it does not claim that unattended private execution is already live.

## Owner's operating model

The owner submits a work list once and may leave. INTELLIGENCE must continue eligible work independently, preserve progress, and provide a consolidated report when the owner returns. Elapsed time is not a completion criterion: correctness and verified acceptance criteria are.

## Roles

- Owner: sets goals and scope; approves sensitive, irreversible, externally visible, or privilege-changing actions.
- ChatGPT: converts the owner's request into a structured work package, defines acceptance criteria, reviews evidence, and reports blockers.
- MEHRAN INTELLIGENCE: execution director; plans, prioritizes, schedules, delegates, checkpoints, retries safe failures, and consolidates results.
- Executors: perform only assigned, allowlisted steps and return evidence.

No role may silently expand its permissions or approve its own restricted actions.

## Work package contract

Every submitted work package must contain:
- stable work_package_id and idempotency_key
- title, objective, scope, exclusions, priority, created_at
- ordered tasks with stable task_id values
- explicit dependencies and expected outputs
- acceptance criteria that can be tested
- risk class and required approval level
- retry policy, timeout policy, and checkpoint policy
- owner-visible reporting destination. The default is a durable report retrievable by ChatGPT through the authenticated MCP connection in the same conversation when the owner returns; push notifications are optional and are not required for report delivery.

The intake must acknowledge durable storage before the owner is told the work was accepted.

## Required task lifecycle

Use these states, with auditable transitions:

`draft -> queued -> claimed -> in_progress -> verifying -> completed`

Additional terminal or holding states:
- `awaiting_approval`: a required owner decision is outstanding.
- `blocked`: safe retries are exhausted or a dependency is unavailable.
- `failed`: a non-recoverable execution failure occurred.
- `cancelled`: owner cancellation or policy cancellation.
- `retry_wait`: transient failure is scheduled for retry.

A task is never `completed` merely because a command returned exit code zero. It reaches `completed` only after its acceptance checks pass and evidence is stored.

## Executor routing contract

The capability registry is the canonical routing map:
- `project_status_report` and `social_metrics_report`: Cloudflare Worker scheduled handler only.
- `service_health_report` and `repository_quality_check`: both the Worker scheduled handler and GitHub Actions package runner may execute these bounded read-only tasks. Both paths use conditional state transitions when claiming a task, so only one executor can claim a given eligible task.
- `source_security_audit`: GitHub Actions package runner only.
- `inspect_repository`: GitHub Actions package runner only; reads 1-6 exact allowlisted files from one immutable `main` commit, capped at 500 KB per file and 750 KB total. It extracts bounded declaration names and file metadata only; repository content is never executed or treated as instructions.

The registry stores executor identities as an explicit list. The GitHub Runner's action allowlist must be checked against the registry and the Worker scheduled handler. An active capability does not imply that every executor can run it. Any routing change must update registry metadata, executor allowlists, and regression tests together.

## Planning and dependency rules

1. Convert each owner request into a work package and a dependency graph.
2. Identify independent tasks and run them concurrently only within configured resource and risk limits.
3. Never start a dependent task until its prerequisites have passed verification.
4. Continue unrelated eligible tasks when one task is blocked.
5. Preserve task IDs, outputs, checkpoints, and dependency state across restarts.
6. Reconcile duplicate submissions using idempotency keys; do not execute the same side effect twice.

## Error and recovery protocol

- Detect and record errors at the point they occur.
- Immediately surface critical security, data-integrity, or service-wide failures to the owner through the configured alert channel. Pause the affected scope to prevent further damage.
- For transient and reversible failures, retry with bounded exponential backoff and jitter.
- For deterministic failures, do not loop. Capture the failing step, sanitized diagnostic, environment/version metadata, and attempted remedies.
- Permit automatic repair only from an explicit, reviewed allowlist. Re-run the failed step and all affected acceptance checks after repair.
- If repair fails, mark the task `blocked` or `failed`, notify promptly, and continue independent work.
- Never suppress an error until the final report.

## Approval boundaries

Run autonomously without per-step owner prompts once the corresponding executor is implemented, tested, and allowlisted:
- read-only diagnostics, repository inspection, and reports
- the repository's fixed test and validation workflows in isolated CI
- bounded code patches on dedicated Intelligence branches
- opening review-only pull requests from tested Intelligence branches
- draft generation, dependency scheduling, and bounded retries of idempotent operations

The owner authorizes the mission scope once. That authorization covers all eligible steps inside the scope; it does not need to be renewed at each task boundary.

Autonomous metadata is not an execution switch: a capability marked `planned` remains unavailable until its executor, validator, result verification, recovery behavior, and regression tests are implemented and allowlisted.

Must pause for explicit owner approval:
- merging any pull request into a protected or default branch
- production deployments or rollbacks
- changes to authentication, authorization, secrets, keys, or security policy
- payments, transfers, purchases, or financial actions
- deleting or exporting user data
- changing user permissions or account ownership
- publishing externally or contacting third parties
- irreversible schema/data migrations

Approval is bound to the exact action, target, diff, and risk summary. Any material change invalidates the prior approval.

## Evidence and verification

Each task result must include:
- task_id and work_package_id
- final state and timestamps
- executor identity and version
- actions attempted and exact changed paths/records
- commands/checks run and their outcomes
- test evidence, not just a success claim
- errors, retries, and repairs
- unresolved risks and follow-up dependencies

Verification must be independent of the execution step where practical. Missing evidence means the task remains unverified, not completed.

## Notifications and reporting

- Emit an alert as soon as a critical error or owner decision is required.
- Emit progress events at meaningful state transitions, not noisy heartbeat messages.
- Persist all events so temporary notification failure does not lose them.
- Retry delivery and mark delivery status separately from task status.
- The final report must summarize completed, blocked, failed, awaiting-approval, and remaining tasks, with links to evidence.
- Never claim that a notification reached the owner unless the delivery channel confirms it.

## Security and privacy

- Private work payloads and results must never pass through public GitHub Issues, public comments, public repository files, or plaintext logs.
- Authenticate every participant with separate, least-privilege identities.
- Encrypt private payloads end-to-end in transit and at rest; keep private keys outside source control and ordinary task records.
- Enforce expiry, replay protection, request signing, rate limits, payload limits, audit logging, and owner-controlled revocation.
- Executors receive only the minimum context and capabilities needed for their assigned task.
- A bridge identity cannot grant itself privileges, approve restricted work, merge pull requests, or deploy. Autonomous permission is granted only by the owner-maintained capability policy and is limited to the named executor, repository, branch pattern, path scope, and fixed workflow. A task description or model-generated plan cannot expand those limits.

## Acceptance criteria for the protocol

The protocol is not production-ready until all of the following are demonstrated:
1. Owner submits a multi-task work package once and can leave without manual message relaying.
2. The package is durably stored and survives Worker/agent restarts.
3. Independent tasks proceed while blocked tasks remain isolated.
4. A transient injected failure is retried and recovered automatically.
5. A deterministic failure is promptly surfaced and does not silently stall unrelated tasks.
6. Sensitive actions remain paused until exact owner approval is recorded.
7. Duplicate delivery does not duplicate side effects.
8. Every completed task has passing acceptance checks and retrievable evidence.
9. A final consolidated report is retrievable by ChatGPT when the owner returns.
10. Notification delivery failures are visible and retried.

## Implementation status and remaining gaps

The companion runtime work in PR #162 adds durable work-package storage, dependency-aware task eligibility, idempotency-key payload fingerprints, bounded retries, checkpoints, lifecycle events, stale-claim recovery, and owner-only package intake/report routes protected by a separate `MEHRAN_ORCHESTRATOR_TOKEN`. The Worker scheduler can execute only the currently allowlisted read-only report actions; the external agent API is likewise restricted to those actions.

This is a runtime foundation, not the complete protocol and not yet production-active. The following acceptance items remain unproven or unimplemented:
- Direct private MCP intake through the dedicated authenticated bridge identity, with owner opt-in enforced by the separately provisioned `MEHRAN_ORCHESTRATOR_TOKEN`. PR #164 implements the bounded MCP tools for this path; it does not require a separate ChatGPT-to-Worker relay. The current ChatGPT session still needs an eligible authenticated MCP connection, and the Worker changes must be merged, deployed, configured, and end-to-end tested before this counts as live.
- A general, reviewed executor framework for additional task types and repository/Cloudflare operations. A dedicated manual-dispatch CI foundation is being added to run exactly one fixed policy test at an immutable main-branch commit inside a no-network, read-only, resource-limited container, without passing secrets into the test process. This workflow is not yet connected to the task queue; `run_repository_tests` remains planned and non-executable until dispatch, result polling, verification, recovery, and end-to-end tests are implemented.
- General-purpose independent acceptance-check execution and durable evidence artifacts for arbitrary task types. PR #162 now verifies the fixed report actions with action-specific schema/identity/cross-field checks and atomically stores the bounded result plus verification event; this is not yet a reusable verifier/evidence framework for broader tasks.
- Automatic push notification delivery is not required for the core protocol. Package status transitions use compare-and-set updates so concurrent report requests cannot enqueue duplicate transition notifications. PR #162 provides an owner-token-protected outbox status, claim, and acknowledgement API; atomic status/audit/outbox writes; unique event IDs per package status transition; five-minute delivery leases with a per-claim random lease token required for acknowledgement; stale-acknowledgement rejection; bounded exponential retry capped at five delivery attempts, including abandoned leases; and at-least-once delivery semantics with receiver-side event-ID deduplication. ChatGPT should retrieve package status and the final report through MCP when the owner returns. Telegram/email/push receivers remain optional and are not part of the core path.
- End-to-end tests demonstrating restart recovery, independent task progress, transient failure recovery, duplicate delivery, owner approval gates, and final report retrieval.

Do not describe the protocol as active until the acceptance criteria have passed in an end-to-end test. Keep public GitHub intake limited to non-sensitive signals. Do not expand unrelated company modules as part of this work.
