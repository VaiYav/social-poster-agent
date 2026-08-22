/**
 * P9: Engagement-Bait Detector.
 *
 * Algorithms on X, Threads, and Facebook pessimize "engagement-bait" content —
 * posts that explicitly ask for likes/comments/shares/tags without adding value.
 * This detector catches common bait patterns so the critique/refine step can
 * rewrite them before posting.
 *
 * Detection is pattern-based (regex) — fast, deterministic, no LLM cost.
 * False positives are acceptable: the refine step rewrites conservatively.
 */

/**
 * A single bait pattern match with context for the critique/refine prompt.
 */
export interface BaitMatch {
  /** The matched substring. */
  match: string;
  /** Bait category — used to give the LLM specific rewrite guidance. */
  category: BaitCategory;
  /** 0-based character offset in the source text. */
  index: number;
}

/**
 * Categorization of bait patterns — drives the rewrite instruction.
 */
export type BaitCategory =
  | "explicit_like_ask" // "like if", "drop a 🔥"
  | "explicit_comment_ask" // "comment below", "tell us"
  | "explicit_share_ask" // "retweet", "share this"
  | "explicit_tag_ask" // "tag a friend", "tag someone"
  | "vote_bait" // "agree or disagree?", "1 or 2?"
  | "engagement_question" // "what's your sign?" with no insight
  | "follow_bait"; // "follow for more"

interface BaitPattern {
  regex: RegExp;
  category: BaitCategory;
}

// Patterns are case-insensitive. Ordered by specificity (most explicit first).
const BAIT_PATTERNS: readonly BaitPattern[] = [
  // Explicit like asks
  { regex: /\blike if\b/i, category: "explicit_like_ask" },
  { regex: /\bdrop a (?:🔥|fire|💯|❤️|♥️|like)\b/i, category: "explicit_like_ask" },
  { regex: /\bsmash that like\b/i, category: "explicit_like_ask" },
  { regex: /\bdouble tap\b/i, category: "explicit_like_ask" },

  // Explicit comment asks
  { regex: /\bcomment below\b/i, category: "explicit_comment_ask" },
  { regex: /\btell us in the comments?\b/i, category: "explicit_comment_ask" },
  { regex: /\blet me know in the comments?\b/i, category: "explicit_comment_ask" },
  { regex: /\bdrop a comment\b/i, category: "explicit_comment_ask" },
  { regex: /\bsound off below\b/i, category: "explicit_comment_ask" },

  // Explicit share asks
  { regex: /\bretweet if\b/i, category: "explicit_share_ask" },
  { regex: /\brt if\b/i, category: "explicit_share_ask" },
  { regex: /\bshare this (?:post|with)\b/i, category: "explicit_share_ask" },
  { regex: /\brepost if\b/i, category: "explicit_share_ask" },

  // Explicit tag asks
  { regex: /\btag a friend\b/i, category: "explicit_tag_ask" },
  { regex: /\btag someone\b/i, category: "explicit_tag_ask" },
  { regex: /\btag (?:your|a) (?:friend|bestie|soulmate)\b/i, category: "explicit_tag_ask" },
  { regex: /\bshare with someone who\b/i, category: "explicit_tag_ask" },

  // Vote bait — "agree or disagree", "1 or 2"
  { regex: /\b(?:agree|disagree)\??\s*(?:👇|below)?\s*$/i, category: "vote_bait" },
  { regex: /\b(?:1|2|3|4)\s+or\s+(?:2|3|4|5)\b/i, category: "vote_bait" },
  { regex: /\bwhich (?:one|are you)\s*(?:1|2|3)\b/i, category: "vote_bait" },

  // Follow bait
  { regex: /\bfollow (?:us|me) for more\b/i, category: "follow_bait" },
  { regex: /\bfollow for daily\b/i, category: "follow_bait" },

  // Engagement question with no insight — "what's your sign?" at the end with no preceding value
  // This is borderline — only flag when it's the entire closing line with no insight.
  // We use a heuristic: the question is in the last 60 chars AND the post is short (<200 chars).
  // Full detection happens in detectEngagementBait() with post length context.
];

/**
 * Detect engagement-bait patterns in a post.
 *
 * @param content Post text to check
 * @returns Array of matches (empty if clean)
 */
export function detectEngagementBait(content: string): BaitMatch[] {
  if (!content || typeof content !== "string") return [];

  const matches: BaitMatch[] = [];

  for (const pattern of BAIT_PATTERNS) {
    let match: RegExpExecArray | null;
    // Reset lastIndex in case the regex was used before (global flag not set, but defensive)
    pattern.regex.lastIndex = 0;
    while ((match = pattern.regex.exec(content)) !== null) {
      matches.push({
        match: match[0],
        category: pattern.category,
        index: match.index,
      });
      // Avoid infinite loop on zero-length matches
      if (match.index === pattern.regex.lastIndex) pattern.regex.lastIndex++;
      // Non-global regexes only match once — break
      if (!pattern.regex.global) break;
    }
  }

  // Heuristic: engagement-question bait at the end of a short post
  // e.g. "What's your sign? 👇" with no preceding insight
  const trimmed = content.trim();
  const last60 = trimmed.slice(-60).toLowerCase();
  const endsWithSignQuestion =
    /\bwhat'?s your (?:sun |moon |rising )?sign\??\s*(?:👇|🤔|✨)?\s*$/i.test(last60);
  if (endsWithSignQuestion && trimmed.length < 200) {
    // Only flag if not already flagged by another pattern
    const alreadyFlagged = matches.some((m) => m.index >= trimmed.length - 60);
    if (!alreadyFlagged) {
      matches.push({
        match: last60.trim(),
        category: "engagement_question",
        index: trimmed.length - 60,
      });
    }
  }

  // Sort by index for stable output
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/**
 * Check if a post contains engagement bait.
 * Convenience wrapper around detectEngagementBait for boolean checks.
 */
export function hasEngagementBait(content: string): boolean {
  return detectEngagementBait(content).length > 0;
}

/**
 * Build a rewrite instruction for the refine step based on detected bait.
 * Returns null when no bait is detected.
 *
 * @param content Post text to check
 * @returns Rewrite instruction string for the LLM, or null
 */
export function buildBaitRewriteInstruction(content: string): string | null {
  const matches = detectEngagementBait(content);
  if (matches.length === 0) return null;

  const categoryLabels: Record<BaitCategory, string> = {
    explicit_like_ask: "asking for likes",
    explicit_comment_ask: "asking for comments",
    explicit_share_ask: "asking for shares/retweets",
    explicit_tag_ask: "asking to tag friends",
    vote_bait: 'vote-style engagement bait ("agree or disagree", "1 or 2")',
    engagement_question: 'closing with "what\'s your sign?" without adding insight',
    follow_bait: "asking for follows",
  };

  const foundCategories = [...new Set(matches.map((m) => m.category))];
  const labels = foundCategories.map((c) => categoryLabels[c]).join(", ");
  const examples = matches
    .slice(0, 3)
    .map((m) => `"${m.match}"`)
    .join(", ");

  return [
    `ENGAGEMENT BAIT DETECTED — rewrite required.`,
    `Issues: ${labels}.`,
    `Flagged phrases: ${examples}.`,
    `Replace with value-first closing: end with an insight, a question that invites reflection (not "what's your sign?"), or a soft CTA to read more.`,
    `Do NOT ask for likes, comments, shares, tags, or follows.`,
  ].join(" ");
}
