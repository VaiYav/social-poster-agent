# 07 — Additional Feature Research

## Status

Research / idea backlog. This file collects researched capabilities that can improve SPA quality and competitiveness, independent of the six core features.

## Source Context

- Internal competitive audit: `docs/audit/05-features-and-competitors.md`
- Existing backlog: `docs/refactor/phase-6-7-p3-strategic-features.md`
- External landscape research (Exa): NapoleonCat, Hootsuite Perch, SocialBee, Sked Social, Send.win, BrowserAct.

## Researched Ideas

| # | Feature | Product Value | Technical Touch | Effort | Priority |
|---|---------|---------------|-------------------|--------|----------|
| 7.1 | **Best-time-to-post + timezone** | Post when audience is active; improves reach | Extend `PostingWindowService` with per-account timezone and schedule enforcement | S-M | High |
| 7.2 | **Real analytics** | Close the feedback loop (likes/replies/impressions) | Official read APIs where free; metrics scraper for X; fix stub `metrics-scraper` | M | High |
| 7.3 | **UTM + link shortening** | Track conversions from social traffic | New `LinkService`; add `Post.links`; optional Bitly/Dub.co/self-hosted shortener | S | Medium |
| 7.4 | **Visual content calendar** | Operator can drag/see scheduled posts | UI calendar over `Post`/`PostThread` | M-L | Medium |
| 7.5 | **Bulk scheduling CSV** | Import weeks of content at once | CSV parser → create `Post` DRAFTs; validate char limits | S | Medium |
| 7.6 | **Fact-checking / grounded generation** | Lower reputation risk for astrology facts | `FactCheckService` against `swisseph`/trusted data; gate before approve | M | Medium |
| 7.7 | **Dynamic ephemeris data** | Stop using hardcoded 2026 calendar | `swisseph` or API integration; daily refresh; fallback to hardcoded | M | High |
| 7.8 | **Performance-based recycling** | Re-post top-performing content | Fix recycling service; sort by engagement metrics | S | High |
| 7.9 | **Social listening / competitor feed** | More topic ideas, engagement targets | Scrape trending / competitor handles; feed `Topic` table | M | Low |
| 7.10 | **Team & RBAC** | Multi-user operation | JWT roles; `admin`/`operator`/`viewer`; route guards | M | Low |
| 7.11 | **Webhook health check** | Know if Discord/alert channels are alive | Canary alert every N hours | XS | Low |
| 7.12 | **SSE Last-Event-ID replay** | UI does not miss events on reconnect | Redis list of recent events; replay on reconnect | M | Medium |
| 7.13 | **Prometheus metrics endpoint** | Operational observability | `/health/metrics` with `prom-client` | M | Medium |
| 7.14 | **Multi-instance / horizontal scaling** | Run multiple backend instances | Redis LLM cache, leader election, distributed locks | L | Medium |

## 7.1 Best-Time-to-Post + Timezone

`PostingWindowService` already builds an engagement heatmap from `PostMetrics`. Extend it:

- Read account `postingTimezone` (Feature 02).
- Convert heatmap hours to account-local time.
- Add `postingWindowHours` setting: list of allowed local hours.
- Orchestrator/scheduler only posts inside the allowed window.

## 7.2 Real Analytics

Current `PostMetrics` is populated by `metrics-scraper` which is disabled/stubbed. Research shows competitors (NapoleonCat, SocialBee, Hootsuite) all provide analytics. SPA should:

- Use **free official read APIs** where available:
  - Threads Insights
  - Facebook Page Insights
- Skip X read API because it is pay-per-use (as noted in `docs/audit/05-features-and-competitors.md`).
- For X, use browser scraping in `dry-run`/low-volume mode if safe, or accept missing metrics.
- Feed metrics into `PostingWindowService` and `HookPerformanceBank`.

## 7.3 UTM + Link Shortening

Add a `LinkService`:

- Wrap URLs with UTM parameters (`utm_source=spa`, `utm_medium=social`, `utm_campaign={account}`, `utm_content={postId}`).
- Optionally call a shortener (Bitly, Dub.co) or self-host a redirector.
- Because links in posts can hurt organic reach on X/Threads, consider placing the link in the **first reply/comment** instead of the root post. This is a common human pattern.
- Add `Post.links` JSON: `[{ url, shortened, utm, placement: "post" | "reply" }]}`.

## 7.4 Visual Content Calendar

The backend already has `Post` (status, `postedAt`, `approvedAt`) and `PostThread`. The UI needs:

- Calendar view by day/week/month.
- Color by status (`DRAFT`, `APPROVED`, `POSTING`, `POSTED`, `FAILED`).
- Drag to reschedule; update `approvedAt` or scheduled time.
- Filter by account/network.

Most work is UI; backend needs a performant `GET /posts/calendar` aggregation.

## 7.5 Bulk Scheduling CSV

Allow operators to upload a CSV:

```csv
topic,network,account_handle,scheduled_at,language,visual_enabled
"Mercury retrograde tips","THREADS","soulwise",2026-08-01T09:00:00Z,en,true
```

Backend parses, creates `Post` rows in `DRAFT`, validates char limits per network, and queues for the scheduled time.

## 7.6 Fact-Checking / Grounded Generation

SPA makes astrology/astronomy claims. A fact-check layer would be a product differentiator:

- Add `FactCheckService`.
- For each generated fact, verify against:
  - `swisseph` (Swiss Ephemeris) for planetary positions,
  - a curated list of astronomical facts,
  - or a cheap LLM call with a strict prompt.
- Flag posts with unverifiable claims for human review.
- Tie into Feature 07.7 dynamic ephemeris data.

## 7.7 Dynamic Ephemeris Data

Replace hardcoded `ASTRO_EVENTS_2026` with real ephemeris data:

- Use `swisseph` Node bindings or an astrology API.
- Generate daily/weekly event cache.
- Feed into topic generation as `trending`/`ephemeris` source.
- Fallback to hardcoded calendar if API fails.

This overlaps with `docs/refactor/phase-6-7-p3-strategic-features.md` 7.1.

## 7.8 Performance-Based Recycling

`RecyclingService` exists but is reported broken. Fix it:

- Sort recyclable posts by `likes + replies + shares` (use `PostMetrics`).
- Add config `RECYCLING_STRATEGY=recency|engagement|hyid`.
- Generate recycled content in all configured posting languages.

See `docs/refactor/phase-6-7-p3-strategic-features.md` 7.2 and 7.3.

## 7.9 Social Listening / Competitor Feed

- Scrape a configurable list of competitor handles or trending feeds.
- Extract popular topics/hooks and add them to the `Topic` table with `sourceType='competitor'`.
- Use low-frequency scraping and per-account browser sessions to avoid bans.

## 7.10 Team & RBAC

Current auth is a single admin account. If SPA becomes multi-user:

- Add roles: `admin`, `operator`, `viewer`.
- `admin`: manage accounts/settings/users.
- `operator`: approve/reject posts, trigger generation.
- `viewer`: dashboard read-only.
- Extend JWT claims and `JwtAuthGuard`.

## 7.11-7.14 Existing Proposals

These are already in `docs/refactor/phase-6-7-p3-strategic-features.md`:

- 7.11 Webhook canary alert (7.9)
- 7.12 SSE Last-Event-ID replay (6.8)
- 7.13 Prometheus metrics endpoint (7.8)
- 7.14 Multi-instance distribution (existing `docs/features/multi-instance-distribution.md`)

## Suggested Priority Order

1. **Now** (high value, low risk): 7.7 dynamic ephemeris, 7.8 recycling, 7.1 best-time-to-post.
2. **Next** (high value, moderate work): 7.2 real analytics, 7.6 fact-checking, 7.3 UTM/links, 7.5 CSV bulk.
3. **Later** (differentiation / scale): 7.4 calendar, 7.9 social listening, 7.10 RBAC, 7.14 multi-instance.
4. **Hygiene** (small): 7.11 canary, 7.12 SSE replay, 7.13 Prometheus.

## Effort Estimate

**S-L** (varies by feature). Collectively, these are the long-tail product improvements. Implement them one at a time after the core six features are stable.

## Related Internal Docs

- `docs/audit/05-features-and-competitors.md`
- `docs/refactor/phase-6-7-p3-strategic-features.md`
- `docs/features/multi-instance-distribution.md`
- `packages/backend/src/modules/orchestrator/posting-window.service.ts`
- `packages/backend/src/modules/content-enhancements/hook-performance-bank.ts`
