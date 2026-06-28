/**
 * P7: Emoji/Hashtag A/B Variant Generator.
 *
 * Generates two variants of each post for A/B testing:
 *   - Variant A: minimal emoji (0-1), 1 hashtag — "clean" style
 *   - Variant B: rich emoji (2-3), 2-3 hashtags — "expressive" style
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

/** Per-network character limits (mirrors generation.graph NETWORK_LIMITS). */
const NETWORK_LIMITS: Record<SocialNetwork, number> = {
  [SocialNetwork.X]: 280,
  [SocialNetwork.THREADS]: 500,
  [SocialNetwork.FACEBOOK]: 500,
};

@Injectable()
export class ABVariantGenerator {
  private readonly logger = new Logger(ABVariantGenerator.name);
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly llm?: ILlmPort,
  ) {
    this.enabled = this.configService.get<string>('AB_VARIANTS_ENABLED', 'false') === 'true';
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
   * @returns Variant pair, or null when disabled
   */
  async generateVariants(
    content: string,
    network: SocialNetwork,
  ): Promise<ABVariantPair | null> {
    if (!this.enabled) return null;

    if (this.llm) {
      try {
        return await this.llmGenerateVariants(content, network);
      } catch (err) {
        this.logger.debug(`P7: LLM variant generation failed: ${(err as Error).message} — using heuristic`);
      }
    }

    // Heuristic fallback — adjust emoji/hashtag count deterministically
    return this.heuristicVariants(content);
  }

  /**
   * LLM-based variant generation — single batched call for both variants.
   */
  private async llmGenerateVariants(
    content: string,
    network: SocialNetwork,
  ): Promise<ABVariantPair> {
    if (!this.llm) throw new Error('LLM unavailable');

    const charLimit = NETWORK_LIMITS[network]!;

    const systemPrompt = `You are a social media copywriter for My Zodiac AI, an AI-powered astrology platform.
Brand voice: mystical-but-grounded, accessible, empowering.

Generate TWO variants of a post for A/B testing:

VARIANT A — "Clean/Minimal":
  - 0-1 emoji (use sparingly, only if it adds meaning)
  - 1 hashtag
  - Professional, understated

VARIANT B — "Expressive/Rich":
  - 2-3 emojis (cosmic/astrology themed: ✨🌙🔮⭐💫🌟)
  - 2-3 hashtags
  - Warmer, more visually engaging

Both variants must:
  - Stay under ${charLimit} characters
  - Preserve the core message and CTA
  - NOT ask for likes/comments/shares (engagement bait)
  - Be distinct in style (not just emoji count)

Return ONLY the two variants in this format:
A: <variant A text>
B: <variant B text>`;

    const userPrompt = `Base post:
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
   * Heuristic fallback — adjusts emoji/hashtag count without LLM.
   * Variant A: strips extra emojis/hashtags (keeps max 1 each)
   * Variant B: adds 1-2 cosmic emojis + 1 hashtag from the content
   */
  private heuristicVariants(content: string): ABVariantPair {
    // Variant A: strip to minimal
    const variantA = content
      .replace(/(\s*[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}✨🌙🔮⭐💫🌟]+\s*)/gu, ' ')
      .replace(/(\s*#[a-zA-Z0-9_]+\s*)/g, (match, _p1, offset, full) => {
        // Keep only the first hashtag
        const before = full.slice(0, offset);
        return before.includes('#') ? '' : match;
      })
      .replace(/\s+/g, ' ')
      .trim();

    // Variant B: add cosmic emojis if missing
    const cosmicEmojis = [' ✨', ' 🌙', ' 🔮'];
    let variantB = content;
    if (countEmojis(variantB) < 2) {
      // Add 1-2 emojis at natural break points (end of sentences)
      const sentences = variantB.split(/(?<=[.!?])\s/);
      for (let i = 0; i < Math.min(sentences.length - 1, 2); i++) {
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
  const matches = text.match(/#[a-zA-Z0-9_]+/g);
  return matches?.length ?? 0;
}
