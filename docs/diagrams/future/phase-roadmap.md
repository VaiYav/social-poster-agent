# Phase Roadmap — Syndication Feature

> **Gantt diagram:** Phase 0-5 timeline with gates and dependencies.
> **To-be:** The full syndication feature rollout plan.

```mermaid
gantt
    title Social Poster Agent — Syndication Roadmap
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Phase 0 — Foundation
    P0-01 Prisma schema migration           :p01, 2026-08-06, 1d
    P0-02 IBrowserPort LLM stubs             :p02, 2026-08-06, 1d
    P0-02a ArticleGraphState type            :p02a, 2026-08-06, 1d
    P0-03 SocialNetwork + ContentType enum   :p03, 2026-08-06, 1d
    P0-04 CanonicalUrlService                :p04, 2026-08-07, 1d
    P0-04a SyndicationModule wrapper         :p04a, 2026-08-07, 1d
    P0-05 Article graph skeleton             :p05, 2026-08-07, 1d
    P0-06 Langfuse article prompts           :p06, 2026-08-07, 1d
    P0-07 Env vars + validation              :p07, 2026-08-06, 1d
    P0-08 Article generation cron            :p08, 2026-08-08, 1d
    P0-09 BrowserFactory extension           :p09, 2026-08-08, 1d

    GATE 0 Foundation ready                  :crit, gate0, 2026-08-09, 1d

    section Phase 1 — MVP (Dev.to+Hash+LI)
    P1-00 LLM-in-the-loop engine             :crit, p1_00, 2026-08-10, 3d
    P1-01 Dev.to poster                      :p1_01, after p1_00, 2d
    P1-02 Hashnode poster                    :p1_02, after p1_00, 2d
    P1-03 LinkedIn poster                    :p1_03, after p1_00, 2d
    P1-04 PostingService extension           :p1_04, after p1_01, 1d
    P1-05 Article graph real impl            :p1_05, after p05, 3d
    P1-06 Auto-approve per-platform          :p1_06, after p1_05, 1d
    P1-07 IndexNow service                   :p1_07, after p1_04, 1d
    P1-08 BullMQ queues for new platforms    :p1_08, after p1_04, 1d
    P1-09 Rate limiter per-platform          :p1_09, after p1_04, 1d
    P1-10 E2E test Dev.to                    :p1_10, after p1_07, 1d
    P1-11 UI syndication dashboard           :p1_11, after p1_04, 2d

    GATE 1 MVP ready                         :crit, gate1, after p1_10, 1d

    section Phase 2 — Social Expansion
    P2-01 Bluesky poster                     :p2_01, after gate1, 2d
    P2-02 Mastodon poster                    :p2_02, after gate1, 2d
    P2-03 Telegram Bot API adapter           :p2_03, after gate1, 1d
    P2-04 Social promo trigger               :p2_04, after p2_03, 2d
    P2-04a Social graph extension            :p2_04a, after p2_04, 1d
    P2-05 E2E tests                          :p2_05, after p2_04a, 1d

    GATE 2 Social expansion ready            :crit, gate2, after p2_05, 1d

    section Phase 3 — Browser Platforms
    P3-01 Medium poster                      :p3_01, after gate2, 3d
    P3-02 Substack poster                    :p3_02, after gate2, 3d
    P3-03 Account model for browser plats    :p3_03, after p3_01, 1d
    P3-04 Selector strategy + health         :p3_04, after p3_01, 1d
    P3-05 E2E tests                          :p3_05, after p3_04, 1d

    GATE 3 Browser platforms ready           :crit, gate3, after p3_05, 1d

    section Phase 4 — Participation
    P4-01 Participation module skeleton      :p4_01, after gate3, 1d
    P4-02 Question finder                    :p4_02, after p4_01, 2d
    P4-03 Answer drafter                     :p4_03, after p4_02, 1d
    P4-04 Answer judge                       :p4_04, after p4_03, 1d
    P4-05 Reddit agent                       :p4_05, after p4_04, 2d
    P4-06 Quora agent                        :p4_06, after p4_04, 2d
    P4-07 Pinterest poster                   :p4_07, after p4_04, 2d
    P4-08 Engagement feedback loop           :p4_08, after p4_05, 1d

    GATE 4 Participation ready               :crit, gate4, after p4_08, 1d

    section Phase 5 — Polish & Backfill
    P5-01 Full syndication dashboard         :p5_01, after gate4, 5d
    P5-02 Judge calibration                  :p5_02, after gate4, 7d
    P5-03 Metrics & alerting                 :p5_03, after gate4, 3d
    P5-04 Backfill existing blog posts       :p5_04, after p5_03, 14d
    P5-05 Content calendar                   :p5_05, after p5_03, 3d
    P5-06 A/B testing                        :p5_06, after p5_02, 5d
    P5-07 Documentation                      :p5_07, after gate4, 3d
    P5-08 Migrate existing posters to LLM    :p5_08, after p5_06, 5d
```

## Key details

### Critical path
```
#4 (IBrowserPort stubs) → #47 (LLM engine) → ALL new platform posters
```
The LLM-in-the-loop browser engine (#47 / P1-00) is the single biggest blocker — every new platform poster depends on it. Phase 0 stubs the interface; Phase 1 implements the real engine.

### Gates (checkpoints)
- **GATE 0** — Foundation ready: Prisma migration applied, IBrowserPort extended, article graph compiles, env vars validated, `SYNDICATION_ENABLED=false` → no errors
- **GATE 1** — MVP ready: Article → judge → auto-approve → publish to Dev.to with canonical URL (verified live), IndexNow submission verified, no bans in 48h
- **GATE 2** — Social expansion ready: Bluesky, Mastodon, Telegram publishing, social promo trigger fires on article publish
- **GATE 3** — Browser platforms ready: Medium + Substack articles published with canonical URL, session persistence works
- **GATE 4** — Participation ready: Reddit/Quora answers posted, judge `promotional_tone` working, engagement tracking works

### Phase durations (estimated)
| Phase | Duration | Platforms added |
|-------|----------|-----------------|
| Phase 0 | 3-5 days | None (foundation) |
| Phase 1 | 1-2 weeks | Dev.to, Hashnode, LinkedIn |
| Phase 2 | 3-5 days | Bluesky, Mastodon, Telegram |
| Phase 3 | 1-2 weeks | Medium, Substack |
| Phase 4 | 1-2 weeks | Reddit, Quora, Pinterest |
| Phase 5 | Ongoing | (polish, backfill, migration) |

### Dependencies
- **#47 (LLM engine)** blocks ALL new platform posters (#11-13, #22-23, #26-27, #34-36)
- **#48 (migrate existing posters)** blocked by #47 + GATE 1
- **#50 (POST_VERIFIED event)** blocks IndexNow (#17) and social promo (#25)
- **#53 (ArticleGraphState)** blocks article graph skeleton (#7)
- **#6 (CanonicalUrlService)** blocks SyndicationModule (#51)
