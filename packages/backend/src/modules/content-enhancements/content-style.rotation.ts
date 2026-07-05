/**
 * Advanced Content Style Rotation System
 *
 * Prevents AI-generated content from looking uniform and detectable.
 * Each generation run picks a different "style" so posts vary in:
 *   - Format (list, story, hot-take, meme, poem, etc.)
 *   - Tone (playful, mysterious, educational, sassy, vulnerable)
 *   - Structure (one-liner, thread, question-led, myth-bust)
 *   - Emoji usage (none, minimal, thematic, meme-style)
 *   - Punctuation (casual, formal, dramatic pauses)
 *
 * The rotation is seeded by date + network so the same day gets
 * a consistent style, but different days get different styles.
 */

import { SocialNetwork } from '@prisma/client';

export type ContentStyle = {
  id: string;
  name: string;
  description: string;
  promptGuidance: string;
  example: string;
  worksForShort: boolean;
  worksForLong: boolean;
  /**
   * Q5: Whether the humor-mechanics layer may be applied on top of this style.
   * Serious/poetic styles (mystical_poem, ancient_wisdom, tiny_lesson) skip
   * humor entirely — forcing jokes into them produces tonal whiplash.
   */
  humorCompatible: boolean;
};

export const CONTENT_STYLES: ContentStyle[] = [
  {
    id: 'hot_take',
    name: 'Hot Take',
    description: 'Bold, controversial opinion that makes people stop scrolling',
    promptGuidance: [
      'Write this as a BOLD HOT TAKE — a provocative opinion that challenges conventional astrology wisdom.',
      '- Start with a controversial claim (not a question)',
      '- Use confident, slightly sassy language',
      '- No hedging ("maybe", "might", "could") — own the take',
      '- Keep it punchy and scroll-stopping',
      '- Example vibe: "Your sun sign is the least interesting thing about your chart. Fight me."',
    ].join('\n'),
    example: 'Your sun sign is the least interesting thing about your chart. Your Venus placement? That is where the tea is. \u2615',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'story_time',
    name: 'Story Time',
    description: 'Personal anecdote, vulnerable and relatable',
    promptGuidance: [
      'Write this as a PERSONAL STORY — like telling a friend about something that happened to you.',
      '- Start with "I" or a specific moment',
      '- Include a small personal detail (time, feeling, observation)',
      '- Make it feel like a real person talking, not a brand',
      '- Vulnerable, warm, conversational',
      '- Example vibe: "Last Tuesday at 3am I was staring at my chart and finally understood why..."',
    ].join('\n'),
    example: 'Last Tuesday at 3am I finally understood why I keep attracting Scorpios. It was never them — it was my 8th house Venus doing the fishing. \uD83C\uDFA3',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'myth_buster',
    name: 'Myth Buster',
    description: 'Debunk a common astrology misconception',
    promptGuidance: [
      'Write this as a MYTH BUSTER — correct a common misconception about astrology.',
      '- Start with "Contrary to..." or "Everyone says... but actually..."',
      '- Be educational but not preachy',
      '- Include the real truth with a specific detail',
      '- Slightly smug "I know something you do not" energy',
      '- Example vibe: "Mercury retrograde does not actually cause chaos. Here is what really happens..."',
    ].join('\n'),
    example: 'Everyone blames Mercury retrograde for their texts going unanswered. Meanwhile Mercury was direct and you are just being left on read. \uD83D\uDC80',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'meme_energy',
    name: 'Meme Energy',
    description: 'Internet humor, relatable meme-style observation',
    promptGuidance: [
      'Write this with MEME ENERGY — like a tweet that would go viral.',
      '- Use internet humor formats (me: / also me:, POV:, nobody:, etc.)',
      '- Relatable, slightly absurd',
      '- Reference meme culture but keep it astrology-focused',
      '- Short, punchy, screenshot-worthy',
      '- Example vibe: "POV: you check your chart and realize your Saturn return is not over yet"',
    ].join('\n'),
    example: 'Me: I am so over my Saturn return.\nMy Saturn return: bestie we have 2 more years \uD83D\uDC80',
    worksForShort: true,
    worksForLong: false,
    humorCompatible: true,
  },
  {
    id: 'mystical_poem',
    name: 'Mystical Poem',
    description: 'Short poetic verse, atmospheric and evocative',
    promptGuidance: [
      'Write this as a SHORT POEM or poetic observation — atmospheric, evocative, mystical.',
      '- Use line breaks for rhythm',
      '- Sensory language (stars, moonlight, cosmic dance)',
      '- No rhyming forced — natural flow',
      '- Mysterious, dreamy, beautiful',
      '- Example vibe: "The moon does not pull the tides. She whispers, and the ocean remembers."',
    ].join('\n'),
    example: 'The moon does not pull the tides.\nShe whispers,\nand the ocean remembers\nwhat it forgot at dawn. \uD83C\uDF19',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: false,
  },
  {
    id: 'listicle',
    name: 'Listicle',
    description: 'Numbered list of quick insights',
    promptGuidance: [
      'Write this as a SHORT LIST — 3 quick points or observations.',
      '- Use numbers (1. 2. 3.) or bullet points',
      '- Each point is one line, punchy',
      '- Easy to scan, satisfying to read',
      '- Example vibe: "3 things your moon sign reveals that your sun sign does not:"',
    ].join('\n'),
    example: '3 things your moon sign knows that your sun sign will not admit:\n1. Why you cry at commercials\n2. Your actual comfort food\n3. Who you text at 2am',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'question_hook',
    name: 'Question Hook',
    description: 'Thought-provoking question that sparks curiosity',
    promptGuidance: [
      'Write this as a THOUGHT-PROVOKING QUESTION — make the reader pause and think.',
      '- Start with a specific, unusual question (not "Did you know?")',
      '- The question should reveal something about astrology',
      '- Follow with a short, satisfying answer or tease',
      '- Curiosity gap — they NEED to know the answer',
      '- Example vibe: "Why do you keep dating the same sign? (Hint: it is not coincidence.)"',
    ].join('\n'),
    example: 'Why do you keep dating the same sign?\n\nIt is not coincidence — it is your 7th house calling. And it will not stop until you learn the lesson. \uD83D\uDD04',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'cosmic_weather',
    name: 'Cosmic Weather Report',
    description: 'Playful weather-report style for current transits',
    promptGuidance: [
      'Write this as a COSMIC WEATHER REPORT — like a meteorologist reporting on planetary movements.',
      '- Use weather language ("forecast", "incoming", "clear skies", "turbulence")',
      '- Make it feel timely and urgent',
      '- Playful but informative',
      '- Example vibe: "Today cosmic forecast: heavy Mercury energy with a chance of impulse texts."',
    ].join('\n'),
    example: 'Today cosmic forecast: \u2600\uFE0F Sun in Leo bringing main character energy, with scattered Venus-Pluto aspects causing impulse DMs. Pack an emotional umbrella. \u26C8\uFE0F',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'ancient_wisdom',
    name: 'Ancient Wisdom',
    description: 'Timeless, philosophical tone referencing ancient traditions',
    promptGuidance: [
      'Write this with ANCIENT WISDOM energy — like a sage sharing timeless knowledge.',
      '- Reference ancient traditions (Babylonian, Hellenistic, Vedic)',
      '- Philosophical, contemplative tone',
      '- Use "the ancients" or "for millennia" type language',
      '- Dignified, wise, slightly mysterious',
      '- Example vibe: "The Babylonians mapped the stars 3000 years ago. They knew what we forgot."',
    ].join('\n'),
    example: 'The Babylonians mapped the stars 3,000 years ago. They knew what modern astrology forgot: the sky does not predict — it reflects. \uD83D\uDD29',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: false,
  },
  {
    id: 'real_talk',
    name: 'Real Talk',
    description: 'Direct, no-nonsense, like advice from a friend',
    promptGuidance: [
      'Write this as REAL TALK — direct, no-nonsense advice from a friend who tells it like it is.',
      '- Conversational, casual, zero pretension',
      '- Use contractions, slang, informal language',
      '- Cut the fluff — get to the point',
      '- Relatable and grounded',
      '- Example vibe: "Stop asking if Mercury retrograde ruined your week. You ruined your week. The planets just watched."',
    ].join('\n'),
    example: 'Stop blaming Mercury retrograde for your week. You made those choices. The planets just watched and took notes. \uD83D\uDCDD',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'plot_twist',
    name: 'Plot Twist',
    description: 'Setup and punchline with an unexpected ending',
    promptGuidance: [
      'Write this as a PLOT TWIST — set up an expectation, then subvert it.',
      '- First line: sets up a normal expectation',
      '- Second line: reveals the twist (astrological truth)',
      '- Short, punchy, satisfying',
      '- Example vibe: "I thought my Saturn return would be spiritual. It was mostly crying in a Target parking lot."',
    ].join('\n'),
    example: 'I thought my Saturn return would be a spiritual awakening.\n\nIt was mostly crying in a Target parking lot at 11pm. But apparently that IS the spiritual awakening. \uD83E\uDE90',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: true,
  },
  {
    id: 'tiny_lesson',
    name: 'Tiny Lesson',
    description: 'Bite-sized educational insight, accessible and warm',
    promptGuidance: [
      'Write this as a TINY LESSON — one small, specific thing the reader will learn.',
      '- Focus on ONE specific concept (not a broad overview)',
      '- Explain it simply, like teaching a friend',
      '- Warm, encouraging tone',
      '- End with a small "aha" moment',
      '- Example vibe: "Your rising sign is not who you are. It is how you enter a room."',
    ].join('\n'),
    example: 'Your rising sign is not who you are. It is how you enter a room — literally. It is your social interface, your first impression, your "hi, nice to meet you" energy. \uD83D\uDEAA',
    worksForShort: true,
    worksForLong: true,
    humorCompatible: false,
  },
];

/**
 * Pick a content style for a given generation run.
 * Uses date-based rotation so different days get different styles,
 * but the same day is consistent (avoids random-looking inconsistency).
 */
export function pickContentStyle(network: SocialNetwork, runId?: string): ContentStyle {
  const isShort = network === SocialNetwork.X;
  const eligible = CONTENT_STYLES.filter(
    (s) => isShort ? s.worksForShort : s.worksForLong,
  );

  const now = new Date();
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000,
  );

  let extraEntropy = 0;
  if (runId) {
    for (let i = 0; i < runId.length; i++) {
      extraEntropy = (extraEntropy + runId.charCodeAt(i)) % 1000;
    }
  }

  const networkHash = network === SocialNetwork.X ? 0 : network === SocialNetwork.THREADS ? 1 : 2;
  const index = (dayOfYear + networkHash + extraEntropy) % eligible.length;

  return eligible[index] ?? CONTENT_STYLES[0]!;
}

/**
 * Get the style's prompt guidance to inject into the draft system prompt.
 */
export function getStylePromptGuidance(style: ContentStyle): string {
  return '\n\nCONTENT STYLE — "' + style.name + '":\n' +
    style.promptGuidance + '\n\n' +
    'Example of this style: "' + style.example + '"\n';
}

/**
 * Lookup map for styles by ID.
 */
export const CONTENT_STYLES_BY_ID: Record<string, ContentStyle> = Object.fromEntries(
  CONTENT_STYLES.map((s) => [s.id, s]),
);
