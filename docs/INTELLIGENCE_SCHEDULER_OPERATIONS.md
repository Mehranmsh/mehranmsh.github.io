# MEHRAN INTELLIGENCE Scheduled Queue

Status: implementation candidate on `feature/intelligence-scheduled-queue-fix`. It is not live on `main` until reviewed and merged.

## What the scheduler does

The Cloudflare Worker already has a Cron Trigger configured for every five minutes (`*/5 * * * *`). The scheduled handler imports eligible public-safe owner issues, checks the D1 task queue, and processes up to five eligible read-only tasks per run.

This change fixes a queue mismatch: owner-created pre-approved report tasks are created as `queued`, while the scheduler previously selected only `accepted` tasks. The scheduler now claims either `queued` or `accepted` tasks, but only when `requires_approval=0` and the assignee is `mehran_intelligence` or `shared`.

## Allowlisted actions

- `project_status_report`: reads project names, statuses, bounded descriptions, and update times.
- `social_metrics_report`: returns aggregate counts only.
- `service_health_report`: checks D1 and counts project records.
- `repository_quality_check`: reads metadata and the latest commit metadata for the fixed public repository `Mehranmsh/mehranmsh.github.io`. It does not fetch or execute source code and performs no repository writes.

The repository check uses a fixed allowlisted URL, bounded network timeout, and validates the returned repository identity.

## Safety boundaries

- Tasks requiring approval are never selected by the scheduler.
- Imported public GitHub issues remain untrusted. Only explicitly marked `public-safe` issues from the repository owner are considered.
- Non-health issue tasks remain in `awaiting_approval`.
- This scheduler is not a general-purpose command runner, does not deploy code, does not edit files, does not access SOCIAL personal data, and does not send private task content to ChatGPT.
- The ChatGPT-to-Worker private two-way bridge is still not implemented by this change.

## Verification after merge

1. Confirm the Worker deployment includes this commit.
2. Create a harmless admin task with action type `service_health_report` or `repository_quality_check`, assigned to `mehran_intelligence` or `shared`, with approval not required.
3. Wait for the next five-minute Cron Trigger.
4. Check `/health` for the latest scheduler run and inspect the task list in the Admin Intelligence panel.
5. Confirm the task reaches `completed` or `blocked` with a bounded result. Do not use sensitive task descriptions for this test.
