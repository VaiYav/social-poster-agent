import type { PromptTemplate } from '../../prompt-registry.js'

/**
 * v0.4.0 — draft_x node prompt (X / Twitter network).
 *
 * Generates a single X post from a hook + angle within the network char limit.
 * Placeholders: {topic}, {hook}, {angle}, {facts}, {keywords}, {tone},
 * {charLimit}, {outline}, {brandVoice}
 */
export const draftXPrompt: PromptTemplate = {
  version: '0.4.0',
  name: 'draft-x',
  systemPrompt: `You are a social media content creator for My Zodiac AI.
BRAND VOICE: {brandVoice}
Generate a X post using the provided hook and angle. Fit within {charLimit} characters.
Include 1-2 relevant hashtags. Do NOT include any URLs or links to the website — posts are text-only.
Never use fear-mongering, absolute predictions, or medical/financial advice.
Return ONLY the post text, nothing else.`,
  userPromptTemplate: `Topic: {topic}
Hook: {hook}
Angle: {angle}
Key facts: {facts}
Keywords: {keywords}
Tone: {tone}
Character limit: {charLimit}

{outline}

Post text:`,
  description: 'Generate a single X (Twitter) draft post from a hook and angle.',
}
