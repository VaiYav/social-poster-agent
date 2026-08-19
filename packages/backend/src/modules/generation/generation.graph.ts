import { StateGraph, END, START, Annotation, interrupt } from '@langchain/langgraph';
import type { ILlmPort } from '../../domain/ports/llm.port.js';
import { SocialNetwork } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { buildBaitRewriteInstruction } from '../content-enhancements/engagement-bait.detector.js';
import { hookCacheKey, getActiveHookCache, type IHookCache } from './hook-cache.js';
import type { HookPerformanceBank } from '../content-enhancements/hook-performance-bank.js';
import { classifyHookTechnique, type HookTechnique } from '../content-enhancements/hook-performance-bank.js';
import type { VisualConcept, VisualConceptService } from '../content-enhancements/visual-concept.service.js';
import type { ABVariantPair, ABVariantGenerator } from '../content-enhancements/ab-variant.generator.js';
import type { ABVariantService } from '../content-enhancements/ab-variant.service.js';
import { pickContentStyle, getStylePromptGuidance, CONTENT_STYLES_BY_ID, type ContentStyle } from '../content-enhancements/content-style.rotation.js';
import { getSlopListForPrompt } from '../content-enhancements/slop-lexicon.js';
import { pickHumorMechanic, getHumorPromptGuidance, HUMOR_MECHANICS_BY_ID } from '../content-enhancements/humor-mechanics.js';
import { buildHumanizeInstruction } from '../content-enhancements/humanizer-gate.js';
import { getLanguageExamples } from '../content-enhancements/language-packs.js';
import type { IPromptPort } from '../../domain/ports/prompt.port.js';
import type { ContentTopic, JudgeScores } from '@spa/shared';
import { NETWORK_LIMITS } from '../posts/network-limits.js';
import { BatchedJudgeService } from './batched-judge.service.js';
import {
  localPromptPort,
  RESEARCH_EXTRACT_PROMPT,
  HOOK_GENERATION_PROMPT,
  DRAFT_POST_PROMPT,
  CRITIQUE_POST_PROMPT,
  REFINE_POST_PROMPT,
} from './prompts/fallback-prompts.js';

const logger = new Logger('GenerationGraph');

/**
 * Derive a 1-10 quality score from LLM-as-a-Judge scores when the critique
 * node did not emit a SCORE. This prevents missing scores from forcing every
 * post into HUMAN_REVIEW when the judge has already validated the post.
 */
function qualityScoreFromJudgeScores(judgeScores?: JudgeScores): number | undefined {
  if (!judgeScores) return undefined;
  const dims = ['anti_ai_tone', 'hook_strength', 'factual_accuracy', 'character_limit'] as const;
  const values = dims.map((k) => judgeScores[k]).filter((v) => typeof v === 'number') as number[];
  if (values.length === 0) return undefined;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(avg * 10);
}



// Re-export hook cache helpers so existing imports continue to work.
export { hookCacheKey, clearHookCache, getHookCacheStats } from './hook-cache.js';

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
  /** Q5: Humor mechanic applied to this post (undefined for serious styles). */
  humorMechanicId?: string;
  draft: string;
  critique: string;
  refined: string;
  /** Q8: judge-gated refine loop — true after the judge triggered one retry. */
  judgeRetried?: boolean;
  /** Q8: set by judge when the post needs a humanize rewrite; cleared by refine. */
  pendingHumanizeRetry?: boolean;
  /** Q8: judge's reasons, injected into the retry-refine prompt. */
  judgeFeedback?: string;
  qualityScore?: number; // 1-10 LLM quality score from critique node
  /** Stage 2: LLM-as-a-Judge scores (anti-AI tone, hook strength, factual accuracy, char limit). */
  judgeScores?: JudgeScores;
  /** P3: Visual concept for image attachment — null when disabled or failed. */
  visualConcept?: VisualConcept | null;
  /** P7: A/B emoji/hashtag variants — null when disabled or failed. */
  abVariants?: ABVariantPair | null;
  error?: string | null;
  /** P2: Accumulated LLM token usage for this network's pipeline (draft+critique+refine+judge). */
  tokens?: number;
  /** P2: Accumulated estimated USD cost for this network's pipeline. */
  cost?: number;
}

/** Output of the full graph — one entry per target network. */
export interface GeneratedPost {
  network: SocialNetwork;
  content: string;
  hook: string;
  angle: string;
  model: string;
  qualityScore?: number; // 1-10 LLM quality score (used by auto-approve gate)
  /** Stage 2: LLM-as-a-Judge scores — stored in llmMetadata for quality tracking. */
  judgeScores?: JudgeScores;
  /** P1: Hook technique tag — stored in Post.llmMetadata for performance tracking. */
  hookTechnique?: HookTechnique;
  /** Content style used (anti-AI-detection rotation) — stored in llmMetadata. */
  contentStyleId?: string;
  /** Q5: Humor mechanic used — stored in llmMetadata for performance tracking. */
  humorMechanicId?: string;
  /** P3: Visual concept for image attachment — null when disabled or failed. */
  visualConcept?: VisualConcept | null;
  /** P7: A/B emoji/hashtag variants — null when disabled or failed. */
  abVariants?: ABVariantPair | null;
  /** Prompt labels used for this post — stored in Post.llmMetadata for A/B tracking. */
  promptLabels?: Record<string, { label: string; isFallback?: boolean }>;
  /** P2: Total LLM tokens consumed producing this post. */
  tokens?: number;
  /** P2: Estimated USD cost of producing this post. */
  cost?: number;
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
  // Language for this generation run (ISO 639-1: en, ru, uk, es, it)
  language: Annotation<string>,
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
 * Q9: Target-length guidance per network (2026 platform research).
 * "Stay within {limit}" makes the LLM FILL the limit; on Threads short
 * 1-2 sentence posts outperform essays, so we target well below the cap.
 */
const NETWORK_LENGTH_GUIDANCE: Partial<Record<SocialNetwork, string>> = {
  [SocialNetwork.X]: 'Max 280 characters. One idea. If it needs two ideas, cut one.',
  [SocialNetwork.THREADS]: 'Target 150-280 characters (short posts outperform essays on Threads). Hard cap 500.',
  [SocialNetwork.FACEBOOK]: 'Target 200-400 characters. Hard cap 500.',
  [SocialNetwork.BLUESKY]: 'Max 300 characters. One strong take or observation. No hashtags — Bluesky uses alt text and real words for discovery.',
  [SocialNetwork.MASTODON]: 'Max 500 characters. Slightly more room than X, but still one focused thought. No hashtags — Mastodon search is not hashtag-driven.',
  [SocialNetwork.TELEGRAM]: 'Hard cap 4096, but this is a promo post — keep it short (≤500 characters). One clear point, no engagement-bait questions.',
  [SocialNetwork.LINKEDIN]: 'Target 1000-1500 characters. Lead with a specific insight or story, then a short takeaway. Conversational professional, not corporate jargon.',
};

/**
 * P9: Max output tokens per generation step.
 * Capping tokens reduces latency and cost while still leaving the model room
 * to produce the requested post. Draft/refine use the network limit as a
 * guide (roughly 1 token ≈ 4 characters, plus headroom); analytical roles
 * use smaller caps because their output is structured/short.
 */
function maxTokensForRole(role: 'facts' | 'hook' | 'critique' | 'judge' | 'draft' | 'refine', network?: SocialNetwork): number {
  switch (role) {
    case 'facts':
      return 256;
    case 'hook':
      return 150;
    case 'critique':
      // Critique prompt asks for 10 rubric checks + a final SCORE/VERDICT.
      // 256 tokens truncates the response before the SCORE line, leaving
      // qualityScore undefined and blocking auto-approve. 512 gives enough
      // headroom for the critique without materially increasing cost.
      return 512;
    case 'judge':
      return 700;
    case 'draft':
    case 'refine':
      if (network === SocialNetwork.X || network === SocialNetwork.BLUESKY) return 200;
      if (network === SocialNetwork.THREADS || network === SocialNetwork.FACEBOOK || network === SocialNetwork.MASTODON || network === SocialNetwork.TELEGRAM) return 350;
      if (network === SocialNetwork.LINKEDIN) return 500;
      return 350;
    default:
      return 350;
  }
}

/**
 * Strip hashtags from post content — LLMs often ignore "no hashtags" instructions.
 * Removes #word patterns and cleans up extra whitespace.
 * Preserves emoji, punctuation, and normal text.
 */
function stripHashtags(text: string): string {
  return text
    .replace(/#[\w\u0400-\u04FF\u0500-\u052F]+/g, '') // remove hashtags (Latin + Cyrillic)
    .replace(/\s{2,}/g, ' ') // collapse multiple spaces
    .replace(/^\s+|\s+$/g, '') // trim
    .replace(/\s+([.!?,;:])/g, '$1') // fix space before punctuation
    .trim();
}

// ── Multilingual support ───────────────────────────────────────────────────
// Language names and per-language instructions for the generation prompt.
// Russian and Ukrainian are explicitly distinguished to prevent the LLM from
// mixing them (a common failure mode since they share Cyrillic alphabet).
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian (русский)',
  uk: 'Ukrainian (українська)',
  es: 'Spanish (español)',
  it: 'Italian (italiano)',
};

const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  en: ' English only. Do NOT use any other language, even if the topic, facts, or brand voice include non-English words.',
  ru: ' English only. Do NOT use Russian or any other language.',
  uk: ' English only. Do NOT use Ukrainian, Russian, or any other language.',
  es: ' English only. Do NOT use Spanish or any other language.',
  it: ' English only. Do NOT use Italian or any other language.',
};

const NETWORK_TONE: Partial<Record<SocialNetwork, string>> = {
  [SocialNetwork.X]: 'Punchy, hook-first, confident. One idea per post. Can be sarcastic, bold, or deadpan. NO hashtags — X algorithm deprioritizes them and 3+ triggers spam filters. No filler.',
  [SocialNetwork.THREADS]: 'Narrative, storytelling, personal. Like texting a friend about something you noticed. Can be vulnerable, funny, or reflective. NO hashtags — Threads doesn\'t use hashtags for discovery.',
  [SocialNetwork.FACEBOOK]: 'Conversational, community-oriented. Relatable, warm, but not corny. End with a genuine question (not engagement bait). NO hashtags — Facebook algorithm treats them as spam signals.',
  [SocialNetwork.BLUESKY]: 'Conversational, a little unpolished, text-first. Think "smart friend at the coffee shop" — opinions, observations, weird specifics. NO hashtags. No engagement bait.',
  [SocialNetwork.MASTODON]: 'Warm, community-minded, slightly old-internet. Sincere takes and gentle humor land better than hustle culture. NO hashtags. No engagement bait.',
  [SocialNetwork.TELEGRAM]: 'Direct and useful, like a channel update worth forwarding. One clear point, friendly but not salesy. NO hashtags. No "tap the link below" CTAs.',
  [SocialNetwork.LINKEDIN]: 'Conversational professional — specific, not self-congratulatory. Share a real insight or small story, then a short takeaway. NO hashtags. No engagement-bait questions.',
};

const NETWORK_ANGLE: Partial<Record<SocialNetwork, string>> = {
  [SocialNetwork.X]: 'bold take or counter-intuitive observation — max impact in 280 chars, make someone stop mid-scroll',
  [SocialNetwork.THREADS]: 'personal story or reflective observation — "I noticed something about..." energy, warmer, more context',
  [SocialNetwork.FACEBOOK]: 'relatable + discussion-starter — everyday life angle, "has anyone else noticed..." energy, invite genuine discussion',
  [SocialNetwork.BLUESKY]: 'sharp, slightly irreverent take or observation — the kind of post you\'d quote-skeet, not thread about',
  [SocialNetwork.MASTODON]: 'sincere, community-rooted take — a small insight or observation you\'d share with people who actually know you',
  [SocialNetwork.TELEGRAM]: 'single useful promo angle — what changed, why it matters, and where to read more, in one breath',
  [SocialNetwork.LINKEDIN]: 'professional mini-story or counter-narrative — a specific thing you learned, how it changed your thinking, and a concise takeaway',
};

/**
 * P2: Per-Network Persona — distinct voice variant per network audience.
 * Augments the shared brand voice with network-specific persona traits.
 * The draft node concatenates `state.brandVoice` + this persona block in the
 * system prompt so each network speaks to its audience in the right register.
 */
const NETWORK_PERSONA: Partial<Record<SocialNetwork, string>> = {
  [SocialNetwork.X]: `X PERSONA — "the one at the party who actually knows the topic and has opinions about it":
- Voice: confident, a bit edgy, has opinions and isn't afraid of them. But also admits when they're wrong.
- Energy: main-character energy but not cringe. Would call out a bad take. Would also admit their own takes are sometimes wrong.
- References: pop-culture takes, sharp observations, personal stories about their own experience, the kind of hot take that gets quote-tweeted
- Sentence rhythm: short, punchy, one idea per post. Fragments are fine. Incomplete thoughts are fine.
- What they'd never do: write a thread that starts "🧵 Let me explain..." or use the word "narrative" or "discourse"
- What they'd do: text a friend "okay but actually though" at 1am about a development
- Occasionally posts in all lowercase when the thought is casual — it reads more human`,
  [SocialNetwork.THREADS]: `THREADS PERSONA — "your friend who got into this topic last year and won't shut up about it (in a good way)":
- Voice: warm, personal, story-first. Like sharing something you noticed at 2am that you can't stop thinking about.
- Energy: vulnerable but not whiny. Curious. Genuinely excited about what they found. Sometimes confused by it.
- References: personal anecdotes, "I noticed...", "has anyone else experienced...", "okay this might be crazy but...", reflective tone
- Sentence rhythm: flowing, conversational, can be longer. Like a text message to a friend, not an essay. Run-on sentences are okay sometimes.
- What they'd never do: end with "What do you think?" (engagement bait) or "Drop your thoughts below"
- What they'd do: end mid-thought, or with a specific question that only someone who read the post would answer`,
  [SocialNetwork.FACEBOOK]: `FACEBOOK PERSONA — "the knowledgeable one in the friend group who always has a take":
- Voice: inviting, accessible, relatable. Not a guru — a peer who happens to know stuff and is sometimes wrong about it.
- Energy: community-oriented. Asks real questions, not engagement-bait questions. Shares personal stories that connect.
- References: everyday life situations, "you know that feeling when...", relatable examples, specific moments not generalizations
- Sentence rhythm: clear, natural, can ramble a bit. Ends with something genuine, not a CTA.
- What they'd never do: write "Comment below if you agree!" or use 5 emojis in a row
- What they'd do: share a specific story about their week and how it connected to the topic, then stop without a neat conclusion`,
  [SocialNetwork.BLUESKY]: `BLUESKY PERSONA — "the person at the small party who actually knows what they're talking about and is not selling anything":
- Voice: conversational, irreverent, text-first. Likes weird specifics and mild contrarianism. Not a guru.
- Energy: low-key smart. Less hustle, more "huh, that's interesting." Can be funny but never performance-funny.
- References: pop-culture observations, "has anyone noticed...", small grumbles about bad takes, the kind of post you'd quote-skeet
- Sentence rhythm: short to medium, one or two sentences. Fragments are fine. No final-sentence wrap-ups.
- What they'd never do: use hashtags, write a thread opener, or ask "what do you think?"
- What they'd do: drop a sharp observation and let the timeline do the rest`,
  [SocialNetwork.MASTODON]: `MASTODON PERSONA — "your friend from the old internet who is kind, skeptical of platforms, and genuinely curious":
- Voice: warm, sincere, community-minded. Dislikes hustle culture and AI-slop. Willing to be wrong.
- Energy: gentle but not boring. Loves a niche observation. Does not perform enthusiasm.
- References: "I just realized...", small community notes, "has anyone else...", things you'd share in a friend's mentions
- Sentence rhythm: conversational, can be a little longer than X but still focused. Run-ons only when they feel like speech.
- What they'd never do: use hashtags, post engagement-bait polls, or end with "boosts appreciated"
- What they'd do: share a small sincere take and sign off naturally`,
  [SocialNetwork.TELEGRAM]: `TELEGRAM PERSONA — "a sharp channel admin who respects your time and only pings you when it's worth it":
- Voice: direct, useful, slightly informal. Not corporate. Not breathless.
- Energy: one clear point. Feels like a note you'd forward to a colleague. No hype.
- References: "just published", "here's what changed", "worth reading if you're into...", concise context + one link worth clicking
- Sentence rhythm: 2-3 short paragraphs max. Lead with the point, then the why. No filler.
- What they'd never do: ask for reactions, use hashtags, or write "tap below"
- What they'd do: give you one reason to care, then stop`,
  [SocialNetwork.LINKEDIN]: `LINKEDIN PERSONA — "the colleague who actually learns in public, not the one who posts hustle quotes":
- Voice: conversational professional. Specific, humble, and slightly self-aware about LinkedIn culture.
- Energy: thoughtful, not performatively grateful. Shares a real thing that happened or a real thing they changed their mind about.
- References: "I used to think...", "what surprised me was...", a small project outcome, a counter-intuitive lesson from the work
- Sentence rhythm: 2-3 short paragraphs. Story up front, insight in the middle, no big conclusion.
- What they'd never do: use hashtags, ask "agree?", or write "I'm humbled to announce"
- What they'd do: share one specific learning and stop before it turns into a sermon`,
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
  promptPort: IPromptPort,
): Promise<Partial<GenerationStateType>> {
  // If facts already provided (from CAP run or article frontmatter), use them
  if (state.topic.facts.length > 0) {
    return { facts: state.topic.facts };
  }

  // Sprint E: LLM-powered fact extraction from topic + keywords + outline
  const outlineStr = state.topic.outline
    ? state.topic.outline.map((o) => `- ${o.heading}${o.entities.length > 0 ? ` (entities: ${o.entities.join(', ')})` : ''}`).join('\n')
    : 'No outline available.';

  const variables = {
    topic: state.topic.topic,
    keywords: state.topic.keywords.join(', '),
    category: state.topic.category ?? 'general',
    outline: outlineStr,
  };

  const { systemPrompt, userPrompt } = await promptPort.getCompiledChat('research-extract', variables, RESEARCH_EXTRACT_PROMPT);

  try {
    const response = await llm.generateChat(systemPrompt, userPrompt, { temperature: 0.7, role: 'facts', maxTokens: maxTokensForRole('facts') });
    const facts = response.content
      .split('\n')
      .map((line) => line.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter((line) => line.length > 10)
      .slice(0, 8);

    // Q10: DON'T pad with slop fillers ("...offers unique insights for personal
    // growth") — those went straight into the draft prompt as "facts" and
    // violated our own anti-AI rules. Fewer real facts beat fake filler.
    if (facts.length === 0) {
      facts.push('No verified facts available — write from the hook alone; do NOT invent statistics or specifics.');
    }

    logger.debug(`research_extract: LLM extracted ${facts.length} facts for "${state.topic.topic}"`);
    return { facts, model: response.model };
  } catch (err) {
    logger.warn(`research_extract LLM call failed: ${(err as Error).message} — using fallback facts`);
    return {
      facts: [
        'No verified facts available — write from the hook alone; do NOT invent statistics or specifics.',
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
  hookBank: HookPerformanceBank | undefined,
  promptPort: IPromptPort,
  hookCache: IHookCache,
  hookTemperature = 0.95,
): Promise<Partial<GenerationStateType>> {
  // Check cache first — avoids re-calling LLM for identical topics across runs.
  // Cache is keyed by topic + keywords + facts (the deterministic inputs).
  // performanceGuidance is excluded (advisory, may change between runs).
  const cacheKey = hookCacheKey(state.topic.topic, state.topic.keywords, state.facts);
  const cached = hookCache.get(cacheKey);
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

  const variables = {
    brandVoice: state.brandVoice,
    topic: state.topic.topic,
    performanceGuidance,
    facts: state.facts.join(', '),
    keywords: state.topic.keywords.join(', '),
    // English-only generation: always use the English slop lexicon.
    slopList: getSlopListForPrompt('en'),
  };

  const { systemPrompt, userPrompt } = await promptPort.getCompiledChat('hook-generation', variables, HOOK_GENERATION_PROMPT);

  let response;
  try {
    response = await llm.generateChat(systemPrompt, userPrompt, { temperature: hookTemperature, role: 'hook', maxTokens: maxTokensForRole('hook') });
  } catch (err) {
    logger.error(`hook_generation LLM call failed: ${(err as Error).message}`);
    throw err; // Re-throw — GenerationService.generate() catches per-topic
  }
  const hooks = response.content
    .split('\n')
    .map((line) => line.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);

  // Q10: If the LLM returned fewer than 3 hooks, pad from FACTS delivered
  // deadpan — a specific fact stated flatly is a legitimate human-sounding
  // hook. The old filler ("Discover what X means for you.") used a word from
  // our own banned list and was the worst possible opener.
  let padIdx = 0;
  while (hooks.length < 3) {
    const fact = state.facts[padIdx];
    hooks.push(fact ? fact : `${state.topic.topic}. That's it. That's the post.`);
    padIdx += 1;
  }

  // Store in cache for future runs with the same topic
  hookCache.set(cacheKey, hooks, response.model);

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
    const angle = NETWORK_ANGLE[net] ?? '';
    // P1: Classify the hook technique for performance tracking.
    // The technique is stored in NetworkResult and propagated to Post.llmMetadata.
    const hookTechnique = classifyHookTechnique(hook);

    // Pick a content style for this network — rotates daily + per-run
    // so posts don't all look the same (anti-AI-detection).
    const style = pickContentStyle(net, state.topic.topic);

    // Q5: Pick a humor mechanic — only for humor-compatible styles.
    // Serious/poetic styles (mystical_poem, ancient_wisdom, tiny_lesson)
    // skip the humor layer entirely.
    const mechanic = style.humorCompatible ? pickHumorMechanic(net, state.topic.topic) : null;

    results[net] = {
      angle,
      hook,
      hookTechnique,
      contentStyleId: style.id,
      humorMechanicId: mechanic?.id,
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
function makeDraftNode(network: SocialNetwork, promptPort: IPromptPort, draftTemperature = 0.8) {
  return async function draftNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    const charLimit = NETWORK_LIMITS[network] ?? 280;
    const tone = NETWORK_TONE[network] ?? '';
    const persona = NETWORK_PERSONA[network] ?? '';

    // English-only generation: all prompts are rendered for English regardless
    // of the source topic's declared language.
    const lang = 'en';
    const langName = LANGUAGE_NAMES[lang] ?? 'English';
    const langInstruction = LANGUAGE_INSTRUCTIONS[lang] ?? '';

    // P10: Source Attribution disabled — links in posts reduce engagement and
    // don't rank on social platforms. Posts should be pure text + hashtags only.
    // (Keeping the import and resolveCtaUrl call removed to avoid unused warnings.)

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
    const outlineStr = state.topic.outline
      ? `Outline:\n${state.topic.outline.map((o: { heading: string }) => `- ${o.heading}`).join('\n')}`
      : '';

    // Q5: humor mechanic guidance (empty string for serious styles)
    const mechanic = netResult.humorMechanicId
      ? (HUMOR_MECHANICS_BY_ID[netResult.humorMechanicId] ?? null)
      : null;
    const humorGuidance = getHumorPromptGuidance(mechanic);

    const variables = {
      brandVoice: state.brandVoice,
      persona: persona ?? '',
      styleGuidance,
      humorGuidance,
      network,
      charLimit: String(charLimit),
      lengthGuidance: NETWORK_LENGTH_GUIDANCE[network] ?? '',
      langName,
      langInstruction,
      topic: state.topic.topic,
      hook: netResult.hook,
      angle: netResult.angle,
      styleName: style.name,
      styleDescription: style.description,
      facts: state.facts.join('\n- '),
      keywords: state.topic.keywords.join(', '),
      tone,
      outline: outlineStr,
      slopList: getSlopListForPrompt(lang),
      langExamples: getLanguageExamples(lang),
    };

    const { systemPrompt, userPrompt } = await promptPort.getCompiledChat('draft-post', variables, DRAFT_POST_PROMPT);

    try {
      const response = await llm.generateChat(systemPrompt, userPrompt, { temperature: draftTemperature, role: 'draft', maxTokens: maxTokensForRole('draft', network) });

      // B5: Return ONLY the updated network — the results reducer merges concurrent updates
      return {
        results: {
          [network]: {
            ...netResult,
            draft: response.content.trim(),
            tokens: (netResult.tokens ?? 0) + (response.tokens ?? 0),
            cost: Number(((netResult.cost ?? 0) + (response.cost ?? 0)).toFixed(6)),
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
function makeCritiqueNode(network: SocialNetwork, promptPort: IPromptPort) {
  return async function critiqueNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    // Sprint I: Skip if draft already failed
    if (netResult.error) return {};

    const charLimit = NETWORK_LIMITS[network] ?? 280;

    // P9: Engagement-Bait Detector — deterministic pattern check.
    // When bait is detected, the critique prompt explicitly flags it so the
    // refine step rewrites the offending phrases. This runs before the LLM
    // critique call so it's free (no extra tokens) and deterministic.
    const baitInstruction = buildBaitRewriteInstruction(netResult.draft);

    // Q6: Humanizer Gate — deterministic statistical scan (slop words,
    // em dashes, uniform sentence lengths, hashtags). Free, zero LLM tokens.
    // English-only generation: the English slop lexicon is always used.
    const lang = 'en';
    const humanizeInstruction = buildHumanizeInstruction(netResult.draft, lang);
    const gateInstructions = [baitInstruction, humanizeInstruction].filter(Boolean).join('\n');

    // Q10: Humor-landing check — only meaningful when this post was drafted
    // with a humor mechanic (Q5). Mirrors makeDraftNode's own mechanic lookup.
    const critiqueMechanic = netResult.humorMechanicId
      ? (HUMOR_MECHANICS_BY_ID[netResult.humorMechanicId] ?? null)
      : null;
    const humorCheck = critiqueMechanic
      ? '\n11. [Humor check] Does the joke actually land — punchline last, one line, punching at planets/situations/the narrator and never at people or groups? If it reads forced, flag it and say so.\n'
      : '';

    const critiqueVariables = {
      network,
      charLimit: String(charLimit),
      draftLength: String(netResult.draft.length),
      angle: netResult.angle,
      draft: netResult.draft,
      baitInstruction: gateInstructions ? `\n${gateInstructions}\n` : '',
      slopList: getSlopListForPrompt(lang),
      humorCheck,
    };

    const critiquePrompt = await promptPort.getCompiledText('critique-post', critiqueVariables, CRITIQUE_POST_PROMPT);

    try {
      const response = await llm.generateChat('', critiquePrompt, { temperature: 0.3, role: 'critique', maxTokens: maxTokensForRole('critique') });

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
            tokens: (netResult.tokens ?? 0) + (response.tokens ?? 0),
            cost: Number(((netResult.cost ?? 0) + (response.cost ?? 0)).toFixed(6)),
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
function makeRefineNode(network: SocialNetwork, promptPort: IPromptPort, refineTemperature = 0.6) {
  return async function refineNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    // Sprint I: Skip if previous step failed
    if (netResult.error) return {};

    // English-only generation: the rewrite must always stay in English.
    const lang = 'en';
    const langName = LANGUAGE_NAMES[lang] ?? 'English';
    const langInstruction = LANGUAGE_INSTRUCTIONS[lang] ?? '';

    // Q8: Judge-triggered retry pass — the judge flagged the REFINED text as
    // AI-sounding. Rewrite the current refined text using the judge's reasons;
    // the normal skip logic does not apply.
    const isJudgeRetry = netResult.pendingHumanizeRetry === true;
    const sourceText = isJudgeRetry ? (netResult.refined || netResult.draft) : netResult.draft;

    // P9: Force refinement when engagement bait is detected — even if the LLM
    // critique said "GOOD". The deterministic bait detector is authoritative;
    // the LLM critique can miss subtle bait patterns.
    const baitInstruction = buildBaitRewriteInstruction(sourceText);
    const hasBait = baitInstruction !== null;

    // Q6: Humanizer Gate — deterministic scan is authoritative like the bait
    // detector: slop words, em dashes, uniform rhythm, hashtags force a rewrite.
    const humanizeInstruction = buildHumanizeInstruction(sourceText, lang);
    const hasHumanizerFlags = humanizeInstruction !== null;

    // BUG-FIX (was: critiqueLower.includes('good')) — the word "good" appears
    // in most detailed critiques ("the hook is good, but..."), which silently
    // skipped refinement for the majority of drafts. Now the critique must
    // explicitly end with "VERDICT: GOOD" (legacy "GOOD — no changes" at line
    // start is still accepted for older Langfuse prompt versions).
    const critiqueSaysGood =
      /^\s*VERDICT:\s*GOOD\b/im.test(netResult.critique) ||
      /^GOOD\b/m.test(netResult.critique.trim());
    if (!isJudgeRetry && critiqueSaysGood && !hasBait && !hasHumanizerFlags) {
      return {
        results: {
          [network]: { ...netResult, refined: netResult.draft },
        },
      };
    }

    const charLimit = NETWORK_LIMITS[network] ?? 280;

    const gateInstructions = [baitInstruction, humanizeInstruction].filter(Boolean).join('\n');
    const critiqueText = isJudgeRetry
      ? `LLM-as-a-Judge flagged this post as AI-sounding. Reasons:\n${netResult.judgeFeedback ?? 'anti_ai_tone below threshold'}`
      : netResult.critique;

    const refineVariables = {
      network,
      draft: sourceText,
      critique: critiqueText,
      baitInstruction: gateInstructions ? `\n${gateInstructions}\n` : '',
      charLimit: String(charLimit),
      slopList: getSlopListForPrompt(lang),
      langName,
      langInstruction,
      langExamples: getLanguageExamples(lang),
    };

    const refinePrompt = await promptPort.getCompiledText('refine-post', refineVariables, REFINE_POST_PROMPT);

    try {
      const response = await llm.generateChat('', refinePrompt, { temperature: refineTemperature, role: 'refine', maxTokens: maxTokensForRole('refine', network) });

      let refined = response.content.trim();
      let refineTokens = response.tokens ?? 0;
      let refineCost = response.cost ?? 0;

      // Q12: Hard char-limit enforcement — if the refined text still exceeds the
      // network limit, do one more LLM pass to cut it down. LLMs (especially
      // smaller models like Gemini Flash Lite) often ignore "max N chars" in the
      // prompt. If the LLM is unavailable, hard-truncate at the last word boundary.
      if (refined.length > charLimit) {
        logger.warn(
          `refine_${network}: refined text ${refined.length} chars > limit ${charLimit} — doing truncation pass`,
        );
        try {
          const cutResponse = await llm.generateChat(
            '',
            `Cut this ${network} post to ${charLimit} characters or fewer. Keep the hook and the punchline. Remove filler, not substance. Preserve the original language (${langName}).\n\nPost:\n"${refined}"\n\nReturn ONLY the shortened post (max ${charLimit} chars):`,
            { temperature: 0.3, role: 'refine', maxTokens: maxTokensForRole('refine', network) },
          );
          refineTokens += cutResponse.tokens ?? 0;
          refineCost += cutResponse.cost ?? 0;
          const cut = cutResponse.content.trim();
          if (cut.length > 0 && cut.length <= charLimit) {
            refined = cut;
          } else {
            // LLM still didn't comply — hard truncate at last word boundary
            refined = refined.slice(0, charLimit).replace(/\s+\S*$/, '').trim();
          }
        } catch {
          // LLM unavailable — hard truncate
          refined = refined.slice(0, charLimit).replace(/\s+\S*$/, '').trim();
        }
        logger.debug(`refine_${network}: after truncation pass — ${refined.length} chars`);
      }

      // B5: Return ONLY the updated network — reducer merges concurrent updates
      return {
        results: {
          [network]: {
            ...netResult,
            refined,
            pendingHumanizeRetry: false,
            tokens: (netResult.tokens ?? 0) + refineTokens,
            cost: Number(((netResult.cost ?? 0) + refineCost).toFixed(6)),
          },
        },
      };
    } catch (err) {
      // Sprint I: Per-network error isolation — fall back to the best text we
      // have. NOTE (bug-fix): previously this ALSO set `error`, which made
      // save_to_db drop the post entirely — contradicting the "fall back to
      // draft" intent. A failed refine is non-fatal: the draft passed critique
      // and the HITL/auto-approve gate still guards publication.
      logger.error(`refine_${network} LLM call failed: ${(err as Error).message} — using unrefined text`);
      return {
        results: {
          [network]: {
            ...netResult,
            refined: netResult.refined || netResult.draft,
            pendingHumanizeRetry: false,
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
function makeABVariantNode(network: SocialNetwork, judgeSkipABThreshold = 0.6) {
  return async function abVariantNode(
    state: GenerationStateType,
    abGenerator?: ABVariantGenerator,
    abVariantService?: ABVariantService,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};
    if (netResult.error) return {};

    // P0: skip A/B variants when judge quality is below the threshold (saves tokens/latency).
    const scores = netResult.judgeScores;
    if (scores) {
      const minScore = Math.min(scores.anti_ai_tone, scores.hook_strength, scores.factual_accuracy, scores.character_limit);
      if (minScore < judgeSkipABThreshold) {
        logger.debug(`ab_variant_${network}: skipped — min judge score ${minScore.toFixed(2)} < ${judgeSkipABThreshold}`);
        return {
          results: {
            [network]: { ...netResult, abVariants: null },
          },
        };
      }
    }

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
      const topic = state.topic?.topic ?? content.slice(0, 50);
      const priorWinner = abVariantService
        ? await abVariantService.getWinnerForTopic(topic, network)
        : null;

      const variants = await abGenerator.generateVariants(content, network, {
        topic,
        priorWinner,
      });
      return {
        results: {
          [network]: { ...netResult, abVariants: variants },
        },
      };
    } catch (err) {
      // P7: Per-network error isolation — variant generation failure is non-fatal
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`ab_variant_${network} failed (non-blocking): ${message}`);
      return {
        results: {
          [network]: { ...netResult, abVariants: null },
        },
      };
    }
  };
}

/**
 * Create a judge node for a specific network.
 *
 * Stage 2: LLM-as-a-Judge — evaluates the refined post on 4 criteria
 * (anti-AI tone, hook strength, factual accuracy, character limit).
 * Scores are stored in NetworkResult.judgeScores and propagated to
 * Post.llmMetadata.judgeScores by save_to_db.
 *
 * The judge runs AFTER refine and BEFORE visual_concept. It's non-blocking —
 * if the judge LLM call fails, the post proceeds with undefined judgeScores.
 */
interface JudgeThresholds {
  antiAiTone: number;
  factualAccuracy: number;
  characterLimit: number;
  skipAB: number;
}

function makeJudgeNode(
  network: SocialNetwork,
  batchedJudgeService: BatchedJudgeService,
  refineThreshold = 0.6,
  thresholds: JudgeThresholds,
) {
  return async function judgeNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    // Skip if previous step failed
    if (netResult.error) return {};

    const content = netResult.refined || netResult.draft;
    if (!content) return {};

    // English-only generation: the English slop lexicon is always used for judging.
    const lang = 'en';
    const slopList = getSlopListForPrompt(lang);
    const factsText = state.facts.length > 0 ? state.facts.map((f) => `- ${f}`).join('\n') : '- (no source facts provided)';

    // Build batch inputs for ALL target networks so concurrent judge nodes share
    // a single LLM call via BatchedJudgeService.
    const batchInputs = state.targetNetworks
      .map((net) => {
        const r = state.results[net];
        if (!r || r.error) return null;
        const c = r.refined || r.draft;
        if (!c) return null;
        return {
          network: net,
          content: c,
          charLimit: NETWORK_LIMITS[net] ?? 280,
          factsText,
          slopList,
        };
      })
      .filter((i): i is NonNullable<typeof i> => i !== null);

    try {
      const allScores = await batchedJudgeService.judgeBatch(batchInputs);
      const judgeScores = allScores[network];
      if (!judgeScores) {
        logger.warn(`judge_${network}: no batched score for this network`);
        return {};
      }

      logger.debug(
        `judge_${network}: anti_ai=${judgeScores.anti_ai_tone} hook=${judgeScores.hook_strength} factual=${judgeScores.factual_accuracy} chars=${judgeScores.character_limit}`,
      );

      // Stage 2: hard-fail — any critical dimension below its per-dimension threshold kills the post.
      const failReasons: string[] = [];
      if (judgeScores.anti_ai_tone < thresholds.antiAiTone) {
        failReasons.push(`anti_ai_tone=${judgeScores.anti_ai_tone.toFixed(2)} < ${thresholds.antiAiTone}`);
      }
      if (judgeScores.factual_accuracy < thresholds.factualAccuracy) {
        failReasons.push(`factual_accuracy=${judgeScores.factual_accuracy.toFixed(2)} < ${thresholds.factualAccuracy}`);
      }
      if (judgeScores.character_limit < thresholds.characterLimit) {
        failReasons.push(`character_limit=${judgeScores.character_limit.toFixed(2)} < ${thresholds.characterLimit}`);
      }
      if (failReasons.length > 0) {
        logger.warn(`judge_${network}: hard-fail (${failReasons.join(', ')}) — not saving post`);
        return {
          results: {
            [network]: {
              ...netResult,
              judgeScores,
              error: `Judge hard-fail: ${failReasons.join(', ')}`,
            },
          },
        };
      }

      // Q8: Judge-gated refine loop — when the post sounds like AI and we
      // haven't retried yet, route back through refine ONCE with the judge's
      // reasons. The router (routeAfterJudge) reads pendingHumanizeRetry.
      const needsRetry = judgeScores.anti_ai_tone < refineThreshold && netResult.judgeRetried !== true;
      if (needsRetry) {
        logger.debug(`judge_${network}: anti_ai_tone ${judgeScores.anti_ai_tone} < ${refineThreshold} — triggering one refine retry`);
        return {
          results: {
            [network]: {
              ...netResult,
              judgeScores,
              judgeRetried: true,
              pendingHumanizeRetry: true,
              judgeFeedback: `anti_ai_tone=${judgeScores.anti_ai_tone}: ${judgeScores.anti_ai_tone_reason}\nhook_strength=${judgeScores.hook_strength}: ${judgeScores.hook_strength_reason}`,
            },
          },
        };
      }

      return {
        results: {
          [network]: {
            ...netResult,
            judgeScores,
            pendingHumanizeRetry: false,
          },
        },
      };
    } catch (err) {
      // Non-blocking — post proceeds without judge scores
      logger.warn(`judge_${network} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  };
}

/**
 * Q8: Router after each judge node — one retry through refine when the judge
 * flagged the post as AI-sounding, otherwise continue to visual_concept.
 */
function routeAfterJudge(network: SocialNetwork) {
  return (state: GenerationStateType): 'refine' | 'continue' => {
    const netResult = state.results[network];
    if (netResult && netResult.pendingHumanizeRetry === true && !netResult.error) {
      return 'refine';
    }
    return 'continue';
  };
}

/**
 * Node 7: save_to_db — collect all refined posts into final output.
 * (Actual DB save happens in GenerationService — this node just formats the output.)
 */
function saveToDbNode(
  state: GenerationStateType,
  getRecordedPromptLabels?: () => Record<string, { label: string; isFallback?: boolean }>,
): Partial<GenerationStateType> {
  const posts: GeneratedPost[] = [];
  const errors: string[] = [];
  const promptLabels = getRecordedPromptLabels?.();

  for (const network of state.targetNetworks) {
    const netResult = state.results[network];
    if (!netResult) continue;

    // Sprint I: Skip networks that errored
    if (netResult.error) {
      errors.push(`${network}: ${netResult.error}`);
      continue;
    }

    const content = stripHashtags(netResult.refined || netResult.draft);
    if (!content) continue;

    const qualityScore = netResult.qualityScore ?? qualityScoreFromJudgeScores(netResult.judgeScores);
    posts.push({
      network,
      content,
      hook: netResult.hook,
      angle: netResult.angle,
      model: state.model,
      qualityScore,
      judgeScores: netResult.judgeScores,
      hookTechnique: netResult.hookTechnique,
      contentStyleId: netResult.contentStyleId,
      humorMechanicId: netResult.humorMechanicId,
      visualConcept: netResult.visualConcept ?? null,
      abVariants: netResult.abVariants ?? null,
      promptLabels,
      tokens: netResult.tokens,
      cost: netResult.cost,
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

  // Collect the CURRENT text for review — the refined version when it exists.
  // BUG-FIX: previously the raw `draft` was shown (stale — refine had already
  // rewritten it), and edits were written back into `draft` while save_to_db
  // reads `refined || draft` — so reviewer edits were silently discarded.
  const draftsForReview: Record<string, string> = {};
  for (const network of state.targetNetworks) {
    const netResult = state.results[network];
    if (netResult && !netResult.error) {
      draftsForReview[network] = netResult.refined || netResult.draft;
    }
  }

  // interrupt() throws GraphInterrupt — graph pauses, checkpoint saved.
  // On resume, the return value is the resume payload from Command.
  const reviewResult = interrupt<{ drafts: Record<string, string> }, {
    approved: boolean;
    edits?: Record<string, string>;
  }>({ drafts: draftsForReview });

  // If reviewer provided edits, apply them to the REFINED text — that's what
  // save_to_db persists (refined || draft).
  if (reviewResult.edits) {
    const updatedResults: Record<string, NetworkResult> = {};
    for (const network of state.targetNetworks) {
      const netResult = state.results[network];
      const edit = reviewResult.edits[network];
      if (netResult && edit) {
        updatedResults[network] = {
          ...netResult,
          refined: edit,
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
 *     → [draft_{network} ...]  (parallel per target network)
 *     → [critique_{network} ...]
 *     → [refine_{network} ...]
 *     → [judge_{network} ...]
 *     → [visual_concept_{network} ...]
 *     → [ab_variant_{network} ...]
 *     → human_review → save_to_db → END
 */
export function buildGenerationGraph(
  llm: ILlmPort,
  progressPublisher?: ProgressPublisher,
  hookBank?: HookPerformanceBank,
  visualService?: VisualConceptService,
  abGenerator?: ABVariantGenerator,
  abVariantService?: ABVariantService,
  promptPort: IPromptPort = localPromptPort,
  options?: {
    /**
     * Q8: anti_ai_tone threshold below which the judge routes the post back
     * through refine once (env JUDGE_REFINE_THRESHOLD, default 0.6).
     * Set to 0 to disable the retry loop.
     */
    judgeRefineThreshold?: number;
    /**
     * Stage 2: any judge dimension below its per-dimension threshold hard-fails the post.
     * The post is not saved and counts as an error for the network.
     */
    judgeHardFailThreshold?: number;
    judgeHardFailAntiAi?: number;
    judgeHardFailFactual?: number;
    judgeHardFailCharacter?: number;
    /** P0: skip A/B variant generation when the judge score is below this threshold. */
    judgeSkipABThreshold?: number;
    /**
     * Per-generation-stage temperature overrides. Reasoning models ignore
     * temperature, but these values are used for the non-reasoning chain.
     */
    temperatures?: { hook?: number; draft?: number; refine?: number };
    /**
     * Callback that returns the prompt labels recorded during this graph run.
     * Injected by the orchestrator so the graph does not depend on the
     * infrastructure label context directly.
     */
    getRecordedPromptLabels?: () => Record<string, { label: string; isFallback?: boolean }>;
    /**
     * Hook cache instance. Defaults to the active process-level hook cache.
     */
    hookCache?: IHookCache;
  },
) {
  const logger = new Logger('GenerationGraph');
  const judgeRefineThreshold = options?.judgeRefineThreshold ?? 0.6;
  const judgeHardFailThreshold = options?.judgeHardFailThreshold ?? 0.25;
  const judgeThresholds: JudgeThresholds = {
    antiAiTone: options?.judgeHardFailAntiAi ?? judgeHardFailThreshold,
    factualAccuracy: options?.judgeHardFailFactual ?? judgeHardFailThreshold,
    characterLimit: options?.judgeHardFailCharacter ?? judgeHardFailThreshold,
    skipAB: options?.judgeSkipABThreshold ?? 0.6,
  };
  const batchedJudgeService = new BatchedJudgeService(llm, promptPort, maxTokensForRole('judge') * 2);
  const HOOK_TEMPERATURE = options?.temperatures?.hook ?? 0.95;
  const DRAFT_TEMPERATURE = options?.temperatures?.draft ?? 0.8;
  const REFINE_TEMPERATURE = options?.temperatures?.refine ?? 0.6;
  const hookCache = options?.hookCache ?? getActiveHookCache();

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

  const SOCIAL_NETWORKS: SocialNetwork[] = [
    SocialNetwork.X,
    SocialNetwork.THREADS,
    SocialNetwork.FACEBOOK,
    SocialNetwork.BLUESKY,
    SocialNetwork.MASTODON,
    SocialNetwork.TELEGRAM,
    SocialNetwork.LINKEDIN,
  ];

  // Step 1-3: linear nodes.
  // Cast to a StateGraph with N=string so we can build it incrementally in
  // per-network loops. LangGraph's builder types accumulate node-name literals
  // in a single chained expression; with a loop we widen N to string and keep
  // S/U typed. The nodes and edges are identical to the previous inline graph.
  let graph = new StateGraph(GenerationState) as StateGraph<
    typeof GenerationState,
    GenerationStateType,
    typeof GenerationState.Update,
    string
  >;
  graph = graph
    // Step 1: research_extract
    .addNode('research_extract', withProgress('research_extract', (s) => researchExtractNode(s, llm, promptPort)))
    // Step 2: hook_generation (3-5 variants)
    .addNode('hook_generation', withProgress('hook_generation', (s) => hookGenerationNode(s, llm, hookBank, promptPort, hookCache, HOOK_TEMPERATURE)))
    // Step 3: angle_per_network (assign hooks + angles)
    .addNode('angle_per_network', withProgress('angle_per_network', (s) => anglePerNetworkNode(s)));

  // Step 4-6.6: per-network parallel nodes (draft → critique → refine → judge → visual_concept → ab_variant)
  for (const network of SOCIAL_NETWORKS) {
    const lower = network.toLowerCase();
    graph = graph
      .addNode(`draft_${lower}`, withProgress(`draft_${lower}`, (s) => makeDraftNode(network, promptPort, DRAFT_TEMPERATURE)(s, llm)))
      .addNode(`critique_${lower}`, withProgress(`critique_${lower}`, (s) => makeCritiqueNode(network, promptPort)(s, llm)))
      .addNode(`refine_${lower}`, withProgress(`refine_${lower}`, (s) => makeRefineNode(network, promptPort, REFINE_TEMPERATURE)(s, llm)))
      .addNode(`judge_${lower}`, withProgress(`judge_${lower}`, (s) => makeJudgeNode(network, batchedJudgeService, judgeRefineThreshold, judgeThresholds)(s, llm)))
      .addNode(`visual_concept_${lower}`, withProgress(`visual_concept_${lower}`, (s) => makeVisualConceptNode(network)(s, visualService)))
      .addNode(`ab_variant_${lower}`, withProgress(`ab_variant_${lower}`, (s) => makeABVariantNode(network, judgeThresholds.skipAB)(s, abGenerator, abVariantService)));
  }

  // Step 7: save + HITL review
  graph = graph
    .addNode('save_to_db', withProgress('save_to_db', (s) => saveToDbNode(s, options?.getRecordedPromptLabels)))
    // Sprint I: HITL review node (no-op when humanReview=false)
    .addNode('human_review', withProgress('human_review', (s) => humanReviewNode(s)));

  // Edges: linear through step 3
  graph = graph
    .addEdge(START, 'research_extract')
    .addEdge('research_extract', 'hook_generation')
    .addEdge('hook_generation', 'angle_per_network');

  // Fan out / fan in: per network (draft → critique → refine → judge → visual_concept → ab_variant → human_review)
  for (const network of SOCIAL_NETWORKS) {
    const lower = network.toLowerCase();
    graph = graph
      .addEdge('angle_per_network', `draft_${lower}`)
      .addEdge(`draft_${lower}`, `critique_${lower}`)
      .addEdge(`critique_${lower}`, `refine_${lower}`)
      .addEdge(`refine_${lower}`, `judge_${lower}`)
      // Q8: Judge → refine (one retry when the post sounds like AI) | visual_concept.
      // The refine_* → judge_* edges above close the loop; judgeRetried guards
      // against infinite cycles (max ONE retry per network).
      .addConditionalEdges(`judge_${lower}`, routeAfterJudge(network), { refine: `refine_${lower}`, continue: `visual_concept_${lower}` })
      .addEdge(`visual_concept_${lower}`, `ab_variant_${lower}`)
      .addEdge(`ab_variant_${lower}`, 'human_review');
  }

  graph = graph
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
  targetNetworks: SocialNetwork | SocialNetwork[],
  brandVoice: string,
  humanReview = false,
  _language = 'en',
): GenerationStateType {
  const networks = Array.isArray(targetNetworks) ? targetNetworks : [targetNetworks];
  return {
    topic,
    targetNetworks: networks,
    brandVoice,
    // Generation is English-only regardless of the language argument.
    language: 'en',
    facts: [],
    hooks: [],
    results: {},
    model: '',
    posts: [],
    error: null,
    humanReview,
  };
}
