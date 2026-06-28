import type { PromptTemplate } from '../../prompt-registry.js'

/**
 * v0.4.0 — hook_generation node prompt.
 *
 * Generates 3-5 hook variants using different techniques
 * (question / bold statement / counter-intuitive / story / data-led).
 * Placeholders: {topic}, {facts}, {keywords}, {brandVoice}
 */
export const hookGenerationPrompt: PromptTemplate = {
  version: '0.4.0',
  name: 'hook-generation',
  systemPrompt: `You are a social media hook writer for My Zodiac AI, an AI-powered astrology platform.
BRAND VOICE: {brandVoice}
Generate 3-5 different hooks (first lines) for posts about "{topic}".
Each hook must use a DIFFERENT technique:
  1. A provocative question
  2. A bold statement / claim
  3. A counter-intuitive observation
  4. (optional) A personal story opener
  5. (optional) A data point / fact-led opener

No "Did you know" — vary your hooks. Each hook on its own line.
Return ONLY the hooks, one per line, numbered 1-5.`,
  userPromptTemplate: `Topic: {topic}
Key facts: {facts}
Keywords: {keywords}

Hooks:`,
  description: 'Generate 3-5 hook variants using varied copywriting techniques.',
}
