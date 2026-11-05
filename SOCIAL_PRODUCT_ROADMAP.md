# SOCIAL Product Roadmap

## Product vision

SOCIAL is an international social network for people everywhere. It combines familiar social networking and messaging patterns with original AI-native and creator-focused experiences. Pi integration is optional, never a requirement for registration or ordinary use.

## Product principles

1. Global by default: open registration, international audiences, multilingual UX, shareable public pages.
2. Human-first and AI-transparent: AI accounts are clearly labeled; no impersonation, fake human identities, fabricated engagement, or undisclosed automated activity.
3. Discovery that distributes opportunity: relevance, quality, freshness, diversity, and meaningful exposure for emerging creators.
4. Trust and safety: privacy controls, reporting, blocking, rate limits, moderation, and clear controls over recommendations.
5. Build in safe increments: preserve working features, test each change, and avoid shipping unverified UI or fake data as real functionality.
6. Pi is optional: any future Pi payments or account linking must be opt-in and must never request or store wallet passphrases/private keys.

## Product layers

### A. Core social and messaging
- Open registration with email, username, and password.
- Optional Pi account linking.
- Profiles, public/private accounts, follow requests, followers/following.
- Posts with media, likes, comments, bookmarks, shares, and views.
- Stories with 24-hour expiry, views, and reactions.
- Direct messages, groups, channels, and notifications.
- Search, reporting, blocking, privacy and session controls.

### B. Global discovery
Explore has three primary surfaces:
- **For You:** personalized recommendations.
- **Trending:** fast-rising topics and posts, globally and by region/language.
- **Discover:** new creators, communities, and emerging topics.

Initial recommendation signals (weights are experimental, not fixed):
- Interest and topic relevance: 30%.
- Watch time and completion: 25%.
- Saves, shares, and meaningful comments: 20%.
- Authentic engagement and quality: 15%.
- Recency: 10%.

Ranking safeguards:
- Diversity across creators and topics.
- New-creator exploration quota / controlled test impressions.
- Down-rank spam, repetitive posts, suspicious engagement, and low-quality content.
- Respect blocks, mutes, privacy, language preferences, and content controls.
- Give users “Not interested”, topic controls, and recommendation reset.
- Do not let paid placement or AI-generated engagement masquerade as organic ranking.

Cold-start strategy:
- Optional interest selection during onboarding.
- Use language, selected interests, and a balanced sample of recent public content.
- Gradually personalize from explicit feedback and genuine behavior.
- Do not invent user history or engagement.

Required event data (privacy-conscious and purpose-limited):
- Impression, meaningful view, watch duration/completion, like, comment, save, share, follow, hide/not-interested, report.
- Avoid collecting more data than needed; document retention and user controls.
- Add offline evaluation and A/B testing before changing ranking weights.

### C. AI Accounts & Agents
- Official AI account type with persistent visible AI label.
- Admin-created agents with a defined name, persona, language, topics, and posting/reply permissions.
- Agent publishing queue, per-agent rate limits, audit log, pause/disable controls, and moderation review.
- Agents may publish useful original content, answer questions, translate, and participate transparently.
- No fake followers, fake views, fake likes, fake testimonials, engagement rings, or pretending to be human.
- AI agents must obey the same community rules and safety controls as human accounts.
- Start with a small, curated set of agents; scale only after quality and user feedback are measured.

### D. AI tools and multilingual communication
- Optional personal AI assistant for drafting, summarizing, and content creation.
- Translation of posts, comments, and messages with original text available.
- User-visible indication when text is machine-translated.
- User control over translation languages and AI assistance.
- Do not send private messages or private account content to third-party AI services without clear consent.

### E. Creator collaboration
- Collaborative posts and projects with explicit contributor attribution.
- Shared creative spaces for text, images, audio, and video workflows.
- Permissions, version history, and clear ownership/licensing controls.
- Start with lightweight collaboration before building complex editing tools.

### F. Creator economy
- Creator subscriptions, tips/support, and digital goods as future optional modules.
- Transparent fees, creator eligibility, refunds/disputes, fraud controls, and applicable legal review.
- Optional Pi integration only after secure payment flows and compliance review.
- Never request wallet seed phrases or private keys.

## Delivery phases and acceptance criteria

### Phase 0: Stabilize and audit
- Verify current production behavior in desktop Chrome and Pi Browser separately.
- Preserve the existing app and backend.
- Inventory existing endpoints, UI views, schema, authentication, and known defects.
- Add a repeatable smoke-test checklist.
**Exit:** core navigation, registration/login, feed, posting, and existing messaging flows pass tests in supported browsers.

### Phase 1: Core network completion
- Fix and verify registration, profiles, follow graph, posts, comments, reactions, bookmarks, stories, messaging, groups, channels, notifications, privacy, and moderation.
- Add accessible empty states and useful onboarding.
**Exit:** each visible control performs a real backend action and survives refresh; no dead buttons or placeholder success states.

### Phase 2: Explore v1
- Implement For You, Trending, and Discover tabs.
- Add event collection, initial transparent ranking, diversity, freshness, new-creator exposure, and user feedback controls.
- Add global/language filters and basic topic pages.
**Exit:** recommendations are based on real events and content, not hardcoded or fabricated engagement.

### Phase 3: AI community
- Implement AI account type, admin agent management, labels, scheduled publishing, reply permissions, rate limits, logs, and moderation.
- Launch a small number of clearly labeled agents with useful topic-specific content.
**Exit:** agents are controllable, auditable, transparent, and cannot inflate engagement metrics.

### Phase 4: AI and global communication
- Add opt-in assistant tools and translation.
- Protect private content and provide clear consent and controls.
**Exit:** users can understand when AI or translation is used and can disable it.

### Phase 5: Collaboration and creator economy
- Add collaborative creation and attribution.
- Evaluate subscriptions, tips, and digital goods, including optional Pi support, after security and compliance review.
**Exit:** creator tools have clear permissions, ownership, payment disclosures, and abuse controls.

## Current repository observations (2026-11-05)

- The current app is a single-page index.html with existing SOCIAL views for feed, explore, reels, profile, messages, groups, channels, bots, notifications, and settings.
- worker.js already contains a substantial /social/* API, including registration/login, feed/posts, follows, notifications, stories, conversations, groups, channels, and bot endpoints.
- The current frontend contains an Explore view and a Bots view; a dedicated Trending surface was not found in the initial text scan.
- These observations are an inventory starting point, not proof that every screen or endpoint is complete or reliable. Each flow must be tested before expansion.
- No production code is changed by this roadmap document. Feature implementation should follow Phase 0 and proceed in small, verifiable commits.

## First implementation priority

Stabilize the current app and test the real Pi Browser environment first. Then complete Explore v1 using real engagement events and genuine content. AI agents should be introduced only as clearly labeled, useful community participants, never as fake human activity.
