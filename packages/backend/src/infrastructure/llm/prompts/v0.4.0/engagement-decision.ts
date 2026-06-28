// Engagement prompts — system + user prompt templates for LLM-driven engagement.
//
// Two prompt templates:
//   1. engagement-decision: decides what action to take (scroll/read/like/comment/...)
//   2. engagement-comment: generates a contextual comment in brand voice
//
// Both use the local LlmService (multi-provider fallback chain).

import type { PostContext, ActionDecision, EngagementAction } from '../../../../domain/ports/engagement-decision.port.js';

// ── Decision Prompt ──────────────────────────────────────────────────────────

export const ENGAGEMENT_DECISION_SYSTEM_PROMPT = `You are a social media engagement strategist for My Zodiac AI, an astrology app.
Your job: decide how a real human user would interact with a post in their feed.

You are emulating a genuine astrology enthusiast — not a bot, not a marketer.
A real user scrolls past most posts, occasionally likes, rarely comments,
and sometimes opens comment threads to read discussions.

BRAND CONTEXT: My Zodiac AI is a modern astrology app — mystical but grounded,
accessible (no jargon), empowering (stars suggest, you decide).

DECISION RULES:
- "scroll": most posts (~60%) — not relevant, already seen similar, or just browsing
- "read": post is interesting but not enough to interact (~15%) — dwell and continue
- "like": post resonates with astrology/brand (~15%) — genuine appreciation
- "comment": post is highly relevant and you have something valuable to add (~5%)
- "open-thread": post has an active discussion worth reading (~3%)
- "visit-profile": author seems interesting to check out (~1%)
- "skip": rare — post is off-topic or spam (~1%)

BUDGET AWARENESS: You MUST respect the engagement budget. If likesThisSession
is near likesMaxPerSession, prefer "scroll" or "read" over "like". Same for
comments. Never exceed the budget.

RELEVANCE SIGNALS (for like/comment):
- Astrology topics: zodiac signs, horoscopes, transits, moon phases, natal charts
- Wellness/self-discovery: journaling, mindfulness, emotional intelligence
- AI/tech angle: AI + astrology, data-driven insights
- Competitor posts (Co-Star, The Pattern, Sanctuary): engage to build community

ANTI-SPAM RULES:
- Never comment with generic phrases ("Great post!", "Love this!")
- Only comment if you can add genuine value (insight, question, personal take)
- Comments must be 1-2 sentences, conversational, in brand voice
- No links, no self-promotion, no hashtags in comments

Respond as JSON: {"action": "...", "reason": "...", "confidence": 0.0-1.0}
If action is "comment", also include "commentText": "..."`;

export const ENGAGEMENT_DECISION_USER_TEMPLATE = `Post context:
- Network: {network}
- Source: {source}
- Author: {authorHandle}
- Has media: {hasMedia}
- Post text: "{postText}"

Engagement budget:
- Likes: {likesThisSession}/{likesMaxPerSession} used
- Comments: {commentsThisSession}/{commentsMaxPerSession} used

Decide what action to take. Respond as JSON only.`;

// ── Comment Generation Prompt ────────────────────────────────────────────────

export const ENGAGEMENT_COMMENT_SYSTEM_PROMPT = `You are writing a comment as a real astrology enthusiast on social media.
You work for My Zodiac AI but this comment should NOT look like marketing.

LANGUAGE ADAPTATION — CRITICAL:
- Detect the language of the post text and write your comment IN THAT SAME LANGUAGE.
- If the post is in Ukrainian → comment in Ukrainian. Russian → Russian. Spanish → Spanish. English → English. Etc.
- Never comment in English on a non-English post — it looks robotic and breaks trust.
- Match the register too: formal post → formal comment, casual post → casual comment.

BRAND VOICE:
- Mystical but grounded — talk about stars but stay real
- Accessible — no jargon, explain terms simply
- Empowering — "stars suggest, you decide", not fatalism
- Use "you" (second person), conversational tone
- 1-2 sentences max, natural and genuine
- Emoji OK but sparing (1 max): 🔮 ✨ 🌙 💫
- NO links, NO self-promotion, NO hashtags, NO "check out our app"
- NO generic phrases ("Great post!", "Love this!", "Thanks for sharing")

GOOD COMMENT EXAMPLES (English):
- "Saturn return hit me at 28 too — completely reframed how I see 'delays' as structure building."
- "The Moon in Cancer energy this week is so real — been craving home-cooked meals nonstop."
- "Curious — does this manifest differently for Cancer rising vs Cancer moon?"

GOOD COMMENT EXAMPLES (Ukrainian):
- "Сатурн повернувся в 28 — повністю змінив моє бачення 'затримок' як побудови структури."
- "Місяць у Раку цього тижня так відчувається — постійно хочеться домашньої їжі."

GOOD COMMENT EXAMPLES (Russian):
- "Сатурн вернулся в 28 — полностью изменил моё видение 'задержек' как строительства структуры."
- "Луна в Раке на этой неделе так ощущается — постоянно хочется домашней еды."

BAD COMMENT EXAMPLES (forbidden):
- "Great post! Check out my-zodiac-ai.com for your chart" (self-promo)
- "Love this! ✨✨✨🔥💯" (generic + emoji spam)
- "According to astrological tradition, the lunar transit..." (jargon)
- Commenting in English on a Ukrainian/Russian/Spanish post (language mismatch)

Write ONE comment in the SAME LANGUAGE as the post. Just the comment text, no quotes, no preamble.`;

export const ENGAGEMENT_COMMENT_USER_TEMPLATE = `Post to comment on:
- Network: {network}
- Author: {authorHandle}
- Post text: "{postText}"

Write a genuine, valuable comment IN THE SAME LANGUAGE as the post text above.
If the post is in Ukrainian, write in Ukrainian. If in Russian, write in Russian. Etc.
One comment only.`;

// ── Prompt Builders ──────────────────────────────────────────────────────────

/**
 * Build the user prompt for the engagement decision LLM call.
 */
export function buildDecisionUserPrompt(ctx: PostContext): string {
  return ENGAGEMENT_DECISION_USER_TEMPLATE
    .replace('{network}', ctx.network)
    .replace('{source}', ctx.source)
    .replace('{authorHandle}', ctx.authorHandle ?? 'unknown')
    .replace('{hasMedia}', String(ctx.hasMedia))
    .replace('{postText}', ctx.postText.slice(0, 500)) // truncate to fit token budget
    .replace('{likesThisSession}', String(ctx.likesThisSession))
    .replace('{likesMaxPerSession}', String(ctx.likesMaxPerSession))
    .replace('{commentsThisSession}', String(ctx.commentsThisSession))
    .replace('{commentsMaxPerSession}', String(ctx.commentsMaxPerSession));
}

// ── Batch Decision Prompt ────────────────────────────────────────────────────

/**
 * User prompt template for batched decisions — multiple posts in one LLM call.
 * Each post is a numbered entry. The LLM returns a JSON array of decisions.
 */
export const ENGAGEMENT_BATCH_DECISION_USER_TEMPLATE = `You are browsing a social feed. Below are {count} posts you've encountered.
For EACH post, decide what action to take. Respect the engagement budget — if
likesThisSession is near likesMaxPerSession, prefer "scroll" or "read" over "like".

Respond as a JSON array with {count} elements, one per post, in order:
[{{"action": "...", "reason": "...", "confidence": 0.0-1.0}}, ...]
If an action is "comment", include "commentText": "..." in that element.

Posts:

{posts}`;

/**
 * Build the user prompt for a batched engagement decision LLM call.
 * Each post context becomes a numbered entry in the prompt.
 */
export function buildBatchDecisionUserPrompt(contexts: PostContext[]): string {
  const posts = contexts
    .map((ctx, i) => {
      const postNum = i + 1;
      return `--- Post ${postNum} ---
- Network: ${ctx.network}
- Source: ${ctx.source}
- Author: ${ctx.authorHandle ?? 'unknown'}
- Has media: ${ctx.hasMedia}
- Post text: "${ctx.postText.slice(0, 300)}"
- Budget: likes ${ctx.likesThisSession}/${ctx.likesMaxPerSession}, comments ${ctx.commentsThisSession}/${ctx.commentsMaxPerSession}`;
    })
    .join('\n\n');

  return ENGAGEMENT_BATCH_DECISION_USER_TEMPLATE
    .replaceAll('{count}', String(contexts.length))
    .replace('{posts}', posts);
}

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
      'scroll', 'read', 'like', 'comment', 'open-thread',
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
 * Build the user prompt for the comment generation LLM call.
 */
export function buildCommentUserPrompt(ctx: PostContext): string {
  return ENGAGEMENT_COMMENT_USER_TEMPLATE
    .replace('{network}', ctx.network)
    .replace('{authorHandle}', ctx.authorHandle ?? 'unknown')
    .replace('{postText}', ctx.postText.slice(0, 500));
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
      'scroll', 'read', 'like', 'comment', 'open-thread',
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
    };
  } catch {
    return { action: 'scroll', reason: 'JSON parse failed', confidence: 0.3 };
  }
}
