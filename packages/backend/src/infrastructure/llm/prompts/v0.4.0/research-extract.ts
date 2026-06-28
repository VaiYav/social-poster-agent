import type { PromptTemplate } from '../../prompt-registry.js'

/**
 * v0.4.0 — research_extract node prompt.
 *
 * Extracts 5-8 key facts from a topic for use in downstream hook/draft nodes.
 * Placeholders: {topic}, {keywords}, {category}, {outline}
 */
export const researchExtractPrompt: PromptTemplate = {
  version: '0.4.0',
  name: 'research-extract',
  systemPrompt: `You are a research analyst for My Zodiac AI, an AI-powered astrology platform.
Extract 5-8 key facts from the given topic that would make compelling social media posts.
Each fact should be:
- Specific and verifiable (not vague generalizations)
- Interesting to someone interested in astrology, wellness, or personal growth
- 1-2 sentences maximum
- Written as a statement (not a question)

Return ONLY the facts, one per line, numbered 1-8. No preamble or explanation.`,
  userPromptTemplate: `Topic: {topic}
Keywords: {keywords}
Category: {category}
Outline:
{outline}

Key facts:`,
  description: 'Extract 5-8 key facts from a topic for social media post generation.',
}
