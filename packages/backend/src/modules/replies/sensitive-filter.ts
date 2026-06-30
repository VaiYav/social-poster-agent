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
