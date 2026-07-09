# Feature Proposal: A/B Testing Infrastructure

## Status

Backlog / proposal. Some building blocks exist; the feedback loop is missing.

## Problem

The generation graph already produces `abVariants` (emoji/hashtag variants) and `judgeScores` (LLM-as-a-Judge evaluation), and both are stored in `Post.llmMetadata` as JSON. However, there is no closed loop that compares the *actual* performance of variants (operator approve/reject, post engagement, posting success) against the predicted judge scores. The system therefore cannot learn which variants perform better in production.

## Current state

- `ab-variant.generator.ts` produces A/B variants per network after `visual_concept`.
- `judge-prompt.ts` / `makeJudgeNode()` in `generation.graph.ts` produces `anti_ai_tone`, `hook_strength`, `factual_accuracy`, `character_limit` scores.
- `Post.llmMetadata` in `prisma/schema.prisma` holds `{ model, tokens, cost, promptVersion, angleType }` plus the new fields `abVariants` and `judgeScores` (JSON).
- `analytics.service.ts` can read `postedAt` and `PostMetrics`, but it does not join variants/judge scores with real-world outcomes.
- No API/UI surface for operators to view test results or to force a "winning" variant.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/src/modules/generation/generation.graph.ts" lines="1123-1130" />

## Proposed feature

1. **Variant registry in the DB.** Add a `PostVariant` relation (or extend `Post.llmMetadata` with strongly-typed fields):
   - `variantId`, `postId`, `network`, `variantLabel` (A/B), `content`, `judgeScores`, `selected` boolean.
   - When a post is generated, persist all variants, not only the one that was eventually posted.
2. **Outcome capture.**
   - `PostingService` records which variant was selected and the final `postUrl`.
   - `AutoApproveService` / `PostsService.approve` records whether the post was approved or rejected (label as "rejected variant").
   - `MetricsScraperService` pulls engagement metrics per `postId` and joins with the variant that was live.
3. **Win computation service.** `AnalyticsService` or a new `ABTestService` computes, per `runId`/topic, which variant had better outcomes (approval rate, likes, reposts, comments, post success). Confidence interval / Bayesian bandit optional.
4. **Feedback into generation.** `ABVariantGenerator` and `judgeNode` receive a "prior winner" hint for recurring topics, or the system can automatically skew the generator toward the winning style (temperature, emoji density, hashtag count).
5. **Operator dashboard.** A new endpoint `/analytics/ab-tests` listing active and historical tests with winner, sample size, lift, confidence.

## Data model changes

```prisma
model PostVariant {
  id        String   @id @default(cuid())
  postId    String
  post      Post     @relation(fields: [postId], references: [id])
  network   String
  label     String   // e.g. "A" | "B"
  content   String
  judgeScores Json?
  selected  Boolean  @default(false)
  postedAt  DateTime?
  metricsAt DateTime?
  likes     Int?
  replies   Int?
  reposts   Int?
  impressions Int?
  createdAt DateTime @default(now())

  @@index([postId, network])
  @@index([network, selected, postedAt])
}
```

Alternative: keep everything in `Post.llmMetadata` JSON if schema churn is undesirable.

## Integration points

- `modules/generation/generation.service.ts` — persist variants after graph returns.
- `modules/posting/posting.service.ts` — mark the selected variant, capture `postUrl`.
- `modules/autonomy/auto-approve.service.ts` / `posts.service.ts` — record rejections.
- `modules/analytics/metrics-scraper.service.ts` — per-variant metrics.
- `modules/analytics/analytics.service.ts` — AB test aggregation.
- `packages/shared` — new `PostVariantSchema` and DTOs.

## Open questions / risks

- Will variant B sometimes violate platform character limits when posted? Need guardrails.
- How long is the feedback window? Engagement can arrive hours/days later; `MetricsScraper` runs daily.
- Should the judge LLM be retrained/calibrated against operator decisions? Start with correlation logging only.
- UI needs new screens; backend can expose endpoints first.

## Effort estimate

**M–L** (2–4 weeks). The largest work is the DB schema, the outcome-capture plumbing, and the operator dashboard UI.

## Related reviews

- `content-enhancements.md` (ABVariantGenerator, VisualConceptService)
- `infrastructure-llm.md` (LLM-as-a-Judge)
- `analytics.md` (MetricsScraper, daily stats)
