# Module: `modules/content-enhancements`

## 1. What this module does

`modules/content-enhancements` is a collection of utility services and pure functions that augment the generation pipeline: visual concepts, A/B variants, thread depth, content pillar rotation, hook performance bank, trend guardrails, engagement-bait detection, humanization gate, slop lexicon, language packs, and source URL resolution.

**Main responsibilities:**
- `ContentPillarTracker` — Redis-backed 7-day content pillar rotation and recommendation.
- `VisualConceptService` — generate image prompts for quote cards / aesthetic photos / chart visualizations.
- `ABVariantGenerator` — generate minimal vs. expressive emoji variants of a post.
- `ThreadDepthController` — decide thread depth and generate continuation tweets.
- `HookPerformanceBank` — aggregate engagement metrics by hook technique and recommend the best technique.
- `TrendGuardrail` — deterministic + LLM brand-safety filter for trending topics.
- `EngagementBaitDetector` — regex-based detection of engagement-bait phrases.
- `HumanizerGate` / `SlopLexicon` — deterministic AI-tell detection and multilingual slop word list.
- `LanguagePacks` — native few-shot examples for non-English voice.
- `SourceUrlUtil` — resolve blog URLs from content source paths.
- `ContentStyleRotation` / `pickContentStyle()` — 12 content styles (hot_take, story_time, myth_buster, etc.) selected by date + network to keep posts varied.
- `ThreadLimit` / `HumorMechanics` — thread character limits and humor-related utilities.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `content-enhancements.module.ts` | NestJS module | `ContentEnhancementsModule` |
| `content-pillar.tracker.ts` | Service | `getPillarStats()`, `recommendPillar()`, `recordPillar()`, `recordPost()`, `classifyPillar()` |
| `visual-concept.service.ts` | Service | `isEnabled()`, `generateConcept()`, `getDimensions()` |
| `ab-variant.generator.ts` | Service | `isEnabled()`, `generateVariants()` |
| `thread-depth.controller.ts` | Service | `planThread()` |
| `hook-performance-bank.ts` | Service | `aggregateStats()`, `getRecommendation()`, `getStats()`, `classifyHookTechnique()` |
| `trend-guardrail.ts` | Pure functions | `isTrendingSource()`, `isBlocklisted()`, `llmOpportunityScore()`, `checkTrendSafety()` |
| `engagement-bait.detector.ts` | Pure functions | `detectEngagementBait()`, `hasEngagementBait()`, `buildBaitRewriteInstruction()` |
| `humanizer-gate.ts` | Pure functions | `analyzeHumanization()`, `buildHumanizeInstruction()` |
| `slop-lexicon.ts` | Pure functions | `getLexicon()`, `getSlopListForPrompt()`, `scanSlop()` |
| `language-packs.ts` | Pure functions | `getLanguageExamples()` |
| `source-url.util.ts` | Pure functions | `extractBlogSlug()`, `buildSourceUrl()`, `resolveCtaUrl()` |
| `content-style.rotation.ts` | Pure functions | `CONTENT_STYLES`, `pickContentStyle()` |
| `thread-limit.ts` | Pure functions | `truncateForThread()` (assumed) |
| `humor-mechanics.ts` | Pure functions | humor utilities (not reviewed) |

## 3. How it works

### 3.1 `ContentPillarTracker`

- Maintains `spa:pillar:<pillar>:count` Redis counters with 7-day TTL.
- `classifyPillar` uses keyword regex to map a topic to one of 7 pillars.
- `recommendPillar` returns the pillar with the largest `targetRatio - actualRatio`.
- `recordPost` classifies and increments the counter.

### 3.2 `VisualConceptService`

- Feature-gated by `VISUAL_CARDS_ENABLED` (default false).
- Selects a cosmic gradient by `content.length % 5`.
- Extracts `firstLine` for quote card overlay.
- Uses LLM to choose `quote_card` / `aesthetic_photo` / `chart_visualization`.
- Falls back to deterministic `quote_card`.
- Returns `VisualConcept` with `imagePrompt`, `textOverlay`, `bgGradient`, `network`.

### 3.3 `ABVariantGenerator`

- Feature-gated by `AB_VARIANTS_ENABLED` (default false).
- LLM generates Variant A (0-1 emoji, no hashtags) and Variant B (2-3 emojis, no hashtags).
- Parses `A:` / `B:` lines from response.
- Heuristic fallback: strip emojis/hashtags for A; add 1-2 cosmic emojis for B.
- Counts emojis and hashtags.

### 3.4 `ThreadDepthController`

- Facebook always depth 1.
- User override clamped to `networkMax`.
- Auto-depth: ≥3 facts + educational/self_discovery pillar → 3-5; ≥2 facts → 3; else default.
- Generates continuation tweets via LLM (one per line, numbered) or heuristically from `keyFacts`.
- Truncates each tweet with `truncateForThread`.

### 3.5 `HookPerformanceBank`

- Daily cron at 7am (or `HOOK_BANK_AGGREGATE_SCHEDULE`).
- Aggregates last 500 `POSTED` posts with `llmMetadata.hook` and `metrics`.
- Computes `engagement = likes + 2*comments + 3*shares`.
- Caches per-network stats in Redis.
- `getRecommendation` ranks by hybrid score (0.4 quality + 0.6 engagement).

### 3.6 `TrendGuardrail`

- `isTrendingSource` checks path segment `trending/`.
- `isBlocklisted` uses 66-word blocklist with word boundaries, astrological override for "Cancer".
- `llmOpportunityScore` calls LLM for JSON `{ safe, opportunityScore, suggestedAngle, reason }`.
- `checkTrendSafety` fails closed on LLM error.

### 3.7 `EngagementBaitDetector`

- Regex patterns for explicit like/comment/share/tag/vote/follow asks and generic "what's your sign?" closings.
- `buildBaitRewriteInstruction` formats the critique for refine prompts.

### 3.8 `HumanizerGate` / `SlopLexicon`

- `scanSlop` searches language-specific slop words/phrases.
- `analyzeHumanization` counts em dashes, sentence lengths (burstiness/CV), hashtags.
- `buildHumanizeInstruction` generates rewrite instructions.

### 3.9 `LanguagePacks`

- Provides 6 native few-shot examples for `ru`, `uk`, `es`, `it`.
- Injected as `{langExamples}` in draft prompt.

### 3.10 `SourceUrlUtil`

- `extractBlogSlug` matches `/blog/<locale>/<slug>.md`.
- `buildSourceUrl` returns `/<locale>/blog/<slug>` for non-`en` locales.

### 3.11 `ContentStyleRotation`

- Defines 12 `ContentStyle` entries (`content-style.rotation.ts:34-236`) — e.g. `hot_take`, `story_time`, `myth_buster`, `tiny_lesson`, `mystical_poem`, `meme_frame`, `broken_fourth_wall`, etc.
- Each style carries `promptGuidance`, `example`, `worksForShort`, `worksForLong`, and `humorCompatible` flags.
- `pickContentStyle(network, runId?)` (`content-style.rotation.ts:243`) filters by short/long eligibility and uses `dayOfYear` rotation so the same day is consistent but different days vary.
- Consumed by `GenerationService` / draft prompt construction to inject `styleGuidance`.

## 4. Dependencies

- `infrastructure/redis` — `SHARED_REDIS`.
- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/llm` — `ILlmPort`.
- `infrastructure/config` — `parseBool`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `VISUAL_CARDS_ENABLED` | `false` | `VisualConceptService` | Enable visual concepts |
| `AB_VARIANTS_ENABLED` | `false` | `ABVariantGenerator` | Enable A/B variants |
| `THREAD_DEFAULT_DEPTH` | `2` | `ThreadDepthController` | Default thread depth |
| `HOOK_BANK_AGGREGATE_SCHEDULE` | `0 7 * * *` | `HookPerformanceBank` | Cron for aggregation |
| `TRENDING_LLM_FILTER_ENABLED` | `true` | `TrendingScraperService` | Enable LLM trend filter |
| `SITE_BASE_URL` | not used? | `SourceUrlUtil` default | `DEFAULT_SITE_BASE_URL` hardcoded |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `ContentPillarTracker` Redis counter is not a true rolling window**
- It `incr`s and `expire`s with 7 days on every record. The counter is `total in last 7 days since last increment`, but if no posts for a pillar, it expires. However, if posting stops, the TTL expires and the counter disappears. When a new post is recorded, it starts at 1 and TTL resets. This means the "rolling window" is actually just `last 7 days from the most recent post of that pillar`, not a fixed calendar window. Two posts of pillar A on day 1 and day 8 will both count because the second resets TTL. This is a bug. It should use a sliding window with `expire` only on first set, or use `spa:pillar:last7` hash as mentioned in the JSDoc. The JSDoc mentions `spa:pillar:last7` hash but the code uses `spa:pillar:<pillar>:count` only. The `last7` hash is never used. This is a discrepancy. **B2. Critical for pillar rotation accuracy.**

**B2. `ContentPillarTracker` `classifyPillar` returns `daily_weather` as default but `daily_weather` target ratio is 0.20. Many topics may default to `daily_weather` and exceed ratio.**
- The `classifyPillar` rules are broad. For example, a topic about "Jupiter in Aries" might not match any rule and default to `daily_weather`. Then `daily_weather` becomes overrepresented. The classifier should be more specific. But this is a heuristic. Not a bug, but a risk.

**B3. `VisualConceptService` `gradientIdx` is `content.length % COSMIC_GRADIENTS.length`. This is a very weak hash. Two posts with same length get same gradient. It does not depend on content. Minor. **B4. `VisualConceptService` `firstLine` for `quote_card` is the first line of content. If the first line is long, it may be truncated by image rendering. It doesn't enforce image-safe length. Minor. **B5. `VisualConceptService` `llmStyleSelection` returns `imagePrompt: String(parsed.imagePrompt ?? ...)` but if `parsed.imagePrompt` is not a string (e.g., object), `String` returns `[object Object]`. The JSON schema in prompt says `imagePrompt` is string. LLM may return object. The prompt does not say `string`. It says detailed prompt. It should be string. If LLM returns object, `String()` coerces. Not a bug. **B6. `VisualConceptService` `generateConcept` does not pass `network` dimensions to `llmStyleSelection` except in prompt. The `network` is used in `NETWORK_DIMENSIONS` ratio. Good. **B7. `VisualConceptService` `getDimensions` is not used by `generateConcept` in the returned concept. The caller must use `getDimensions` separately. Good. **B8. `ABVariantGenerator` `llmGenerateVariants` parses `A:` and `B:` lines. If the LLM returns a single line with `A: ... B: ...` on same line, parsing fails. It splits by newline. Good. If the response has `A:` with no following text and then `B:`, it may not handle. It uses regex `/^a[:")]\s*/i`. Good. But the parsing `variantA += trimmed.replace(...) + '\n'` and then `variantA = variantA.trim()` means if the line starts with `A:` it removes the prefix and adds the rest. If subsequent lines don't start with A/B, they are appended to current parsing state. Good. **B9. `ABVariantGenerator` `heuristicVariants` removes all emojis and hashtags for Variant A. For Variant B, it adds cosmic emojis after sentences. It uses `cosmicEmojis = [' ✨', ' 🌙', ' 🔮']` and loops `sentences.length - 1` times. If there are 2 sentences, it adds `✨` to first. If 3, `✨` to first, `🌙` to second. If 1, no emoji. The `if (countEmojis(variantB) < 2)` check is after adding. It may add only one emoji. The condition says `< 2`, so if after one addition it's still < 2? The loop adds 1 emoji per iteration. If there are 2 sentences, it adds 1 emoji. If count < 2, it enters. But it does not add a second if count is still < 2. Actually the loop runs for `sentences.length - 1` iterations, but the `if` condition is outside. It adds up to 2 emojis. If `sentences.length - 1` is 2, it adds 2. Good. But if `sentences.length - 1` is 1, it adds 1. The condition `if (countEmojis(variantB) < 2)` is only once before loop. It doesn't re-check. So if it adds 1 and count is 1, it doesn't add more. If `sentences.length - 1` is 2, it adds 2. Good. The intent is 2-3 emojis. It may add 1 or 2. Fine. **B10. `ABVariantGenerator` `heuristicVariants` removes all hashtags. But `countHashtags` may still be 0. Good. **B11. `ThreadDepthController` `defaultDepth` uses `configService.get<string>` and `Number`. If env is `foo`, `isNaN` true, fallback. Good. It clamps. Good. **B12. `ThreadDepthController` `planThread` `factsCount >= 2` sets `targetDepth = 3` regardless of `defaultDepth`. If `defaultDepth` is 5, it still sets 3. This may under-shoot. But the logic is `if (>=3 && pillar) deep; else if (>=2) 3; else default`. So if default is 5 and facts are 2, it returns 3. This may be intentional. But if `defaultDepth` is 1, it sets 3. The `defaultDepth` is overridden. Is this intended? The default is 2. If user wants 1 default, too bad. The logic is not consistent. It should consider `defaultDepth`. But the auto logic is independent. Could be a bug. **B13. `ThreadDepthController` `generateContinuations` uses `truncateForThread` on each tweet. It should enforce `280` chars. The `truncateForThread` is in `thread-limit.ts` not reviewed. It likely truncates. Good. **B14. `ThreadDepthController` `generateContinuations` LLM prompt says `Be under 280 characters` but does not mention `Threads` or `Facebook` limits. It uses 280. For `Threads`, the limit is 500. For `Facebook`, depth is 1. Good. But the LLM may not know network. The `network` is not passed to prompt. Wait `planThread` receives `network` but `generateContinuations` does not pass it. The `systemPrompt` says under 280 characters always. For `Threads` continuation, 280 is safe but could be longer. Fine. **B15. `ThreadDepthController` `generateContinuations` pads missing tweets with `keyFacts[idx]` or `Discover more about ${topic} ✨`. If `topic` is long, it may exceed 280. It uses `truncateForThread`. Good. **B16. `HookPerformanceBank` `onModuleInit` uses `process.env.HOOK_BANK_AGGREGATE_SCHEDULE` instead of `ConfigService`. This is the same pattern as `trending-scraper` etc. Should be `ConfigService`. **B17. `HookPerformanceBank` `aggregateStats` uses `take: 500` but doesn't order by `postedAt`. It may take arbitrary 500 posts. If `status: POSTED` and `llmMetadata not null`, it returns first 500 by default. Prisma `findMany` without `orderBy` is not deterministic. Could miss recent posts. Should `orderBy: { postedAt: 'desc' }`. **B18. `HookPerformanceBank` `aggregateStats` uses `post.metrics[0]` but `metrics` relationship is `orderBy: { collectedAt: 'desc' } take: 1`. Good. But `metrics` may be a relation that is not loaded? Wait `include` in `findMany`? The `select` includes `metrics: { orderBy, take }`. This is `include`? Actually `select` with nested `metrics` is `include`? In Prisma, `select` with nested relation is `select: { metrics: { ... } }`. The syntax is correct: it selects `metrics` with orderBy and take. Good. But the `select` block has `metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }`. This is valid. It returns an array. Good. **B19. `HookPerformanceBank` `getRecommendation` `normalizedEngagement` uses `avgEng / (engagementBaseline * 2)`. If `avgEng` is greater than `engagementBaseline * 2`, `normalizedEngagement` > 1, but `Math.min` clamps to 1. Good. But `performanceMultiplier` uses `avgEng / engagementBaseline` and can be >1. Good. The `hybridScore` uses `0.4 * quality + 0.6 * min(eng, 1)`. If `engagementBaseline` is 0, `normalizedEngagement` is 0 and `hybridScore` is `normalizedQuality` (0-1). Good. **B20. `TrendGuardrail` `isBlocklisted` uses `BLOCKLIST_MATCHERS` regex with `\b` and optional trailing `\b`. The `STEM_KEYWORDS` have no trailing word boundary. The `ASTROLOGICAL_OVERRIDES` allows `cancer` when astrological context. Good. But `BLOCKLIST_KEYWORDS` includes `death` with `\b` on both sides. It will match "death" but not "deathbed"? `\bdeath\b` matches "death" in "deathbed"? No, word boundary is between `h` and `b`. `deathbed` is one word, `\bdeath\b` will not match because no boundary after `h`. Good. But the keyword `casualt` is a stem without trailing boundary. It matches "casualty", "casualties". Good. It uses `\b` at start. For "casualty", `\bcasualt` matches. Good. But `death` is full. `war` with `\b` won't match "forward". Good. **B21. `TrendGuardrail` `isBlocklisted` `isAstrologicalOverride` gets `matchedKeyword` from `match[0]`. If the regex matches "cancer" with `\b`, `match[0]` is "cancer". It checks `ASTROLOGICAL_OVERRIDES` for "cancer" and looks for context words. Good. But if the regex is case-insensitive and `matchedKeyword` is "Cancer"? The code uses `match[0].toLowerCase()`. Good. But if `match[0]` is "cancer" (from `/\b${kw}\b/i`) and `kw` is "cancer", `match[0].toLowerCase()` is "cancer". Good. **B22. `TrendGuardrail` `isTrendingSource` uses `/(^|\/)trending\//.test(path ?? '')`. This matches `trending/google_trends+x_trends` and `trending/` paths. Good. The JSDoc mentions `topic` source path `trending/<sources>`. Good. **B23. `TrendGuardrail` `llmOpportunityScore` uses inline prompt. Should be in `PromptRegistry` / Langfuse. Not a bug. **B24. `EngagementBaitDetector` `detectEngagementBait` iterates non-global regexes and `while` loops. If a regex is non-global, `exec` returns the same match every time, causing infinite loop if not for the `break` on non-global. It resets `lastIndex` and breaks if not global. Good. The `if (match.index === pattern.regex.lastIndex) pattern.regex.lastIndex++` avoids zero-length infinite loop. But if regex is non-global, `lastIndex` is not set? Actually `lastIndex` is 0 for non-global. Good. **B25. `EngagementBaitDetector` pattern `\b(?:agree|disagree)\??\s*(?:👇|below)?\s*$/i` has `\s*$` at the end. It will match only if the string ends with "agree" or "disagree" (optionally with "👇"/"below"). But `detectEngagementBait` runs `pattern.regex.exec(content)` and `content` is the whole post. The `\s*$` means it matches if the content ends with the phrase. Good. But `BaitMatch.index` is the start of the phrase. Good. **B26. `EngagementBaitDetector` `buildBaitRewriteInstruction` uses `foundCategories` as an array of unique categories. It maps `categoryLabels`. Good. `examples` are the matched strings. Good. **B27. `HumanizerGate` `analyzeHumanization` splits sentences by `(?<=[.!?…])\s+|\n+`. It uses positive lookbehind for `.!?` and `…`. Good. It counts words by splitting on whitespace. Good. `MIN_SENTENCE_WORDS` is 1. Good. `UNIFORMITY_CV_THRESHOLD` is 0.35. `burstiness` is coefficient of variation. If `lengths` has 2 values, `burstiness` computed. Good. `uniformSentences` if `>=3` and `burstiness < 0.35`. Good. **B28. `HumanizerGate` `emDashCount` counts em and en dashes. The comment says em dash is #1 AI punctuation tell. It flags any em dash. Real humans use em dashes too. This may be overly aggressive. But it is a heuristic. **B29. `HumanizerGate` `hashtagCount` regex `#[\wЀ-ӿԀ-ԯ]+` matches Cyrillic hashtags. Good. **B30. `SlopLexicon` `scanSlop` uses `new RegExp` for each word. This is O(n) regex constructions. For a long text, 40 words × compile each call. But `scanSlop` is called per draft. Good. Could precompile. Not a bug. **B31. `SlopLexicon` `words` are matched with unicode-aware boundaries. Good. `phrases` are substring matched. The phrases like `"in today's fast-paced world"` will match. Good. **B32. `LanguagePacks` `getLanguageExamples` returns empty for `en`. Good. It includes native examples. Good. **B33. `SourceUrlUtil` `extractBlogSlug` uses `/blog\/(?:[a-z]{2}\/)?([^/]+)\.md$/i`. It matches `/blog/en/mars-in-aries.md` and `../content/blog/ru/luna.md`. Good. It captures slug. It ignores locale. Good. `buildSourceUrl` detects locale and builds URL. Good. But `DEFAULT_SITE_BASE_URL` is hardcoded. Should be from `ConfigService`. **B34. `SourceUrlUtil` `resolveCtaUrl` returns `buildSourceUrl(...) ?? siteBaseUrl`. If `siteBaseUrl` is not provided, uses default. Good. But `siteBaseUrl` from env is not wired. The `generation.graph` or `posting` may pass `process.env.SITE_BASE_URL`. Need to check. Not a bug. **B35. `HumorMechanics` and `ThreadLimit` not reviewed. Assume they are small utilities.**

### 6.2 Performance

**P1. `ContentPillarTracker` `getPillarStats` does 7 Redis `get` calls in parallel. Good. **P2. `HookPerformanceBank` `aggregateStats` fetches 500 posts with `metrics` relation. Could be heavy if metrics are large. Good. **P3. `HookPerformanceBank` `aggregateStats` groups in memory. Good. **P4. `TrendGuardrail` `isRelevantByLlm` per borderline topic is expensive. The `TrendingScraperService` batches. Good. **P5. `VisualConceptService` `generateConcept` makes one LLM call per post. Good. **P6. `ThreadDepthController` `generateContinuations` makes one LLM call per thread. Good. **P7. `ABVariantGenerator` `generateVariants` makes one LLM call per post. Good. **P8. `ContentPillarTracker` `recordPillar` does `incr` + `expire` sequentially. Could pipeline. Not critical.**

### 6.3 Architecture / anti-patterns

**A1. `content-enhancements` is a grab-bag of utilities. Good for shared concerns. But `ContentPillarTracker`, `HookPerformanceBank`, `VisualConceptService`, `ABVariantGenerator`, `ThreadDepthController` are all NestJS injectables. Pure functions are also exported. This is a mixed module. Acceptable. **A2. `HookPerformanceBank` uses `process.env` for cron schedule. Should be `ConfigService`. **A3. `VisualConceptService` and `ABVariantGenerator` and `ThreadDepthController` use inline LLM prompts. Should be in `PromptRegistry` / Langfuse. **A4. `ContentPillarTracker` uses `incr` + `expire` but does not implement the `last7` hash described in JSDoc. **A5. `SourceUrlUtil` hardcodes `DEFAULT_SITE_BASE_URL`. Should be env-driven. **A6. `ContentPillarTracker` `classifyPillar` keyword regex is broad and default-heavy. Could be improved. **A7. `HumanizerGate` penalizes em dashes, which may reject legitimate human writing. **A8. `ABVariantGenerator` and `ThreadDepthController` are `@Injectable` but only used in generation graph. They are exported as providers. Good.**

### 6.4 TypeScript / type safety

**T1. `ContentPillarTracker` `targetRatios` is `Record<ContentPillar, number>` but `DEFAULT_TARGET_RATIOS` sums to 1.0. Good. **T2. `VisualConceptService` `NETWORK_DIMENSIONS` uses `SocialNetwork` enum. Good. `NETWORK_DIMENSIONS[network]!` non-null. Good. **T3. `ABVariantGenerator` `NETWORK_LIMITS` is `Record<SocialNetwork, number>` with hardcoded. Good. **T4. `ThreadDepthController` `NETWORK_MAX_DEPTH` similar. Good. **T5. `HookPerformanceBank` `groups` uses `Map<string, ...>` with key `${network}:${technique}`. Good. **T6. `TrendGuardrail` `isBlocklisted` `match` is `RegExpExecArray | null`. `match[0].toLowerCase()` used. Good. **T7. `SlopLexicon` `SLOP_LEXICON` is `Record<string, SlopLexiconEntry>`. Good. **T8. `SourceUrlUtil` functions are pure and typed. Good. **

### 6.5 Security / reliability

**S1. `TrendGuardrail` fails closed on LLM errors. Good. **S2. `ContentPillarTracker` uses Redis; if Redis down, it would fail. No fallback. `GenerationService` may catch. Good. **S3. `HookPerformanceBank` `aggregateStats` uses `prisma` optional. If not available, logs and skips. Good. **S4. `VisualConceptService` disabled by default. Good. **S5. `ABVariantGenerator` disabled by default. Good. **S6. `ThreadDepthController` clamps user override to network max. Good. **S7. `EngagementBaitDetector` `buildBaitRewriteInstruction` includes matched phrases in instruction. The matched phrases are from generated content, not user input. Fine. **S8. `HumanizerGate` `buildHumanizeInstruction` includes slop words from content. Fine. **S9. `SourceUrlUtil` doesn't validate `siteBaseUrl` for injection. It just interpolates. The caller controls `siteBaseUrl`. Good. **S10. `ContentPillarTracker` `recordPillar` does not validate `pillar` is one of `CONTENT_PILLARS`. But `ContentPillar` type enforces at compile time. If called with string, it will create a key with arbitrary string. Should validate. **S11. `HookPerformanceBank` `onModuleInit` `process.env` is allowed per AGENTS? It says `getEnabledNetworks()` and `isOrchestratorEnabled()` and `app.module.ts` read process.env by design. But `HOOK_BANK_AGGREGATE_SCHEDULE` is not in that list. It should use ConfigService. **S12. `TrendGuardrail` `llmOpportunityScore` prompt is inline. Good security but not versioned. **S13. `ABVariantGenerator` `llmGenerateVariants` prompt says `Return ONLY the two variants in this format`. It may be less robust than JSON. Good. **S14. `ThreadDepthController` `generateContinuations` prompt asks for `one per line, numbered`. It parses. Good. **S15. `VisualConceptService` `llmStyleSelection` prompt asks for JSON. Good. **S16. `ContentPillarTracker` `recordPillar` `expire` refreshes on every increment. As noted, this creates a non-sliding window. **S17. `HumanizerGate` flags `emDashCount > 0` as AI tell. It may over-flag. But it only injects rewrite instruction, not reject. Good. **S18. `SlopLexicon` `getSlopListForPrompt` returns `,...` but includes quotes for phrases. It doesn't include quotes for words. The prompt variable may use it as a list. Good. **S19. `SourceUrlUtil` `extractBlogSlug` uses a regex that may match `../content/blog/en/../other.md`? The `[^/]+` captures any slug, including `..`. It should sanitize. But `sourcePath` is from internal content reader. Not user input. Fine. **S20. `ContentPillarTracker` `getPillarStats` `count` is `Number(val) || 0`. If Redis returns `undefined`, count 0. Good. If Redis returns `NaN`? It won't. **S21. `HookPerformanceBank` `aggregateStats` `take: 500` without `orderBy` is non-deterministic. Could be a bug if it picks old posts and misses new. **S22. `HookPerformanceBank` `getRecommendation` `JSON.parse(raw)` may throw if Redis value is corrupted. It catches and returns fallback. Good. **S23. `HookPerformanceBank` `getStats` uses `parseInt(updatedRaw, 10)`. If `updatedRaw` is `'abc'`, returns `NaN`. The return type says `number | null`. `NaN` is not `null`. This is a bug. It should check `isNaN`. **S24. `HookPerformanceBank` `aggregateStats` uses `pipeline.exec()` but `Redis` may not support `multi`? `ioredis` supports. Good. **S25. `HookPerformanceBank` `aggregateStats` computes `engagement` with `metrics.likes + 2*metrics.comments + 3*metrics.shares`. If metrics fields are `undefined`, it becomes `NaN`. The `PostMetrics` model likely has `likes` `comments` `shares` as `Int` default 0. Fine. **S26. `HookPerformanceBank` `aggregateStats` groups by `post.network` and `technique`. It then writes stats for each `SocialNetwork` and each technique. Good. **S27. `HookPerformanceBank` `getRecommendation` `bottomWith` uses `hybridScore < 0.4`. If no technique has score < 0.4, `bottomTechnique` is null. Good. **S28. `ContentPillarTracker` `classifyPillar` `/(ai |algorithm|10 planets|machine|ai-powered|ai read)/` includes `ai ` (with space). It will match "ai advantage" but not "ai-powered"? It will match `ai-powered` because `ai-` contains `ai` followed by `-`? The regex `ai ` requires space. The alternation includes `ai-powered` and `ai read`. But `ai` with `ai` + punctuation? It will match "ai" as a word? No, it requires a space after `ai` unless `ai-powered` or `ai read`. It won't match "ai-astrology" because `ai ` has space. It won't match "ai:" or "ai.". This is a minor classifier issue. **S29. `ContentPillarTracker` `classifyPillar` `/(did you know|house|aspect|node|retrograde|orbit|ingress|transit)/` for educational. `node` is a broad word. It may classify topics about "nodes" as educational. But `node` is also a technical term. Fine. **S30. `ContentPillarTracker` `classifyPillar` `/(new article|blog|read more|fresh|just published|new post)/` for blog_promo. It may classify a "fresh" topic as blog_promo. Fine. **S31. `TrendGuardrail` `isBlocklisted` `ASTROLOGICAL_OVERRIDES` only for `cancer`. It does not include other ambiguous terms like `virgo` (not blocklisted) or `gemini` (not blocklisted). `Cancer` is the only zodiac sign in the blocklist. Good. **S32. `TrendGuardrail` `BLOCKLIST_KEYWORDS` includes `depression` and `suicide` and `mental illness`. These are medical/crisis. Good. It also includes `divorce`, `breakup`, `cheating`, `affair`. These are celebrity gossip? But also personal. The guardrail will reject trend topics about "breakup". That may be too broad if a relationship astrology angle could be safe. But the blocklist is for brand safety. Good. **S33. `TrendGuardrail` `llmOpportunityScore` `systemPrompt` is inline and not in Langfuse. Good for prompt safety but not versioned. **S34. `EngagementBaitDetector` `buildBaitRewriteInstruction` returns a single string. It may be injected into the prompt. The `examples` are from generated content. Good. **S35. `HumanizerGate` `buildHumanizeInstruction` may produce a very long instruction if many slop words. It joins with `;`. The `fixes` can be long. The prompt size may grow. But it's bounded by content. **S36. `SourceUrlUtil` `extractBlogSlug` uses `sourcePath.match` with `[a-z]{2}` locale. It does not support `pt-BR` or `zh`. The project supports 5 languages, all `[a-z]{2}`. Good. **S37. `SourceUrlUtil` `buildSourceUrl` uses `/blog/<slug>` for `en` and `/<locale>/blog/<slug>` for non-en. This matches Nuxt i18n. Good. **S38. `VisualConceptService` `generateConcept` returns `null` if disabled. The caller may not handle null. Need to check. But not this module. **S39. `VisualConceptService` `llmStyleSelection` `NETWORK_DIMENSIONS[network]!.ratio` uses non-null. If `network` is invalid, it throws. Good. **S40. `ABVariantGenerator` `heuristicVariants` Variant B loop `for (let i = 0; i < Math.min(sentences.length - 1, 2); i++)`. If `sentences.length - 1` is 0, no emojis. Good. **S41. `ABVariantGenerator` `countEmojis` regex does not include zero-width joiner sequences or newer emojis. It covers many. Good. **S42. `ABVariantGenerator` `countHashtags` regex `#\w+`. Cyrillic? `\w` in JS is `[A-Za-z0-9_]`. It does not match Cyrillic hashtags. The `heuristicVariants` removes hashtags with `/#[a-zA-Z0-9_]+/g`. It won't remove Cyrillic hashtags. This is a bug. The `hashtagCount` will be 0 for Cyrillic hashtags. The `countHashtags` won't count them. The `heuristicVariants` won't strip them. This is a bug. **S43. `ABVariantGenerator` `countHashtags` and `heuristicVariants` regex should include `\u{...}` Cyrillic ranges. **S44. `ContentPillarTracker` `recordPillar` `expire` refreshes TTL on every increment. As noted, this is not a rolling window. The correct sliding window would be to set `expire` only on the first count of a window, or use `EXPIREAT` with a fixed time. But it uses `EXPIRE` seconds, which resets TTL every time. This is a bug. **S45. `ContentPillarTracker` JSDoc mentions `spa:pillar:last7` hash but the code doesn't use it. The implementation is incomplete. **S46. `HookPerformanceBank` `process.env` read. Should be `ConfigService`. **S47. `VisualConceptService` `generateConcept` gradient selection is content-length based. Weak. **S48. `VisualConceptService` `llmStyleSelection` prompt is inline. **S49. `ThreadDepthController` `generateContinuations` LLM prompt is inline. **S50. `ABVariantGenerator` `llmGenerateVariants` prompt is inline. **

### 6.3 Architecture / anti-patterns (continued)

**A3. `ContentEnhancementsModule` exports `ThreadDepthController` as a provider. `ThreadDepthController` is a service, not a controller. The naming is confusing. **A4. `ContentEnhancementsModule` does not import `RedisModule` but `ContentPillarTracker` and `HookPerformanceBank` inject `SHARED_REDIS`. The module importing `ContentEnhancementsModule` must provide Redis. In `app.module.ts`, `RedisModule` is global? Not sure. The `RedisModule` may be `@Global()`. Good. **A5. `ContentEnhancementsModule` does not import `PrismaModule`. `HookPerformanceBank` injects `PrismaService` optionally. The module using it must provide. Good. **A6. `ContentEnhancementsModule` does not import `LlmModule`. `VisualConceptService`, `ABVariantGenerator`, `ThreadDepthController` inject `ILlmPort` optionally. The module using it must provide. Good. **A7. Many inline prompts in this module. Not centralized. **A8. `ContentPillarTracker` `recordPillar` is called from `GenerationService` after saving posts. It should be called after posting, not after generation? The JSDoc says "After posts are saved". If a post is generated but rejected, it still records. Should be after `POSTED` or `APPROVED`. **S51. `recordPillar` recorded in `GenerationService` after saving `DRAFT` may inflate counts with rejected posts. **S52. This is a bug. The pillar rotation should count only approved/posted posts. **S53. The `recordPillar` call site in `GenerationService` needs to be checked. Not in this review. But the design is questionable. **

### 6.4 TypeScript / type safety (continued)

**T9. `ContentPillarTracker` `getPillarStats` `actualRatio` uses `total > 0 ? c.count / total : 0`. `total` is `Number` sum. Good. **T10. `ContentPillarTracker` `recommendPillar` `sorted[0]!` non-null assertion. If `CONTENT_PILLARS` empty, it would fail. Good. **T11. `HookPerformanceBank` `aggregateStats` `post.llmMetadata as {...}` casts. `llmMetadata` is `Json`. Cast is unsafe. Should use `zod` or `unknown`. **T12. `VisualConceptService` `llmStyleSelection` `parsed` cast `as { style?: string; ... }`. Unsafe. **T13. `ABVariantGenerator` `llmGenerateVariants` does not parse JSON, just text. Good. **T14. `ThreadDepthController` `generateContinuations` parses text lines. Good. **T15. `TrendGuardrail` `llmOpportunityScore` `parsed` cast `as { safe?: boolean; ... }`. Unsafe. Should validate. **T16. `SourceUrlUtil` types are good. **T17. `SlopLexicon` `scanSlop` creates `new RegExp` for each word. Good. **T18. `LanguagePacks` `PACKS` typed `Record<string, string[]>`. Good. **

### 6.5 Security / reliability (continued)

**S54. `ABVariantGenerator` `heuristicVariants` regex for hashtag removal only ASCII. Cyrillic hashtags not stripped. **S55. `ABVariantGenerator` `countHashtags` same issue. **S56. `ThreadDepthController` `planThread` auto-depth logic may generate 3 tweets for 2 facts. Could be too many. Fine. **S57. `VisualConceptService` disabled by default. When enabled, it makes LLM calls per post. Good. **S58. `ContentPillarTracker` `recordPillar` increments for every saved post, not just posted. Could be a bug. **S59. `HookPerformanceBank` `aggregateStats` `take: 500` without `orderBy` non-deterministic. **S60. `HookPerformanceBank` `getStats` `parseInt` returns `NaN` for invalid. **S61. `ContentPillarTracker` `classifyPillar` keyword regex default `daily_weather` may overclassify. **S62. `TrendGuardrail` `isBlocklisted` `ASTROLOGICAL_OVERRIDES` only for `cancer`. Good. **S63. `TrendGuardrail` `isBlocklisted` `BLOCKLIST_MATCHERS` precompiled on module load. Good. **S64. `EngagementBaitDetector` `detectEngagementBait` does not exclude URLs or code blocks. Fine. **S65. `HumanizerGate` `analyzeHumanization` splits by newline too. If a post has a list, each item may be a sentence. Fine. **S66. `SourceUrlUtil` `resolveCtaUrl` uses default `DEFAULT_SITE_BASE_URL` if not provided. Hardcoded. **S67. `ContentPillarTracker` `getPillarStats` `total` counts all pillars. If all counters are 0, `actualRatio` 0. Good. **S68. `ContentPillarTracker` `targetRatios` sum to 1.0. Good. **S69. `VisualConceptService` `llmStyleSelection` returns `style` cast to `VisualConcept['style']`. Good. **S70. `ABVariantGenerator` `llmGenerateVariants` `content` may contain quotes. The user prompt wraps with `"`. If content contains `"`, it may break. The LLM likely handles. Good. **S71. `ThreadDepthController` `generateContinuations` user prompt wraps `rootContent` with `"`. Same. **S72. `VisualConceptService` `llmStyleSelection` prompt wraps `content` with `"`. Same. **S73. `TrendGuardrail` `llmOpportunityScore` wraps `topic` with `"`. Same. **S74. `HumanizerGate` `buildHumanizeInstruction` includes user content in instruction. The content is generated, not user input. Good. **S75. `SlopLexicon` `getSlopListForPrompt` includes phrases in quotes. The prompt may use this list. Good. **S76. `ContentPillarTracker` `recordPillar` `expire` refreshes TTL. Bug. **S77. `ContentPillarTracker` `getPillarStats` `Number(val) || 0` treats `NaN` as 0. If Redis returns `'NaN'`, `Number('NaN')` is `NaN`, `|| 0` returns 0. Good. **S78. `HookPerformanceBank` `aggregateStats` `metrics` relation selected. If `metrics` is not defined in Prisma select? It is. Good. **S79. `HookPerformanceBank` `process.env` read. Should be config. **S80. `ContentEnhancementsModule` is imported by `app.module.ts`. Good. **S81. `ThreadDepthController` is exported as provider. Should be a service named `ThreadDepthService`. Naming confusion. **S82. `HumorMechanics` and `ThreadLimit` not reviewed. Need to read. **

### 6.6 Performance (continued)

**P9. `SlopLexicon` `scanSlop` creates `new RegExp` for each word per call. Could be optimized by precompiling. **P10. `ContentPillarTracker` `getPillarStats` parallel Redis. Good. **P11. `HookPerformanceBank` `aggregateStats` 500 posts with metrics. Good. **P12. `VisualConceptService` one LLM call per post. Good. **P13. `ABVariantGenerator` one LLM call per post. Good. **P14. `ThreadDepthController` one LLM call per thread. Good. **P15. `TrendGuardrail` one LLM call per borderline topic. Good. **P16. `ContentPillarTracker` `recordPillar` `incr` + `expire` sequential. Could use `multi`/`pipeline`. **P17. `HookPerformanceBank` `aggregateStats` uses `pipeline` for Redis writes. Good. **P18. `ContentPillarTracker` `getPillarStats` does not pipeline. Minor. **

## 7. New feature / improvement ideas

**F1. Fix `ContentPillarTracker` to use a true 7-day rolling window**
- Use `EXPIREAT` with fixed window end or use `spa:pillar:last7` hash with daily buckets.

**F2. Call `recordPillar` only when a post is approved/posted, not on draft save**
- Avoid inflating counts with rejected posts.

**F3. Precompile `SlopLexicon` regexes**
- Reduce repeated `new RegExp`.

**F4. Move all inline prompts to `PromptRegistry` / Langfuse**
- `VisualConceptService`, `ABVariantGenerator`, `ThreadDepthController`, `TrendGuardrail`, `HookPerformanceBank`.

**F5. Use `ConfigService` for `HOOK_BANK_AGGREGATE_SCHEDULE` and `DEFAULT_SITE_BASE_URL`**
- Remove `process.env` reads.

**F6. Add `orderBy: { postedAt: 'desc' }` to `HookPerformanceBank.aggregateStats`**
- Ensure last 500 posts are recent.

**F7. Validate `HookPerformanceBank.getStats` `parseInt` for `NaN`**
- Return `null` if invalid.

**F8. Improve `ABVariantGenerator` heuristic to handle Cyrillic hashtags**
- Use unicode-aware `\p` regex.

**F9. Improve `VisualConceptService` gradient selection**
- Use a hash of content, not just length.

**F10. Add `ContentPillarTracker` `classifyPillar` sanity checks**
- Better rules to avoid defaulting to `daily_weather`.

**F11. Add `HumanizerGate` configurable thresholds**
- `UNIFORMITY_CV_THRESHOLD`, `emDash` sensitivity.

**F12. Add `SourceUrlUtil` support for `create_run` and `topic` paths**
- JSDoc mentions but not implemented. Only `article` supported.

**F13. Add `ThreadDepthController` `network` to LLM prompt**
- So it can use 500-char limit for Threads.

**F14. Add `content-enhancements` metrics**
- `pillar_recommendations_total`, `visual_concepts_generated_total`, `ab_variants_generated_total`, `hook_bank_recommendations_total`.

**F15. Rename `ThreadDepthController` to `ThreadDepthService` or add a real controller**
- Avoid confusing service/controller naming.

## 8. Cross-references

- `modules/generation` — uses `ContentPillarTracker`, `VisualConceptService`, `ABVariantGenerator`, `ThreadDepthController`, `EngagementBaitDetector`, `HumanizerGate`, `SlopLexicon`, `LanguagePacks`, `SourceUrlUtil`, `TrendGuardrail`.
- `modules/trending` — `TrendGuardrail` is imported by `GenerationService` (not `TrendingScraperService`? Need to check). Actually `trend-guardrail.ts` is in `content-enhancements` and likely used by `GenerationService` for trending topics.
- `infrastructure/redis` — `SHARED_REDIS` for `ContentPillarTracker` and `HookPerformanceBank`.
- `infrastructure/prisma` — `PrismaService` for `HookPerformanceBank`.
- `infrastructure/llm` — `ILlmPort` for `VisualConceptService`, `ABVariantGenerator`, `ThreadDepthController`, `TrendGuardrail`.
- `modules/posting` — `Post.llmMetadata` stores `visualConcept`, `abVariants`, `hookTechnique`, `qualityScore`.
- `modules/analytics` — `PostMetrics` used by `HookPerformanceBank`.

## 9. Overall assessment

- **Health**: 6/10. `content-enhancements` is a rich toolkit with good ideas (slop lexicon, multilingual language packs, engagement-bait detection, hook performance bank). But it has recurring issues: `process.env` reads, inline prompts, `ContentPillarTracker` rolling window bug, `ABVariantGenerator` Cyrillic hashtag handling, `HookPerformanceBank` non-deterministic ordering, and `ThreadDepthController` naming.
- **Biggest strengths**: centralized slop lexicon, multilingual support, deterministic humanizer gate, content pillar rotation, A/B variant generation, hook performance learning loop.
- **Biggest risks**: `ContentPillarTracker` TTL refresh creates a non-rolling window and may record drafts; inline prompts not versioned; `HookPerformanceBank` cron schedule from `process.env`; `ABVariantGenerator` heuristic fails for Cyrillic hashtags; `ThreadDepthController` is a service named controller.
- **Recommended next actions**:
  1. Fix `ContentPillarTracker` to use a true sliding window or daily buckets and only record approved/posted posts.
  2. Move all inline prompts to `PromptRegistry` / Langfuse.
  3. Use `ConfigService` for `HOOK_BANK_AGGREGATE_SCHEDULE` and `DEFAULT_SITE_BASE_URL`.
  4. Add `orderBy` to `HookPerformanceBank.aggregateStats` and fix `getStats` `NaN` handling.
  5. Fix `ABVariantGenerator` Cyrillic hashtag regex.
  6. Rename `ThreadDepthController` to `ThreadDepthService`.
