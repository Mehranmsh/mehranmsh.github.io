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
- owner-visible reporting destination

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

May run automatically only when explicitly allowlisted, scoped, and reversible:
- read-only diagnostics and reports
- local validation and tests
- draft generation
- bounded retries of idempotent operations

Must pause for explicit owner approval:
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
- A bridge identity cannot grant itself privileges, approve restricted work, or deploy.

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
- A private authenticated intake path from ChatGPT or another approved owner interface.
- A general, reviewed executor framework for additional task types and repository/Cloudflare operations.
- Independent acceptance-check execution and durable evidence artifacts for every completed task. Current completion evidence is limited to bounded task result text and lifecycle events for the two read-only report actions.
- A configured private notification receiver/channel. PR #162 now provides an owner-token-protected outbox status, claim, and acknowledgement API; atomic status/audit/outbox writes; five-minute delivery leases; bounded exponential retry capped at five delivery attempts, including abandoned leases; and at-least-once delivery semantics with receiver-side event-ID deduplication. No Telegram/email/push/ChatGPT delivery provider is configured.
- End-to-end tests demonstrating restart recovery, independent task progress, transient failure recovery, duplicate delivery, owner approval gates, and final report retrieval.

Do not describe the protocol as active until the acceptance criteria have passed in an end-to-end test. Keep public GitHub intake limited to non-sensitive signals. Do not expand unrelated company modules as part of this work.
