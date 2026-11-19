# INTELLIGENCE One-Time Capability Consumption Design

## Status

Design and disposable-SQLite contract tests only. This document does not enable execution, add a Worker mutation route, or authorize deployment. `EXECUTION_ENABLED` remains false.

## Required transaction boundary

A future approved mutation must be a single Cloudflare D1 `batch()` whose statements are all in one transaction, in this order:

1. Conditionally transition exactly one matching capability grant from `issued` to `consumed`.
2. Assert that the immediately preceding statement changed exactly one row.
3. Perform exactly one owner-scoped mutation, conditioned on the exact consumed grant and a unique per-request consumer ID.
4. Assert that the mutation changed exactly one row.
5. Write the operation-completed audit event. The migration's state-transition trigger separately records the grant-consumed event.

If any statement fails, the D1 batch must roll back the grant transition, its trigger-generated audit event, the operation, and the operation audit together. A route must return failure unless the batch completes and both expected row counts are exactly one.

## Conditional consume statement

The future Worker must derive owner identity from the authenticated server session. It must never accept owner UID, approval status, scope, or a trusted approval object from the client. The Worker also creates a unique request/consumer ID and uses it as `consumed_by` for this single attempt.

```sql
UPDATE intelligence_capability_approvals
SET status='consumed', consumed_at=?, consumed_by=?
WHERE id=? AND owner_uid=? AND capability=? AND scope='owner_staging'
  AND status='issued' AND expires_at>? AND revoked_at IS NULL
  AND consumed_at IS NULL AND consumed_by IS NULL;
```

The conditional update is the single-use gate. Concurrent requests race on the same row: at most one can change `issued` to `consumed`. The database trigger rejects invalid state transitions and writes the consume audit event.

## Fail-closed row-count guards

D1 batch does not provide application-level branching between statements. Therefore, the future batch needs a database-enforced guard after the consume statement and after the mutation. A guard statement should deliberately violate a NOT NULL constraint if the immediately preceding statement changed anything other than exactly one row. That constraint failure aborts the batch and rolls back all earlier statements.

After the consume guard, the mutation must check the consumed approval row using the unique per-request consumer ID, owner, capability, scope, and timestamp. It must not depend on `changes()` from the consume statement because the guard statement itself becomes the immediately preceding SQL statement.

The disposable SQLite test implements this pattern using `intelligence_staging_audit.details_json` (NOT NULL) and `WHERE changes() <> 1`. The guard is a test/design primitive, not a production route or permission to execute.

## Mandatory additional checks

- Match exact capability and `owner_staging` scope.
- Require unexpired Unix-second timestamps and `status='issued'`.
- Match the authenticated owner UID in the SQL predicate.
- Never consume on assessment, preview, listing, or UI selection.
- Do not permit retries to reuse a consumed grant. A retry requires a newly issued owner approval.
- Keep operation-specific input validation and owner scoping in the mutation statement itself.
- Avoid external side effects inside this transaction. A database rollback cannot undo an email, network call, payment, or other external effect.
- Any future external side effect requires a separately reviewed transactional outbox/idempotency design and explicit owner authorization.
- Keep audit data minimal and exclude tokens, secrets, and sensitive payload contents.

## Validation

`scripts/test-intelligence-capability-approval-atomic-consumption.py` applies the full staging migration chain to disposable SQLite and verifies:

- only one of two sequential uses can consume the same grant;
- two simultaneous SQLite contenders produce exactly one committed operation and one consumed-grant audit event;
- wrong owner, wrong capability, expired, and revoked grants fail closed;
- a failed protected mutation rolls back consumption and trigger-generated audit;
- a successful operation and the consumed state commit together.

The simultaneous contender test uses local SQLite file locking and is not a Cloudflare D1 concurrency test. These local contract tests do not prove a live D1 deployment or production executor. A staging-only D1 integration test and separate security review remain necessary.

## Explicit non-goals

This change adds no Worker route, scheduler, queue, cron, executor, production binding, secret, or Cloudflare migration. It does not enable autonomous actions. The staging Worker remains assessment-only.
