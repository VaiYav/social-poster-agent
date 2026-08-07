# ADR-010: Engagement Safety and Ban-Risk Guardrails

## Status
Accepted — implemented in Sprint 2.4 (F1 Safety & Tests).

## Context
The autonomous engagement agent browses X, Threads, and Facebook and performs likes, comments, reposts, quotes, and follows. Without guardrails it can:
- Navigate to arbitrary URLs supplied by operators or extracted from the platform, including phishing/malicious pages.
- Post comments or quotes that contain self-promotion, troll/spam keywords, or sensitive topics, causing brand damage or platform bans.
- Be driven by any authenticated user through REST endpoints, not just admins.
- Run up interaction counts on accounts still in browse-only warmup.

Sprint 2.4 adds deterministic, fast, LLM-free safety guardrails that run before any action reaches the browser.

## Decision
We introduced a dedicated `EngagementSafetyService` and wired it into the engagement decision and execution paths.

### 1. `EngagementSafetyService`
A new service in `packages/backend/src/modules/engagement/engagement-safety.service.ts` provides two guards:

- **URL allow-listing (`validateUrl`)**: every `postUrl` or follow URL must belong to the target network's allowed hostnames.
  - X: `x.com`, `twitter.com` and their `www`/`mobile` subdomains.
  - Threads: `threads.net` and `www.threads.net`.
  - Facebook: `facebook.com`, `mbasic.facebook.com`, `m.facebook.com`, `www.facebook.com`, `mobile.facebook.com`.
  - Anything else (including `evil.example.com` or the wrong network's domain) is rejected before the browser navigates.

- **Content safety (`checkContentSafety`)**: every user-supplied or LLM-generated comment/quote text is checked against deterministic filters reused from the replies module:
  - `isLowValueComment` — self-promo / follow-bait, emoji-only, pure hashtags, generic reactions, very short text.
  - `isLikelyTroll` — troll/spam keywords (e.g. `fake`, `scam`, `bot`, `hate`).
  - `detectSensitive` — crisis/mental-health/serious complaint patterns in EN and RU/UA.

These checks are intentionally local and deterministic: they add no LLM latency, never fail due to provider outages, and are safe to run on every action.

### 2. Integration points
- `EngagementService.performInteraction` validates `targetUrl` and `targetHandle` (when it looks like a URL) and `content` (for comment/reply/quote) before acquiring a browser context.
- `EngagementDecisionService.validateGeneratedText` runs content safety on LLM-generated comments and quotes, returning `null` for unsafe text. The caller downgrades the action (`comment → like` or `quote → read`).
- `EngagementController` is now protected by `@UseGuards(AdminGuard)` so only admin users can trigger likes, comments, follows, etc. The guard is a pass-through when `AUTH_ENABLED=false`.
- Warmup gating (`WarmupService.canInteract`) and per-account rate limits (`RateLimitService`) remain in place and continue to act as pre-action guardrails.

### 3. Existing guardrails kept in place
- `EngagementDecisionService` language/script validation and `isForbiddenComment` checks continue to block off-brand or wrong-language generated text.
- Per-account, per-action rate limit keys already isolate counters across accounts.
- `BrowsingSessionService` and `HumanBehaviorEngine` abort on fatal browser errors to avoid spamming a crashed context.
- Flow-control pause stops all engagement without a restart.

## Consequences
- Engagement actions cannot be used to navigate to arbitrary URLs, reducing phishing and unintended-platform risks.
- LLM-generated text gets a brand-safety backstop before it is ever typed into a platform compose box.
- Engagement endpoints require admin role, closing the unauthenticated/authenticated-user loophole.
- All new safety logic is covered by unit tests (`engagement-safety.service.spec.ts`, additional cases in `engagement.service.spec.ts` and `engagement-decision.service.spec.ts`).

## Alternatives considered
- **LLM-based safety classifier for every comment/quote** — rejected because it adds latency, cost, and an additional failure mode. The deterministic filters catch the high-risk cases; the existing `CommentSafetyClassifierService` from `RepliesModule` can be integrated later if we need a second, heavier pass.
- **Per-network URL regex instead of a hostname allow-list** — a hostname allow-list is simpler to maintain and harder to bypass; regexes are brittle across URL variants.
- **Validate URLs only in the controller** — doing it in `EngagementService` catches both API-triggered and graph-executed paths consistently.

## Future work
- Add a `selector-health` or `consecutive-failure` circuit breaker that pauses an account when multiple actions fail in a row, as an additional ban-risk signal.
- Persist blocked unsafe interactions in the DB or a metric for monitoring.
- Consider optional `CommentSafetyClassifierService` injection for a stronger LLM-based second opinion when available.
