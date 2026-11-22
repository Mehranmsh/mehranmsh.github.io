# MEHRAN INTELLIGENCE Scheduled Queue

Status: deployed to the production Cloudflare Worker from `main` on 2026-11-22. The scheduler implementation is live.

## What the scheduler does

The Cloudflare Worker has a Cron Trigger configured for every five minutes (`*/5 * * * *`). The scheduled handler imports eligible public-safe owner issues, checks the D1 task queue, and processes up to five eligible read-only tasks per run.

The queue fix allows the scheduler to claim either `queued` or `accepted` tasks, but only when `requires_approval=0` and the assignee is `mehran_intelligence` or `shared`.

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

## Production deployment verification

Verified on 2026-11-22:

- PR #140 was merged into `main` as commit `85fe54bd06ddfb8c562a84b09961295f9deeadd0`.
- Cloudflare Worker deployment workflow run `45012770737` completed successfully.
- GitHub Pages deployment workflow run `45012770425` completed successfully.
- Main-branch quality workflow run `45012770786` completed successfully.
- Live `/health` returned `status=online`, `database=true`, and scheduler `lastStatus=completed`.
- The latest observed scheduler run reported `processed=0`, `completed=0`, and `blocked=0`. This confirms the scheduled handler ran, but it does not yet prove an actual queued task was executed; no eligible task was present at that run.

## Remaining end-to-end check

1. In the authenticated Admin Intelligence panel, create a harmless task with action type `service_health_report`, assigned to `mehran_intelligence` or `shared`, with approval not required.
2. Wait for the next five-minute Cron Trigger.
3. Check `/health` for the latest scheduler run and inspect the task in the Admin Intelligence panel.
4. Confirm the task reaches `completed` with a bounded result. Do not use sensitive task descriptions for this test.

Do not create a public GitHub issue for private work. The GitHub issue inbox is only for explicitly public-safe tasks.
