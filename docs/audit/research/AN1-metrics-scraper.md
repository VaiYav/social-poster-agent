# AN1 — Metrics-scraper: research & feasibility (Product Forge · Phase 1)

> Generated: 2026-06-29 · Feature: revive `scrapePostMetrics` (currently → `null`) so `PostMetrics`
> is populated, unblocking **recycling** (perf-based selection) and the **hook-bank** «learning» loop.
> Mode: CONFIRM (rich context). Repo has no `.product-forge/` — output adapted to `docs/audit/research/`.
> Implementation needs **live credentials** and cannot be completed in the sandbox — this is the
> research + plan that precedes it.

---

## 1. Executive summary

The codebase is **ready to receive metrics** — the cron, the `PostMetrics` schema, and the consumers
(hook-bank, analytics) all exist; only the actual collection (`scrapePostMetrics`) is a stub. The 2026
API landscape splits cleanly:

- **Threads → free official Insights API.** Use it. Own-account/tester mode works without App Review.
- **Facebook Pages → free official Graph API insights.** Use it (Standard Access, own Pages, no review).
  Caveat: June-15-2026 metric deprecations — build against the surviving field names.
- **X → no free read anymore.** Since **Feb 2026** X is pay-per-use (~**$0.005/read**, ≈ **$7–15/mo** at
  tens of posts/day); free tier removed. The honest risk call (see §3): the **paid API is lower-risk**
  than authenticated scraping, because scraping X analytics gambles the very account you post from. This
  is the one **decision for you** — it touches the project's stealth-vs-API philosophy.

Recommended split: **free official API for Threads + FB; X = your call (paid API vs stealth scrape).**

---

## 2. 2026 API landscape (verified, sourced)

| Network | Official metrics API? | Free for own account? | Recommendation | Key risk |
|---|---|---|---|---|
| **X (Twitter)** | Yes — API v2 `public_/non_public_/organic_metrics` on `GET /2/tweets` | **No** — pay-per-use $0.005/read (≈$7–15/mo here); free tier removed Feb 2026 | **Paid API (lower risk) _or_ stealth scrape (free, risky)** | Scrape = ban-roulette on the posting account (Turnstile, active ToS enforcement); API = paid dependency + impressions/profile-clicks gated to author OAuth and only for posts ≤30 days old |
| **Threads** | Yes — Threads Insights API `GET /{media-id}/insights?metric=views,likes,replies,reposts,quotes,shares` | **Yes** — fully free | **Free official API** | App Review needed only for *public* prod use of `threads_manage_insights`; own-account/tester mode bypasses it. 60-day token refresh |
| **Facebook Pages** | Yes — Graph API `GET /{post-id}/insights/{metric}` | **Yes** — Standard Access for own Pages, no review | **Free official API** | June-15-2026 deprecations: legacy `post_impressions`/unique-reach removed → use **Total Unique Media Views**. ≥100-likes gate; ~2-yr retention |

### Per-network detail

**X.** Full metric set (esp. impressions + profile clicks) lives in `non_public_metrics`/`organic_metrics`,
which require OAuth **user-context as the author** and only cover the **last 30 days**. Pay-per-use since
2026-02-06 ($0.005/read, 2M/mo cap); new devs can't even buy the old Basic/Pro tiers. At ~50 posts/day ×
one read = **~$7.50/mo**. Scraping is feasible (the tool already runs stealth Camoufox) but the highest-risk
option — X moved analytics/login behind Cloudflare Turnstile and enforces ToS aggressively; each scrape
risks the posting account.
Sources: docs.x.com/x-api/fundamentals/metrics · docs.x.com/x-api/getting-started/pricing ·
postproxy.dev/blog/x-api-pricing-2026 · scrapfly.io/blog/posts/how-to-scrape-twitter

**Threads.** `GET /{media-id}/insights` (views, likes, replies, reposts, quotes, clicks, shares — expanded
2025-07-25) + account insights. No paid tier / no pricing page. OAuth 2.0, scope `threads_manage_insights`
(+`threads_basic`); long-lived 60-day refreshable token. Own-account/tester reads work **without** clearing
App Review. Rate limit floor 48,000 calls/day — irrelevant at this volume.
Sources: developers.facebook.com/docs/threads/insights · …/threads/get-started/get-access-tokens-and-permissions · blotato.com/blog/threads-api-pricing

**Facebook Pages.** `GET /{page-post-id}/insights/{metric}` + page insights. Free; gated by permissions not
money. Needs a **Page Access Token** with `pages_read_engagement` (+`pages_show_list`, `read_insights`) held
by a Page admin — available under **Standard Access for your own Pages without App Review**. Gotchas: insights
populate only on Pages with ≥100 likes; ~2-year retention; **June-15-2026** deprecated most reach/impression
fields (no 1:1 replacement for reach/viral splits) → pin to surviving names (Total Unique Media Views).
Sources: developers.facebook.com/docs/platforminsights/page · …/permissions/reference/pages_read_engagement · support.sproutsocial.com (FB metric deprecations June 2026)

### Verify before building
1. X pay-per-use rate + your exact monthly cost (X changes pricing aggressively).
2. X `non_public/organic` metrics are author-OAuth-only and 30-day — read within the window.
3. FB field names post-June-2026 (Total Unique Media Views vs dead `post_impressions`).
4. Threads: does the deployment count as "public" (needs review) or stay dev/tester (own-account only)?
5. Meta token refresh (Threads 60-day; FB long-lived page token) — build refresh or reads silently 401.
6. FB ≥100-likes / Threads ≥100-followers gates: small accounts return empty insights.

---

## 3. The one decision for you — X

The agent's honest risk assessment leans **paid X API**: at ~$7–15/mo it is cheap, and it does **not** risk
the posting account, whereas scraping authenticated X analytics is "ban-roulette" on the exact account you
post from. But the project's stated philosophy is **stealth-browser, free-only, API only for free read**.
So X is a genuine product call:

- **Option A — paid X API (read-only, own posts).** ~$7–15/mo, lower ban risk, clean data incl. impressions.
  Breaks the "no paid API" rule but only for *reading your own* metrics, not posting.
- **Option B — stealth scrape X analytics.** Free, philosophy-aligned, reuses the existing Camoufox stack;
  but each scrape risks the posting account, and X analytics sit behind Turnstile.
- **Option C — skip X metrics for now.** Ship Threads + FB (free APIs) metrics; leave X metrics unpopulated
  (impressions stay null for X). Recycling/hook-bank still get 2/3 networks of signal.

Recommendation: **C now, then A or B for X later.** Ship the free Threads+FB collectors first (real value,
zero cost, low risk), and decide X separately — that unblocks recycling/hook-bank for two networks
immediately without forcing the philosophy call.

---

## 4. Codebase integration

| Layer | Location | State | Change |
|---|---|---|---|
| Cron + orchestration | `modules/analytics/metrics-scraper.service.ts` | exists (`@Cron 0 6 * * *`, gated `METRICS_SCRAPER_ENABLED`) | implement real collection per network behind a port |
| Collector (the stub) | `MetricsScraperService.scrapePostMetrics()` | returns `null` (AN1) | replace with per-network metric fetch |
| Persistence | Prisma `PostMetrics` { likes, comments, shares, impressions?, collectedAt } | schema ready | upsert rows per (post, collectedAt) |
| Consumer — learning | `modules/content-enhancements/hook-performance-bank.ts` | exists | already reads metrics once populated |
| Consumer — API | `modules/analytics/analytics.controller.ts` | exists | surfaces metrics |

**Recommended shape (matches existing hexagonal style):** define an `IMetricsSourcePort` per network and bind
implementations in the analytics infra module — `ThreadsInsightsSource` + `FacebookInsightsSource` (HTTP to
Graph/Threads APIs, tokens from env via the existing config + `withTimeout` for the calls), and later an
`XMetricsSource` (paid API client **or** a Camoufox scraper reusing `IBrowserPort`). The cron iterates
recent POSTED posts lacking fresh metrics, calls the network's source, and upserts `PostMetrics`. New tokens
(`THREADS_*`, `FACEBOOK_*`) join `env.validation.ts`. This keeps X's paid-vs-scrape choice swappable as a
single provider binding (A5/A3 pattern).

---

## 5. Recommended plan (incremental, when you give the go)

1. **Token plumbing + port.** `IMetricsSourcePort`, env tokens, `withTimeout`-wrapped HTTP client. (no creds → mock-tested)
2. **Threads collector** (free API) → upsert `PostMetrics`. Needs a Threads token (live verify).
3. **Facebook collector** (free API, post-June-2026 fields) → upsert. Needs a Page token (live verify).
4. **Cron wiring** to iterate POSTED posts + dedup collections; flag stays off until verified.
5. **X** — your decision (A paid / B scrape / C defer).
6. Recycling perf-selection + hook-bank now have real signal.

**Blocked on you:** (a) the X decision (§3); (b) live tokens for Threads + FB to verify the collectors
end-to-end (I can build + mock-test steps 1–4 without them, but can't confirm the live API shapes/fields).

---

## 6. Status / gate

Research complete (API landscape + codebase integration). **Open decision: X strategy (A/B/C).**
Next on your go: build steps 1–4 (Threads+FB collectors, mock-tested) — then you supply tokens for live
verification, and we settle X.
