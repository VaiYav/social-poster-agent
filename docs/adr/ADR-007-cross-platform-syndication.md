# ADR-007: Cross-Platform Content Syndication Extension

**Status:** Accepted
**Date:** 2026-08-05
**Decider:** Valentyn Yakovliev
**Supersedes:** None (extends ADR-003 LangGraph, ADR-004 hexagonal ports, ADR-006 autonomy)

## Context

SPA currently posts short-form social content to X, Threads, and Facebook via
Camoufox browser automation. The system has mature infrastructure (458 tests,
LangGraph generation, LLM-as-a-Judge, auto-approve pipeline, BullMQ queues,
rate limiter, health monitor, SimHash dedup, 8-provider LLM router, Langfuse
observability, hexagonal ports).

A new requirement emerged: **cross-platform content syndication** — publishing
long-form articles and social posts to 11+ platforms (Dev.to, Hashnode,
LinkedIn, Bluesky, Mastodon, Telegram, Medium, Substack, Reddit, Quora,
Pinterest) to grow brand authority for My Zodiac AI.

### Options considered

| Option | Verdict | Reason |
|--------|---------|--------|
| Build inside `astro-ai-landing` | Rejected | Nuxt frontend — adding NestJS + Prisma + BullMQ + Camoufox = architectural monolith |
| New standalone project | Rejected | Duplicates ~90% of SPA infrastructure (3-4 weeks wasted before first adapter) |
| Use Pipepost MCP | Rejected | External dependency, limited platform coverage, no browser automation for API-less platforms, no LLM-judge, no Langfuse |
| **Extend SPA** | **Accepted** | All infrastructure exists. Add new adapters + article generation mode. Reuse 458 tests, hexagonal ports, auto-approve, judge, queues. |

## Decision

**Extend SPA with:**

1. **New platform adapters** — API-based (Dev.to, Hashnode, LinkedIn, Bluesky,
   Mastodon, Telegram) and browser-based (Medium, Substack via Camoufox)
2. **Article generation mode** — new LangGraph graph for long-form content
   (vs existing short-post social graph)
3. **Canonical URL management** — POSSE strategy (blog = source of truth)
4. **Participation module** — Reddit/Quora agent (find questions → draft →
   judge → post)
5. **IndexNow integration** — submit new URLs after publish
6. **Full autonomy** — LLM-judge gatekeeps, no HITL (`AUTO_APPROVE_ENABLED=true`)

### New port: IApiPosterPort

Existing `IBrowserPort` covers Camoufox-based posting. API-based platforms need
a separate port (no browser, direct HTTP):

```typescript
export const IApiPosterPort = Symbol('IApiPosterPort');

export interface IApiPosterPort {
  readonly platform: string;
  publish(content: ArticleContent | SocialPostContent): Promise<PublishResult>;
  verifyPublished(url: string): Promise<boolean>;
  revoke?(url: string): Promise<boolean>; // optional — delete post
}
```

Each API adapter implements `IApiPosterPort`. Browser adapters (Medium,
Substack) continue using `IBrowserPort` (same as Facebook persistent context
pattern).

### Platform type extension

`SocialNetwork` enum extends to cover all platforms. New platforms are
**syndication targets** (article + social), not just social:

```typescript
export const SocialNetworkSchema = {
  // Existing (social, browser-based)
  X: 'X',
  THREADS: 'THREADS',
  FACEBOOK: 'FACEBOOK',
  // New: API-based article + social
  DEVTO: 'DEVTO',
  HASHNODE: 'HASHNODE',
  LINKEDIN: 'LINKEDIN',
  BLUESKY: 'BLUESKY',
  MASTODON: 'MASTODON',
  TELEGRAM: 'TELEGRAM',
  // New: browser-based article
  MEDIUM: 'MEDIUM',
  SUBSTACK: 'SUBSTACK',
  // New: participation (not broadcast)
  REDDIT: 'REDDIT',
  QUORA: 'QUORA',
  PINTEREST: 'PINTEREST',
} as const;
```

### Content type distinction

```typescript
export const ContentTypeSchema = {
  SOCIAL_POST: 'SOCIAL_POST',   // existing — short-form, per-network
  ARTICLE: 'ARTICLE',           // new — long-form, canonical URL
  ANSWER: 'ANSWER',             // new — Reddit/Quora participation
  PIN: 'PIN',                   // new — Pinterest visual
} as const;
```

### Article generation graph (new LangGraph)

Separate from existing social-post graph:

```
research_extract → outline → draft_article → judge_article →
  [score < threshold] → refine_article → judge_article (max 3 retries)
  [score ≥ threshold] → set_canonical → save_to_db → auto_approve
```

New judge criteria for articles:
- `anti_ai_tone` (existing)
- `factual_accuracy` (existing)
- `canonical_correctness` (new) — is canonical URL set and correct?
- `structure_quality` (new) — headings, flow, readability
- `seo_score` (new) — keyword density, meta description, title

### Auto-approve per-platform thresholds

```env
AUTO_APPROVE_ENABLED=true
AUTO_APPROVE_MIN_SCORE=7                    # default
AUTO_APPROVE_MIN_SCORE_DEVTO=8              # developer audience, quality bar
AUTO_APPROVE_MIN_SCORE_HASHNODE=8
AUTO_APPROVE_MIN_SCORE_LINKEDIN=7
AUTO_APPROVE_MIN_SCORE_MEDIUM=8
AUTO_APPROVE_MIN_SCORE_SUBSTACK=8
AUTO_APPROVE_MIN_SCORE_BLUESKY=7
AUTO_APPROVE_MIN_SCORE_MASTODON=7
AUTO_APPROVE_MIN_SCORE_TELEGRAM=7
AUTO_APPROVE_MIN_SCORE_REDDIT=9             # participation, strictest
AUTO_APPROVE_MIN_SCORE_QUORA=9
```

### Canonical URL service

New `CanonicalUrlService`:
- Blog URL pattern: `https://my-zodiac-ai.com/blog/{slug}`
- Stores `canonicalUrl` on `Post` record (new Prisma field)
- API adapters pass `canonical_url` in platform API payload
- Browser adapters set canonical in platform UI (Medium story settings,
  Substack post settings)
- Judge criterion `canonical_correctness` fails if missing

### Participation module (Reddit/Quora)

Different workflow — not broadcast, but participation:

```
find_questions → filter_relevant → draft_answer → judge_answer →
  [score < threshold] → refine_answer (max 2 retries)
  [score ≥ threshold] → post_answer (Camoufox) → track_engagement
```

Judge criteria for participation:
- `helpfulness` — does it answer the question?
- `promotional_tone` — is it overly promotional? (must be < 0.3)
- `factual_accuracy` — are astrology facts correct?
- `anti_ai_tone` — does it sound human?

## Consequences

### Positive

- **Zero infrastructure duplication** — reuse SPA's queues, judge, auto-approve,
  rate limiter, health monitor, SimHash, LLM router, Langfuse, UI, SSE
- **Consistent autonomy model** — same LLM-judge gatekeeper for all platforms
- **Unified observability** — all syndicated content tracked in Langfuse +
  SPA UI
- **Hexagonal extensibility** — new adapters are new port implementations,
  no core changes
- **POSSE compliance** — canonical URLs wired automatically

### Negative

- **SPA scope expands** — from 3 social platforms to 11+ platforms + articles
- **Prisma schema migration** — new `canonicalUrl` field, new enum values
- **More Camoufox sessions** — Medium + Substack + Reddit + Quora = 4 more
  persistent browser contexts (memory: ~340-500 MB each)
- **More API credentials to manage** — 6 API keys + 2 browser session cookies
- **Judge calibration overhead** — per-platform thresholds need tuning over
  time

### Mitigations

- Camoufox memory: existing `firefox_user_prefs` optimization + pool size=1
  per platform + idle context TTL
- API credentials: SPA already has `Account` + `AccountGroup` models +
  `credentials_ref` pattern (stores env var name, not secret)
- Judge calibration: Langfuse tracks scores over time, thresholds are env vars

## References

- ADR-003: LangGraph generation
- ADR-004: Hexagonal ports
- ADR-006: Autonomous agent architecture (auto-approve)
- Feature spec: `docs/features/cross-platform-syndication.md`
- Roadmap: `ROADMAP-SYNDICATION.md`
- Rule (astro-ai-landing): `.devin/rules/content-syndication.md`
- Loop spec (astro-ai-landing): `.devin/plans/syndication-loop.md`
