# INTELLIGENCE Queue Isolation Design

Status: implementation under PR review; not merged or deployed. End-to-end acceptance and CI must pass before describing isolation as active.

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

The policy primitive is now connected to the D1 schema, owner/shared claim endpoints, checkpoint/result acknowledgements, scheduled owner selection, and the private owner runner. Legacy rows remain quarantined. This provides lane-level claim isolation in code, but does not create separate Cloudflare account-level AI capacity or prove independent provider throughput.


## D1 schema groundwork

The task table now has nullable `owner_uid` and `queue_lane TEXT NOT NULL DEFAULT 'quarantine'`, plus a lane/status/priority/created-at index. The migration is additive and idempotent for duplicate-column initialization. Existing records are intentionally not backfilled: neither `assigned_to` nor `created_by` is accepted as proof of owner identity.

The schema now enforces lane-specific claims. Owner tasks require `queue_lane='owner'`, the exact `mehran_owner_orchestrator` principal, and matching package ownership where applicable. Shared tasks require `queue_lane='shared'` and a null owner. Legacy records default to quarantine and are not automatically backfilled.


## Authenticated task creation binding

New owner-created task-hub and chat tasks retain the authenticated admin as the creator/audit actor, while their queue ownership is bound to the dedicated service principal `mehran_owner_orchestrator`. The owner work-package API is authenticated by the dedicated orchestration bearer and stores that same explicit principal on both package and tasks. Shared assignments have no owner UID and enter the shared lane. This is a service identity, not a guessed personal account UID.

`GET /agent/v1/owner/tasks/next` plus owner checkpoint/result routes require `MEHRAN_ORCHESTRATOR_TOKEN`. The legacy `/agent/v1/tasks/next` plus checkpoint/result routes require `MEHRAN_AGENT_TOKEN` and can only claim shared-lane rows. Both claim recovery and acknowledgements enforce the same lane. The GitHub Actions private runner now claims and reports owner-lane work only, using the orchestration identity. The scheduled Worker scheduler also selects owner-lane tasks only.

The shared lane now has its own scheduled GitHub Actions workflow and concurrency group. It receives only `MEHRAN_AGENT_TOKEN`, claims only shared tasks, and supports only the two bounded read-only report actions. Its test subprocesses receive a minimal environment that excludes bearer credentials. The owner runner uses the orchestration identity and a separate concurrency group. This separates task queues, claim authorization, and runner slots. It still does not create a distinct Cloudflare Workers AI provider quota or guarantee independent account-level provider throughput.
