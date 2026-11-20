# SOCIAL Media Lifecycle

Status: staging implementation, review required. This document does not authorize deployment or a Remote D1 migration.

## Safety boundary

- Provider deletion execution is disabled: `SOCIAL_MEDIA_DELETION_EXECUTION_ENABLED = false`.
- No scheduler, queue consumer, cron, poller, or background deletion worker is added.
- The deletion ledger is an inert record of work requiring a future, separately approved processor.
- The account deletion endpoint fails closed while resumable media cleanup is not available.
- No Production Worker, Production database, secret, binding, or configuration is changed by this branch.
- Migration `0021_social_media_lifecycle_registry.sql` is not applied to Remote D1.

## Data model

### `social_media_references`

One row represents one known use of an upload by a content object. References are scoped by upload owner, content type, content ID, and media slot. Active references have `released_at IS NULL`.

Supported content types:

- `post`
- `story`
- `profile_avatar`
- `profile_gallery`
- `message`
- `channel_post`

The database verifies that the referenced upload exists, is ready, belongs to the same owner, and has the expected visibility. Messages require private uploads; other supported content types require public uploads. Reference identity cannot be edited and reference history cannot be deleted.

### `social_media_deletion_jobs`

Each row represents one provider file, rather than a multi-file batch. This keeps retries independent: a failure for one file cannot hide the state of another file. Jobs are created only when no active reference remains. The database rechecks this invariant at insertion time.

A newly-created reference blocks any pending/retry job for that upload. A future executor must re-check ownership, provider ID, upload readiness, active references, and job state immediately before every provider request.

### `social_media_lifecycle_audit`

The audit ledger records reference creation/release and queued deletion. It is append-only at the database boundary.

## Current Worker behavior

- New post media, stories, channel-post media, private message attachments, profile avatars, and profile gallery images register stable upload references in the same D1 batch as their content writes.
- Story, post, channel-post, gallery-photo, avatar replacement, and message soft-delete operations release their references through database triggers.
- The final known reference release creates a per-file pending deletion job.
- User-requested upload deletion checks active references and queues work only. It never calls Rapidfile DELETE and returns HTTP 202 with `executionEnabled: false`.
- Profile avatar/gallery URLs must resolve to ready public uploads owned by the authenticated user. URL-only legacy records are not retroactively guessed.
- Account deletion is temporarily unavailable rather than invoking the former non-resumable provider-first deletion flow.

## Legacy compatibility

Existing URL-only media is intentionally not backfilled by URL matching. A URL alone is not a durable identity or sufficient proof of ownership. Such records remain outside automatic deletion until a separately reviewed reconciliation process can verify exact provider file IDs and ownership.

The added `media_upload_id`, `avatar_upload_id`, and profile-photo `upload_id` columns preserve stable IDs for new and future code paths. Existing null values remain null.

## Required verification before any future activation

1. Apply the migration only to a disposable/staging D1 database and verify every required trigger exists.
2. Run SQLite and D1 runtime tests for reference registration, ownership, concurrent release, re-reference after queueing, and append-only audit.
3. Add explicit tests for all SOCIAL deletion paths and account deletion recovery.
4. Verify Rapidfile behavior for already-deleted files, timeouts after provider success, scan states, and provider ID mismatch.
5. Add an idempotent, lease-based, separately controlled executor with bounded retries and a dead-letter/manual-review state.
6. Perform a second security review and obtain separate explicit approval before enabling any provider deletion.

## Test

`python scripts/test-social-media-lifecycle-migration.py`

This test uses disposable in-memory SQLite. It does not connect to D1 or Rapidfile.
