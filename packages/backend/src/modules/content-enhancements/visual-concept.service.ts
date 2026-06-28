/**
 * P3: Visual Hook Cards — image concept generation for native image posts.
 *
 * Social algorithms (X, Threads, Facebook) boost posts with native images 2-3x.
 * This service generates an image prompt from a post's refined text, which an
 * image generation API (Flux, DALL-E, Recraft) can render into a visual.
 *
 * Two visual styles:
 *   1. "quote_card" — typography-focused, the post's hook on a cosmic gradient
 *      (reuses the existing F19 QuoteCardService for rendering)
 *   2. "aesthetic_photo" — mood image (moon, stars, crystals, nature) that
 *      complements the post without text
 *
 * The visual concept is stored in Post.llmMetadata.visualConcept and rendered
 * by the posting pipeline (image upload step in the poster).
 *
 * Env-gated: only active when VISUAL_CARDS_ENABLED=true.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ILlmPort } from '../../domain/ports/llm.port.js';
import { SocialNetwork } from '@prisma/client';
import { parseBool } from '../../infrastructure/config/parse-bool';

/**
 * Visual concept for a post — describes what image to generate/attach.
 */
export interface VisualConcept {
  /** Visual style — drives the rendering pipeline. */
  style: 'quote_card' | 'aesthetic_photo' | 'chart_visualization';
  /** Prompt for the image generation API (Flux/DALL-E/Recraft). */
  imagePrompt: string;
  /** The text to render on the image (for quote_card style). */
  textOverlay?: string;
  /** Background gradient colors (for quote_card style). */
  bgGradient?: [string, string];
  /** Which network this concept is for (affects aspect ratio). */
  network: SocialNetwork;
  /** Why this visual was chosen — for logging/debugging. */
  reasoning: string;
}

/**
 * Per-network image dimensions (aspect ratios).
 * X: 16:9 (1200x675) for in-feed images
 * Threads: 4:5 (1080x1350) for portrait
 * Facebook: 1.91:1 (1200x630) for link-style images
 */
const NETWORK_DIMENSIONS: Record<SocialNetwork, { width: number; height: number; ratio: string }> = {
  [SocialNetwork.X]: { width: 1200, height: 675, ratio: '16:9' },
  [SocialNetwork.THREADS]: { width: 1080, height: 1350, ratio: '4:5' },
  [SocialNetwork.FACEBOOK]: { width: 1200, height: 630, ratio: '1.91:1' },
};

/**
 * Cosmic gradient presets — match the My Zodiac AI "Cosmic Glass" aesthetic.
 */
const COSMIC_GRADIENTS: [string, string][] = [
  ['#1a1a2e', '#16213e'],   // deep night
  ['#2d1b4e', '#1a1a2e'],   // purple dusk
  ['#0f3460', '#16213e'],   // midnight blue
  ['#533483', '#0f3460'],   // cosmic purple
  ['#1a1a2e', '#533483'],   // nebula
];

@Injectable()
export class VisualConceptService {
  private readonly logger = new Logger(VisualConceptService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly llm?: ILlmPort,
  ) {
    this.enabled = parseBool(this.configService.get<string>('VISUAL_CARDS_ENABLED', 'false'));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generate a visual concept for a post.
   *
   * Uses the LLM to decide the best visual style based on the post content:
   *   - Educational/factual posts → quote_card (typography focus)
   *   - Mood/reflection posts → aesthetic_photo (atmospheric)
   *   - Chart/birth-chart posts → chart_visualization (natal wheel)
   *
   * Falls back to a deterministic quote_card when the LLM is unavailable.
   *
   * @param content  Refined post text
   * @param network  Target network (affects dimensions + style preference)
   * @param topic    Original topic (for context)
   * @returns Visual concept, or null when disabled
   */
  async generateConcept(
    content: string,
    network: SocialNetwork,
    topic: string,
  ): Promise<VisualConcept | null> {
    if (!this.enabled) return null;

    // Deterministic gradient selection based on content hash
    const gradientIdx = content.length % COSMIC_GRADIENTS.length;
    const bgGradient = COSMIC_GRADIENTS[gradientIdx]!;

    // Extract the hook (first line) for quote card text overlay
    const firstLine = content.split('\n')[0]?.trim() ?? content.slice(0, 80);

    // Try LLM-based style selection
    if (this.llm) {
      try {
        const concept = await this.llmStyleSelection(content, network, topic, bgGradient, firstLine);
        if (concept) return concept;
      } catch (err) {
        this.logger.debug(`P3: LLM style selection failed: ${(err as Error).message} — using fallback`);
      }
    }

    // Fallback: deterministic quote_card
    return {
      style: 'quote_card',
      imagePrompt: this.buildQuoteCardPrompt(firstLine, bgGradient, network),
      textOverlay: firstLine,
      bgGradient,
      network,
      reasoning: 'Fallback: quote_card style (LLM unavailable)',
    };
  }

  /**
   * LLM-based visual style selection.
   * Asks the LLM to pick the best visual style for the post content.
   */
  private async llmStyleSelection(
    content: string,
    network: SocialNetwork,
    topic: string,
    bgGradient: [string, string],
    firstLine: string,
  ): Promise<VisualConcept | null> {
    if (!this.llm) return null;

    const systemPrompt = `You are a visual content strategist for My Zodiac AI, an AI-powered astrology platform.
Choose the best visual style for a social media post image.

Return ONLY a JSON object (no markdown, no code fences):
{
  "style": "quote_card" | "aesthetic_photo" | "chart_visualization",
  "imagePrompt": "detailed prompt for an image generation API (Flux/DALL-E)",
  "reasoning": "one sentence explaining the choice"
}

Style guidelines:
- "quote_card": typography-focused, the hook text on a cosmic gradient. Best for bold statements, facts, counter-intuitive observations.
- "aesthetic_photo": atmospheric mood image (moon, stars, crystals, nature, cosmic scenes). Best for reflective, emotional, wellness posts. NO text overlay.
- "chart_visualization": natal wheel or astrological chart diagram. Best for educational posts about birth charts, aspects, houses.

Image prompt rules:
- For quote_card: describe the gradient, typography style, and layout
- For aesthetic_photo: describe the scene, lighting, mood, composition. No text in image.
- For chart_visualization: describe the chart type, elements, and aesthetic
- All styles: cosmic, mystical, elegant, high-quality, professional
- Aspect ratio: ${NETWORK_DIMENSIONS[network]!.ratio}`;

    const userPrompt = `Post content: "${content}"
Topic: ${topic}
Network: ${network}
First line (for text overlay): "${firstLine}"

Choose the visual style:`;

    const response = await this.llm.generateChat(systemPrompt, userPrompt, {
      temperature: 0.4,
    });

    const jsonStr = response.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as {
      style?: string;
      imagePrompt?: string;
      reasoning?: string;
    };

    const style = (
      ['quote_card', 'aesthetic_photo', 'chart_visualization'].includes(parsed.style ?? '')
        ? parsed.style
        : 'quote_card'
    ) as VisualConcept['style'];

    return {
      style,
      imagePrompt: String(parsed.imagePrompt ?? this.buildQuoteCardPrompt(firstLine, bgGradient, network)),
      textOverlay: style === 'quote_card' ? firstLine : undefined,
      bgGradient,
      network,
      reasoning: String(parsed.reasoning ?? 'LLM-selected style'),
    };
  }

  /**
   * Build a deterministic quote card prompt (fallback).
   */
  private buildQuoteCardPrompt(
    text: string,
    gradient: [string, string],
    network: SocialNetwork,
  ): string {
    const dims = NETWORK_DIMENSIONS[network]!;
    return `Cosmic gradient background (${gradient[0]} to ${gradient[1]}), minimalist white typography centered, quote: "${text}", elegant serif font, subtle starfield texture, ${dims.ratio} aspect ratio, professional social media graphic`;
  }

  /**
   * Get the recommended image dimensions for a network.
   */
  getDimensions(network: SocialNetwork): { width: number; height: number } {
    return NETWORK_DIMENSIONS[network]!;
  }
}
