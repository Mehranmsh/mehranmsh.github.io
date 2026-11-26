# MEHRAN SOCIAL + INTELLIGENCE Integration Blueprint

Status: Architecture baseline (implementation not yet wired)
Repository: Mehranmsh/mehranmsh.github.io
Date: 2026-11-27

## Mission

MEHRAN INTELLIGENCE is a shared intelligence service embedded across MEHRAN SOCIAL, not a separate chatbot bolted onto one screen. It should improve creation, discovery, communication, community operations, accessibility, trust, safety, and product quality while preserving user agency.

## Product principles

1. **Everywhere available, never omnipotent.** Intelligence may observe permitted context, analyze, recommend, draft, summarize, translate, and coordinate. It must not silently impersonate a user or take irreversible account actions.
2. **User ownership.** Publishing, sending a message, changing account/profile/privacy settings, joining/leaving communities, deleting content, blocking users, and other account-affecting actions require the user's explicit confirmation. Moderation actions must follow published policy, provide reasons, and support appeal.
3. **Privacy by default.** Private messages and private groups are processed only to provide the feature requested and only within the relevant participants' permissions. No cross-user memory, advertising profile, or unrelated reuse. Minimize retained prompts and derived data; provide clear controls and deletion paths.
4. **Separate identities.** Human, Business, AI, and Bot accounts remain distinct. AI accounts must identify themselves as AI; bots must not be disguised as people.
5. **Global access.** All AI surfaces must respect the app's selected language, RTL/LTR direction, and original-content language. Translation is opt-in or user-triggered, never forced.
6. **Quota isolation.** Owner/personal-assistant capacity is reserved and isolated from public SOCIAL and customer usage. SOCIAL has its own budgets, queues, rate limits, and graceful degradation. Exhausted customer capacity must never consume owner capacity.
7. **Free-first infrastructure.** Prefer existing MEHRAN infrastructure and local/rule-based safeguards for routine tasks. Invoke generative AI only when needed; no mandatory paid third-party AI dependency.
8. **Explainability.** Recommendations and risk flags include a concise reason, confidence/uncertainty, and a way to report mistakes.

## Intelligence capability map

### A. Home and feed
- Relevance controls chosen by the user; explain why an item is recommended.
- Topic/language filters, duplicate and low-quality-content signals, spam detection.
- Feed quality and diversity checks; never silently suppress content based only on an opaque score.
- User controls to reset, pause, or disable personalization.

### B. Post and media creation
- Draft captions, titles, descriptions, alt text, hashtags, and translations.
- Improve clarity and accessibility while preserving the author's meaning and voice.
- Detect likely duplicates, broken links, unsafe file types, and missing descriptions.
- All generated or edited content remains a draft until the author publishes it.

### C. Messaging
- Optional translation, conversation summaries, search assistance, and suggested replies.
- Suggested replies are never sent automatically.
- Do not analyze private conversations for unrelated ranking, ads, or public analytics.
- Provide clear per-conversation controls for AI assistance.

### D. Groups and channels
- Admin summaries, topic digests, FAQ drafting, moderation queues, and spam/risk signals.
- Community-specific rules and role permissions constrain every recommendation.
- Human admins retain final authority for removals, bans, and membership decisions, except narrowly scoped reversible rate-limiting protections defined by policy.
- Record moderation reasons and provide an appeal path.

### E. Search and discovery
- Semantic search across content the current user is authorized to see.
- Discover relevant users, communities, channels, and public posts with transparent ranking reasons.
- Never reveal private profiles, private group membership, or inaccessible content through summaries or search.

### F. Profiles and account support
- Optional profile/bio drafting and accessibility/language help.
- Explain privacy/security settings and identify risky public exposure.
- Never change identity, authentication, recovery, or privacy settings without explicit confirmation.

### G. Trust, safety, and security
- Layered detection for spam, phishing links, impersonation patterns, harassment, suspicious automation, and malicious uploads.
- Combine deterministic checks with AI risk assessment; do not treat model confidence as proof.
- Use graduated responses: warn, label, queue for review, temporary reversible friction, then human-reviewed enforcement.
- Provide evidence snippets, reason codes, false-positive reporting, and appeals.
- Never expose sensitive detection signals to suspected abusers.

### H. Creator and community analytics
- Aggregate activity, engagement, growth, language coverage, and content-health trends.
- Use minimum group sizes and privacy safeguards; no individual-level surveillance dashboards for ordinary members.
- Distinguish observed facts from estimates and recommendations.

### I. Accessibility and multilingual experience
- User-triggered translation and summaries across supported languages.
- Respect selected app language, RTL/LTR, screen readers, captions, and alt text.
- Preserve the original text and offer a one-tap return to it.

### J. AI and Bot accounts
- Separate AI identities from human and bot identities in UI and permissions.
- Clearly disclose when content or replies are AI-generated.
- Owner-controlled scopes, rate limits, and audit history for AI agents.
- AI agents cannot obtain elevated permissions by prompting or by being invited into a group.

## Shared technical architecture

Use a single server-side Intelligence Gateway rather than embedding provider calls independently in each UI module.

Suggested flow:

1. SOCIAL feature emits a typed event or explicit user request.
2. Gateway authenticates the user and calling feature.
3. Policy layer checks consent, role, content visibility, scope, and action class.
4. Quota router selects the correct isolated pool and queue.
5. Task router chooses deterministic processing or an approved AI capability.
6. Output validator checks schema, safety, language, and policy.
7. Feature receives a suggestion/result; state-changing actions remain pending until confirmed.
8. Audit layer stores minimal metadata and action outcome, not unnecessary private content.

Suggested capability interfaces:
- `social.intelligence.request`
- `social.intelligence.draft`
- `social.intelligence.translate`
- `social.intelligence.summarize`
- `social.intelligence.search`
- `social.intelligence.risk_assess`
- `social.intelligence.moderation_recommend`
- `social.intelligence.analytics`

Every request should carry: request ID, actor ID, feature/source, target resource ID, permitted scope, user consent state, language, quota class, requested capability, and expiry. Never trust client-supplied role or permission claims; re-check them server-side.

## Permissions and action classes

- **Read/analyze:** only resources the actor and feature are authorized to access.
- **Draft/recommend:** allowed within the user's selected context; output is not published or sent.
- **Reversible action:** requires an explicit confirmation unless a narrowly defined, user/admin-enabled safety rule permits it.
- **High-impact action:** always requires explicit human confirmation and an audit record.
- **Forbidden:** credential extraction, silent impersonation, bypassing privacy controls, cross-account data access, covert surveillance, or quota-pool borrowing.

## Quota and reliability model

- Separate owner-reserved, public SOCIAL, and any future paid/customer quota classes.
- Independent rate limits, daily caps, queues, concurrency, and circuit breakers.
- Low-priority tasks pause before owner tasks are affected.
- On quota exhaustion or provider failure, SOCIAL remains usable; hide or disable only the affected AI enhancement and explain why.
- Cache only safe, non-sensitive, permission-independent results. Never reuse private-context outputs across users.
- Prefer batching and lightweight deterministic checks for routine workloads.

## Delivery sequence

### Phase 0 - Baseline and contracts
- Map current SOCIAL routes, components, API endpoints, authentication, database schema, and existing AI gateway.
- Identify duplicate AI paths and any client-side provider calls.
- Define event contracts, capability schemas, consent model, quota classes, and audit fields.
- Add tests before connecting live actions.

### Phase 1 - Safe shared gateway
- Implement authenticated gateway and policy checks.
- Add isolated quota routing and graceful fallback.
- Add request validation, output validation, rate limits, and minimal audit events.
- Keep all state-changing capabilities disabled by default.

### Phase 2 - User-facing assistance
- Add optional AI assistant entry points to feed, composer, search, messaging, profiles, and accessibility controls.
- Add draft-only writing, translation, summaries, and semantic search.
- Respect language and RTL/LTR preferences.

### Phase 3 - Community operations
- Add group/channel admin summaries, FAQ drafts, spam queues, risk signals, and transparent moderation recommendations.
- Add human review, reason codes, and appeal flow before enforcement automation.

### Phase 4 - Trust, safety, and analytics
- Add layered abuse detection, phishing/file checks, aggregate analytics, and false-positive feedback.
- Validate privacy boundaries and adversarial cases.

### Phase 5 - AI identities and optimization
- Add separately labeled AI accounts with explicit scopes.
- Measure quality, latency, cost, false positives, and user control outcomes.
- Expand only after tests and real-world review.

## Acceptance criteria

- Every SOCIAL AI request is authenticated, authorized, scoped, rate-limited, and routed to the correct quota pool.
- No public/customer task can consume owner-reserved capacity.
- No draft is published and no message is sent without user confirmation.
- Private content never leaks into public search, analytics, or another user's response.
- Human, Business, AI, and Bot identities remain visibly distinct.
- Moderation recommendations include reasons and appeal support; model scores alone never trigger permanent enforcement.
- All AI surfaces honor selected language and RTL/LTR.
- SOCIAL remains functional when AI is unavailable or quota is exhausted.
- Automated tests cover cross-user access, role escalation, prompt injection in user content, quota isolation, and unauthorized state changes.

## Immediate implementation rule

Do not rewrite the existing SOCIAL interface or replace its current authentication/data flows as a first step. First map the current code and server contracts, then integrate behind a small, testable gateway in incremental changes. This blueprint is the target architecture, not a claim that these capabilities are already implemented.
