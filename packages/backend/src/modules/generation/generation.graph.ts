import { StateGraph, END, START, Annotation, interrupt } from '@langchain/langgraph';
import type { ILlmPort } from '../../domain/ports/llm.port.js';
import type { ContentTopic } from '@spa/shared';
import { SocialNetwork } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { resolveCtaUrl } from '../content-enhancements/source-url.util.js';
import { buildBaitRewriteInstruction } from '../content-enhancements/engagement-bait.detector.js';
import type { HookPerformanceBank, HookRecommendation } from '../content-enhancements/hook-performance-bank.js';
import { classifyHookTechnique, HOOK_TECHNIQUES, type HookTechnique } from '../content-enhancements/hook-performance-bank.js';
import type { VisualConcept, VisualConceptService } from '../content-enhancements/visual-concept.service.js';
import type { ABVariantPair, ABVariantGenerator } from '../content-enhancements/ab-variant.generator.js';
import { pickContentStyle, getStylePromptGuidance, CONTENT_STYLES_BY_ID, type ContentStyle } from '../content-enhancements/content-style.rotation.js';

const logger = new Logger('GenerationGraph');

// ============================================================
// Hook cache — avoids re-calling LLM for identical topics across runs.
// Keyed by topic + keywords + facts hash. TTL 30 min, max 50 entries.
// Saves ~3,800 tokens per cache hit (system prompt with brand-voice is large).
// ============================================================

interface HookCacheEntry {
  hooks: string[];
  model: string;
  expiresAt: number;
}

const hookCache = new Map<string, HookCacheEntry>();
const HOOK_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const HOOK_CACHE_MAX_SIZE = 50;

/**
 * Compute a cache key for hook_generation from the deterministic inputs.
 * Excludes brandVoice (constant per process) and performanceGuidance (advisory).
 */
function hookCacheKey(topic: string, keywords: string[], facts: string[]): string {
  const input = `${topic}||${keywords.slice().sort().join(',')}||${facts.slice().sort().join('\n')}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Check the hook cache. Returns cached hooks if valid, null otherwise.
 */
function getHookCache(key: string): HookCacheEntry | null {
  const entry = hookCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    hookCache.delete(key);
    return null;
  }
  logger.debug(`Hook cache hit (key: ${key.slice(0, 8)}) — skipping LLM call`);
  return entry;
}

/**
 * Store hooks in cache. Evicts oldest entry if full (FIFO).
 */
function setHookCache(key: string, hooks: string[], model: string): void {
  if (hookCache.size >= HOOK_CACHE_MAX_SIZE) {
    const oldestKey = hookCache.keys().next().value;
    if (oldestKey) hookCache.delete(oldestKey);
  }
  hookCache.set(key, { hooks, model, expiresAt: Date.now() + HOOK_CACHE_TTL_MS });
}

/**
 * Clear the hook cache (for testing or manual invalidation).
 */
export function clearHookCache(): void {
  hookCache.clear();
}

/**
 * Get hook cache stats for monitoring.
 */
export function getHookCacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return { size: hookCache.size, maxSize: HOOK_CACHE_MAX_SIZE, ttlMs: HOOK_CACHE_TTL_MS };
}

// ============================================================
// Types
// ============================================================

/** Per-network generation result (draft → critique → refine pipeline). */
interface NetworkResult {
  angle: string;
  hook: string;
  /** P1: Hook technique tag (question/bold/counter_intuitive/story/data). */
  hookTechnique?: HookTechnique;
  /** Content style used for this post (anti-AI-detection rotation). */
  contentStyleId?: string;
  draft: string;
  critique: string;
  refined: string;
  qualityScore?: number; // 1-10 LLM quality score from critique node
  /** P3: Visual concept for image attachment — null when disabled or failed. */
  visualConcept?: VisualConcept | null;
  /** P7: A/B emoji/hashtag variants — null when disabled or failed. */
  abVariants?: ABVariantPair | null;
  error?: string | null;
}

/** Output of the full graph — one entry per target network. */
export interface GeneratedPost {
  network: SocialNetwork;
  content: string;
  hook: string;
  angle: string;
  model: string;
  qualityScore?: number; // 1-10 LLM quality score (used by auto-approve gate)
  /** P1: Hook technique tag — stored in Post.llmMetadata for performance tracking. */
  hookTechnique?: HookTechnique;
  /** Content style used (anti-AI-detection rotation) — stored in llmMetadata. */
  contentStyleId?: string;
  /** P3: Visual concept for image attachment — null when disabled or failed. */
  visualConcept?: VisualConcept | null;
  /** P7: A/B emoji/hashtag variants — null when disabled or failed. */
  abVariants?: ABVariantPair | null;
}

// ============================================================
// State — the data flowing through the graph
// ============================================================

/**
 * Generation workflow state (§10.3 parallel per-network graph).
 *
 * Flow:
 *   START → research_extract → hook_generation → angle_per_network
 *                                                          ↓
 *                  ┌──────────────────┬────────────────────┘
 *                  ▼                  ▼                    ▼
 *             draft_x          draft_threads        draft_facebook
 *                  │                  │                    │
 *                  ▼                  ▼                    ▼
 *            critique_x       critique_threads      critique_facebook
 *                  │                  │                    │
 *                  ▼                  ▼                    ▼
 *             refine_x          refine_threads        refine_facebook
 *                  │                  │                    │
 *                  └──┬───────────────┴────────────────────┘
 *                     ▼
 *              [save_to_db: 3 Posts]
 */
export const GenerationState = Annotation.Root({
  topic: Annotation<ContentTopic>,
  targetNetworks: Annotation<SocialNetwork[]>,
  brandVoice: Annotation<string>,
  // Accumulated outputs
  facts: Annotation<string[]>,
  hooks: Annotation<string[]>, // 3-5 hook variants from hook_generation
  // Per-network results (keyed by network name) — reducer merges concurrent updates from parallel nodes
  results: Annotation<Record<string, NetworkResult>>({
    reducer: (old: Record<string, NetworkResult>, update: Record<string, NetworkResult>) => ({ ...old, ...update }),
    default: () => ({} as Record<string, NetworkResult>),
  }),
  // LLM metadata
  model: Annotation<string>,
  // Final outputs
  posts: Annotation<GeneratedPost[]>,
  // Error tracking
  error: Annotation<string | null>,
  // Sprint I: HITL — when true, graph pauses after drafts for human review.
  // Resume with Command({ resume: { approved: true } }) or { approved: false, edits: {...} }
  humanReview: Annotation<boolean>,
});

export type GenerationStateType = typeof GenerationState.State;

// ============================================================
// Network config
// ============================================================

/**
 * Per-network character limits.
 * CONSTITUTION §11.3: FB ~63k chars max, but for marketing ≤500.
 * We enforce the marketing limit (500) — long FB posts get low engagement.
 */
const NETWORK_LIMITS: Record<SocialNetwork, number> = {
  [SocialNetwork.X]: 280,
  [SocialNetwork.THREADS]: 500,
  [SocialNetwork.FACEBOOK]: 500, // §11.3: marketing ≤500
};

const NETWORK_TONE: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: 'Punchy, hook-first, confident, conversation-starter. 1-2 hashtags max.',
  [SocialNetwork.THREADS]: 'Narrative, storytelling, warmer, like a knowledgeable friend. 2-3 hashtags.',
  [SocialNetwork.FACEBOOK]: 'Conversational, community-oriented, end with a question for engagement. 3-4 hashtags.',
};

const NETWORK_ANGLE: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: 'punchy + hook-first — bold claim or counter-intuitive observation, max impact in 280 chars',
  [SocialNetwork.THREADS]: 'narrative + storytelling — personal angle, warmer, like sharing a discovery with a friend',
  [SocialNetwork.FACEBOOK]: 'conversational + question-end — community angle, invite discussion, end with a question',
};

/**
 * P2: Per-Network Persona — distinct voice variant per network audience.
 * Augments the shared brand-voice.md with network-specific persona traits.
 * The draft node concatenates `state.brandVoice` + this persona block in the
 * system prompt so each network speaks to its audience in the right register.
 */
const NETWORK_PERSONA: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: `X PERSONA — "Cosmic Insider":
- Voice: confident, slightly edgy, meme-aware, main-character energy
- References: pop-culture astrology, sharp observations, bold takes
- Sentence rhythm: short, punchy, one idea per tweet
- Avoid: long sentences, soft hedges, generic horoscope clichés`,
  [SocialNetwork.THREADS]: `THREADS PERSONA — "Stargazing Friend":
- Voice: warm, vulnerable, story-first, like sharing a personal discovery
- References: personal anecdotes, "I noticed...", reflective tone
- Sentence rhythm: flowing, conversational, allows longer thoughts
- Avoid: punchy claims without context, irony, hard sells`,
  [SocialNetwork.FACEBOOK]: `FACEBOOK PERSONA — "Community Astrologer":
- Voice: inviting, accessible, discussion-starter, community-oriented
- References: everyday life situations, relatable examples
- Sentence rhythm: clear, structured, ends with an open question
- Avoid: jargon, irony, edge — older audience prefers warmth`,
};

// ============================================================
// Nodes — each node is a step in the workflow
// ============================================================

/**
 * Node 1: research_extract — extract key facts from the topic.
 *
 * Sprint E: Enhanced fact extraction — when no pre-extracted facts are available,
 * uses LLM to extract 5-8 key facts from the topic, keywords, and outline.
 * This produces richer, more specific content for downstream nodes (hook, draft, critique).
 */
async function researchExtractNode(
  state: GenerationStateType,
  llm: ILlmPort,
): Promise<Partial<GenerationStateType>> {
  // If facts already provided (from CAP run or article frontmatter), use them
  if (state.topic.facts.length > 0) {
    return { facts: state.topic.facts };
  }

  // Sprint E: LLM-powered fact extraction from topic + keywords + outline
  const outlineStr = state.topic.outline
    ? state.topic.outline.map((o) => `- ${o.heading}${o.entities.length > 0 ? ` (entities: ${o.entities.join(', ')})` : ''}`).join('\n')
    : 'No outline available.';

  const systemPrompt = `You are a research analyst for My Zodiac AI, an AI-powered astrology platform.
Extract 5-8 key facts from the given topic that would make compelling social media posts.
Each fact should be:
- Specific and verifiable (not vague generalizations)
- Interesting to someone interested in astrology, wellness, or personal growth
- 1-2 sentences maximum
- Written as a statement (not a question)

Return ONLY the facts, one per line, numbered 1-8. No preamble or explanation.`;

  const userPrompt = `Topic: ${state.topic.topic}
Keywords: ${state.topic.keywords.join(', ')}
Category: ${state.topic.category ?? 'general'}
Outline:
${outlineStr}

Key facts:`;

  try {
    const response = await llm.generateChat(systemPrompt, userPrompt, { temperature: 0.7 });
    const facts = response.content
      .split('\n')
      .map((line) => line.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter((line) => line.length > 10)
      .slice(0, 8);

    // Ensure at least 3 facts (fallback if LLM returned fewer)
    while (facts.length < 3) {
      facts.push(`${state.topic.topic} offers unique insights for personal growth and self-awareness.`);
    }

    logger.debug(`research_extract: LLM extracted ${facts.length} facts for "${state.topic.topic}"`);
    return { facts, model: response.model };
  } catch (err) {
    logger.warn(`research_extract LLM call failed: ${(err as Error).message} — using fallback facts`);
    return {
      facts: [
        `${state.topic.topic} is relevant to current astrological events.`,
        `${state.topic.keywords.slice(0, 3).join(', ')} are key themes to explore.`,
        'No specific facts available — generate from general knowledge.',
      ],
    };
  }
}

/**
 * Node 2: hook_generation — generate 3-5 hook variants (§10.3).
 * Variants: question / bold statement / counter-intuitive observation.
 *
 * P1: When a HookPerformanceBank is available, fetches per-network
 * performance guidance and includes it in the prompt so the LLM prefers
 * techniques that historically perform well on each target network.
 */
async function hookGenerationNode(
  state: GenerationStateType,
  llm: ILlmPort,
  hookBank?: HookPerformanceBank,
): Promise<Partial<GenerationStateType>> {
  // Check cache first — avoids re-calling LLM for identical topics across runs.
  // Cache is keyed by topic + keywords + facts (the deterministic inputs).
  // performanceGuidance is excluded (advisory, may change between runs).
  const cacheKey = hookCacheKey(state.topic.topic, state.topic.keywords, state.facts);
  const cached = getHookCache(cacheKey);
  if (cached) {
    return { hooks: cached.hooks, model: cached.model };
  }

  // P1: Fetch hook performance guidance for each target network.
  // Graceful degradation: if the bank is unavailable or fails, generate
  // without guidance (the original behavior).
  let performanceGuidance = '';
  if (hookBank) {
    try {
      const recs = await Promise.all(
        state.targetNetworks.map((n) => hookBank.getRecommendation(n)),
      );
      const withData = recs.filter((r) => r.hasData);
      if (withData.length > 0) {
        performanceGuidance =
          '\n\nHOOK PERFORMANCE DATA (from historical engagement):\n' +
          recs
            .map((r, i) => (r.hasData ? `${state.targetNetworks[i]}: ${r.guidance}` : null))
            .filter(Boolean)
            .join('\n');
      }
    } catch (err) {
      logger.debug(`P1: Hook bank guidance failed (non-blocking): ${(err as Error).message}`);
    }
  }

  const systemPrompt = `You are a social media hook writer for My Zodiac AI, an AI-powered astrology platform.
BRAND VOICE: ${state.brandVoice}
Generate 3-5 different hooks (first lines) for posts about "${state.topic.topic}".
Each hook must use a DIFFERENT technique:
  1. A provocative question
  2. A bold statement / claim
  3. A counter-intuitive observation
  4. (optional) A personal story opener
  5. (optional) A data point / fact-led opener

No "Did you know" — vary your hooks. Each hook on its own line.
Return ONLY the hooks, one per line, numbered 1-5.${performanceGuidance}`;

  const userPrompt = `Topic: ${state.topic.topic}
Key facts: ${state.facts.join(', ')}
Keywords: ${state.topic.keywords.join(', ')}

Hooks:`;

  let response;
  try {
    response = await llm.generateChat(systemPrompt, userPrompt, { temperature: 0.9 });
  } catch (err) {
    logger.error(`hook_generation LLM call failed: ${(err as Error).message}`);
    throw err; // Re-throw — GenerationService.generate() catches per-topic
  }
  const hooks = response.content
    .split('\n')
    .map((line) => line.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);

  // Ensure at least 3 hooks (fallback if LLM returned fewer)
  while (hooks.length < 3) {
    hooks.push(`Discover what ${state.topic.topic} means for you.`);
  }

  // Store in cache for future runs with the same topic
  setHookCache(cacheKey, hooks, response.model);

  return { hooks, model: response.model };
}

/**
 * Node 3: angle_per_network — assign a different hook + angle to each network.
 *
 * §10.3: "Per-network angle = разный контент, не адаптация одного."
 * Each network gets a DIFFERENT hook from the pool, with a network-specific angle.
 */
function anglePerNetworkNode(state: GenerationStateType): Partial<GenerationStateType> {
  const results: Record<string, NetworkResult> = {};

  const networks = state.targetNetworks;
  for (let i = 0; i < networks.length; i++) {
    const net = networks[i];
    if (!net) continue;
    // Assign different hooks to different networks (cycle through available hooks)
    const hook = state.hooks[i % state.hooks.length] ?? state.hooks[0] ?? '';
    const angle = NETWORK_ANGLE[net];
    // P1: Classify the hook technique for performance tracking.
    // The technique is stored in NetworkResult and propagated to Post.llmMetadata.
    const hookTechnique = classifyHookTechnique(hook);

    // Pick a content style for this network — rotates daily + per-run
    // so posts don't all look the same (anti-AI-detection).
    const style = pickContentStyle(net, state.topic.topic);

    results[net] = {
      angle,
      hook,
      hookTechnique,
      contentStyleId: style.id,
      draft: '',
      critique: '',
      refined: '',
    };
  }

  return { results };
}

/**
 * Create a draft generation node for a specific network.
 * Each network gets its own node so LangGraph can run them in parallel.
 */
function makeDraftNode(network: SocialNetwork) {
  return async function draftNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    const charLimit = NETWORK_LIMITS[network];
    const tone = NETWORK_TONE[network];
    const persona = NETWORK_PERSONA[network];

    // P10: Source Attribution — link to the specific source article when available.
    // Falls back to the site base URL when the source is not a blog article
    // (briefs, topic-queues, trending have no canonical blog URL).
    const ctaUrl = resolveCtaUrl(state.topic.path);

    // Content style rotation — pick style for this network if not already assigned
    // (assigned in anglePerNetworkNode, but re-pick here as fallback)
    let style: ContentStyle | null = null;
    if (netResult.contentStyleId) {
      style = CONTENT_STYLES_BY_ID[netResult.contentStyleId] ?? null;
    }
    if (!style) {
      style = pickContentStyle(network, state.topic.topic);
    }
    const styleGuidance = getStylePromptGuidance(style);

    // P2: Per-Network Persona + content style — concatenate the shared brand voice
    // with the network-specific persona and the rotating content style so each
    // post looks visually and tonally different (anti-AI-detection).
    const systemPrompt = `You are a social media content creator for My Zodiac AI.
BRAND VOICE: ${state.brandVoice}

${persona}
${styleGuidance}

Generate a ${network} post using the provided hook and angle. Fit within ${charLimit} characters.
Include 1-2 relevant hashtags. End with a soft CTA to ${ctaUrl} when appropriate.
Never use fear-mongering, absolute predictions, or medical/financial advice.
Never ask for likes, comments, shares, tags, or follows (engagement bait — algorithms penalize it).
IMPORTANT: Write in the CONTENT STYLE specified above. Don't default to a generic astrology post.
Return ONLY the post text, nothing else.`;

    const userPrompt = `Topic: ${state.topic.topic}
Hook: ${netResult.hook}
Angle: ${netResult.angle}
Content style: ${style.name} — ${style.description}
Key facts: ${state.facts.join('\n- ')}
Keywords: ${state.topic.keywords.join(', ')}
Tone: ${tone}
Character limit: ${charLimit}
CTA URL (use this exact URL when including a CTA): ${ctaUrl}

${state.topic.outline ? `Outline:\n${state.topic.outline.map((o: { heading: string }) => `- ${o.heading}`).join('\n')}` : ''}

Post text (in "${style.name}" style):`;

    try {
      const response = await llm.generateChat(systemPrompt, userPrompt, { temperature: 0.7 });

      // B5: Return ONLY the updated network — the results reducer merges concurrent updates
      return {
        results: {
          [network]: {
            ...netResult,
            draft: response.content.trim(),
          },
        },
      };
    } catch (err) {
      // Sprint I: Per-network error isolation — don't abort entire graph
      logger.error(`draft_${network} LLM call failed: ${(err as Error).message}`);
      return {
        results: {
          [network]: {
            ...netResult,
            draft: '',
            error: `draft failed: ${(err as Error).message}`,
          },
        },
      };
    }
  };
}

/**
 * Create a critique node for a specific network.
 */
function makeCritiqueNode(network: SocialNetwork) {
  return async function critiqueNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    // Sprint I: Skip if draft already failed
    if (netResult.error) return {};

    const charLimit = NETWORK_LIMITS[network];

    // P9: Engagement-Bait Detector — deterministic pattern check.
    // When bait is detected, the critique prompt explicitly flags it so the
    // refine step rewrites the offending phrases. This runs before the LLM
    // critique call so it's free (no extra tokens) and deterministic.
    const baitInstruction = buildBaitRewriteInstruction(netResult.draft);

    const critiquePrompt = `Critique this ${network} post. Check:
1. Is it within ${charLimit} characters? (current: ${netResult.draft.length})
2. Is it on-brand? (mystical-but-grounded, accessible, empowering)
3. No fear-mongering or absolute predictions?
4. Has a hook in the first line?
5. Has 1-2 relevant hashtags?
6. Is the tone appropriate for ${network}?
7. Does it match the angle: "${netResult.angle}"?
8. No engagement bait (asking for likes/comments/shares/tags/follows)?

Draft:
"${netResult.draft}"

${baitInstruction ? `\n${baitInstruction}\n` : ''}
Return a brief critique (2-3 sentences). If the draft is good, say "GOOD — no changes needed."

Then on a NEW line, output a quality score in this exact format:
SCORE: <number 1-10>

Where 10 = excellent, publish-ready; 7 = good enough to auto-approve; 5 = needs refinement; 1 = unusable.`;

    try {
      const response = await llm.generateChat('', critiquePrompt, { temperature: 0.3 });

      // Parse quality score from response (format: "SCORE: 8" or "SCORE: 8/10")
      // Regex tolerates: optional space, optional /10 suffix, case-insensitive
      const scoreMatch = response.content.match(/SCORE[:\s]+(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i);
      let qualityScore: number | undefined;
      if (scoreMatch) {
        const parsed = Number(scoreMatch[1]);
        // Validate: must be finite and in 1-10 range, else treat as missing
        qualityScore = Number.isFinite(parsed) && parsed >= 1 && parsed <= 10 ? Math.round(parsed) : undefined;
      }
      if (qualityScore !== undefined) {
        logger.debug(`critique_${network}: quality score = ${qualityScore}/10`);
      } else {
        logger.warn(`critique_${network}: no valid SCORE found in critique response`);
      }

      // B5: Return ONLY the updated network — reducer merges concurrent updates
      return {
        results: {
          [network]: {
            ...netResult,
            critique: response.content.trim(),
            qualityScore,
          },
        },
      };
    } catch (err) {
      // Sprint I: Per-network error isolation
      logger.error(`critique_${network} LLM call failed: ${(err as Error).message}`);
      return {
        results: {
          [network]: {
            ...netResult,
            critique: '',
            error: `critique failed: ${(err as Error).message}`,
          },
        },
      };
    }
  };
}

/**
 * Create a refine node for a specific network.
 */
function makeRefineNode(network: SocialNetwork) {
  return async function refineNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    // Sprint I: Skip if previous step failed
    if (netResult.error) return {};

    // P9: Force refinement when engagement bait is detected — even if the LLM
    // critique said "GOOD". The deterministic bait detector is authoritative;
    // the LLM critique can miss subtle bait patterns.
    const baitInstruction = buildBaitRewriteInstruction(netResult.draft);
    const hasBait = baitInstruction !== null;

    // If critique says it's good AND no bait detected, skip refinement
    const critiqueLower = netResult.critique.toLowerCase();
    const critiqueSaysGood =
      critiqueLower.includes('good') || critiqueLower.includes('no changes');
    if (critiqueSaysGood && !hasBait) {
      return {
        results: {
          [network]: { ...netResult, refined: netResult.draft },
        },
      };
    }

    const charLimit = NETWORK_LIMITS[network];

    const refinePrompt = `Refine this ${network} post based on the critique.

Draft:
"${netResult.draft}"

Critique:
${netResult.critique}
${hasBait ? `\n${baitInstruction}\n` : ''}
Character limit: ${charLimit}
Return ONLY the refined post text, nothing else.`;

    try {
      const response = await llm.generateChat('', refinePrompt, { temperature: 0.5 });

      // B5: Return ONLY the updated network — reducer merges concurrent updates
      return {
        results: {
          [network]: {
            ...netResult,
            refined: response.content.trim(),
          },
        },
      };
    } catch (err) {
      // Sprint I: Per-network error isolation — fall back to draft
      logger.error(`refine_${network} LLM call failed: ${(err as Error).message}`);
      return {
        results: {
          [network]: {
            ...netResult,
            refined: netResult.draft, // use draft as fallback
            error: `refine failed: ${(err as Error).message}`,
          },
        },
      };
    }
  };
}

/**
 * P3: Create a visual_concept node for a specific network.
 *
 * Runs after refine_* — generates an image concept (prompt for image gen API)
 * from the refined post text. When the VisualConceptService is disabled or
 * unavailable, this node is a no-op (returns the refined content unchanged).
 *
 * The concept is stored in NetworkResult.visualConcept and propagated to
 * Post.llmMetadata.visualConcept by save_to_db.
 */
function makeVisualConceptNode(network: SocialNetwork) {
  return async function visualConceptNode(
    state: GenerationStateType,
    visualService?: VisualConceptService,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};
    if (netResult.error) return {};

    // No-op when the visual service is disabled or unavailable
    if (!visualService || !visualService.isEnabled()) {
      return {
        results: {
          [network]: { ...netResult, visualConcept: null },
        },
      };
    }

    const content = netResult.refined || netResult.draft;
    if (!content) return {};

    try {
      const concept = await visualService.generateConcept(
        content,
        network,
        state.topic.topic,
      );
      return {
        results: {
          [network]: { ...netResult, visualConcept: concept },
        },
      };
    } catch (err) {
      // P3: Per-network error isolation — visual concept failure is non-fatal
      logger.debug(`visual_concept_${network} failed (non-blocking): ${(err as Error).message}`);
      return {
        results: {
          [network]: { ...netResult, visualConcept: null },
        },
      };
    }
  };
}

/**
 * P7: Create an ab_variant node for a specific network.
 *
 * Runs after visual_concept — generates two emoji/hashtag variants (A: minimal,
 * B: expressive) for A/B testing. When the ABVariantGenerator is disabled or
 * unavailable, this node is a no-op.
 *
 * The variants are stored in NetworkResult.abVariants and propagated to
 * Post.llmMetadata.abVariants by save_to_db.
 */
function makeABVariantNode(network: SocialNetwork) {
  return async function abVariantNode(
    state: GenerationStateType,
    abGenerator?: ABVariantGenerator,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};
    if (netResult.error) return {};

    // No-op when the generator is disabled or unavailable
    if (!abGenerator || !abGenerator.isEnabled()) {
      return {
        results: {
          [network]: { ...netResult, abVariants: null },
        },
      };
    }

    const content = netResult.refined || netResult.draft;
    if (!content) return {};

    try {
      const variants = await abGenerator.generateVariants(content, network);
      return {
        results: {
          [network]: { ...netResult, abVariants: variants },
        },
      };
    } catch (err) {
      // P7: Per-network error isolation — variant generation failure is non-fatal
      logger.debug(`ab_variant_${network} failed (non-blocking): ${(err as Error).message}`);
      return {
        results: {
          [network]: { ...netResult, abVariants: null },
        },
      };
    }
  };
}

/**
 * Node 7: save_to_db — collect all refined posts into final output.
 * (Actual DB save happens in GenerationService — this node just formats the output.)
 */
function saveToDbNode(state: GenerationStateType): Partial<GenerationStateType> {
  const posts: GeneratedPost[] = [];
  const errors: string[] = [];

  for (const network of state.targetNetworks) {
    const netResult = state.results[network];
    if (!netResult) continue;

    // Sprint I: Skip networks that errored
    if (netResult.error) {
      errors.push(`${network}: ${netResult.error}`);
      continue;
    }

    const content = netResult.refined || netResult.draft;
    if (!content) continue;

    posts.push({
      network,
      content,
      hook: netResult.hook,
      angle: netResult.angle,
      model: state.model,
      qualityScore: netResult.qualityScore,
      hookTechnique: netResult.hookTechnique,
      contentStyleId: netResult.contentStyleId,
      visualConcept: netResult.visualConcept ?? null,
      abVariants: netResult.abVariants ?? null,
    });
  }

  return { posts, error: errors.length > 0 ? errors.join('; ') : null };
}

/**
 * Node 7.5: human_review — Sprint I HITL interrupt.
 *
 * When state.humanReview is true, this node calls interrupt() with the current
 * drafts. The graph pauses until resumed with Command({ resume: { approved, edits } }).
 *
 * - approved: true → continue to save_to_db
 * - approved: false → apply edits to drafts, then continue
 *
 * If humanReview is false (default), this node is a no-op pass-through.
 */
function humanReviewNode(state: GenerationStateType): Partial<GenerationStateType> {
  if (!state.humanReview) {
    return {};
  }

  // Collect current drafts for review
  const draftsForReview: Record<string, string> = {};
  for (const network of state.targetNetworks) {
    const netResult = state.results[network];
    if (netResult && !netResult.error) {
      draftsForReview[network] = netResult.draft;
    }
  }

  // interrupt() throws GraphInterrupt — graph pauses, checkpoint saved.
  // On resume, the return value is the resume payload from Command.
  const reviewResult = interrupt<{ drafts: Record<string, string> }, {
    approved: boolean;
    edits?: Record<string, string>;
  }>({ drafts: draftsForReview });

  // If reviewer provided edits, apply them to the drafts
  if (reviewResult.edits) {
    const updatedResults: Record<string, NetworkResult> = {};
    for (const network of state.targetNetworks) {
      const netResult = state.results[network];
      if (netResult && reviewResult.edits[network]) {
        updatedResults[network] = {
          ...netResult,
          draft: reviewResult.edits[network]!,
        };
      }
    }
    return { results: updatedResults };
  }

  return {};
}

// ============================================================
// Graph builder — assembles the 7-step parallel workflow (§10.3)
// ============================================================

/** Optional progress publisher — called after each node with (node, state). */
export type ProgressPublisher = (event: {
  node: string;
  topic: string;
  postsCount: number;
  error: string | null;
}) => void;

/**
 * Build the LangGraph generation workflow with per-network parallel fan-out.
 *
 * Flow:
 *   START → research_extract → hook_generation → angle_per_network
 *     → [draft_x || draft_threads || draft_facebook]  (parallel)
 *     → [critique_x || critique_threads || critique_facebook]  (parallel)
 *     → [refine_x || refine_threads || refine_facebook]  (parallel)
 *     → save_to_db → END
 */
export function buildGenerationGraph(
  llm: ILlmPort,
  progressPublisher?: ProgressPublisher,
  hookBank?: HookPerformanceBank,
  visualService?: VisualConceptService,
  abGenerator?: ABVariantGenerator,
) {
  const logger = new Logger('GenerationGraph');

  /** Wrap a node to publish progress after execution. */
  function withProgress(nodeName: string, fn: (s: GenerationStateType) => Promise<Partial<GenerationStateType>> | Partial<GenerationStateType>) {
    return async (state: GenerationStateType): Promise<Partial<GenerationStateType>> => {
      logger.debug(`Node: ${nodeName}`);
      const result = await fn(state);
      if (progressPublisher) {
        try {
          progressPublisher({
            node: nodeName,
            topic: state.topic.topic,
            postsCount: state.posts?.length ?? 0,
            error: result.error ?? null,
          });
        } catch {
          // SSE publish failure should never break generation
        }
      }
      return result;
    };
  }

  const graph = new StateGraph(GenerationState)
    // Step 1: research_extract
    .addNode('research_extract', withProgress('research_extract', (s) => researchExtractNode(s, llm)))
    // Step 2: hook_generation (3-5 variants)
    .addNode('hook_generation', withProgress('hook_generation', (s) => hookGenerationNode(s, llm, hookBank)))
    // Step 3: angle_per_network (assign hooks + angles)
    .addNode('angle_per_network', withProgress('angle_per_network', (s) => anglePerNetworkNode(s)))
    // Step 4: parallel draft per network
    .addNode('draft_x', withProgress('draft_x', (s) => makeDraftNode(SocialNetwork.X)(s, llm)))
    .addNode('draft_threads', withProgress('draft_threads', (s) => makeDraftNode(SocialNetwork.THREADS)(s, llm)))
    .addNode('draft_facebook', withProgress('draft_facebook', (s) => makeDraftNode(SocialNetwork.FACEBOOK)(s, llm)))
    // Step 5: parallel critique per network
    .addNode('critique_x', withProgress('critique_x', (s) => makeCritiqueNode(SocialNetwork.X)(s, llm)))
    .addNode('critique_threads', withProgress('critique_threads', (s) => makeCritiqueNode(SocialNetwork.THREADS)(s, llm)))
    .addNode('critique_facebook', withProgress('critique_facebook', (s) => makeCritiqueNode(SocialNetwork.FACEBOOK)(s, llm)))
    // Step 6: parallel refine per network
    .addNode('refine_x', withProgress('refine_x', (s) => makeRefineNode(SocialNetwork.X)(s, llm)))
    .addNode('refine_threads', withProgress('refine_threads', (s) => makeRefineNode(SocialNetwork.THREADS)(s, llm)))
    .addNode('refine_facebook', withProgress('refine_facebook', (s) => makeRefineNode(SocialNetwork.FACEBOOK)(s, llm)))
    // P3: Step 6.5: parallel visual_concept per network (no-op when disabled)
    .addNode('visual_concept_x', withProgress('visual_concept_x', (s) => makeVisualConceptNode(SocialNetwork.X)(s, visualService)))
    .addNode('visual_concept_threads', withProgress('visual_concept_threads', (s) => makeVisualConceptNode(SocialNetwork.THREADS)(s, visualService)))
    .addNode('visual_concept_facebook', withProgress('visual_concept_facebook', (s) => makeVisualConceptNode(SocialNetwork.FACEBOOK)(s, visualService)))
    // P7: Step 6.6: parallel ab_variant per network (no-op when disabled)
    .addNode('ab_variant_x', withProgress('ab_variant_x', (s) => makeABVariantNode(SocialNetwork.X)(s, abGenerator)))
    .addNode('ab_variant_threads', withProgress('ab_variant_threads', (s) => makeABVariantNode(SocialNetwork.THREADS)(s, abGenerator)))
    .addNode('ab_variant_facebook', withProgress('ab_variant_facebook', (s) => makeABVariantNode(SocialNetwork.FACEBOOK)(s, abGenerator)))
    // Step 7: save_to_db (collect outputs)
    .addNode('save_to_db', withProgress('save_to_db', (s) => saveToDbNode(s)))
    // Sprint I: HITL review node (no-op when humanReview=false)
    .addNode('human_review', withProgress('human_review', (s) => humanReviewNode(s)))
    // Edges: linear through step 3
    .addEdge(START, 'research_extract')
    .addEdge('research_extract', 'hook_generation')
    .addEdge('hook_generation', 'angle_per_network')
    // Fan out: angle → parallel drafts
    .addEdge('angle_per_network', 'draft_x')
    .addEdge('angle_per_network', 'draft_threads')
    .addEdge('angle_per_network', 'draft_facebook')
    // Drafts → critiques (per network)
    .addEdge('draft_x', 'critique_x')
    .addEdge('draft_threads', 'critique_threads')
    .addEdge('draft_facebook', 'critique_facebook')
    // Critiques → refines (per network)
    .addEdge('critique_x', 'refine_x')
    .addEdge('critique_threads', 'refine_threads')
    .addEdge('critique_facebook', 'refine_facebook')
    // P3: Refines → visual_concept (per network, parallel)
    .addEdge('refine_x', 'visual_concept_x')
    .addEdge('refine_threads', 'visual_concept_threads')
    .addEdge('refine_facebook', 'visual_concept_facebook')
    // P7: visual_concept → ab_variant (per network, parallel)
    .addEdge('visual_concept_x', 'ab_variant_x')
    .addEdge('visual_concept_threads', 'ab_variant_threads')
    .addEdge('visual_concept_facebook', 'ab_variant_facebook')
    // Fan in: all ab_variants → human_review → save_to_db
    .addEdge('ab_variant_x', 'human_review')
    .addEdge('ab_variant_threads', 'human_review')
    .addEdge('ab_variant_facebook', 'human_review')
    .addEdge('human_review', 'save_to_db')
    .addEdge('save_to_db', END);

  return graph;
}

/**
 * Prepare initial state for a generation run.
 * One graph invocation generates posts for ALL target networks in parallel.
 */
export function createInitialState(
  topic: ContentTopic,
  targetNetworks: SocialNetwork[],
  brandVoice: string,
  humanReview = false,
): GenerationStateType {
  return {
    topic,
    targetNetworks,
    brandVoice,
    facts: [],
    hooks: [],
    results: {},
    model: '',
    posts: [],
    error: null,
    humanReview,
  };
}
