/**
 * Q6: Deterministic Humanizer Gate — zero-LLM-token "pre-judge".
 *
 * Complements the engagement-bait detector: scans a draft for the measurable
 * statistical tells that AI detectors (and readers) key on:
 *   - slop words/phrases (multilingual, via slop-lexicon)
 *   - em dashes (— / –): the #1 modern-LLM punctuation tell (~8% of sentences)
 *   - uniform sentence lengths (low burstiness — the "AI shape")
 *   - hashtags (banned by brand policy)
 *   - the hook → explanation → CTA-question sandwich
 *
 * Findings are rendered into an explicit rewrite instruction and injected
 * into the critique/refine prompts, exactly like buildBaitRewriteInstruction.
 * Detection is regex/statistics — fast, deterministic, free.
 */

import { scanSlop, type SlopMatch } from './slop-lexicon.js';

export interface HumanizationReport {
  slopMatches: SlopMatch[];
  emDashCount: number;
  sentenceCount: number;
  /** Coefficient of variation (stdev/mean) of sentence word counts. */
  burstiness: number;
  /** True when ≥3 sentences and their lengths are suspiciously uniform. */
  uniformSentences: boolean;
  hashtagCount: number;
  /** Human-readable flags — empty means the text passes the gate. */
  flags: string[];
}

/** Sentences shorter than this (in words) are ignored for burstiness stats. */
const MIN_SENTENCE_WORDS = 1;
/** CV below this with ≥3 sentences = "AI shape" (uniform rhythm). */
const UNIFORMITY_CV_THRESHOLD = 0.35;

/**
 * Analyze a draft for statistical AI tells.
 */
export function analyzeHumanization(text: string, language: string): HumanizationReport {
  const slopMatches = scanSlop(text, language);

  const emDashCount = (text.match(/[—–]/g) ?? []).length;

  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const lengths = sentences
    .map((s) => s.split(/\s+/).filter(Boolean).length)
    .filter((n) => n >= MIN_SENTENCE_WORDS);

  let burstiness = 1; // single/no sentence → treated as fine
  if (lengths.length >= 2) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    burstiness = mean > 0 ? Math.sqrt(variance) / mean : 1;
  }
  const uniformSentences = lengths.length >= 3 && burstiness < UNIFORMITY_CV_THRESHOLD;

  const hashtagCount = (text.match(/#[\wЀ-ӿԀ-ԯ]+/g) ?? []).length;

  const flags: string[] = [];
  if (slopMatches.length > 0) {
    flags.push(`AI slop words/phrases found: ${slopMatches.map((m) => `"${m.term}"`).join(', ')}`);
  }
  if (emDashCount > 0) {
    flags.push(`${emDashCount} em/en dash(es) (—/–) — the #1 AI punctuation tell`);
  }
  if (uniformSentences) {
    flags.push('sentence lengths are uniform (low burstiness — "AI rhythm")');
  }
  if (hashtagCount > 0) {
    flags.push(`${hashtagCount} hashtag(s) — banned by brand policy`);
  }

  return { slopMatches, emDashCount, sentenceCount: sentences.length, burstiness, uniformSentences, hashtagCount, flags };
}

/**
 * Build an explicit rewrite instruction for the critique/refine prompts.
 * Returns null when the text passes the gate (no injection needed).
 */
export function buildHumanizeInstruction(text: string, language: string): string | null {
  const report = analyzeHumanization(text, language);
  if (report.flags.length === 0) return null;

  const fixes: string[] = [];
  if (report.slopMatches.length > 0) {
    fixes.push(
      `Replace or delete these AI-tell words/phrases: ${report.slopMatches.map((m) => `"${m.term}"`).join(', ')}. Use plain, specific language instead.`,
    );
  }
  if (report.emDashCount > 0) {
    fixes.push('Remove ALL em/en dashes (—/–). Use periods, commas, or parentheses.');
  }
  if (report.uniformSentences) {
    fixes.push('Break the rhythm: make at least one sentence under 6 words and one over 20. Fragments are allowed.');
  }
  if (report.hashtagCount > 0) {
    fixes.push('Delete all hashtags — posts are pure text.');
  }

  return `HUMANIZER GATE — deterministic scan flagged this draft (${report.flags.join('; ')}). Required fixes:\n- ${fixes.join('\n- ')}`;
}
