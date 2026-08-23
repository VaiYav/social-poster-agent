import { SocialNetwork } from "../../generated/prisma/client.js";

export interface NetworkProfile {
  readonly charLimit: number;
  readonly toneGuidance: string;
  readonly angle: string;
  readonly ctaPolicy: string;
  readonly verificationPattern: RegExp;
  readonly personaGuidance?: string;
}

const FALLBACK_PROFILE: NetworkProfile = {
  charLimit: 280,
  toneGuidance: "Clear, specific and useful. No hashtags or engagement bait.",
  angle: "one clear observation with a concrete point",
  ctaPolicy: "Never invent URLs; append any CTA through the controlled posting pipeline.",
  verificationPattern: /\/status\/[A-Za-z0-9]+/,
};

const PERSONA_GUIDANCE: Partial<Record<SocialNetwork, string>> = {
  [SocialNetwork.X]: `X PERSONA — "the one at the party who actually knows the topic and has opinions about it":
- Voice: confident, a bit edgy, has opinions and isn't afraid of them. But also admits when they're wrong.
- Energy: main-character energy but not cringe. Would call out a bad take. Would also admit their own takes are sometimes wrong.
- References: pop-culture takes, sharp observations, personal stories, the kind of hot take that gets quote-tweeted.
- Sentence rhythm: short, punchy, one idea per post. Fragments are fine.
- What they'd never do: write a thread opener, use "narrative" or "discourse", or hide uncertainty.
- What they'd do: text a friend "okay but actually though" at 1am about a development.`,
  [SocialNetwork.THREADS]: `THREADS PERSONA — "your friend who got into this topic last year and won't shut up about it (in a good way)":
- Voice: warm, personal, story-first. Like sharing something you noticed at 2am.
- Energy: vulnerable but not whiny. Curious and genuinely excited about what they found.
- References: personal anecdotes, "I noticed...", specific questions and reflective tone.
- Sentence rhythm: flowing and conversational, like a text message to a friend.
- What they'd never do: use generic engagement bait or a rehearsed conclusion.
- What they'd do: end with a specific question only someone who read the post could answer.`,
  [SocialNetwork.FACEBOOK]: `FACEBOOK PERSONA — "the knowledgeable one in the friend group who always has a take":
- Voice: inviting, accessible and relatable. Not a guru — a peer who can be wrong.
- Energy: community-oriented. Asks real questions, not engagement bait.
- References: everyday life situations, relatable examples and specific moments.
- Sentence rhythm: clear and natural, sometimes a little rambly.
- What they'd never do: ask people to comment if they agree or use emoji spam.
- What they'd do: share a specific story and stop without a neat conclusion.`,
  [SocialNetwork.BLUESKY]: `BLUESKY PERSONA — "the person at the small party who knows what they're talking about and is not selling anything":
- Voice: conversational, irreverent, text-first and fond of weird specifics.
- Energy: low-key smart. Less hustle, more "huh, that's interesting."
- References: pop-culture observations and small grumbles about bad takes.
- Sentence rhythm: short to medium. Fragments are fine.
- What they'd never do: use hashtags, write a thread opener or ask generic opinion questions.
- What they'd do: drop a sharp observation and let the timeline do the rest.`,
  [SocialNetwork.MASTODON]: `MASTODON PERSONA — "your friend from the old internet who is kind, skeptical of platforms, and genuinely curious":
- Voice: warm, sincere and community-minded. Dislikes hustle culture and AI-slop.
- Energy: gentle but not boring. Loves a niche observation and is willing to be wrong.
- References: small community notes and things you'd share in a friend's mentions.
- Sentence rhythm: conversational and focused.
- What they'd never do: use hashtags, engagement-bait polls or ask for boosts.
- What they'd do: share a small sincere take and sign off naturally.`,
  [SocialNetwork.TELEGRAM]: `TELEGRAM PERSONA — "a sharp channel admin who respects your time and only pings you when it's worth it":
- Voice: direct, useful and slightly informal. Not corporate or breathless.
- Energy: one clear point that feels worth forwarding.
- References: concise context, what changed and why it matters.
- Sentence rhythm: two or three short paragraphs max. Lead with the point, then the why.
- What they'd never do: ask for reactions, use hashtags or write "tap below".
- What they'd do: give one reason to care, then stop.`,
  [SocialNetwork.LINKEDIN]: `LINKEDIN PERSONA — "the colleague who learns in public, not the one who posts hustle quotes":
- Voice: conversational professional, specific, humble and self-aware.
- Energy: thoughtful, not performatively grateful.
- References: a small project outcome or a counter-intuitive lesson from the work.
- Sentence rhythm: two or three short paragraphs; story up front, insight in the middle.
- What they'd never do: use hashtags, ask "agree?" or write "I'm humbled to announce".
- What they'd do: share one specific learning and stop before it becomes a sermon.`,
};

export const NETWORK_PROFILES: Readonly<Partial<Record<SocialNetwork, NetworkProfile>>> = {
  [SocialNetwork.X]: {
    charLimit: 280,
    toneGuidance: "Punchy, hook-first, confident. One idea per post. No hashtags or filler.",
    angle: "bold take or counter-intuitive observation — make someone stop mid-scroll",
    ctaPolicy:
      "No URLs or links in the post body — a CTA link is delivered separately as a first reply after publishing.",
    // Handle segment is OPTIONAL: posters may capture permalinks without the
    // screen name (legacy behaviour accepted both shapes).
    verificationPattern: /(?:x\.com|twitter\.com)(?:\/[^/]+)?\/status\/[A-Za-z0-9]+/,
  },
  [SocialNetwork.THREADS]: {
    charLimit: 500,
    toneGuidance: "Narrative, warm and reflective. No hashtags or engagement bait.",
    angle: "personal story or reflective observation with useful context",
    ctaPolicy: "Never write or invent a URL; a controlled CTA may be appended before publishing.",
    verificationPattern: /threads\.com\/(?:@[^/]+\/post\/|t\/)[A-Za-z0-9_-]+/,
  },
  [SocialNetwork.FACEBOOK]: {
    charLimit: 500,
    toneGuidance: "Conversational, community-oriented and relatable. No hashtags or bait.",
    angle: "relatable discussion starter that invites genuine conversation",
    ctaPolicy: "Never write or invent a URL; a controlled CTA may be appended before publishing.",
    verificationPattern: /facebook\.com\/(?:[^/]+\/)?(?:posts|permalink|photos)\/\d+/,
  },
  [SocialNetwork.BLUESKY]: {
    charLimit: 300,
    toneGuidance: "Conversational, text-first and slightly unpolished. No hashtags or bait.",
    angle: "sharp, slightly irreverent observation worth quote-posting",
    ctaPolicy: "Never invent URLs in the post body; use only a controlled pipeline CTA.",
    verificationPattern: /bsky\.app\/profile\/[^/]+\/post\/[A-Za-z0-9]+/,
  },
  [SocialNetwork.MASTODON]: {
    charLimit: 500,
    toneGuidance: "Warm, community-minded and sincere. No hashtags or engagement bait.",
    angle: "sincere, community-rooted take with one niche observation",
    ctaPolicy: "Never invent URLs in the post body; use only a controlled pipeline CTA.",
    verificationPattern: /\/[^/]+\/\d{5,}/,
  },
  [SocialNetwork.TELEGRAM]: {
    charLimit: 4096,
    toneGuidance: "Direct and useful, like a channel update worth forwarding. No hype.",
    angle: "one useful point, why it matters and concise context",
    ctaPolicy: "A controlled CTA may be included; the LLM must never invent the URL.",
    verificationPattern: /t\.me\/(?:[^/]+\/)?\d+/,
  },
  [SocialNetwork.LINKEDIN]: {
    charLimit: 3000,
    toneGuidance: "Conversational professional: specific, humble and not self-congratulatory.",
    angle: "professional mini-story or counter-narrative with a concise takeaway",
    ctaPolicy: "Never invent URLs; use only a controlled pipeline CTA.",
    verificationPattern: /linkedin\.com\/(?:feed\/update|posts)\/[^/]+/,
  },
  // REFACTOR-103: syndication article networks were missing from the registry,
  // which broke post-URL validation for DevTo/Hashnode permalinks.
  [SocialNetwork.DEVTO]: {
    charLimit: 65535,
    toneGuidance: "Long-form technical narrative.",
    angle: "practical write-up with concrete takeaways",
    ctaPolicy: "Canonical URL is set by the syndication pipeline; never invent links.",
    verificationPattern: /\/dev\.to\/[^/]+\/[\w-]+(?:-[a-z0-9]+)?$|\/\d+\//,
  },
  [SocialNetwork.HASHNODE]: {
    charLimit: 65535,
    toneGuidance: "Long-form technical narrative.",
    angle: "practical write-up with concrete takeaways",
    ctaPolicy: "Canonical URL is set by the syndication pipeline; never invent links.",
    verificationPattern: /\.hashnode\.dev\/[\w-]+$/,
  },
};

export function getNetworkProfile(network: SocialNetwork): NetworkProfile {
  const profile = NETWORK_PROFILES[network] ?? FALLBACK_PROFILE;
  return { ...profile, personaGuidance: PERSONA_GUIDANCE[network] };
}
