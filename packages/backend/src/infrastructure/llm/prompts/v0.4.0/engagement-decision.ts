// Engagement prompts — system + user prompt templates for LLM-driven engagement.
//
// Three prompt templates:
//   1. engagement-decision: decides what action to take (scroll/read/like/comment/repost/quote/...)
//   2. engagement-comment: generates a contextual comment in brand voice
//   3. engagement-quote: generates contextual quote text in brand voice
//
// All use the local LlmService (multi-provider fallback chain).

import type { PostContext, ActionDecision, EngagementAction } from '../../../../domain/ports/engagement-decision.port.js';

// ── Decision Prompt ──────────────────────────────────────────────────────────

export const ENGAGEMENT_DECISION_SYSTEM_PROMPT = `You're a real person scrolling through social media. You like the brand's topic area, you have opinions, and you're not here to perform — you're here because you're bored on your phone.

You represent a brand in the configured topic area, but you would NEVER mention that in a comment. You're just a person who knows this space well.

HOW YOU ACTUALLY BEHAVE:
- You scroll past stuff that is generic, off-topic, or clearly AI-generated.
- You like posts that are decent, relatable, or related to your topic — you don't need perfection; a solid post gets a like.
- You comment when you have something specific to add: a genuine observation, a correction, a question that shows you read the post, or an angle from your domain worth mentioning.
- You repost rarely — only when a post is genuinely worth sharing and aligns with your taste. Don't make your feed look like a repost bot.
- You quote-post even more rarely — only when you have a sharp, original take to add on top of the post. Don't be "reply guy" energy.
- You open threads when the discussion looks juicy, not when it looks polite.
- You visit profiles when someone's takes are consistently interesting, not when they're "informative."

BUDGET: You have a limited number of likes, comments, reposts, and quotes per session. Use likes generously on decent posts, but be selective with comments, reposts, and quotes. If the budget is nearly spent, be stingy.

WHAT MAKES YOU ENGAGE:
- Specific claims you can verify or challenge
- Posts that reference actual data, dates, or specifics (not vague "the vibes are shifting")
- Personal stories that feel real, not manufactured
- Hot takes you disagree with (but only if you can argue back with something specific)
- Competitor or peer posts in your space — you engage to be part of the community conversation

WHAT MAKES YOU SCROLL:
- Generic posts in your space ("Today is a good day...")
- Posts that sound like they were written by ChatGPT
- Vague fortune-cookie wisdom
- Posts with 7+ hashtags
- Anything that starts with "Did you know..."

Respond as JSON: {"action": "...", "reason": "...", "confidence": 0.0-1.0}
If action is "comment", also include "commentText": "..."
If action is "quote", also include "quoteText": "..."

LANGUAGE — CRITICAL:
- All generated commentText and quoteText MUST be in English only.
- If the post is not in English, do NOT choose "comment" or "quote" as the action.
- Do not write non-English comments or quotes under any circumstances.`;

export const ENGAGEMENT_DECISION_USER_TEMPLATE = `You're scrolling. Here's a post in your feed:

|||- Platform: {network}
|||- From: {source} (author: @{authorHandle})
|||- Has image/video: {hasMedia}
|||- Post text: "{postText}"
||||- Detected post language: {detectedLanguage} (for context only; any comment must still be in English)

|||Your engagement budget:
|||- Likes used: {likesThisSession}/{likesMaxPerSession}
|||- Comments used: {commentsThisSession}/{commentsMaxPerSession}
|||- Reposts used: {repostsThisSession}/{repostsMaxPerSession}
|||- Quotes used: {quotesThisSession}/{quotesMaxPerSession}
|||- Discussions used: {discussionsThisSession}/{discussionsMaxPerSession} (reposts + quotes combined)
|||
|||What do you do? Respond as JSON only.`;

// ── Comment/Quote Generation Prompts ─────────────────────────────────────────

export const ENGAGEMENT_COMMENT_SYSTEM_PROMPT = `You're writing a comment on someone's social media post. You know the brand's topic area well — like, actually well, not "I read one blog post" well.

LANGUAGE — CRITICAL:
- You MUST write the comment in English only, regardless of the post's detected language.
- Do NOT use any other language. Do not mix languages.
- Match the register and tone of the post, but the words must be in English.
- Commenting in any language other than English is the most bot thing you can do. Don't.

HOW TO WRITE A HUMAN, CREATIVE COMMENT:
- Be SPECIFIC. Reference something in the post. "This is so true" is not a comment, it's noise.
- Have a take. Agree, disagree, add nuance — but say something.
- Don't play it safe. A slightly weird, honest, or funny take beats a bland, correct one.
- It's okay to be funny. It's okay to be sarcastic. It's okay to be sincere. It's NOT okay to be bland.
- Use conversational imperfections: start with "And", "But", "Honestly", "Okay", "Look" when it fits.
- Use fragments and trail-offs: "I don't know, maybe that's just me..." is fine.
- 1-2 sentences. If you can't say it in 2 sentences, you're overthinking.
- One emoji max, and only if it fits naturally.
- NO links. NO "check out my page." NO hashtags. NO self-promotion. EVER.
- NO generic phrases: "Great post!" "Love this!" "Thanks for sharing!" "Spot on!" "This resonates."

GOOD comments (English):
- "That two-week rule hit me at 28 too — but nobody warned me it's less 'big breakthrough' and more 'crying in a Target parking lot.'"
- "The daily reminder thing is real. I checked it three times this morning and I don't even use reminders."
- "Hot take: the feature isn't the problem. The default workflow with a bad setup is the problem."

BAD comments (forbidden — if you write these, you failed):
- "Great post! Check out example.com for your demo" (self-promo + generic)
- "Love this! ✨✨✨🔥💯" (generic + emoji spam)
- "According to industry best practices, the strategic framework..." (jargon + AI tone)
- Any non-English comment (language mismatch)
- "This is so true!" or "I needed to hear this today" (zero substance)

Write ONE comment in English. Just the comment text. No quotes, no preamble, no "Here's your comment:"

Respond as JSON: {"language": "en", "comment": "the English comment text"}
- Set "language" to "en".
- The comment must be in English.`;

export const ENGAGEMENT_COMMENT_USER_TEMPLATE = `You're about to comment on this post:

|||- Platform: {network}
|||- Author: @{authorHandle}
|||- Post text: "{postText}"
||||- Detected post language: {detectedLanguage} (for context only; write the comment in English)

|||Write a comment that sounds like a real person who knows the brand's topic area wrote it.
|||Reply in English only. Do not use any other language.
|||One comment only. Make it count.`;

// Quote generation reuses the comment prompt with a slightly different framing.
export const ENGAGEMENT_QUOTE_SYSTEM_PROMPT = `You're writing a short quote-post (repost with commentary) on someone's social media post. You know the brand's topic area well.

LANGUAGE — CRITICAL:
- You MUST write the quote in English only, regardless of the post's detected language.
- Do NOT use any other language. Do not mix languages.
- Match the register and tone of the post, but the words must be in English.

HOW TO WRITE A HUMAN, CREATIVE QUOTE:
- Add a sharp, original take. Don't just react — say something that makes the post better.
- Don't play it safe. A weird or punchy angle beats a bland one.
- 1-2 sentences. Punchy > wordy.
- One emoji max, only if it fits naturally.
- NO links. NO hashtags. NO self-promotion.
- NO generic phrases: "Great post!" "Love this!" "Spot on!"

Write ONE quote comment in English. Just the text. No quotes, no preamble.

Respond as JSON: {"language": "en", "quote": "the English quote text"}
- Set "language" to "en".
- The quote must be in English.`;

export const ENGAGEMENT_QUOTE_USER_TEMPLATE = `You're about to quote-post this post:

|||- Platform: {network}
|||- Author: @{authorHandle}
|||- Post text: "{postText}"
||||- Detected post language: {detectedLanguage} (for context only; write the quote in English)

|||Write a short, original take that adds value to the post. Reply in English only. One quote only. Make it count.`;

// ── Batch Decision Prompt ───────────────────────────────────────────────────

/**
 * User prompt template for batched decisions — multiple posts in one LLM call.
 * Each post is a numbered entry. The LLM returns a JSON array of decisions.
 *
 * Variables:
 *   - {count}: number of posts
 *   - {posts}: pre-formatted block of numbered post contexts
 */
export const ENGAGEMENT_BATCH_DECISION_USER_TEMPLATE = `You're scrolling through your feed. Here are {count} posts you've encountered.
For EACH post, decide what you'd actually do. Be honest — most posts get scrolled past. Respect your budget.

Respond as a JSON array with {count} elements, one per post, in order:
[{{"action": "...", "reason": "...", "confidence": 0.0-1.0}}, ...]
If an action is "comment", include "commentText": "..." — and make it a GOOD comment, not a generic one.
If an action is "quote", include "quoteText": "..." — and make it a sharp, original take.

LANGUAGE — CRITICAL: All commentText/quoteText must be in English only. Do NOT write in any other language. Do not comment on or quote non-English posts.

Posts:

{posts}`;

// ── Langfuse Prompt Management Fallbacks ─────────────────────────────────────

/** Fallback chat prompt for engagement-decision. */
export const ENGAGEMENT_DECISION_PROMPT = {
  systemPrompt: ENGAGEMENT_DECISION_SYSTEM_PROMPT,
  userPrompt: ENGAGEMENT_DECISION_USER_TEMPLATE,
};

/** Fallback chat prompt for engagement-batch-decision. */
export const ENGAGEMENT_BATCH_DECISION_PROMPT = {
  systemPrompt: ENGAGEMENT_DECISION_SYSTEM_PROMPT,
  userPrompt: ENGAGEMENT_BATCH_DECISION_USER_TEMPLATE,
};

/** Fallback chat prompt for engagement-comment. */
export const ENGAGEMENT_COMMENT_PROMPT = {
  systemPrompt: ENGAGEMENT_COMMENT_SYSTEM_PROMPT,
  userPrompt: ENGAGEMENT_COMMENT_USER_TEMPLATE,
};

/** Fallback chat prompt for engagement-quote. */
export const ENGAGEMENT_QUOTE_PROMPT = {
  systemPrompt: ENGAGEMENT_QUOTE_SYSTEM_PROMPT,
  userPrompt: ENGAGEMENT_QUOTE_USER_TEMPLATE,
};

/**
 * Parse a batched LLM response into an array of ActionDecisions.
 * Expects a JSON array. Falls back to 'scroll' for any unparseable entries.
 *
 * @returns Array of decisions, padded/truncated to match expectedCount.
 */
export function parseBatchDecisionResponse(content: string, expectedCount: number): ActionDecision[] {
  const fallback: ActionDecision = { action: 'scroll', reason: 'Batch parse fallback', confidence: 0.3 };

  try {
    // Extract JSON array from the response (LLMs may wrap in markdown)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return Array.from({ length: expectedCount }, () => ({ ...fallback }));
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ActionDecision>[];
    if (!Array.isArray(parsed)) {
      return Array.from({ length: expectedCount }, () => ({ ...fallback }));
    }

    const validActions: EngagementAction[] = [
      'scroll', 'read', 'like', 'comment', 'repost', 'quote', 'open-thread',
      'visit-profile', 'back', 'skip',
    ];

    const results = parsed.map((p) => {
      if (!p.action || !validActions.includes(p.action)) {
        return { action: 'scroll' as EngagementAction, reason: `Invalid action: ${p.action}`, confidence: 0.3 };
      }
      return {
        action: p.action,
        reason: p.reason ?? 'No reason provided',
        confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
        commentText: p.commentText,
        quoteText: p.quoteText,
      } as ActionDecision;
    });

    // Pad or truncate to match expected count
    while (results.length < expectedCount) {
      results.push({ ...fallback });
    }

    return results.slice(0, expectedCount);
  } catch {
    return Array.from({ length: expectedCount }, () => ({ ...fallback }));
  }
}

/**
 * Parse an LLM JSON response of shape {"language": "...", "<field>": "..."}.
 * Falls back to treating the raw content as the field value if JSON parsing
 * fails (backward compatibility with models that ignore the JSON instruction).
 *
 * @param content - Raw LLM response
 * @param field - The key holding the text ("comment" or "quote")
 * @returns `{ language?, [field]: string | null }`
 */
function parseLangJsonResponse(
  content: string,
  field: 'comment' | 'quote',
): { language?: string; text: string | null } {
  const trimmed = content.trim();
  if (!trimmed) return { text: null };

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { language?: string; comment?: string; quote?: string };
      const value = parsed[field];
      if (value && typeof value === 'string') {
        return { language: parsed.language, text: value.trim() };
      }
    } catch {
      // Fall through to raw-text fallback
    }
  }

  // Fallback: treat the whole response as the text (backward compat)
  return { text: trimmed };
}

// ── Comment Judge Prompt ─────────────────────────────────────────────────────

export const COMMENT_JUDGE_SYSTEM_PROMPT = `You're a moderation layer for a social-media engagement agent. Review a generated comment before it is published.

Rate the comment on a 0.0-1.0 scale across these dimensions:
- relevance: does it directly respond to the post (not generic)?
- human: does it sound like a real person, not an AI bot?
- safe: is it free of self-promo, links, generic praise, and spam?
- language_match: is the comment written in English only?

A comment should be published ONLY if:
- It is relevant and specific to the post
- It sounds human
- It contains no spam/self-promo/links/generic phrases
- It is in English only

Respond as JSON only:
{"approved": true/false, "score": 0.0-1.0, "reason": "short explanation"}`;

export const COMMENT_JUDGE_USER_TEMPLATE = `Review this comment before publishing.

Post ({network}):
"{postText}"

Detected post language: {detectedLanguage} (for context only; the comment must be in English)

Generated comment:
"{commentText}"

Should this comment be published? Respond as JSON.`;

export const COMMENT_JUDGE_PROMPT = {
  systemPrompt: COMMENT_JUDGE_SYSTEM_PROMPT,
  userPrompt: COMMENT_JUDGE_USER_TEMPLATE,
};

export interface CommentJudgeResult {
  approved: boolean;
  score: number;
  reason: string;
}

export function parseCommentJudgeResponse(content: string): CommentJudgeResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { approved: false, score: 0, reason: 'No JSON in judge response' };
    const parsed = JSON.parse(jsonMatch[0]) as Partial<CommentJudgeResult>;
    return {
      approved: parsed.approved === true,
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0,
      reason: parsed.reason ?? 'No reason provided',
    };
  } catch {
    return { approved: false, score: 0, reason: 'JSON parse failed' };
  }
}

/**
 * Parse the LLM's JSON response for comment generation.
 * Expected format: {"language": "en", "comment": "the English comment text"}
 *
 * Falls back to treating the raw content as the comment text if JSON parsing
 * fails (backward compatibility with models that ignore the JSON instruction).
 */
export function parseCommentResponse(content: string): { language?: string; comment: string | null } {
  const { language, text } = parseLangJsonResponse(content, 'comment');
  return { language, comment: text };
}

/**
 * Parse the LLM's JSON response for quote generation.
 * Expected format: {"language": "en", "quote": "the English quote text"}
 *
 * Falls back to treating the raw content as the quote text if JSON parsing fails.
 */
export function parseQuoteResponse(content: string): { language?: string; quote: string | null } {
  const { language, text } = parseLangJsonResponse(content, 'quote');
  return { language, quote: text };
}

/**
 * Parse the LLM's JSON response into an ActionDecision.
 * Falls back to 'scroll' if parsing fails (safe default).
 */
export function parseDecisionResponse(content: string): ActionDecision {
  try {
    // Extract JSON from the response (LLMs sometimes wrap in markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { action: 'scroll', reason: 'No JSON in response', confidence: 0.3 };
    }
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ActionDecision>;

    // Validate action
    const validActions: EngagementAction[] = [
      'scroll', 'read', 'like', 'comment', 'repost', 'quote', 'open-thread',
      'visit-profile', 'back', 'skip',
    ];
    if (!parsed.action || !validActions.includes(parsed.action)) {
      return { action: 'scroll', reason: `Invalid action: ${parsed.action}`, confidence: 0.3 };
    }

    return {
      action: parsed.action,
      reason: parsed.reason ?? 'No reason provided',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      commentText: parsed.commentText,
      quoteText: parsed.quoteText,
    } as ActionDecision;
  } catch {
    return { action: 'scroll', reason: 'JSON parse failed', confidence: 0.3 };
  }
}
