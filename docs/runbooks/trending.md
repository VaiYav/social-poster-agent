# Trending (F22) Runbook

## Overview

The Trending module combines three sources to surface hot astrology-related topics:

1. **Astro events calendar** — `TrendingService` returns known astrological events (Mercury retrograde, eclipses, planetary ingresses, etc.) and flags those currently active.
2. **Google Trends** — `TrendingScraperService` fetches daily trending searches from the public RSS feed by default.
3. **X (Twitter) trending** — `TrendingScraperService` scrapes the X Explore/Trending tab via the existing Camoufox browser session pool.

Results are merged, deduplicated, niche-filtered (astrology/wellness/spirituality), and exposed through `GET /trending` (astro events), `GET /trending/merged`, and `GET /trending/active`. The `Dashboard.vue` shows a small "Trending Snapshot" card with active and upcoming events.

## Optional programmatic Google Trends API

Set both of these to use a proxy / programmatic endpoint instead of (or before falling back to) the public RSS feed:

- `TRENDING_GOOGLE_API_URL` — JSON endpoint returning an array of objects like `{ topic: string; rank?: number; url?: string; traffic?: string }`.
- `TRENDING_GOOGLE_API_KEY` — sent as `Authorization: Bearer <key>`.

Behavior:

- If **both** are set, the scraper calls the API first. On any failure (network, non-2xx, bad JSON, empty array) it falls back to the public RSS feed.
- If **only one** is set, a warning is logged and the public RSS feed is used.
- If **neither** is set, only the public RSS feed is used.

The RSS feed (`https://trends.google.com/trending/rss?geo=US`) is public, requires no key, and is the default.

## Common tasks

### Refresh trends manually

```bash
# From the UI
# Dashboard > Trending Snapshot > "View all trends" > "Refresh X + Google Trends"

# From the API
curl http://localhost:3100/api/v1/trending/merged
```

### Disable trending scraping

```bash
TRENDING_SCRAPING_ENABLED=false
```

This turns off both Google Trends and X scraping. The `TrendingService` astro calendar still works.

### Disable only X trending scraping

```bash
X_TRENDS_SCRAPING_ENABLED=false
```

Useful when the browser pool is constrained or X selectors drift.

### Tune cache

```bash
TRENDING_CACHE_TTL_MS=900000    # default 15 minutes
TRENDING_SCRAPER_SCHEDULE=0 */2 * * *  # default every 2 hours
```

### Check cache status

```bash
curl http://localhost:3100/api/v1/trending/cache-status
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Trending Snapshot` card missing | No active or upcoming astro events | Astro events are hardcoded/preloaded; verify `GET /trending` returns data. |
| Merged trends empty or slow | X scrape requires a browser context | `X_TRENDS_SCRAPING_ENABLED` can be disabled; Google Trends RSS is independent. |
| `TRENDING_GOOGLE_API_URL is set but TRENDING_GOOGLE_API_KEY is missing` warning | Only one of the two env vars is set | Set both, or unset both to use RSS only. |
| API returns `Google Trends API did not return a JSON array` | Endpoint returned an object or non-array | Update the proxy to return the expected array shape. |

## Tests

- Unit: `packages/backend/tests/unit/trending/trending-scraper.spec.ts`
- Unit: `packages/backend/tests/unit/trending/google-trends-rss.spec.ts`
- UI store: `packages/ui/tests/stores/stats.spec.ts`
