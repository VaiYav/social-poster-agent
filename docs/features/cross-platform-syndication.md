# Feature: Cross-Platform Content Syndication

**Status:** Proposal → Accepted (ADR-007)
**Effort:** L (5 phases, ~6-8 weeks total)
**Why it matters:** Grow My Zodiac AI brand authority across 11+ platforms with
zero manual effort. POSSE strategy with LLM-judge autonomous publishing.
**Related:** ADR-003 (LangGraph), ADR-004 (hexagonal ports), ADR-006 (autonomy),
ADR-007 (this feature)

## Problem

My Zodiac AI needs regular cross-platform content publication to grow brand
authority, reach audiences where they are, and earn backlinks. Currently:

- SPA posts only to X/Threads/Facebook (short-form social)
- No long-form article syndication (Dev.to, Hashnode, Medium, Substack)
- No participation mode (Reddit, Quora)
- No canonical URL management (POSSE)
- No IndexNow integration

## Proposed architecture

### High-level data flow

```
                    astro-ai-landing (blog)
                    content/blog/** → my-zodiac-ai.com/blog
                           │
                           ▼
                    content-agent-platform (CAP)
                    briefs + topics + RAG
                           │
                           ▼
               ┌───────────────────────┐
               │   SPA (extended)      │
               │                       │
               │  ContentReader        │
               │  (existing)           │
               │         │             │
               │         ▼             │
               │  ┌──────────────┐     │
               │  │ ARTICLE graph│     │  ← new LangGraph
               │  │ (long-form)  │     │
               │  └──────┬───────┘     │
               │         │             │
               │  ┌──────▼───────┐     │
               │  │ SOCIAL graph │     │  ← existing LangGraph
               │  │ (short-form) │     │
               │  └──────┬───────┘     │
               │         │             │
               │  ┌──────▼───────┐     │
               │  │ LLM-as-Judge │     │  ← existing + extended
               │  │ (5 criteria) │     │
               │  └──────┬───────┘     │
               │         │ score≥thr  │
               │  ┌──────▼───────┐     │
               │  │ Auto-Approve │     │  ← existing, enabled
               │  └──────┬───────┘     │
               │         │             │
               │  ┌──────▼───────┐     │
               │  │ BullMQ Queue │     │  ← existing
               │  └──────┬───────┘     │
               │         │             │
               │  ┌──────▼───────────────────────┐
               │  │    Platform Adapters         │
               │  │                               │
               │  │  API:                         │
               │  │  ├ devto.poster.ts   (Forem)  │
               │  │  ├ hashnode.poster.ts(GraphQL)│
               │  │  ├ linkedin.poster.ts(rest)   │
               │  │  ├ bluesky.poster.ts (ATProto)│
               │  │  ├ mastodon.poster.ts(API)    │
               │  │  └ telegram.poster.ts(Bot)    │
               │  │                               │
               │  │  Browser (Camoufox):          │
               │  │  ├ medium.poster.ts           │
               │  │  ├ substack.poster.ts         │
               │  │  ├ reddit.agent.ts            │
               │  │  └ quora.agent.ts             │
               │  │                               │
               │  │  Existing:                    │
               │  │  ├ x.poster.ts                │
               │  │  ├ threads.poster.ts          │
               │  │  └ facebook.poster.ts         │
               │  └──────┬───────────────────────┘
               │         │             │
               │  ┌──────▼───────┐     │
               │  │ Post-Publish │     │  ← new
               │  │ Hooks        │     │
               │  │ ├ verify     │     │
               │  │ ├ indexnow   │     │
               │  │ └ social-promo-trigger │
               │  └──────────────┘     │
               └───────────────────────┘
```

### New port: IApiPosterPort

```typescript
// packages/backend/src/domain/ports/api-poster.port.ts
export const IApiPosterPort = Symbol('IApiPosterPort');

export interface PublishResult {
  success: boolean;
  url?: string;
  platformId?: string;  // platform-specific post ID
  error?: string;
  rawResponse?: unknown;
}

export interface ArticleContent {
  title: string;
  body: string;              // markdown
  canonicalUrl: string;
  tags: string[];
  coverImageUrl?: string;
  contentType: 'ARTICLE';
}

export interface SocialPostContent {
  text: string;
  canonicalUrl?: string;     // link back to blog
  images?: string[];
  contentType: 'SOCIAL_POST';
}

export interface IApiPosterPort {
  readonly platform: string;
  publish(content: ArticleContent | SocialPostContent): Promise<PublishResult>;
  verifyPublished(url: string): Promise<boolean>;
  revoke?(url: string): Promise<boolean>;
}
```

### Platform adapters detail

#### API adapters (implement IApiPosterPort)

| Platform | Auth | Endpoint | Canonical | Notes |
|----------|------|----------|-----------|-------|
| Dev.to | `api-key` header | `POST /api/articles` | `canonical_url` field | Forem API, cleanest |
| Hashnode | `Authorization` header | GraphQL `publishPublication` | `canonicalUrl` arg | GraphQL mutation |
| LinkedIn | `Bearer` token | `POST /v2/posts` | URL in text | `lifecycleState=MEMBER_SHARES` |
| Bluesky | App password | `com.atproto.repo.createRecord` | URL in text | AT Protocol, open |
| Mastodon | `Bearer` token | `POST /api/v1/statuses` | URL in text | Per-instance, 500 char limit |
| Telegram | Bot token | `POST /bot{token}/sendMessage` | URL in text | Channel broadcast |

#### Browser adapters (implement IBrowserPort, Camoufox persistent context)

| Platform | URL | Editor | Canonical setting | Pattern |
|----------|-----|--------|-------------------|---------|
| Medium | `medium.com/new-story` | Lexical | Story settings → canonical URL | Like Facebook persistent context |
| Substack | `substack.com/publish` | Rich text | Post settings → canonical | Persistent context |
| Reddit | `reddit.com/r/{sub}/comments/{id}` | Markdown editor | N/A (participation) | Browse → find → answer |
| Quora | `quora.com/{question}` | Rich text | N/A (participation) | Browse → find → answer |

### Article generation graph

New file: `packages/backend/src/modules/generation/article-graph.ts`

```
StateGraph:
  research_extract → outline → draft_article → judge_article →
    conditional:
      score < threshold AND retries < 3 → refine_article → judge_article
      score < threshold AND retries >= 3 → REJECTED (end)
      score >= threshold → set_canonical → save_to_db → auto_approve (end)
```

**New state fields:**
```typescript
interface ArticleGraphState {
  topic: ContentTopic;
  facts: ExtractedFact[];
  outline: ArticleOutline;
  draft: string;           // markdown article body
  judgeScores?: ArticleJudgeScores;
  judgeFeedback?: string;
  judgeRetried: boolean;
  canonicalUrl?: string;
  retryCount: number;
}
```

**New Langfuse prompts:**
- `article-research-extract` — extract facts from topic + RAG
- `article-outline` — generate H2/H3 structure
- `article-draft` — write full article from outline
- `article-judge` — evaluate 5 criteria
- `article-refine` — rewrite based on judge feedback

### Participation module

New folder: `packages/backend/src/modules/participation/`

```
participation/
├── participation.module.ts
├── participation.service.ts       # orchestrator
├── question-finder.service.ts     # search Reddit/Quora for questions
├── answer-drafter.service.ts      # LLM drafts value-first answer
├── answer-judge.service.ts        # LLM-judge (helpfulness, promotional_tone)
├── reddit.agent.ts                # Camoufox browse + post
├── quora.agent.ts                 # Camoufox browse + post
└── engagement-tracker.service.ts  # monitor upvotes, replies
```

**Cron:** `CRON_PARTICIPATION_SCHEDULE=0 10 * * 3` (Wednesdays 10:00 UTC)

### IndexNow integration

New file: `packages/backend/src/modules/indexnow/indexnow.service.ts`

```typescript
class IndexNowService {
  async submitUrls(urls: string[]): Promise<void>;
  async submitOnPublish(post: Post): Promise<void>;  // event listener
}
```

- Listens for `POST_VERIFIED` domain event
- Submits blog URL + syndicated URLs to IndexNow API
- Key: `INDEXNOW_KEY` env var
- Batch submit (max 10,000 URLs per request)

### Canonical URL service

New file: `packages/backend/src/modules/canonical/canonical-url.service.ts`

```typescript
class CanonicalUrlService {
  buildBlogUrl(slug: string): string;
  setCanonical(postId: string, canonicalUrl: string): Promise<void>;
  verifyCanonical(postUrl: string, expectedCanonical: string): Promise<boolean>;
}
```

- Blog URL pattern: `https://my-zodiac-ai.com/blog/{slug}`
- Stores on `Post.canonicalUrl` (new Prisma field)
- API adapters pass in platform payload
- Browser adapters set in platform UI

## Data model changes

### Prisma schema

```prisma
// Updated SocialNetwork enum
enum SocialNetwork {
  X
  THREADS
  FACEBOOK
  DEVTO        // new
  HASHNODE     // new
  LINKEDIN     // new
  BLUESKY      // new
  MASTODON     // new
  TELEGRAM     // new
  MEDIUM       // new
  SUBSTACK     // new
  REDDIT       // new
  QUORA        // new
  PINTEREST    // new
}

// Updated PostStatus enum
enum PostStatus {
  DRAFT
  APPROVED
  POSTING
  POSTED
  FAILED
  REJECTED
  JUDGED       // new — judge evaluated, awaiting auto-approve decision
  VERIFIED     // new — post is live and verified
}

// New fields on Post
model Post {
  // ... existing fields
  canonicalUrl    String?   // new — POSSE canonical URL
  syndicatedUrls  Json?     // new — { devto: "...", hashnode: "...", ... }
  contentType     String    @default("SOCIAL_POST")  // new — SOCIAL_POST | ARTICLE | ANSWER | PIN
  judgeScores     Json?     // new — { anti_ai_tone: 0.85, ... }
  judgeRetried    Boolean   @default(false)           // new
  // ...
}
```

### Migration

```bash
pnpm prisma:migrate -- --name add-syndication-fields
```

## Integration points

| Component | Integration |
|-----------|-------------|
| `ContentReader` (existing) | Already reads CAP + blog. No changes needed. |
| `GenerationService` (existing) | Add `generateArticle()` method that invokes article graph. |
| `AutoApproveService` (existing) | Extend with per-platform threshold lookup. |
| `PostingService` (existing) | Extend to dispatch to API adapters (not just browser). |
| `BullMQ queues` (existing) | New queues: `spa-posting-devto`, `spa-posting-hashnode`, etc. |
| `RateLimiter` (existing) | New per-platform limits in env. |
| `HealthMonitor` (existing) | Extend to monitor API adapter health (not just browser). |
| `SSE` (existing) | New event types: `syndication:published`, `indexnow:submitted`. |
| `Langfuse` (existing) | New prompts: article-outline, article-draft, article-judge, article-refine. |
| `SPA UI` (existing) | New views: syndication dashboard, per-platform status, canonical URL column. |

## New env vars

```env
# Syndication feature flag
SYNDICATION_ENABLED=true

# API credentials
DEVTO_API_KEY=
HASHNODE_TOKEN=
HASHNODE_PUBLICATION_ID=
LINKEDIN_ACCESS_TOKEN=
LINKEDIN_AUTHOR_URN=
BLUESKY_HANDLE=
BLUESKY_APP_PASSWORD=
MASTODON_INSTANCE=mastodon.social
MASTODON_ACCESS_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=

# Browser session credentials (stored as env var names in Account model)
MEDIUM_SESSION_COOKIE=
SUBSTACK_SESSION_COOKIE=
REDDIT_SESSION_COOKIE=
QUORA_SESSION_COOKIE=

# IndexNow
INDEXNOW_KEY=
INDEXNOW_ENDPOINT=https://api.indexnow.org/indexnow

# Per-platform auto-approve thresholds
AUTO_APPROVE_MIN_SCORE_DEVTO=8
AUTO_APPROVE_MIN_SCORE_HASHNODE=8
AUTO_APPROVE_MIN_SCORE_LINKEDIN=7
AUTO_APPROVE_MIN_SCORE_MEDIUM=8
AUTO_APPROVE_MIN_SCORE_SUBSTACK=8
AUTO_APPROVE_MIN_SCORE_BLUESKY=7
AUTO_APPROVE_MIN_SCORE_MASTODON=7
AUTO_APPROVE_MIN_SCORE_TELEGRAM=7
AUTO_APPROVE_MIN_SCORE_REDDIT=9
AUTO_APPROVE_MIN_SCORE_QUORA=9

# Participation cron
CRON_PARTICIPATION_SCHEDULE=0 10 * * 3

# Article generation cron
CRON_ARTICLE_GENERATION_SCHEDULE=0 9 * * 1

# Blog URL pattern (for canonical)
BLOG_BASE_URL=https://my-zodiac-ai.com/blog
```

## Testing strategy

### Unit tests

- Each API adapter: mock HTTP, test publish/verify/revoke
- Article graph: test state transitions, judge loop, retry logic
- Canonical URL service: test URL building, verification
- Participation module: test question filtering, answer judging
- IndexNow service: test batch submission, error handling

### Integration tests

- Article generation → judge → auto-approve → BullMQ enqueue (full flow)
- API adapter publish → verify → IndexNow submit
- Browser adapter (Camoufox mock) → publish → verify

### E2E tests

- Dry-run mode: generate article → judge → "publish" (intercepted) → verify
- Live mode (manual): real publish to Dev.to with canonical URL, verify

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Medium/Substack ban for automation | Medium | High | Camoufox stealth + warm-up + rate limiter + human-like cadence |
| Reddit/Quora ban for self-promotion | Medium | High | LLM-judge `promotional_tone` criterion (must be < 0.3); max 2-3 answers/week |
| Judge false positives (bad content published) | Low | Medium | Per-platform threshold tuning; Langfuse calibration; dry-run mode |
| API rate limits hit | Medium | Low | BullMQ concurrency=1; Redis sliding window; exponential backoff |
| Canonical URL missing | Low | High | Judge criterion `canonical_correctness` fails-closed |
| Account sessions expire | Medium | Low | Existing session warm-up + health monitor + login flow |
| LLM cost explosion | Low | Medium | Free-first 8-provider router; judge-loop capped at 3; SimHash dedup |
| Camoufox memory (4 more persistent contexts) | Medium | Medium | Existing `firefox_user_prefs` optimization; pool size=1 per platform |

## References

- ADR-007: `docs/adr/ADR-007-cross-platform-syndication.md`
- Roadmap: `ROADMAP-SYNDICATION.md`
- Rule (astro-ai-landing): `.devin/rules/content-syndication.md`
- Loop spec (astro-ai-landing): `.devin/plans/syndication-loop.md`
- Architecture (astro-ai-landing): `.devin/plans/cross-platform-syndication-system.md`
- SPA CLAUDE.md: `CLAUDE.md`
- SPA CONSTITUTION.md: `CONSTITUTION.md`
