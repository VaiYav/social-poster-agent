/**
 * P5: Trend-Jacking Guardrail.
 *
 * Two-layer safety filter for trending topics before they enter generation:
 *
 *   Layer 1 — Deterministic keyword blocklist (free, instant).
 *     Rejects topics that contain scandal/drama/political/medical/violence
 *     keywords. These never align with the brand voice
 *     (grounded, empowering, no controversy).
 *
 *   Layer 2 — LLM opportunity scoring (paid, ~1 call per topic).
 *     For topics that pass layer 1, asks the LLM to evaluate:
 *       - Is there a safe brand/domain angle?
 *       - How strong is the opportunity (1-10)?
 *       - What angle to use?
 *     Rejects topics with score < 4 or no safe angle.
 *
 * The guardrail runs in GenerationService before passing a trending topic to
 * the LangGraph workflow. Non-trending topics (briefs, articles) skip the
 * guardrail — they are already brand-safe (CAP pipeline vetted them).
 */

import type { ILlmPort } from '../../domain/ports/llm.port.js';

/**
 * Result of the trend-jacking guardrail check.
 */
export interface TrendGuardrailResult {
  /** true = safe to use, false = reject this topic */
  safe: boolean;
  /** 1-10 opportunity score (higher = better fit). 0 when blocked by layer 1. */
  opportunityScore: number;
  /** Suggested angle for the LLM to use. Empty when blocked. */
  suggestedAngle: string;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Which layer made the decision: 'blocklist' | 'llm' | 'not_trending' */
  decidedBy: 'blocklist' | 'llm' | 'not_trending';
}

/**
 * Layer 1 — keyword blocklist.
 * Topics containing any of these (case-insensitive substring) are rejected
 * without an LLM call. Covers brand-unsafe territory.
 */
const BLOCKLIST_KEYWORDS: readonly string[] = [
  // Scandal / drama
  'scandal', 'drama', 'controversy', 'controversial', 'exposed', 'exposé',
  'lawsuit', 'sued', 'arrested', 'charged', 'crime', 'criminal', 'victim',
  'abuse', 'assault', 'harassment', 'allegation', 'accused',
  // Death / violence
  'dead', 'death', 'killed', 'murder', 'shooting', 'attack', 'bombing',
  'war', 'casualt', 'fatal', 'tragedy', 'disaster', 'massacre',
  // Politics
  'election', 'politician', 'political', 'congress', 'senate', 'president',
  'parliament', 'democrat', 'republican', 'tory', 'labour', 'putin', 'trump',
  'biden', 'macron', 'netanyahu', 'zelensky', 'regime', 'coup',
  // Medical claims (brand voice forbids medical advice)
  'cancer', 'tumor', 'tumour', 'disease', 'pandemic', 'covid', 'vaccine',
  'overdose', 'addiction', 'depression', 'suicide', 'mental illness',
  // Hate / discrimination
  'racist', 'racism', 'sexist', 'sexism', 'homophob', 'transphob', 'islamophob',
  'antisemit', 'nazi', 'fascist', 'white supremacist',
  // Celebrity gossip (low-value, off-brand)
  'divorce', 'breakup', 'cheating', 'affair', 'leaked', 'nude', 'onlyfans',
];

/**
 * Minimum opportunity score to accept a trending topic (layer 2).
 * Below this, the topic is rejected even if it passed the blocklist.
 */
const MIN_OPPORTUNITY_SCORE = 4;

/**
 * Check if a topic is a trending source (vs. brief/article/create_run).
 * Only trending topics go through the guardrail — other sources are already
 * brand-safe (vetted by the CAP pipeline).
 *
 * Note: trending topics from F22 have `sourceType: 'topic'` (not 'trending')
 * with a path like "trending/google_trends+x_trends" — see generation.service.ts
 * getTrendingTopics(). The path prefix is the reliable identifier.
 */
export function isTrendingSource(sourceType: string, path: string): boolean {
  return /(^|\/)trending\//.test(path ?? '');
}

/**
 * Keywords matched as a prefix/stem (e.g. "casualt" → casualty/casualties), not as a
 * whole word. Everything else is matched on word boundaries so short words like "war"
 * no longer false-positive inside "forward"/"warm"/"reward" (B11).
 */
const STEM_KEYWORDS: ReadonlySet<string> = new Set([
  'casualt', 'homophob', 'transphob', 'islamophob', 'antisemit',
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Precompiled matchers: leading word boundary always; trailing boundary only when the
 * keyword ends in an ASCII word char and is not a stem (so phrases and stems still match,
 * but "war" stops matching inside "forward").
 */
const BLOCKLIST_MATCHERS: readonly RegExp[] = BLOCKLIST_KEYWORDS.map((kw) => {
  const trailing = !STEM_KEYWORDS.has(kw) && /[a-z0-9]$/i.test(kw);
  return new RegExp(`\\b${escapeRegExp(kw)}${trailing ? '\\b' : ''}`, 'i');
});

/**
 * Layer 1 — deterministic blocklist check (word-boundary aware, B11).
 * Returns true if the topic contains a blocked keyword.
 */
export function isBlocklisted(topic: string): boolean {
  for (const re of BLOCKLIST_MATCHERS) {
    if (re.test(topic)) {
      return true;
    }
  }
  return false;
}

/**
 * Layer 2 — LLM opportunity scoring.
 * Asks the LLM to evaluate whether a trending topic has a safe brand/domain
 * angle and how strong the opportunity is.
 *
 * Returns a structured result. On LLM failure, defaults to "safe with low
 * score" — graceful degradation (we don't block generation on LLM errors).
 */
export async function llmOpportunityScore(
  topic: string,
  llm: ILlmPort,
): Promise<TrendGuardrailResult> {
  const systemPrompt = `You are a brand-safety evaluator for a social media brand.
Brand voice: grounded, accessible, empowering. No controversy, no fear-mongering, no medical/financial advice.

Evaluate whether a trending topic can be safely used for a social media post for the configured domain.

Return ONLY a JSON object (no markdown, no code fences):
{
  "safe": true | false,
  "opportunityScore": 1-10,
  "suggestedAngle": "one sentence describing a brand- or domain-relevant angle",
  "reason": "one sentence explaining the decision"
}

Rules:
- safe=true only if there is a genuine brand/domain angle that fits the brand voice
- opportunityScore: 1-3 = weak fit, 4-6 = decent, 7-10 = strong fit
- Reject (safe=false) if: the topic is scandalous, political, medical, violent, or has no connection to the brand's domain
- Accept (safe=true) if: the topic relates to the brand's domain and audience interests`;

  const userPrompt = `Trending topic: "${topic}"

Evaluate:`;

  try {
    const response = await llm.generateChat(systemPrompt, userPrompt, {
      temperature: 0.2,
    });

    const jsonStr = response.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as {
      safe?: boolean;
      opportunityScore?: number;
      suggestedAngle?: string;
      reason?: string;
    };

    return {
      safe: Boolean(parsed.safe),
      opportunityScore: Math.max(0, Math.min(10, Number(parsed.opportunityScore) || 0)),
      suggestedAngle: String(parsed.suggestedAngle ?? ''),
      reason: String(parsed.reason ?? 'LLM evaluation completed'),
      decidedBy: 'llm',
    };
  } catch (err) {
    return {
      safe: false,
      opportunityScore: 0,
      suggestedAngle: '',
      reason: `LLM evaluation failed (${(err as Error).message}) — failing closed (topic rejected)`,
      decidedBy: 'llm',
    };
  }
}

/**
 * Run the full trend-jacking guardrail on a topic.
 *
 * Non-trending topics bypass the guardrail entirely (return safe=true).
 * Trending topics go through layer 1 (blocklist) then layer 2 (LLM score).
 *
 * @param topic       Topic text
 * @param sourceType  Content source type ('brief' | 'article' | 'topic' | 'create_run' | 'trending')
 * @param path        Content source path
 * @param llm         LLM port for layer 2 scoring
 * @returns Guardrail result
 */
export async function checkTrendSafety(
  topic: string,
  sourceType: string,
  path: string,
  llm: ILlmPort,
): Promise<TrendGuardrailResult> {
  if (!isTrendingSource(sourceType, path)) {
    return {
      safe: true,
      opportunityScore: 10,
      suggestedAngle: '',
      reason: 'Non-trending source — already brand-safe (CAP-vetted)',
      decidedBy: 'not_trending',
    };
  }

  if (isBlocklisted(topic)) {
    return {
      safe: false,
      opportunityScore: 0,
      suggestedAngle: '',
      reason: `Blocklisted keyword detected in topic — brand-unsafe territory`,
      decidedBy: 'blocklist',
    };
  }

  const llmResult = await llmOpportunityScore(topic, llm);

  if (llmResult.safe && llmResult.opportunityScore < MIN_OPPORTUNITY_SCORE) {
    return {
      ...llmResult,
      safe: false,
      reason: `Opportunity score ${llmResult.opportunityScore} < minimum ${MIN_OPPORTUNITY_SCORE} — weak fit`,
    };
  }

  return llmResult;
}
