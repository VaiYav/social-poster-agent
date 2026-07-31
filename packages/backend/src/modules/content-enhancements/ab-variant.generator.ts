/**
 * P7: Emoji A/B Variant Generator.
 *
 * Generates two variants of each post for A/B testing:
 *   - Variant A: minimal emoji (0-1) — "clean" style
 *   - Variant B: rich emoji (2-3) — "expressive" style
 *
 * NOTE: hashtags are BANNED by brand policy (algorithms deprioritize them) —
 * variants differ by emoji/tone only. hashtagCount is kept as a telemetry
 * field to catch policy violations, not as a variant dimension.
 *
 * The posting pipeline posts variant A first, then variant B after a delay
 * (or to a different account). Engagement metrics are compared to learn
 * which style performs better per network/topic.
 *
 * Both variants are stored in Post.llmMetadata.abVariants:
 *   {
 *     a: { content, emojiCount, hashtagCount },
 *     b: { content, emojiCount, hashtagCount },
 *     winner: null  // filled after metrics are collected
 *   }
 *
 * Env-gated: only active when AB_VARIANTS_ENABLED=true.
 * When disabled, the graph produces a single refined post (original behavior).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ILlmPort } from '../../domain/ports/llm.port.js';
import { SocialNetwork } from '@prisma/client';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { NETWORK_LIMITS } from '../posts/network-limits.js';

export interface GenerateVariantsOptions {
  /** Topic string used for logging and prior-winner lookup. */
  topic?: string;
  /** Historical winner for this topic, if known. */
  priorWinner?: 'a' | 'b' | null;
}

/**
 * A single A/B variant.
 */
export interface PostVariant {
  /** Variant label — "a" (minimal) or "b" (expressive). */
  label: 'a' | 'b';
  /** Post text. */
  content: string;
  /** Number of emojis in the variant. */
  emojiCount: number;
  /** Number of hashtags in the variant. */
  hashtagCount: number;
}

/**
 * A/B variant pair for a post.
 */
export interface ABVariantPair {
  /** Minimal emoji variant. */
  a: PostVariant;
  /** Rich emoji variant. */
  b: PostVariant;
  /** Which variant won (null until metrics are collected). */
  winner: 'a' | 'b' | null;
}

@Injectable()
export class ABVariantGenerator {
  private readonly logger = new Logger(ABVariantGenerator.name);
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly llm?: ILlmPort,
  ) {
    this.enabled = parseBool(this.configService.get<string>('AB_VARIANTS_ENABLED', 'false'));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generate A/B variants for a post.
   *
   * Uses a single LLM call to produce both variants (batch prompt) for
   * efficiency. Falls back to deterministic emoji/hashtag adjustment when
   * the LLM is unavailable.
   *
   * @param content  Refined post text (the base for variants)
   * @param network  Target network (affects char limit)
   * @param options  Optional topic and prior winner hint
   * @returns Variant pair, or null when disabled
   */
  async generateVariants(
    content: string,
    network: SocialNetwork,
    options?: GenerateVariantsOptions,
  ): Promise<ABVariantPair | null> {
    if (!this.enabled) return null;

    if (this.llm) {
      try {
        return await this.llmGenerateVariants(content, network, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `P7: LLM variant generation failed for ${options?.topic ?? 'unknown'}: ${message} — using heuristic`,
        );
      }
    }

    // Heuristic fallback — adjust emoji/hashtag count deterministically
    return this.heuristicVariants(content, options);
  }

  /**
   * LLM-based variant generation — single batched call for both variants.
   */
  private async llmGenerateVariants(
    content: string,
    network: SocialNetwork,
    options?: GenerateVariantsOptions,
  ): Promise<ABVariantPair> {
    if (!this.llm) throw new Error('LLM unavailable');

    const charLimit = NETWORK_LIMITS[network];
    const priorWinner = options?.priorWinner;

    let winnerHint = '';
    if (priorWinner === 'a') {
      winnerHint = `\nPrior winner for this topic is the "Clean/Minimal" style. Lean the baseline slightly toward that style while still producing a valid variant B.`;
    } else if (priorWinner === 'b') {
      winnerHint = `\nPrior winner for this topic is the "Expressive/Rich" style. Lean the baseline slightly toward that style while still producing a valid variant A.`;
    }

    const systemPrompt = `You are a social media copywriter for My Zodiac AI, an AI-powered astrology platform.
Brand voice: mystical-but-grounded, accessible, human. Never use AI-cliché words (delve, unlock, discover, empowering, transformative).

Generate TWO variants of a post for A/B testing:

VARIANT A — "Clean/Minimal":
  - 0-1 emoji (use sparingly, only if it adds meaning)
  - NO hashtags (algorithms deprioritize them)
  - Professional, understated

VARIANT B — "Expressive/Rich":
  - 2-3 emojis (cosmic/astrology themed: ✨🌙🔮⭐💫🌟)
  - NO hashtags (algorithms deprioritize them)
  - Warmer, more visually engaging

Both variants must:
  - Stay under ${charLimit} characters
  - Preserve the core message, voice, and any joke — do NOT sanitize the personality out
  - NOT ask for likes/comments/shares (engagement bait)
  - NOT include hashtags, URLs, or links
  - Be distinct in style (not just emoji count)
  ${winnerHint}

Return ONLY the two variants in this format:
A: <variant A text>
B: <variant B text>`;

    const userPrompt = `Topic: ${options?.topic ?? 'general'}
Base post:
"${content}"

Generate A/B variants:`;

    const response = await this.llm.generateChat(systemPrompt, userPrompt, {
      temperature: 0.6,
    });

    // Parse "A: ..." and "B: ..." lines
    const lines = response.content.split('\n');
    let variantA = '';
    let variantB = '';
    let parsing = 'a';

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^a[:\)]\s*/i.test(trimmed)) {
        parsing = 'a';
        variantA += trimmed.replace(/^a[:\)]\s*/i, '') + '\n';
      } else if (/^b[:\)]\s*/i.test(trimmed)) {
        parsing = 'b';
        variantB += trimmed.replace(/^b[:\)]\s*/i, '') + '\n';
      } else if (trimmed) {
        if (parsing === 'a') variantA += trimmed + '\n';
        else variantB += trimmed + '\n';
      }
    }

    variantA = variantA.trim() || content;
    variantB = variantB.trim() || content;

    return {
      a: {
        label: 'a',
        content: variantA,
        emojiCount: countEmojis(variantA),
        hashtagCount: countHashtags(variantA),
      },
      b: {
        label: 'b',
        content: variantB,
        emojiCount: countEmojis(variantB),
        hashtagCount: countHashtags(variantB),
      },
      winner: null,
    };
  }

  /**
   * Heuristic fallback — adjusts emoji count without LLM.
   * Variant A: strips all emojis/hashtags (clean text only)
   * Variant B: adds 1-2 cosmic emojis, strips hashtags
   */
  private heuristicVariants(content: string, options?: GenerateVariantsOptions): ABVariantPair {
    const priorWinner = options?.priorWinner;

    // Variant A: strip to minimal — no emojis, no hashtags
    const variantA = content
      .replace(/(\s*#[\p{L}\p{N}_]+\s*)/gu, ' ') // remove all hashtags (Unicode-aware)
      .replace(/(\s*[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}✨🌙🔮⭐💫🌟]+\s*)/gu, ' ') // remove all emojis
      .replace(/\s+/g, ' ')
      .trim();

    // Variant B: add cosmic emojis if missing, strip hashtags
    const cosmicEmojis = [' ✨', ' 🌙', ' 🔮'];
    let variantB = content.replace(/(\s*#[\p{L}\p{N}_]+\s*)/gu, ' ').replace(/\s+/g, ' ').trim();

    const minBEmojis = priorWinner === 'b' ? 3 : 2;
    if (countEmojis(variantB) < minBEmojis) {
      // Add 1-2 emojis at natural break points (end of sentences)
      const sentences = variantB.split(/(?<=[.!?])\s/);
      const slots = Math.min(sentences.length - 1, minBEmojis - countEmojis(variantB));
      for (let i = 0; i < Math.max(slots, 1); i++) {
        const emojiIdx = i % cosmicEmojis.length;
        sentences[i] = sentences[i]!.trimEnd() + cosmicEmojis[emojiIdx]!;
      }
      variantB = sentences.join(' ');
    }

    return {
      a: {
        label: 'a',
        content: variantA,
        emojiCount: countEmojis(variantA),
        hashtagCount: countHashtags(variantA),
      },
      b: {
        label: 'b',
        content: variantB,
        emojiCount: countEmojis(variantB),
        hashtagCount: countHashtags(variantB),
      },
      winner: null,
    };
  }
}

/**
 * Count emojis in a string (Unicode emoji ranges).
 */
function countEmojis(text: string): number {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}]/gu;
  const matches = text.match(emojiRegex);
  return matches?.length ?? 0;
}

/**
 * Count hashtags in a string.
 */
function countHashtags(text: string): number {
  // 2.8.5: Unicode-aware regex so Cyrillic, Arabic, etc. hashtags are counted.
  const matches = text.match(/#[\p{L}\p{N}_]+/gu);
  return matches?.length ?? 0;
}
