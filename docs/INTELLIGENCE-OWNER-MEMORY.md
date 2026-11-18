# MEHRAN INTELLIGENCE Owner Memory

## Purpose

The owner memory is a private, owner-curated context store for MEHRAN INTELLIGENCE. It is not a chat transcript store, an autonomous instruction channel, or an execution permission system.

## Data model

The Worker creates `intelligence_owner_memory` idempotently:

- `id`: random UUID primary key
- `owner_uid`: verified Pi owner UID from the authenticated administrator session
- `category`: one of `company`, `decision`, `preference`, `security`, or `project`
- `content`: cleaned text, 3 to 1,000 characters
- `created_at` and `updated_at`: database timestamps

The owner is limited to 100 notes. The Worker scopes reads, writes, and deletes by the verified owner UID. The API never accepts an owner UID from the request body.

## Private API

All routes require a valid administrator session and fail closed when the session cannot be verified.

- `GET /intelligence/memory`: returns up to 50 notes for the authenticated owner
- `POST /intelligence/memory`: creates one note from `category` and `content`
- `DELETE /intelligence/memory/:id`: deletes a note owned by the authenticated owner
- `GET /intelligence/events`: returns the latest 50 Intelligence-related audit events for the authenticated owner; read-only

Create and delete operations write metadata-only events to `admin_audit_log`. Note contents are deliberately excluded from audit details. The Intelligence Activity Log reads owner-scoped task, approval, and memory events from that same audit ledger.

## Use in AI conversations

The chat endpoint loads up to 30 most recently updated notes for the authenticated owner and supplies them as context. The model is instructed to treat these notes as untrusted contextual data, not executable instructions. Current explicit owner instructions and verified company data take precedence over conflicting notes.

Notes are never automatically created from chat messages. The owner explicitly adds or deletes them through the Intelligence panel.

## Safety boundaries and remaining verification

- Memory does not grant tool permissions, approve tasks, or authorize code changes.
- The memory store is separate from task results, scheduler history, and the approval ledger.
- The table is created idempotently by the Worker; no production D1 migration has been applied by this change.
- End-to-end verification against a separate staging D1 database, including owner isolation and audit behavior, remains required before production use.
