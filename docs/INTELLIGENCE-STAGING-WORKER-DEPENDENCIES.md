# INTELLIGENCE staging Worker dependency review

The production Worker cannot safely be pointed at the four-table staging database. Its Intelligence routes are preceded by shared SOCIAL/admin bootstrap and depend on production-style admin sessions, admin audit, shared rate limits, AI budget accounting, Workers AI, and owner memory.

A separate Worker source, `intelligence-staging-worker.js`, is now implemented with its own Pi `/v2/me` verification, staging-only owner UID, SHA-256 hashed sessions, 12-hour maximum session age, revocation, owner-scoped knowledge/task-planning/relationship/approval routes, rate limiting, and atomic audit writes. Task routes only create/list queued plans. There is no task executor, scheduler, agent poller, AI binding, or production database reference.

Migration 0003 adds staging-only sessions, audit, rate limits, and owner memory. It is committed but not yet applied to Cloudflare D1. The staging database ID has not yet been independently recorded. Do not apply it until the target is positively confirmed.

A separate `wrangler.intelligence-staging.jsonc` template now exists and points only to the staging database name, but its `database_id` is an explicit placeholder. It is not deployable and no Cloudflare binding or Worker has been created. The existing production `wrangler.jsonc`, Worker, D1 binding, AI binding, cron, secrets, and data remain outside this work.
