# MEHRAN Intelligence multi-provider AI setup

The Intelligence Worker can route one bounded inference request through configured providers in this order:

1. Cloudflare Workers AI
2. Groq
3. Google Gemini API
4. OpenRouter

The default order is `cloudflare,groq,gemini,openrouter`. Override it with the Worker variable
`MEHRAN_INTELLIGENCE_PROVIDER_ORDER`. The router skips providers that do not have both a
credential (where required) and a model name configured. It never requires a local computer.

## Worker secrets

Add provider API keys as encrypted Worker secrets, never as frontend variables, repository
files, GitHub Actions variables, or plain-text configuration:

- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`

Cloudflare Workers AI continues to use the existing `AI` binding and requires no new key.

## Worker variables

Configure the model identifiers for providers you enable:

- `MEHRAN_INTELLIGENCE_GROQ_MODEL`
- `MEHRAN_INTELLIGENCE_GEMINI_MODEL`
- `MEHRAN_INTELLIGENCE_OPENROUTER_MODEL` (must end in `:free`; paid model IDs are skipped)
- `MEHRAN_INTELLIGENCE_GEMINI_FREE_ONLY=true` (required opt-in; set only after confirming the Google account has billing disabled and the free tier is in use)
- `MEHRAN_INTELLIGENCE_PROVIDER_ORDER` (optional)

Model identifiers are intentionally explicit rather than silently hard-coded. Choose identifiers
currently available to the account and its free tier from each provider's own model catalog.
The model names and free-tier quotas can change. Gemini is deliberately disabled unless the explicit free-only opt-in is set. OpenRouter is restricted to model IDs ending in `:free`.

## Failover behavior

- A missing credential or model configuration causes that provider to be skipped.
- A Workers AI budget reservation denial or provider request failure moves to the next configured provider.
- The router records bounded provider, status, and error-code diagnostics, never prompts, response bodies,
  API keys, or authorization headers.
- Provider output is never trusted merely because it came from a different model. The existing
  planner schema checks, source-evidence validation, and append-only patch validation remain mandatory.
- If every configured provider is unavailable, the mission is preserved/blocked with a structured
  diagnostic. No unlimited retries or paid fallback are attempted.
- Workers AI reservation credits are released when its inference attempt fails.

## Privacy and safety

Only add providers after reviewing their current free-tier data-use and retention terms. In particular,
the free Gemini API tier may use submitted content to improve Google's products. Do not send secrets,
credentials, wallet data, personal information, or private source material to a provider unless its
data terms have been reviewed and the owner has explicitly accepted that use.

This router does not increase any provider's contractual quota. It aggregates independent free-tier
allowances subject to each provider's rate limits, availability, account eligibility, and model access.
