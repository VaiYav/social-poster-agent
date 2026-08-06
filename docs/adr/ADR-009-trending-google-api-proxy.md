# ADR-009: Programmatic Google Trends proxy with RSS fallback

## Status

Accepted, implemented in Sprint 1.1 (Phase 1 F22).

## Context

Google Trends has no official public API that accepts an API key. The previous implementation used the public RSS feed at `https://trends.google.com/trending/rss`, which is free but limited (no structured metadata, no ranking beyond traffic approximation, can be blocked or rate-limited).

The F22 plan asked for an `TRENDING_GOOGLE_API_KEY` env gate for a "programmatic API" with RSS fallback. The natural interpretation is a user-supplied proxy or third-party gateway (e.g., SerpApi, RapidAPI, or an internal service) that returns structured trending data. We still keep the public RSS feed as the zero-config default and as the fallback when the proxy is unavailable.

## Decision

1. Add two optional env vars:
   - `TRENDING_GOOGLE_API_URL` — a JSON endpoint.
   - `TRENDING_GOOGLE_API_KEY` — sent as `Authorization: Bearer <key>`.
2. The scraper (`TrendingScraperService`) uses the API only when **both** are set.
3. On any API failure (network, non-2xx, malformed JSON) the scraper falls back to the public RSS feed.
4. The API is expected to return a JSON array of objects shaped like `{ topic: string; rank?: number; url?: string; traffic?: string }`.
5. If only one of the two env vars is set, log a warning and use RSS.

## Consequences

- **Pros**: Supports any external paid/proxy Google Trends provider without vendor lock-in; preserves zero-config RSS path; graceful degradation on proxy failures.
- **Cons**: Requires the operator to provide and maintain a third-party endpoint if they want structured data; the public RSS feed remains the only free built-in source.

## Related

- `packages/backend/src/modules/trending/trending-scraper.service.ts`
- `packages/backend/tests/unit/trending/trending-scraper.spec.ts`
- `docs/runbooks/trending.md`
