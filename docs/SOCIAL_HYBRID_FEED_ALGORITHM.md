# MEHRAN SOCIAL Hybrid Intelligence Feed

Status: client-side V1 implemented in the SOCIAL web app. Server-side Intelligence ranking is a planned phase and is not active yet.

## Product decision

The default feed mode is **Hybrid Intelligence** ("For you"). Members can switch to **Latest** at any time. The selection is stored on the current device.

Hybrid means relevance and discovery are balanced with recency and diversity. It must not optimize for endless scrolling, outrage, raw watch time, or engagement bait.

## V1 behavior currently implemented

- Ranks the posts already returned by the existing SOCIAL feed endpoint (currently up to 50 posts).
- Uses a small, transparent set of signals: recency, the signed-in member's likes on authors, aggregate likes/comments, and whether media is present.
- Applies a diversity pass so the first part of the feed does not show more than two posts from one author before other authors get a chance.
- Adds a per-account "Show less" feedback action. Feedback is stored locally on the device and scoped by SOCIAL username.
- Provides a "Latest" mode that sorts by post creation time without personalization.
- Adds a member-controlled personalization strength slider (0-100%). At 0%, author-affinity and aggregate-engagement boosts are disabled; freshness, diversity, media presence, and explicit negative feedback remain active.
- Adds a per-account local reset action for accumulated "Show less" feedback.
- Stores personalization strength separately for each SOCIAL username on the current device.
- Defaults to Hybrid Intelligence for members who have not selected a mode.
- Does not publish, like, follow, comment, block, or change account settings on a member's behalf.

## Ranking principles

1. **Relevance:** use explicit member actions and followed relationships where the API provides them.
2. **Freshness:** newer content should normally receive a boost, without making older high-quality content invisible.
3. **Diversity:** avoid repetitive authors, topics, and media formats.
4. **Quality and integrity:** apply moderation and trust signals before recommendation ranking; popularity alone is not proof of quality.
5. **Member agency:** provide Latest, adjustable personalization strength, Show less, and a reset for local feedback. A true full pause remains a future server-side control.
6. **Safety:** do not reward harassment, scams, spam, misinformation, or manipulative engagement patterns.
7. **Transparency:** clearly distinguish organic recommendations from sponsored content. Sponsored content must be labeled and must not silently buy organic rank.
8. **Privacy:** do not infer sensitive traits or use private message contents to rank public feed content.

## V1 scoring outline

The current client-side prototype combines:
- A decaying freshness score.
- A capped engagement score based on likes and comments.
- A modest media-presence signal.
- A limited author-affinity signal from posts the member has liked.
- A strong negative adjustment for "Show less" feedback.
- A small diversity pass by author.

The values are initial engineering heuristics, not trained model weights. They must be tuned only after representative testing and member feedback. Client-side V1 is not a claim that MEHRAN INTELLIGENCE or the Worker is already ranking feed responses.

## Required server-side phase

The current SOCIAL API worker source was not present in the accessible repository during the implementation audit. Before server-side ranking can be shipped:

- Locate and review the actual Worker source and deployment pipeline.
- Add a versioned feed-ranking service behind the existing authenticated SOCIAL API.
- Keep authorization, visibility, block/mute, and moderation filtering ahead of ranking.
- Add privacy-safe event collection with explicit retention limits and member controls.
- Add per-account preference storage, including mode, reset, and "show less" feedback.
- Keep owner/administrator Intelligence capacity and customer-facing AI capacity isolated.
- Add deterministic fallback to chronological order if ranking is unavailable or slow.
- Add rate limits, bounded candidate sets, cache controls, and audit logs.
- Never send a post, message, follow, or other action without the member's explicit action.

## Rollout gates

1. Unit tests for score calculation, date parsing, author diversity, and account isolation.
2. Test with empty feeds, malformed timestamps, missing metrics, large counts, and mixed account types.
3. Verify blocked/private content cannot enter candidate sets.
4. Verify Latest is truly chronological and does not read personalization signals.
5. Verify one member's local feedback is not visible to another member on the same device.
6. Compare relevance, freshness, diversity, hide/show-less rate, reports, and member satisfaction. Do not use time-spent as the sole success metric.
7. Ship server-side Intelligence ranking only after Worker source review and security approval.

## Known V1 limitations

- Ranking only reorders the candidate posts already loaded by the current feed endpoint; it does not expand discovery.
- Personalization strength and Show less feedback are local to the browser/device and based on a narrow set of signals. The slider does not disable every non-personalized ranking component.
- No server-side model, embeddings, trend engine, creator-growth model, or cross-device preference sync is active.
- Existing Explore and Reels views are not yet powered by this ranking service.
