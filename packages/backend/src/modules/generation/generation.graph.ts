import { StateGraph, END, START, Annotation, interrupt } from '@langchain/langgraph';
import type { ILlmPort } from '../../domain/ports/llm.port.js';
import type { ContentTopic } from '@spa/shared';
import { SocialNetwork } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { buildBaitRewriteInstruction } from '../content-enhancements/engagement-bait.detector.js';
import type { HookPerformanceBank } from '../content-enhancements/hook-performance-bank.js';
import { classifyHookTechnique, type HookTechnique } from '../content-enhancements/hook-performance-bank.js';
import type { VisualConcept, VisualConceptService } from '../content-enhancements/visual-concept.service.js';
import type { ABVariantPair, ABVariantGenerator } from '../content-enhancements/ab-variant.generator.js';
import { pickContentStyle, getStylePromptGuidance, CONTENT_STYLES_BY_ID, type ContentStyle } from '../content-enhancements/content-style.rotation.js';
import { getSlopListForPrompt } from '../content-enhancements/slop-lexicon.js';
import { pickHumorMechanic, getHumorPromptGuidance, HUMOR_MECHANICS_BY_ID } from '../content-enhancements/humor-mechanics.js';
import { buildHumanizeInstruction } from '../content-enhancements/humanizer-gate.js';
import { getLanguageExamples } from '../content-enhancements/language-packs.js';
import type { IPromptPort, CompiledChatPrompt } from '../../domain/ports/prompt.port.js';
import { JUDGE_SYSTEM_PROMPT, JUDGE_USER_PROMPT_TEMPLATE } from './prompts/judge-prompt.js';

const logger = new Logger('GenerationGraph');

// Temperature overrides — read once at module load. Reasoning models ignore
// temperature by design, but these values are used for the non-reasoning chain.
const HOOK_TEMPERATURE = Number(process.env.GENERATION_TEMPERATURE_HOOK ?? 0.95);
const DRAFT_TEMPERATURE = Number(process.env.GENERATION_TEMPERATURE_DRAFT ?? 0.8);
const REFINE_TEMPERATURE = Number(process.env.GENERATION_TEMPERATURE_REFINE ?? 0.6);

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
}

/** Stage 2: LLM-as-a-Judge evaluation result (0.0-1.0 per criterion). */
export interface JudgeScores {
  anti_ai_tone: number;
  anti_ai_tone_reason: string;
  hook_strength: number;
  hook_strength_reason: string;
  factual_accuracy: number;
  factual_accuracy_reason: string;
  character_limit: number;
  character_limit_reason: string;
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
 * Per-network character limits.
 * CONSTITUTION §11.3: FB ~63k chars max, but for marketing ≤500.
 * We enforce the marketing limit (500) — long FB posts get low engagement.
 */
const NETWORK_LIMITS: Record<SocialNetwork, number> = {
  [SocialNetwork.X]: 280,
  [SocialNetwork.THREADS]: 500,
  [SocialNetwork.FACEBOOK]: 500, // §11.3: marketing ≤500
};

/**
 * Q9: Target-length guidance per network (2026 platform research).
 * "Stay within {limit}" makes the LLM FILL the limit; on Threads short
 * 1-2 sentence posts outperform essays, so we target well below the cap.
 */
const NETWORK_LENGTH_GUIDANCE: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: 'Max 280 characters. One idea. If it needs two ideas, cut one.',
  [SocialNetwork.THREADS]: 'Target 150-280 characters (short posts outperform essays on Threads). Hard cap 500.',
  [SocialNetwork.FACEBOOK]: 'Target 200-400 characters. Hard cap 500.',
};

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
  en: '',
  ru: ' Use natural conversational Russian. Use Cyrillic script.',
  uk: ' Use natural conversational Ukrainian — NOT Russian. Ukrainian has its own vocabulary (e.g. "дякую" not "спасибо", "так" not "да", "час" not "время"). Use Cyrillic script.',
  es: ' Use natural conversational Spanish. Use appropriate regional Spanish (neutral/international).',
  it: ' Use natural conversational Italian. Use standard Italian, not dialects.',
};

const NETWORK_TONE: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: 'Punchy, hook-first, confident. One idea per post. Can be sarcastic, bold, or deadpan. NO hashtags — X algorithm deprioritizes them and 3+ triggers spam filters. No filler.',
  [SocialNetwork.THREADS]: 'Narrative, storytelling, personal. Like texting a friend about something you noticed. Can be vulnerable, funny, or reflective. NO hashtags — Threads doesn\'t use hashtags for discovery.',
  [SocialNetwork.FACEBOOK]: 'Conversational, community-oriented. Relatable, warm, but not corny. End with a genuine question (not engagement bait). NO hashtags — Facebook algorithm treats them as spam signals.',
};

const NETWORK_ANGLE: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: 'bold take or counter-intuitive observation — max impact in 280 chars, make someone stop mid-scroll',
  [SocialNetwork.THREADS]: 'personal story or reflective observation — "I noticed something about..." energy, warmer, more context',
  [SocialNetwork.FACEBOOK]: 'relatable + discussion-starter — everyday life angle, "has anyone else noticed..." energy, invite genuine discussion',
};

/**
 * P2: Per-Network Persona — distinct voice variant per network audience.
 * Augments the shared brand-voice.md with network-specific persona traits.
 * The draft node concatenates `state.brandVoice` + this persona block in the
 * system prompt so each network speaks to its audience in the right register.
 */
const NETWORK_PERSONA: Record<SocialNetwork, string> = {
  [SocialNetwork.X]: `X PERSONA — "the one at the party who actually reads charts and has opinions about it":
- Voice: confident, a bit edgy, has opinions and isn't afraid of them. But also admits when they're wrong.
- Energy: main-character energy but not cringe. Would call out a bad astrology take. Would also admit their own takes are sometimes wrong.
- References: pop-culture astrology, sharp observations, personal stories about their own chart, the kind of hot take that gets quote-tweeted
- Sentence rhythm: short, punchy, one idea per post. Fragments are fine. Incomplete thoughts are fine.
- What they'd never do: write a thread that starts "🧵 Let me explain..." or use the word "narrative" or "discourse"
- What they'd do: text a friend "okay but actually though" at 1am about a transit
- Occasionally posts in all lowercase when the thought is casual — it reads more human`,
  [SocialNetwork.THREADS]: `THREADS PERSONA — "your friend who got into astrology last year and won't shut up about it (in a good way)":
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
- What they'd do: share a specific story about their week and how it connected to a transit, then stop without a neat conclusion`,
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
  promptPort?: IPromptPort,
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

  const fallback: CompiledChatPrompt = {
    systemPrompt: `You're the person at the party who actually knows astrology — not the vague "Mercury retrograde means communication issues" kind, but the "Mercury was at 24° Gemini when it stationed retrograde and that's conjunct your natal Mercury so yes it's personal" kind.

Extract 5-8 facts about the topic that would make someone stop scrolling and actually read.

Each fact must be:
- SPECIFIC. Not "Mars is energetic" but "Mars takes 687 days to orbit the Sun — almost 2 Earth years per Mars year."
- SURPRISING or COUNTERINTUITIVE. If everyone already knows it, it's not a fact, it's a cliché.
- VERIFIABLE. Real astronomical data, real astrological tradition. No made-up statistics.
- 1-2 sentences max. Punchy. No filler.
- Written as a statement, not a question.

BAD facts (vague, boring, AI-sounding):
- "Mercury retrograde affects communication."
- "The Moon influences emotions."
- "Saturn represents discipline."

GOOD facts (specific, surprising, human):
- "Saturn takes 29.5 years to orbit the Sun — so your Saturn return happens almost exactly once per Saturn year."
- "Your Moon sign changes every 2.5 days. That's why two people born on the same day can have completely different emotional wiring."
- "The Babylonians invented the zodiac 2,500 years ago, but they used 18 signs, not 12. The 12-sign system came later from the Greeks."

Return ONLY the facts, one per line, numbered 1-8. No preamble.`,
    userPrompt: `Topic: {topic}
Keywords: {keywords}
Category: {category}
Outline:
{outline}

Key facts:`,
  };

  const { systemPrompt, userPrompt } = promptPort
    ? await promptPort.getCompiledChat('research-extract', variables, fallback)
    : fallback;

  try {
    const response = await llm.generateChat(systemPrompt, userPrompt, { temperature: 0.7, role: 'facts' });
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
  hookBank?: HookPerformanceBank,
  promptPort?: IPromptPort,
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

  const variables = {
    brandVoice: state.brandVoice,
    topic: state.topic.topic,
    performanceGuidance,
    facts: state.facts.join(', '),
    keywords: state.topic.keywords.join(', '),
    slopList: getSlopListForPrompt(state.language || 'en'),
  };

  const fallback: CompiledChatPrompt = {
    systemPrompt: `You are a real person who knows astrology deeply and is about to post about it. You're not a "social media writer." You're someone with opinions, experiences, and a phone.

BRAND VOICE: {brandVoice}

Write 3-5 hooks (opening lines) for posts about "{topic}".

THE HOOK IS THE FIRST THING SOMEONE SEES WHILE SCROLLING AT 11PM.
It needs to make them stop. Not because it's "engaging" but because it's specific, weird, or uncomfortably relatable.

ANTI-AI RULES — CRITICAL:
- Do NOT start with "Did you know" or "Discover" or "Unlock" or "Explore" — those scream bot.
- BANNED words/phrases (AI tells for this language): {slopList}
- Do NOT write hooks that sound like a Wikipedia intro or a horoscope column.
- Do NOT use em dashes (—) — use periods, commas, or parentheses.
- DO write like someone who just had a thought at 2am and needs to share it.
- DO be specific, opinionated, sometimes weird. Bland = AI. Specific = human.
- DO include personal stakes — "I" not "you" in at least one hook. What does this mean for YOU?

Each hook MUST use a DIFFERENT technique:
  1. A provocative question that makes you pause (not rhetorical, genuinely unsettling — you don't know the answer)
  2. A bold claim that would start an argument at a dinner party
  3. A counter-intuitive observation — "everyone thinks X, but actually Y"
  4. (optional) A personal confession or story opener ("I didn't believe in X until..." or "I spent 3 hours on my chart last night and...")
  5. (optional) A dry fact delivered deadpan — no hype, just "here's the thing" energy

Vary the TONE across hooks: one sarcastic, one sincere, one deadpan, one curious, one slightly unhinged. If all hooks sound the same, you failed.

GOOD hooks (these sound human):
- "I've been staring at my Saturn return chart for 40 minutes and I think I need to lie down"
- "Nobody talks about how annoying Mercury in Virgo is for texting. Everything becomes a draft."
- "Hot take: your Moon sign matters more than your Sun sign and I will die on this hill"
- "Spent $200 on a birth chart reading. The first thing she said was 'so, your dad...' and I knew it was over"
- "The Sun takes 365 days. Your Moon sign changes every 2.5 days. And yet everyone leads with 'I'm a Leo'"

BAD hooks (these sound like AI):
- "Discover the hidden meaning behind your Moon sign"
- "Astrology can be a powerful tool for self-discovery"
- "Did you know that Saturn takes 29.5 years to orbit the Sun?"
- "Let's explore what Mercury retrograde really means for you"

Return ONLY the hooks, one per line, numbered 1-5. No quotes, no preamble.{performanceGuidance}`,
    userPrompt: `Topic: {topic}
Key facts: {facts}
Keywords: {keywords}

Hooks:`,
  };

  const { systemPrompt, userPrompt } = promptPort
    ? await promptPort.getCompiledChat('hook-generation', variables, fallback)
    : fallback;

  let response;
  try {
    response = await llm.generateChat(systemPrompt, userPrompt, { temperature: HOOK_TEMPERATURE, role: 'hook' });
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
function makeDraftNode(network: SocialNetwork, promptPort?: IPromptPort) {
  return async function draftNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    const charLimit = NETWORK_LIMITS[network];
    const tone = NETWORK_TONE[network];
    const persona = NETWORK_PERSONA[network];

    // Multilingual support — determine the language for this post
    const lang = state.language || 'en';
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
      persona,
      styleGuidance,
      humorGuidance,
      network,
      charLimit: String(charLimit),
      lengthGuidance: NETWORK_LENGTH_GUIDANCE[network],
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

    const fallback: CompiledChatPrompt = {
      systemPrompt: `You are a real person. Not a brand. Not a content creator. Not "an AI assistant." A real, flawed, opinionated human who happens to know astrology really well and is posting on their personal account.

You're not writing "content." You're writing the way you'd text a friend at 11pm about something that's been on your mind. Or the way you'd tweet a thought that hit you in the shower.

BRAND VOICE: {brandVoice}

{persona}
{styleGuidance}{humorGuidance}

Write a {network} post using the hook and angle provided. {lengthGuidance}

LANGUAGE: Write this post in {langName}.{langInstruction}
- Russian and Ukrainian are DIFFERENT languages. Do not mix them. Do not use Russian words in Ukrainian posts or vice versa.
- Use natural, native-speaker phrasing — not translated-sounding text. Use slang, colloquialisms, and informal expressions natural to that language.
- Do NOT use hashtags — they are deprioritized by all major platforms. Pure text only.{langExamples}

THE #1 RULE — SOUND HUMAN, NOT AI:
The biggest giveaway of AI text is "sterile certainty." AI never doubts itself, never shares a personal mess, never admits ignorance. Real humans do all of that constantly. Your posts must feel like they came from a person who:
- Has been wrong before and knows it
- Has specific memories, not generic "experiences"
- Changes their mind mid-sentence sometimes
- Has a body that gets tired, cold, hungry, restless
- Has opinions they can't fully justify but hold anyway
- Gets annoyed, excited, confused — not just "informed" and "empowering"

HOW TO SOUND HUMAN — CONCRETE TECHNIQUES:

1. VULNERABILITY — show doubt, imperfection, or a moment of being wrong:
   BAD: "Saturn return is a powerful time of transformation."
   GOOD: "I thought my Saturn return would be spiritual. Mostly I just cried in my car and changed jobs."

2. SPECIFIC SENSORY DETAILS — not abstractions. "Cold steering wheel at 2am" beats "difficult night."
   BAD: "Mercury retrograde affects communication."
   GOOD: "Sent three texts I regret during Mercury retrograde. All at 1am. All to my ex."

3. PERSONAL ANECDOTES — invent them. They don't need to be real, they need to FEEL real:
   BAD: "Many people find astrology helpful for self-reflection."
   GOOD: "My therapist asked why I keep checking Co-Star before our sessions. I didn't have a good answer."

4. CONVERSATIONAL IMPERFECTIONS — talk like a real person talks:
   - Start sentences with "And" or "But" or "Look" or "Honestly" or "Okay so"
   - Use parentheticals: "(and yes, I know how that sounds)"
   - Trail off sometimes: "I don't know, maybe that's just me but..."
   - Self-correct: "Well, not exactly — more like..."
   - Use "you know that feeling when..." (but only if it's genuinely specific)

5. VARIED RHYTHM — mix short punchy sentences with longer flowing ones:
   "Saturn takes 29.5 years. That's it. That's the whole Saturn return. And somehow it still wrecks you."

6. OPINIONS WITHOUT HEDGING — have a take, even an unpopular one:
   BAD: "Some people believe Mercury retrograde is challenging, while others see it as an opportunity."
   GOOD: "Mercury retrograde isn't real. I said it. The astronomy doesn't support it and I'm tired of pretending."

7. SHOW, DON'T TELL — don't say something is "powerful" or "transformative." Show the transformation:
   BAD: "New Moon in Aries is a powerful time for new beginnings."
   GOOD: "New Moon in Aries. I bought running shoes at 6am. I don't run. But Aries said GO so here we are."

8. BE MORE CREATIVE — take a risk. The safe, generic take is the AI take.
   - Start from an unexpected angle: the annoying part, the part nobody admits, the petty detail.
   - Use a weird metaphor: "Saturn return feels like finally reading the terms and conditions you signed at 21."
   - Include one line that makes you slightly nervous to post. If it feels too safe, rewrite it.
   - Don't summarize the topic — react to it. Have a real thought.

ANTI-AI RULES — CRITICAL (read these twice):
- BANNED words/phrases for this language (instant AI tells): {slopList}
- NEVER use em dashes (—) or en dashes (–). Use periods, commas, or parentheses instead.
- NEVER start with "Did you know" or a rhetorical question that answers itself.
- NEVER write a "hook → explanation → CTA" sandwich. That structure is a dead giveaway.
- NEVER end with a neat conclusion or summary. Real posts don't have conclusions. They just... stop.
- DO write like you're talking to one specific person, not "an audience."
- DO use contractions. DO use sentence fragments. DO start sentences with "And" or "But."
- STRUCTURE (burstiness): at least one sentence under 6 words. At least one over 20 (for longer posts). Never two consecutive sentences of similar length.
- DO be specific. "Mercury in Gemini at 24°" beats "planetary movements." "Crying in your car at 2am" beats "emotional moments."
- DO have an opinion. If the post could be written by ChatGPT with no personality, rewrite it.
- DO include at least one concrete, specific detail — a time, a place, a body sensation, an object.

TONE: Match the content style specified above. If it says sarcastic, be sarcastic. If serious, be serious. If playful, be playful. Do NOT default to "warm and informative" every time — that's the AI default and it's boring.

Do NOT include any URLs, links, or hashtags. Hashtags are deprioritized by X/Threads/Facebook algorithms and 3+ triggers spam filters. Posts should be pure text only.
Never use fear-mongering, absolute predictions, or medical/financial advice.
Never ask for likes, comments, shares, tags, or follows.

Return ONLY the post text. No preamble, no explanation, no "Here's your post:"`,
      userPrompt: `Topic: {topic}
Hook: {hook}
Angle: {angle}
Content style: {styleName} — {styleDescription}
Key facts: {facts}
Keywords: {keywords}
Tone: {tone}
Character limit: {charLimit}
Do NOT include any URLs or links in the post.

{outline}

Post text (in "{styleName}" style):`,
    };

    const { systemPrompt, userPrompt } = promptPort
      ? await promptPort.getCompiledChat('draft-post', variables, fallback)
      : fallback;

    try {
      const response = await llm.generateChat(systemPrompt, userPrompt, { temperature: DRAFT_TEMPERATURE, role: 'draft' });

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
function makeCritiqueNode(network: SocialNetwork, promptPort?: IPromptPort) {
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

    // Q6: Humanizer Gate — deterministic statistical scan (slop words,
    // em dashes, uniform sentence lengths, hashtags). Free, zero LLM tokens.
    const lang = state.language || 'en';
    const humanizeInstruction = buildHumanizeInstruction(netResult.draft, lang);
    const gateInstructions = [baitInstruction, humanizeInstruction].filter(Boolean).join('\n');

    const critiqueVariables = {
      network,
      charLimit: String(charLimit),
      draftLength: String(netResult.draft.length),
      angle: netResult.angle,
      draft: netResult.draft,
      baitInstruction: gateInstructions ? `\n${gateInstructions}\n` : '',
      slopList: getSlopListForPrompt(lang),
    };

    const critiqueFallback = `Critique this {network} post as if you're a picky editor who hates AI-sounding content.

Check these things:
1. Is it within {charLimit} characters? (current: {draftLength})
2. HUMAN CHECK — the most important: Does this sound like a real person wrote it at 11pm, or does it sound like ChatGPT? Look for:
   - "Sterile certainty" (no doubt, no vulnerability, no personal mess) = AI
   - Generic "experiences" instead of specific memories = AI
   - Perfect structure (hook → explanation → conclusion) = AI
   - No body, no senses, no objects, no time of day = AI
   - "Empowering" or "transformative" or "powerful" = AI tell words
   - Ends with a neat summary or conclusion = AI
3. Does it use any banned AI words/phrases for this language? ({slopList}) Any em dashes (—)?
4. No fear-mongering or absolute predictions?
5. Does the first line grab you, or is it generic?
6. No hashtags? (hashtags are deprioritized by algorithms and look spammy — posts should be pure text)
7. Does it match the angle: "{angle}"?
8. No engagement bait (asking for likes/comments/shares/tags/follows)?
9. Does it have OPINION and PERSONALITY, or is it bland and "informative"?
10. Does it have at least ONE concrete specific detail (a time, a place, a body sensation, an object)?

Draft:
"{draft}"

{baitInstruction}
Be honest. If it sounds like AI, say so. If it's bland, say so. If it has no personal voice, say so.

End your critique with EXACTLY these two lines (each on its own line):
SCORE: <number 1-10>
VERDICT: <GOOD or REVISE>

VERDICT: GOOD means "post as-is, no changes needed" — use it ONLY when there is nothing to fix.
VERDICT: REVISE means the post needs a rewrite based on your critique.
Where SCORE 10 = "I'd share this on my personal account and people would think I wrote it"; 7 = good enough to post; 5 = needs work; 3 = sounds like AI; 1 = unusable.`;

    const critiquePrompt = promptPort
      ? await promptPort.getCompiledText('critique-post', critiqueVariables, critiqueFallback)
      : critiqueFallback;

    try {
      const response = await llm.generateChat('', critiquePrompt, { temperature: 0.3, role: 'critique' });

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
function makeRefineNode(network: SocialNetwork, promptPort?: IPromptPort) {
  return async function refineNode(
    state: GenerationStateType,
    llm: ILlmPort,
  ): Promise<Partial<GenerationStateType>> {
    const netResult = state.results[network];
    if (!netResult) return {};

    // Sprint I: Skip if previous step failed
    if (netResult.error) return {};

    const lang = state.language || 'en';

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

    const charLimit = NETWORK_LIMITS[network];

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
    };

    const refineFallback = `Rewrite this {network} post based on the critique. Make it sound MORE HUMAN and LESS like AI.

Draft:
"{draft}"

Critique:
{critique}
{baitInstruction}
Character limit: {charLimit}

ANTI-AI RULES:
- Kill any of these words/phrases if they appear: {slopList}
- Remove ALL em dashes (—/–) — use periods, commas, or parentheses.
- If it sounds like a horoscope column, rewrite it to sound like a person talking.
- If it's bland and "informative," add opinion, personality, or a weird detail.
- If the structure is "hook → explanation → CTA sandwich," break it up.
- Use contractions. Use sentence fragments. Vary sentence length: at least one sentence under 6 words.
- Do NOT sanitize the personality out. Keep the opinion, keep the joke, keep the mess.
- Take a creative risk: include one specific, slightly odd detail or a take that feels honest rather than safe.
- If the rewrite feels like it could have been generated by any AI, rewrite it again until it feels like one person's voice.

Return ONLY the refined post text. No preamble.`;

    const refinePrompt = promptPort
      ? await promptPort.getCompiledText('refine-post', refineVariables, refineFallback)
      : refineFallback;

    try {
      const response = await llm.generateChat('', refinePrompt, { temperature: REFINE_TEMPERATURE, role: 'draft' });

      let refined = response.content.trim();

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
            `Cut this ${network} post to ${charLimit} characters or fewer. Keep the hook and the punchline. Remove filler, not substance.\n\nPost:\n"${refined}"\n\nReturn ONLY the shortened post (max ${charLimit} chars):`,
            { temperature: 0.3, role: 'draft' },
          );
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
function makeJudgeNode(network: SocialNetwork, promptPort?: IPromptPort, refineThreshold = 0.6) {
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

    const charLimit = NETWORK_LIMITS[network];
    const lang = state.language || 'en';
    const factsText = state.facts.length > 0 ? state.facts.map((f) => `- ${f}`).join('\n') : '- (no source facts provided)';

    const variables = {
      postText: content,
      network,
      charLimit: String(charLimit),
      // Q7: judge now receives the SOURCE FACTS (was judging accuracy blind)
      // and the language-specific slop list (was a third hardcoded EN list).
      facts: factsText,
      slopList: getSlopListForPrompt(lang),
    };

    const judgeFallback = {
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt: JUDGE_USER_PROMPT_TEMPLATE,
    };

    try {
      const systemPrompt = promptPort
        ? await promptPort.getCompiledChat('post-quality-judge', variables, judgeFallback)
        : {
            systemPrompt: JUDGE_SYSTEM_PROMPT.replace('{slopList}', variables.slopList),
            userPrompt: JUDGE_USER_PROMPT_TEMPLATE
              .replace('{postText}', content)
              .replace('{network}', network)
              .replace('{charLimit}', String(charLimit))
              .replace('{facts}', factsText),
          };

      // Q7: cap raised 300 → 700. The old cap + "enumerate first" instruction
      // meant the model either skipped its reasoning or truncated the JSON.
      const response = await llm.generateChat(systemPrompt.systemPrompt, systemPrompt.userPrompt, {
        temperature: 0.2,
        maxTokens: 700,
        role: 'judge',
      });

      // Parse JSON from response (tolerate markdown code fences)
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`judge_${network}: no JSON in response`);
        return {};
      }

      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (!isPartialJudgeScores(parsed)) {
        logger.warn(`judge_${network}: invalid JSON structure in judge response`);
        return {};
      }
      const judgeScores: JudgeScores = {
        anti_ai_tone: clamp01(parsed.anti_ai_tone),
        anti_ai_tone_reason: String(parsed.anti_ai_tone_reason ?? ''),
        hook_strength: clamp01(parsed.hook_strength),
        hook_strength_reason: String(parsed.hook_strength_reason ?? ''),
        factual_accuracy: clamp01(parsed.factual_accuracy),
        factual_accuracy_reason: String(parsed.factual_accuracy_reason ?? ''),
        character_limit: clamp01(parsed.character_limit),
        character_limit_reason: String(parsed.character_limit_reason ?? ''),
      };

      logger.debug(
        `judge_${network}: anti_ai=${judgeScores.anti_ai_tone} hook=${judgeScores.hook_strength} factual=${judgeScores.factual_accuracy} chars=${judgeScores.character_limit}`,
      );

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
          [network]: { ...netResult, judgeScores, pendingHumanizeRetry: false },
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

/** Clamp a value to [0, 1] range. */
function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * Type guard: validate that a parsed JSON value is structurally compatible
 * with `Partial<JudgeScores>`. Checks that score fields (if present) are
 * numbers and reason fields (if present) are strings. Rejects non-objects
 * and objects with wrong-typed known fields.
 */
function isPartialJudgeScores(value: unknown): value is Partial<JudgeScores> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const scoreFields = ['anti_ai_tone', 'hook_strength', 'factual_accuracy', 'character_limit'] as const;
  const reasonFields = [
    'anti_ai_tone_reason',
    'hook_strength_reason',
    'factual_accuracy_reason',
    'character_limit_reason',
  ] as const;
  for (const field of scoreFields) {
    if (field in v && typeof v[field] !== 'number') return false;
  }
  for (const field of reasonFields) {
    if (field in v && typeof v[field] !== 'string') return false;
  }
  return true;
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

    const content = stripHashtags(netResult.refined || netResult.draft);
    if (!content) continue;

    posts.push({
      network,
      content,
      hook: netResult.hook,
      angle: netResult.angle,
      model: state.model,
      qualityScore: netResult.qualityScore,
      judgeScores: netResult.judgeScores,
      hookTechnique: netResult.hookTechnique,
      contentStyleId: netResult.contentStyleId,
      humorMechanicId: netResult.humorMechanicId,
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
      if (netResult && reviewResult.edits[network]) {
        updatedResults[network] = {
          ...netResult,
          refined: reviewResult.edits[network]!,
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
  promptPort?: IPromptPort,
  options?: {
    /**
     * Q8: anti_ai_tone threshold below which the judge routes the post back
     * through refine once (env JUDGE_REFINE_THRESHOLD, default 0.6).
     * Set to 0 to disable the retry loop.
     */
    judgeRefineThreshold?: number;
  },
) {
  const logger = new Logger('GenerationGraph');
  const judgeRefineThreshold = options?.judgeRefineThreshold ?? 0.6;

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
    .addNode('research_extract', withProgress('research_extract', (s) => researchExtractNode(s, llm, promptPort)))
    // Step 2: hook_generation (3-5 variants)
    .addNode('hook_generation', withProgress('hook_generation', (s) => hookGenerationNode(s, llm, hookBank, promptPort)))
    // Step 3: angle_per_network (assign hooks + angles)
    .addNode('angle_per_network', withProgress('angle_per_network', (s) => anglePerNetworkNode(s)))
    // Step 4: parallel draft per network
    .addNode('draft_x', withProgress('draft_x', (s) => makeDraftNode(SocialNetwork.X, promptPort)(s, llm)))
    .addNode('draft_threads', withProgress('draft_threads', (s) => makeDraftNode(SocialNetwork.THREADS, promptPort)(s, llm)))
    .addNode('draft_facebook', withProgress('draft_facebook', (s) => makeDraftNode(SocialNetwork.FACEBOOK, promptPort)(s, llm)))
    // Step 5: parallel critique per network
    .addNode('critique_x', withProgress('critique_x', (s) => makeCritiqueNode(SocialNetwork.X, promptPort)(s, llm)))
    .addNode('critique_threads', withProgress('critique_threads', (s) => makeCritiqueNode(SocialNetwork.THREADS, promptPort)(s, llm)))
    .addNode('critique_facebook', withProgress('critique_facebook', (s) => makeCritiqueNode(SocialNetwork.FACEBOOK, promptPort)(s, llm)))
    // Step 6: parallel refine per network
    .addNode('refine_x', withProgress('refine_x', (s) => makeRefineNode(SocialNetwork.X, promptPort)(s, llm)))
    .addNode('refine_threads', withProgress('refine_threads', (s) => makeRefineNode(SocialNetwork.THREADS, promptPort)(s, llm)))
    .addNode('refine_facebook', withProgress('refine_facebook', (s) => makeRefineNode(SocialNetwork.FACEBOOK, promptPort)(s, llm)))
    // Stage 2: parallel judge per network (LLM-as-a-Judge quality evaluation)
    .addNode('judge_x', withProgress('judge_x', (s) => makeJudgeNode(SocialNetwork.X, promptPort, judgeRefineThreshold)(s, llm)))
    .addNode('judge_threads', withProgress('judge_threads', (s) => makeJudgeNode(SocialNetwork.THREADS, promptPort, judgeRefineThreshold)(s, llm)))
    .addNode('judge_facebook', withProgress('judge_facebook', (s) => makeJudgeNode(SocialNetwork.FACEBOOK, promptPort, judgeRefineThreshold)(s, llm)))
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
    // Stage 2: Refines → judge (per network, parallel)
    .addEdge('refine_x', 'judge_x')
    .addEdge('refine_threads', 'judge_threads')
    .addEdge('refine_facebook', 'judge_facebook')
    // Q8: Judge → refine (one retry when the post sounds like AI) | visual_concept.
    // The refine_* → judge_* edges above close the loop; judgeRetried guards
    // against infinite cycles (max ONE retry per network).
    .addConditionalEdges('judge_x', routeAfterJudge(SocialNetwork.X), { refine: 'refine_x', continue: 'visual_concept_x' })
    .addConditionalEdges('judge_threads', routeAfterJudge(SocialNetwork.THREADS), { refine: 'refine_threads', continue: 'visual_concept_threads' })
    .addConditionalEdges('judge_facebook', routeAfterJudge(SocialNetwork.FACEBOOK), { refine: 'refine_facebook', continue: 'visual_concept_facebook' })
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
  language = 'en',
): GenerationStateType {
  return {
    topic,
    targetNetworks,
    brandVoice,
    language,
    facts: [],
    hooks: [],
    results: {},
    model: '',
    posts: [],
    error: null,
    humanReview,
  };
}
