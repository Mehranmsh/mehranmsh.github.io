# MEHRAN INTELLIGENCE knowledge retrieval

## Current retrieval method

The current knowledge store uses bounded lexical relevance ranking over the authenticated owner's entries and system-seeded company entries. Persian and English text is normalized with Unicode NFKC, Arabic yeh/kaf variants are normalized, and terms are ranked with stronger weight for title matches than body matches. High-importance entries receive a small ranking boost.

The chat context receives at most 20 ranked entries. The model can also call the read-only `search_organizational_knowledge` tool for up to 12 relevant entries. Content is bounded before it enters the model context.

## Security properties

- Retrieval is limited to the verified owner UID plus immutable system-seeded entries.
- Search is read-only and does not alter knowledge, tasks, approvals, accounts or external systems.
- Retrieved text is untrusted reference data. It cannot grant permissions or override system instructions.
- Unknown or weakly matching queries fall back to a small high-priority context set rather than dumping the entire store.
- This is lexical retrieval, not semantic/vector search. Do not describe it as embeddings, autonomous learning or verified reasoning.

## Future evaluation

Before adding embeddings, external model providers or broader tools, measure retrieval precision and recall on owner-approved Persian and English evaluation questions. Include tests for conflicting/stale entries, prompt injection, missing knowledge and owner isolation. Any future vector index must remain inside the approved Pi Network company architecture and must not become an execution authority.
