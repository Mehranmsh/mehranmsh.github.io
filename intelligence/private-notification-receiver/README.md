# MEHRAN private notification receiver

This is a separate Cloudflare Worker that polls the existing MEHRAN MSH private notification outbox and forwards only validated work-package status summaries to one Telegram chat.

## Security model

- It uses the dedicated `MEHRAN_ORCHESTRATOR_TOKEN` only as an encrypted Cloudflare Worker secret.
- It uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as encrypted Cloudflare Worker secrets/variables.
- No secrets belong in this repository, GitHub Actions, Issues, pull requests, workflow logs, or ChatGPT messages.
- The source API host is pinned in code to the existing MEHRAN MSH Worker. Redirects are rejected.
- Only `owner_private` events of type `work_package_status_changed` are accepted. The receiver validates UUIDs, event identity, status values, and numeric counters.
- It sends a minimal Persian summary, not arbitrary task text or private user data.
- It processes at most five notifications per scheduled run. Delivery is at-least-once; a Telegram send that succeeds while its acknowledgement is lost can be delivered again after lease expiry.
- The public HTTP surface exposes only a non-sensitive health response. It does not expose poll, send, or acknowledgement operations.

## Deployment

1. Create a separate Cloudflare Worker named `mehran-private-notification-receiver` from this folder.
2. Configure encrypted secrets:
   - `MEHRAN_ORCHESTRATOR_TOKEN`: the same high-entropy secret configured on the source `mehran-msh-auth` Worker.
   - `TELEGRAM_BOT_TOKEN`: token from the Telegram bot you control.
3. Configure `TELEGRAM_CHAT_ID` as a Worker variable for the private destination chat.
4. Keep the cron trigger at one minute. Do not add the secrets to GitHub.
5. Verify `GET /health`, then create a harmless test work package through the authenticated private MCP route and confirm the status notification arrives.

The source Worker must already be deployed with the private outbox routes and the owner orchestration secret configured. This repository change does not deploy either Worker or configure any secret. A bot token and private chat ID must be provisioned by the owner before Telegram delivery can become active.

## Local tests

Run:

```sh
node --test intelligence/private-notification-receiver/worker.test.mjs
```
