# INTELLIGENCE staging Worker dependency review

The production Worker cannot safely be pointed at the four-table staging database. Its Intelligence routes are preceded by shared SOCIAL/admin bootstrap and depend on production-style admin sessions, admin audit, shared rate limits, AI budget accounting, Workers AI, and owner memory.

A dedicated Intelligence-only staging Worker is preferred. It must independently implement Pi token verification, staging-only owner UID verification, hashed/revocable sessions, audit, rate limits, and owner-scoped data access. Do not copy production secrets, sessions, user data, audit records, or AI budget rows.

Migration 0003 adds staging-only sessions, audit, rate limits, and owner memory. It is committed to the repository but not yet applied to Cloudflare D1. The database ID has not yet been independently recorded. Do not apply it until the target is positively confirmed.

The existing production `wrangler.jsonc`, Worker, D1 binding, AI binding, cron, secrets, and data remain outside this work. No deploy, merge, task execution, or executor activation is authorized or performed.
