# Feature Proposal: A/B Testing Infrastructure

## Document maturity (non-canonical)

Feature status: `PLATFORM-001` in [the canonical register](../planning/FEATURES.md).

**Implemented.** The `PostVariant` model, persistence, metrics capture, `/analytics/ab-tests` endpoint, and the full feedback loop are in place. The only remaining work is optional calibration logging (item 4 below).

## Problem

The generation graph produces `abVariants` (emoji/hashtag variants) and `judgeScores` (LLM-as-a-Judge evaluation). The infrastructure now uses the *actual* performance of variants (operator approve/reject, post engagement, posting success) to influence future generation via a weighted selection and a prior-winner hint. The remaining optional work is calibration logging (item 4).

## Current state

- `prisma/schema.prisma` has a `PostVariant` table that stores `a`/`b`/`base`/`default`/`custom` variants, `judgeScores`, `selected`, `postedAt`, and engagement metrics.
- `ABVariantGenerator` produces `a`/`b` emoji variants after the `refine` step.
- `ABVariantService` creates variants, selects the one to post, records `postedAt` after posting, and updates per-variant metrics from `MetricsScraperService`.
- `MetricsScraperService` pushes scraped engagement metrics into `PostVariant`.
- `ABTestService` aggregates posted variants by `topic + network` and computes a winner via `GET /analytics/ab-tests`.
- `GenerationService` persists variants after `graph.invoke()` returns.
- `PostingService` calls `ABVariantService.selectAndApplyVariant()` before posting.
- `AnalyticsController` exposes `/analytics/ab-tests`.
- `ABTest` / `ABTestVariant` / `ABTestQuery` schemas live in `@spa/shared`.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/prisma/schema.prisma" lines="227-247" />

## Remaining work

1. ✅ **Close the selection feedback loop.** `ABVariantService.selectAndApplyVariant()` now looks up the historical winner for `topic + network` and uses a weighted selection (`AB_TEST_EXPLOITATION_WEIGHT`, default 80% winner / 20% challenger) while still preserving exploration.
2. ✅ **Prior-winner hint in generation.** `ABVariantGenerator.generateVariants()` accepts `topic` and `priorWinner` options, and the `ab_variant_*` graph node passes the historical winner from `ABVariantService.getWinnerForTopic()`.
3. ✅ **Operator UI for A/B tests.** `Analytics.vue` exposes a new A/B Tests section that calls `/analytics/ab-tests` with day/network filters and a refresh button.
4. **(Optional) Calibration logging.** Compare `judgeScores.anti_ai_tone` / `hook_strength` with operator approve/reject and engagement to judge the judge.

## Data model

No new schema changes. The existing `PostVariant` model already captures everything:

```prisma
model PostVariant {
  id          String        @id @default(uuid())
  postId      String
  post        Post          @relation(fields: [postId], references: [id], onDelete: Cascade)
  network     SocialNetwork
  label       String        // 'a', 'b', 'base', 'default', 'custom'
  content     String
  judgeScores Json?
  selected    Boolean       @default(false)
  postedAt    DateTime?
  metricsAt   DateTime?
  likes       Int?
  comments    Int?
  shares      Int?
  impressions Int?
  createdAt   DateTime      @default(now())

  @@index([postId, network])
  @@index([network, selected, postedAt])
}
```

## Integration points

- `modules/content-enhancements/ab-variant.service.ts` — selection + winner lookup.
- `modules/content-enhancements/ab-variant.generator.ts` — prior-winner hint.
- `modules/content-enhancements/ab-test.utils.ts` — shared `extractTopic` / `computeVariantStats` / `pickWinner` helpers.
- `modules/generation/generation.graph.ts` — `ab_variant_*` node passes topic to generator.
- `modules/generation/generation.service.ts` — already wires `ABVariantService` and `ABVariantGenerator`.
- `modules/analytics/ab-test.service.ts` — aggregate reporting.
- `packages/ui/src/views/Analytics.vue` — A/B tests UI section.

## Open questions / risks

- Will variant B sometimes violate platform character limits when posted? Need guardrails.
- How long is the feedback window? Engagement can arrive hours/days later; `MetricsScraper` runs daily.
- Should the judge LLM be retrained/calibrated against operator decisions? Start with correlation logging only.
- The `topic` key is extracted from `post.sourceRef.topic` (or `originalTopic` / `title` for recycled posts). Topic drift or inconsistent `sourceRef` can split the A/B sample across multiple topic keys.

## Effort estimate

**S–M** (2–5 days). The largest pieces (DB schema, outcome capture, aggregation endpoint) are already done. The remaining work is the feedback loop, generator hint, and UI.

## Related reviews

- `content-enhancements.md` (`ABVariantGenerator`, `VisualConceptService`)
- `infrastructure-llm.md` (LLM-as-a-Judge)
- `analytics.md` (`MetricsScraper`, daily stats)
- `prompt-versioning-langfuse.md` (prompt labels can be joined with A/B outcomes later)
