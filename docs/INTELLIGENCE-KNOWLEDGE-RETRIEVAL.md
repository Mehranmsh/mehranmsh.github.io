# MEHRAN INTELLIGENCE knowledge retrieval

## Current retrieval method

The current knowledge store uses bounded lexical relevance ranking over the authenticated owner's entries and system-seeded company entries. Persian and English text is normalized with Unicode NFKC, Arabic yeh/kaf variants are normalized, and terms are ranked with stronger weight for title matches than body matches. High-importance entries receive a small ranking boost.

The main chat context receives at most 12 relevant ranked entries. A separate read-only knowledge search tool can return up to 12 relevant entries. The model can also call the read-only `search_organizational_knowledge` tool for up to 12 relevant entries. Content is bounded before it enters the model context.

## Security properties

- Retrieval is limited to the verified owner UID plus immutable system-seeded entries.
- Search is read-only and does not alter knowledge, tasks, approvals, accounts or external systems.
- Retrieved text is untrusted reference data. It cannot grant permissions or override system instructions.
- The main chat and targeted knowledge-search tool use strict no-fallback retrieval: when no relevant entry matches, they return an empty result rather than injecting unrelated high-priority notes. The ranking helper retains an optional bounded fallback mode for explicitly chosen internal callers, but the current chat path does not use it.
- This is lexical retrieval, not semantic/vector search. Do not describe it as embeddings, autonomous learning or verified reasoning.

## Conflict and freshness handling

Retrieved entries retain their source and `updatedAt` provenance. The current conflict-preservation safeguard recognizes competing entries only when their normalized category and title are identical; it retains a competing record in the bounded result set so the assistant can surface both versions and timestamps. It does not yet reliably detect semantic conflicts whose titles or categories differ. For conflicts it can identify, the assistant must not silently select the newest or highest-importance item. A current explicit owner instruction or independently verified company data may resolve the conflict; otherwise the assistant must ask the owner to confirm. Old or undated entries are potentially stale and must be described with that limitation. If targeted retrieval returns no relevant evidence, the assistant must say the information was not found instead of guessing. Archived entries are excluded from retrieval.

## Future evaluation

Before adding embeddings, external model providers or broader tools, measure retrieval precision and recall on owner-approved Persian and English evaluation questions. Include tests for conflicting/stale entries, prompt injection, missing knowledge and owner isolation. Any future vector index must remain inside the approved Pi Network company architecture and must not become an execution authority.

## Next conflict-management phase (design only)

The next conflict improvement must not rely on title similarity, recency, importance, or an LLM guess as proof that two statements contradict each other. The current schema has no durable relationship field, so semantic conflict detection is not yet implemented.

The safe staged design is:

1. Keep the existing lexical retrieval path read-only and fail-closed.
2. Add an owner-scoped knowledge-relationship record with a narrowly defined relation type such as `conflicts_with`, `supersedes`, or `supports`. A relationship must point to existing knowledge IDs and must never grant permissions.
3. Let INTELLIGENCE propose candidate relationships with evidence snippets and source timestamps. Candidate relationships remain unconfirmed and cannot change retrieval priority or archive either entry.
4. Require the owner to confirm, dismiss, or resolve a conflict. A resolution must identify the chosen knowledge record and retain the losing/older record and audit history; it must not silently delete information.
5. In chat, surface confirmed conflicts and unresolved candidate conflicts separately. Only owner-confirmed resolution metadata or independently verified current company data may settle a conflict.
6. Enforce owner UID checks on both ends of every relationship, reject cross-owner/system-seed mutations, and test archived, missing, duplicate, self-referential, and stale records.

Before implementation, add a dedicated migration and disposable SQLite lifecycle tests. Do not run that migration against production D1 until an isolated staging database has been created and verified. This section is a design target, not an implemented feature.

## Knowledge relationship implementation status

The staged schema and owner-controlled Worker API are now implemented on review branches, pending CI and integration review:

- `GET /intelligence/knowledge/relations` lists only the authenticated owner's relationships, with an optional validated status filter.
- `POST /intelligence/knowledge/relations` creates a candidate only after both active knowledge records are verified as belonging to the authenticated owner and both evidence excerpts are found verbatim in their corresponding stored content.
- `PUT /intelligence/knowledge/relations/:id` supports candidate confirmation or dismissal. A conflict can be resolved only after confirmation, and the selected ID must be one of its two endpoints.
- Relationship mutation and audit insertion are performed in one D1 batch.
- The Worker does not auto-create the relationship table. It returns a controlled unavailable response until the separately reviewed migration has been installed.
- Chat context now includes only relationships that touch a knowledge entry selected by the existing bounded lexical retrieval. Candidate, confirmed and resolved states are passed separately. Candidate status is explicitly unconfirmed; only an owner-confirmed resolved conflict records an owner choice. No source knowledge record is rewritten or deleted.

These endpoints are owner-operated, not autonomous model actions. The model does not yet create relationship proposals itself. CI uses smoke contracts and disposable SQLite migration tests; this is not a live Cloudflare D1 or provider integration test. Do not claim production readiness until the stacked PRs are reviewed, merged in dependency order, staged against a separate D1 database, and browser-tested.


## AI-proposed knowledge relationships (review branch)

The chat model may now call `propose_knowledge_relationship` when it identifies a possible connection between two knowledge entries. This is a suggestion workflow only:

- Both IDs must already have been retrieved into the current conversation, either in the initial ranked knowledge context or through the read-only targeted search tool.
- The model must submit a non-empty evidence excerpt for each entry. Each excerpt is bounded to 500 characters and must match the corresponding stored content verbatim.
- Both entries are reloaded from D1 and must be active records owned by the authenticated owner. System-seed records and other owners' records cannot be linked by this tool.
- The tool accepts only `conflicts_with`, `supersedes`, and `supports`. Conflict pairs are canonicalized to prevent reverse duplicates.
- A successful call creates only a `candidate` relationship and an audit event in one D1 batch. It never confirms, dismisses, resolves, edits, archives, or deletes either knowledge entry.
- The owner-controlled GET/PUT relationship API remains the only path to confirm, dismiss, or resolve. The model is explicitly instructed not to perform those transitions.
- A per-owner hourly rate limit applies. If the relationship table is absent, the proposal fails closed; the chat tool does not create or migrate production schema.

The smoke suite exercises valid candidate creation, exact-evidence rejection, non-visible-ID rejection, unexpected-field rejection, candidate-only SQL, audit insertion, and chat tool wiring. These are deterministic unit/source-contract checks with a mocked D1 batch, not a live Cloudflare D1 or live-model integration test.
