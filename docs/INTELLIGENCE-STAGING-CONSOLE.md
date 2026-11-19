# INTELLIGENCE staging console

## Purpose

`intelligence-staging.html` is a separate owner-only interface for the isolated INTELLIGENCE staging Worker. It is not the production INTELLIGENCE screen and must not be merged into the production app before a separate owner review.

## Connection lock

- The page intentionally ships with `STAGING_WORKER_URL` set to `REPLACE_WITH_VERIFIED_STAGING_WORKER_URL`.
- The UI remains disabled while that placeholder is present.
- After an independently authorized staging deployment, replace it only with the verified `mehran-intelligence-staging.<account-subdomain>.workers.dev` URL for Worker `mehran-intelligence-staging`.
- Never enter the production Worker URL or reuse the production authentication/session API.
- The staging Worker CORS allowlist currently permits the GitHub Pages origin `https://mehranmsh.github.io`.

## Authentication

- The owner signs in using the official Pi SDK with the `username` scope.
- The Pi access token is sent only to the staging Worker's `POST /session` endpoint.
- The staging Worker verifies the token server-side against Pi Platform and compares the verified UID and username to its staging-only owner setting.
- The resulting staging bearer token remains in page memory only. It is not written to localStorage or sessionStorage.
- Sign-out calls `DELETE /session` to revoke the server-side session, then clears the in-memory token.

## Included staging features

- Read-only schema health diagnostics.
- Owner-scoped knowledge review queue with explicit Verify, Dispute, and Reset review actions.
- Knowledge creation with provenance metadata. New knowledge always starts as unreviewed.
- Owner-scoped task planning. Tasks remain queued; execution is disabled.
- Owner-scoped private memory create/list.

## Explicitly excluded

- Production API, production Worker, production D1, production session, and production secrets.
- Scheduler, cron, queue consumer, agent polling, autonomous task execution, and code executor.
- Production chat and MCP endpoints.
- Public user acquisition or general user sign-up.

## Validation

The HTML inline JavaScript is included in `scripts/quality-check.py` syntax validation. `scripts/test-intelligence-staging-ui.py` checks the staging URL placeholder, Pi owner login flow, server-side session routes, allowed staging endpoints, and absence of production API references.

This page is not live until the isolated staging Worker has been separately configured and deployed with explicit owner authorization. A passing CI run does not establish a live Cloudflare connection.
