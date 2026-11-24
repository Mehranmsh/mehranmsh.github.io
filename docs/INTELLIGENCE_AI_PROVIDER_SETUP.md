# MEHRAN Intelligence multi-provider AI setup

This change adds a provider router for the Intelligence mission planner and repository semantic analyzer. It preserves the existing Cloudflare Worker, D1 database, GitHub Actions runner, task queue, and report pipeline.

## Free-tier provider configuration

Add provider API keys as **Worker secrets** in the Cloudflare Worker settings. Never put keys in source files, GitHub commits, browser code, or logs.

Required secret names (only providers you choose to enable):
- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`

Cloudflare Workers AI remains available through the existing `AI` binding and needs no API key.

Optional Worker variables:
- `MEHRAN_AI_FREE_PROVIDERS`: explicit allowlist of providers verified by the owner to be on a no-billing free tier. Defaults to `openrouter` only. Cloudflare, Groq, and Gemini are completely skipped unless explicitly added here.
- `MEHRAN_AI_PROVIDER_ORDER`: comma-separated order, e.g. `openrouter,groq,gemini,cloudflare`. Entries not present in `MEHRAN_AI_FREE_PROVIDERS` are ignored.
- `MEHRAN_GROQ_MODEL`: defaults to `llama-3.3-70b-versatile`.
- `MEHRAN_GEMINI_MODEL`: defaults to `gemini-2.5-flash`.
- `MEHRAN_OPENROUTER_MODEL`: defaults to `meta-llama/llama-3.3-70b-instruct:free`. The router refuses OpenRouter model names that do not end in `:free`.
- `MEHRAN_INTELLIGENCE_MODEL`: existing Cloudflare model override.

## Failover behavior

The default provider is OpenRouter using a model ID ending in `:free`. Other providers are disabled by default and are skipped unless explicitly added to `MEHRAN_AI_FREE_PROVIDERS` after the owner verifies that the account/project is on a free tier with no billing enabled. Missing credentials are skipped. Provider quota/rate-limit and transient failures are recorded as bounded provider/status diagnostics, then the next configured provider is attempted. Cloudflare reservations are released after failed inference. The router does not retry indefinitely.

Provider free-tier quotas are controlled by each provider and can change by model, account, and region. A successful API key configuration does not guarantee free access or unlimited usage. This code cannot inspect a provider account's billing-plan state. Never add Groq or Gemini to the allowlist if billing is enabled or a paid tier is active. Never enable Cloudflare here unless the account remains on the Workers Free plan; Workers AI overage is billable on Workers Paid. Keep payment methods and auto-recharge disabled. When unsure, leave the provider disabled. OpenRouter is explicitly restricted to model IDs ending in `:free`; confirm the selected model remains available in the provider dashboard.

## Privacy and safety

External providers may receive the bounded owner mission, selected durable MEHRAN project-memory entries, and/or the bounded repository excerpts required for the requested analysis. These payloads are sent from the Worker to the selected provider. Do not store credentials, secrets, wallet material, or unrelated personal data in project memory or source excerpts. Gemini free-tier data handling may differ from paid tiers; review current provider terms before enabling it. Groq and OpenRouter have their own data-handling terms as well. Secrets remain Worker-side and are never included as model inputs. This router is limited to mission planning and repository semantic analysis in this first phase; other Intelligence chat and media-generation paths are not silently migrated by this change.

## Activation

After reviewing and merging the pull request, add the desired Worker secrets and optional variables in Cloudflare, then deploy the Worker. Do not paste API keys into ChatGPT or GitHub source files. Verify with a read-only health check and one bounded repository-analysis mission.
