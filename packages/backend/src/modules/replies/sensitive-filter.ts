/**
 * RP3: deterministic sensitive-comment detector.
 *
 * Runs as a HARD pre-filter before any LLM reply decision — a brand-safety / harm backstop so the
 * bot never auto-replies (chirpily) to a comment about grief, self-harm, a mental-health crisis, or
 * a serious complaint, even when the LLM misclassifies it as "simple".
 *
 * The audience is RU/UA + EN, so patterns cover Cyrillic too. Note: ASCII `\b` does not work for
 * Cyrillic, and "гор" alone matches innocent words (город/гора/гордість) — so we match "горе"/"горю".
 */
export interface SensitiveDetection {
  sensitive: boolean;
  kind?: 'crisis' | 'complaint';
  /** Human-facing reason, suitable for the review queue. */
  reason?: string;
}

const CRISIS_PATTERNS =
  /depress|suicid|anxiety|mental health|self[-\s]?harm|abuse|trauma|death|died|grief|crisis|депрес|суицид|тревог|насили|травм|смерт|помер|горе|горю|криз|самоповре|покончить/i;

const COMPLAINT_PATTERNS =
  /wrong|disappointed|terrible|awful|hate this|not helpful|misleading|refund|неправил|розчаров|жахлив|ненавиж|не допом|оскорб|обман|верните деньг/i;

/**
 * Classify a comment as sensitive (crisis) or a complaint. Sensitive comments must be routed to
 * human review and never auto-replied.
 */
export function detectSensitive(text: string): SensitiveDetection {
  const t = text ?? '';
  if (CRISIS_PATTERNS.test(t)) {
    return {
      sensitive: true,
      kind: 'crisis',
      reason: 'Comment mentions mental health, crisis, or other sensitive topic',
    };
  }
  if (COMPLAINT_PATTERNS.test(t)) {
    return {
      sensitive: true,
      kind: 'complaint',
      reason: 'Comment contains a complaint or negative sentiment',
    };
  }
  return { sensitive: false };
}

/**
 * RP-troll: word-boundary troll/spam detector for skipping replies. The previous substring match
 * (/…|bot|…/) false-positived on ordinary words — "about" contains "bot", "studied" contains "die",
 * "skill" contains "kill" — silently skipping benign comments. Word boundaries fix that.
 */
const TROLL_PATTERNS = /\b(?:spam|scam|fake|bots?|stupid|idiot|hate|kill|die|racist|nazi)\b/i;

export function isLikelyTroll(text: string): boolean {
  return TROLL_PATTERNS.test(text ?? '');
}

// ── Low-value comment detector ─────────────────────────────────────────────

/**
 * Deterministic pre-filter for low-value comments that don't warrant a reply.
 *
 * Runs BEFORE the LLM call (saves tokens) and catches obvious cases:
 *   - Emoji-only comments (no meaningful text)
 *   - Very short generic reactions ("nice", "cool", "lol", "first", "ок")
 *   - Follow-for-follow / subscribe-bait ("follow me", "подпишись", "подписка")
 *   - Pure hashtag comments
 *   - Single-punctuation comments ("!!!", "???")
 *
 * Conservative by design: only triggers on SHORT comments (≤ 40 meaningful chars
 * after stripping emojis/hashtags/whitespace). Longer comments always go to the
 * LLM, which can make a nuanced skip/reply/review decision.
 *
 * Multilingual: covers EN + RU/UA (the brand's primary audience).
 */
export interface LowValueDetection {
  lowValue: boolean;
  reason?: string;
}

/** Strip emojis, hashtags, mentions, and whitespace to get "meaningful" text length. */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu;
const HASHTAG_RE = /#[\w\u0400-\u04FF]+/g;
const MENTION_RE = /@[\w.]+/g;

/** Generic one-word / short-phrase reactions that don't need a reply. EN + RU/UA. */
const GENERIC_REACTIONS = new Set([
  // English
  'nice', 'cool', 'great', 'good', 'wow', 'lol', 'lmao', 'rofl', 'ok', 'okay',
  'yes', 'no', 'true', 'facts', 'agreed', 'this', 'same', 'first', 'second',
  'omg', 'whoa', 'neat', 'sweet', 'dope', 'fire', 'based', 'fr', 'real',
  'amen', 'thanks', 'thx', 'ty', 'w', 'ww', 'www', 'congrats', 'congratulations',
  'beautiful', 'perfect', 'amazing', 'awesome', 'love', 'loved',
  // Russian / Ukrainian
  'да', 'нет', 'ок', 'класс', 'супер', 'круто', 'согласен', 'согласна',
  'первый', 'спасибо', 'дякую', 'красиво', 'чудово',
  'правда', 'істина', 'істинно', 'так', 'нє', 'погоджуюсь', 'згода',
  'огонь', 'вогонь', 'топ', 'топчик', 'база', 'факт', 'факти',
]);

/** Follow/subscribe bait patterns. EN + RU/UA. */
const FOLLOW_BAIT_RE =
  /\b(?:follow\s*me|follow\s*for\s*follow|f4f|sub4sub|subscribe|check\s*my\s*(?:profile|page|channel)|visit\s*my)\b/i;
const FOLLOW_BAIT_CYR_RE =
  /(?:подпишись|подписка|подписывайся|підпишись|підписка|підписуйся|заходи\s*в\s*профиль|посети\s*мой|заходи\s*на\s*канал)/i;

/** Pure hashtag check: after stripping hashtags, nothing meaningful remains. */
function isPureHashtag(text: string): boolean {
  const withoutHashtags = text.replace(HASHTAG_RE, '').replace(MENTION_RE, '').trim();
  return withoutHashtags.length === 0 && /#/.test(text);
}

/** Check if text is only emojis (no meaningful alphabetic content). */
function isEmojiOnly(text: string): boolean {
  const stripped = text.replace(EMOJI_RE, '').replace(/[\s\p{P}]/gu, '').trim();
  return stripped.length === 0 && text.trim().length > 0;
}

/**
 * Classify a comment as low-value (not worth replying to).
 * Returns { lowValue: true, reason } when the comment should be skipped.
 */
export function isLowValueComment(text: string): LowValueDetection {
  const t = (text ?? '').trim();
  if (t.length === 0) {
    return { lowValue: true, reason: 'Empty comment' };
  }

  // Emoji-only — no text to reply to
  if (isEmojiOnly(t)) {
    return { lowValue: true, reason: 'Emoji-only comment — nothing to reply to' };
  }

  // Pure hashtags / mentions — no conversational content
  if (isPureHashtag(t)) {
    return { lowValue: true, reason: 'Pure hashtag/mention comment — no conversational content' };
  }

  // Follow/subscribe bait — never engage with self-promo
  if (FOLLOW_BAIT_RE.test(t) || FOLLOW_BAIT_CYR_RE.test(t)) {
    return { lowValue: true, reason: 'Follow/subscribe bait — not engaging with self-promo' };
  }

  // Strip emojis, hashtags, mentions to get meaningful text
  const meaningful = t
    .replace(EMOJI_RE, '')
    .replace(HASHTAG_RE, '')
    .replace(MENTION_RE, '')
    .replace(/[\s\p{P}]/gu, '')
    .trim();

  // Very short meaningful content (≤ 3 chars) after stripping fluff
  if (meaningful.length > 0 && meaningful.length <= 3) {
    return { lowValue: true, reason: 'Too short to warrant a reply (≤3 meaningful chars)' };
  }

  // Generic one-word / short-phrase reactions (only check short comments ≤ 40 chars
  // to avoid false positives on longer comments that happen to contain these words)
  if (t.length <= 40) {
    const normalized = t
      .replace(EMOJI_RE, '')
      .replace(/[\s\p{P}]/gu, '')
      .toLowerCase()
      .trim();
    if (normalized.length > 0 && GENERIC_REACTIONS.has(normalized)) {
      return { lowValue: true, reason: `Generic reaction "${normalized}" — no reply needed` };
    }
  }

  return { lowValue: false };
}
