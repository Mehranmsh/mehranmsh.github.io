# INTELLIGENCE Owner Memory Governance

## Scope

This migration and Worker change apply only to the isolated `mehran-msh-intelligence-staging` database and staging Worker. They do not change production data, production Worker routes, or production credentials.

## Memory record model

Each owner memory record now carries:

- `memory_kind`: general, preference, goal, constraint, decision, or project_context.
- `source_type`: owner_input, knowledge_record, or system_observation.
- `source_ref`: optional bounded source locator. A knowledge_record source must resolve to a knowledge row owned by the same verified Pi owner.
- `confidence_score`: optional owner-recorded integer from 0 to 100. It is metadata, not a calibrated probability or truth score.
- `review_status`: unreviewed, owner_confirmed, or disputed.
- `reviewed_at`: timestamp for the most recent owner review.
- `archived_at`: reversible archive marker, separate from permanent deletion.

The source identity is immutable after creation. To correct provenance, create a new memory record rather than silently rewriting the original source.

## Owner-scoped routes

- `GET /intelligence/memory`: lists active records by default. `?state=archived` lists archived records and `?state=all` lists both.
- `POST /intelligence/memory`: creates a record. New records always start as `unreviewed`. The server rejects unsupported kinds, invalid confidence values, invalid source references, and cross-owner knowledge references.
- `GET /intelligence/memory/review-queue`: returns a bounded owner-only review list, with disputed and unreviewed items first. It reports review state only; it does not decide factual truth.
- `PUT /intelligence/memory/:id` with `{"action":"confirm"}`, `dispute`, or `unverify`: records an explicit owner review and audit event.
- The same route with `{"action":"archive"}` or `{"action":"restore"}`: reversibly archives or restores a record.
- `DELETE /intelligence/memory/:id`: permanently deletes an owner-scoped record and records a metadata-only audit event.

Every mutation is owner-scoped and uses an atomic D1 batch for the state change and audit record. Audit events do not copy private memory content.

## Safety boundaries

- This is private staging memory, not a general autonomous agent memory service.
- No external source is fetched or independently validated.
- A recorded confidence score is not a truth probability.
- Owner confirmation means the owner reviewed the record, not that an external fact was proven.
- Memory review and archive actions are not executor capabilities.
- No task execution, scheduler, cron, queue consumer, production binding, or deployment is added.
- Migration `0005` is additive and one-time. Apply it only after migrations `0000` through `0004` on the dedicated staging D1 database.
