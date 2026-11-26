# INTELLIGENCE Queue Isolation Design

Status: design checkpoint; not wired into production scheduling.

## Verified current behavior

- `intelligence_tasks` has `assigned_to`, but no task-level `owner_uid`.
- `intelligence_work_packages` has nullable `owner_uid`.
- Package creation assigns its tasks to the symbolic value `mehran_intelligence`.
- The scheduled Worker candidate query accepts both `mehran_intelligence` and `shared` in one selection loop (up to five tasks per run).
- The agent `/agent/v1/tasks/next` endpoint also accepts both assignment values in one claim query.
- Consequently, the current design does not prove per-owner queue isolation, and shared tasks can compete in the same scheduler/agent claim path.

## Required target model

1. Add a task-level `owner_uid` and a constrained `queue_lane` (at minimum `owner` and `shared`).
2. Owner tasks must be created with the authenticated owner UID copied from the owning work package. A missing or mismatched owner UID must fail closed for the owner lane.
3. Owner candidate selection, atomic claim, checkpoint, result acknowledgement, stale-claim recovery, and concurrency accounting must all require the same owner UID and owner lane.
4. Shared work must use a separate candidate query, claim path, capacity counter, and recovery path. It must never be eligible for an owner claim.
5. Owner capacity must be reserved before shared work is scheduled. Shared backlog must not consume owner slots, and shared workers must not hold owner leases.
6. Preserve compare-and-set claims, claim-token hashes, attempt caps, dependency checks, idempotency, append-only task events, and bounded outputs.
7. Existing rows must be migrated conservatively. Do not infer ownership from the symbolic `assigned_to` string alone. Legacy rows without verifiable package ownership remain outside the owner lane until reconciled.
8. Provider-level Cloudflare AI quota remains shared unless the provider offers an independently enforceable quota. Internal queue isolation must not be described as provider quota isolation.

## Required executable tests

Use SQLite integration tests against the actual schema and SQL, not string-only assertions:

- owner A cannot select or claim owner B tasks;
- owner claims cannot select shared tasks;
- shared claims cannot select owner tasks;
- two concurrent claim attempts for one task produce exactly one winner;
- a full shared queue does not reduce reserved owner capacity;
- stale owner claims recover only in the owner lane;
- stale shared claims recover only in the shared lane;
- retry exhaustion and dependency-terminal propagation remain lane-local;
- legacy tasks without verified ownership fail closed;
- task result/checkpoint acknowledgements reject cross-lane or cross-owner claim tokens.

## Security and rollout boundaries

This work must not read secrets, credentials, private user data, or wallet data. No financial transaction capability is involved. Do not merge existing PRs or deploy the live Worker as part of this change. The implementation must remain behind tests and review until the owner/shared isolation invariants are demonstrated.


## Implementation checkpoint (policy primitive only)

A fail-closed policy primitive now exists in `scripts/intelligence-queue-policy.mjs` with unit tests in `scripts/intelligence-queue-policy.test.mjs`.

- It does not infer ownership from `assigned_to`.
- Owner tasks require task-level and package-level owner UIDs to match, and the claimant UID must match both.
- Shared tasks require an explicit shared lane and no owner UID.
- Legacy or malformed rows resolve to `quarantine`.

This is a policy primitive, not yet connected to D1 migrations, Scheduler selection, agent claims, checkpoint/result acknowledgements, or separate worker capacity. It must not be described as live queue isolation. The current single agent endpoint also has one runner authorization boundary; a separate shared-worker authorization boundary must be designed without reading or exposing credentials.


## D1 schema groundwork

The task table now has nullable `owner_uid` and `queue_lane TEXT NOT NULL DEFAULT 'quarantine'`, plus a lane/status/priority/created-at index. The migration is additive and idempotent for duplicate-column initialization. Existing records are intentionally not backfilled: neither `assigned_to` nor `created_by` is accepted as proof of owner identity.

This schema change is not yet enforcing lane-specific claims. The existing scheduler and agent endpoints still use their legacy shared selection predicates until authenticated owner identity is wired end-to-end. Do not enable lane filtering or claim the queues are isolated until task creation, claim, checkpoint, result, and stale-claim recovery all enforce the same lane and owner binding.


## Authenticated task creation binding

New tasks created through the authenticated owner task API now persist `admin.uid` as `owner_uid` when assigned to `mehran_intelligence`, and set `queue_lane='owner'`. Explicitly shared tasks are stored with a null owner and `queue_lane='shared'`; other assignments are quarantined. Owner mission work-package tasks inherit the supplied owner UID only when it is present; otherwise they are quarantined. The chat task proposal path follows the same owner/shared classification.

The existing agent claim endpoint is still a combined legacy endpoint and has not yet been lane-filtered. This is intentional: switching its query before the owner runner has a distinct authenticated route would risk stranding or misrouting work. Next implementation slice must split owner orchestration claims from shared-agent claims, bind checkpoint/result acknowledgements to the same lane, and keep stale-claim recovery lane-specific.
