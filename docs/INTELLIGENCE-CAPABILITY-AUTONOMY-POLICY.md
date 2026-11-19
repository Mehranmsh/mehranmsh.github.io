# INTELLIGENCE Capability and Autonomy Policy

## Purpose

This policy defines what INTELLIGENCE may propose, what it may become eligible to do automatically in a future execution runtime, what requires explicit owner approval, and what remains prohibited. It is a deterministic authorization boundary, not an AI judgment and not an execution engine.

## Three capability tiers

### Tier A: low-risk, owner-scoped

The initial allowlist is intentionally narrow:
- `knowledge.read`: read the authenticated owner's staging knowledge.
- `memory.read`: read the authenticated owner's staging memory.
- `task.plan`: create or revise a task plan only; it does not run the task.

These operations are eligible for future automatic handling only inside the owner's isolated staging scope. Eligibility does not execute anything today.

### Tier B: explicit owner approval

These require a fresh, server-verified approval whose owner, capability, scope, and expiry match the requested operation:
- `knowledge.create`
- `memory.create`
- `knowledge.review`
- `memory.delete`

Approval is operation-specific and cannot be reused for another capability or scope. Revoked or expired approvals fail closed.

### Tier C: prohibited

These capabilities are never granted by this policy:
- `task.execute` (until a separately reviewed execution design is approved)
- `production.write`
- `credential.read`
- `permission.escalate`

A normal approval record cannot override a prohibited capability.

## Mandatory authorization checks

Every future executor must independently enforce:
1. Verified Pi owner identity and a live, revocable server-side session.
2. Exact capability allowlist match. Unknown capabilities are denied.
3. Exact resource scope. Staging authority never implies production authority.
4. Approval ledger lookup on the server, not a client-supplied `approved: true` flag.
5. Approval owner, capability, scope, expiry, and revocation checks.
6. Least-privilege credentials limited to the one approved operation.
7. Bounded inputs, idempotency where possible, audit before/after, and fail-closed error handling.
8. No self-approval, no privilege escalation, and no modification of the policy by the agent itself.

## Autonomy progression

1. **Observe:** read owner-scoped data and report.
2. **Plan:** create proposed steps without executing them.
3. **Approval simulation:** evaluate a server-verified approval and show the intended scope.
4. **Sandbox execution:** only after a separate owner decision, use disposable staging resources with strict quotas and rollback.
5. **Production execution:** separate design, security review, and explicit owner authorization. Never inherited from staging.

## Current implementation status

- `intelligence-capability-policy.mjs` implements deterministic classification only.
- `intelligence-capability-policy.test.mjs` tests fail-closed behavior, approval binding, expiry, revocation, scope isolation, and prohibited capabilities.
- The module exports `EXECUTION_ENABLED = false`. It does not call APIs, access databases, create credentials, or execute tasks.
- The staging Worker is not wired to an executor. No scheduler, queue consumer, cron, agent poller, or production binding is introduced.
- This policy is not yet a live authorization gate for Worker routes. It is a tested policy primitive pending separate integration review.

## Change control

Changes to the capability inventory or tier assignments require owner review and tests. Adding a capability is not permission to deploy or execute it. Production remains outside this policy's staging scope.


## Staging Worker integration

The isolated staging Worker exposes the policy through two authenticated, owner-scoped assessment routes:

- `GET /intelligence/capabilities` returns the allowlist inventory and explicitly reports `executionEnabled: false`.
- `POST /intelligence/capabilities/evaluate` accepts only a `capability` identifier. The Worker constructs owner authentication, session validity, owner ID, and staging scope from its already-verified server session. Client-supplied trust assertions or approval objects are rejected.

This route is deliberately assessment-only. It passes no approval record, so approval-tier mutations remain `approval_required`; it does not read or consume the approval ledger, perform the requested operation, create tasks, or enable execution. Forbidden and unknown capabilities remain denied. This is not a live authorization gate for mutation endpoints.
