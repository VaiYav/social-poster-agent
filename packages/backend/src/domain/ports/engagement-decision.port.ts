// Engagement decision port — abstract interface for LLM-driven engagement decisions.
// Implementation: EngagementDecisionService (uses ILlmPort via LlmService).
// Unit tests can inject a mock decision port without LLM API calls.
//
// Replaces the Math.random() approach in BrowsingSessionService with
// context-aware LLM decisions that consider post content, brand relevance,
// and engagement budget.

import type { SocialNetwork } from '@spa/shared';

export const IEngagementDecisionPort = Symbol('IEngagementDecisionPort');

/**
 * The set of actions the human-behavior engine can decide to perform
 * after viewing a post during a browsing session.
 */
export type EngagementAction =
  | 'scroll' // continue scrolling past the post
  | 'read' // dwell on the post (simulate reading) then scroll
  | 'like' // like the post
  | 'comment' // write and post a comment
  | 'repost' // repost / retweet without adding text
  | 'quote' // repost / retweet with added commentary
  | 'open-thread' // open the comments thread to read replies
  | 'visit-profile' // navigate to the post author's profile
  | 'back' // go back (e.g. after visiting a profile)
  | 'skip'; // do nothing and continue (distinct from scroll — no movement)

/**
 * Context provided to the LLM when deciding what action to take.
 */
export interface PostContext {
  /** The social network the post is on. */
  network: SocialNetwork;
  /** URL of the post being evaluated. */
  postUrl: string;
  /** Extracted text content of the post (may be truncated). */
  postText: string;
  /** Author handle/display name if available. */
  authorHandle?: string;
  /** Whether the post has media (image/video). */
  hasMedia: boolean;
  /** Source where the post was discovered (hashtag, competitor, feed, own-post). */
  source: EngagementSource;
  /** How many likes already performed this session. */
  likesThisSession: number;
  /** How many comments already performed this session. */
  commentsThisSession: number;
  /** Max likes allowed this session (from config / warmup phase). */
  likesMaxPerSession: number;
  /** Max comments allowed this session (from config / warmup phase). */
  commentsMaxPerSession: number;
  /** How many reposts already performed this session. */
  repostsThisSession?: number;
  /** Max reposts allowed this session. */
  repostsMaxPerSession?: number;
  /** How many quotes already performed this session. */
  quotesThisSession?: number;
  /** Max quotes allowed this session. */
  quotesMaxPerSession?: number;
}

/**
 * The source where a post was discovered — used for targeting rotation.
 */
export type EngagementSource =
  | 'home-feed'
  | 'hashtag'
  | 'competitor'
  | 'explore'
  | 'own-post'
  | 'notifications';

/**
 * The LLM's decision about what to do with a post.
 */
export interface ActionDecision {
  /** The action to perform. */
  action: EngagementAction;
  /** Reason for the decision (for logging / debugging). */
  reason: string;
  /** For 'comment' action — the generated comment text. */
  commentText?: string;
  /** For 'quote' action — the generated quote text. */
  quoteText?: string;
  /** Confidence 0-1 (how sure the LLM is about the action). */
  confidence: number;
}

/**
 * Port interface for LLM-driven engagement decisions.
 */
export interface IEngagementDecisionPort {
  /**
   * Decide what action to take for a post, given the context.
   * Uses the local LlmService (multi-provider fallback: Groq → OpenRouter →
   * DeepSeek → Cerebras → OpenAI → Ollama).
   */
  decideAction(context: PostContext): Promise<ActionDecision>;

  /**
   * Decide actions for multiple posts in a single LLM call (batch optimization).
   *
   * Reduces LLM calls from N (one per post) to 1 per batch.
   * The system prompt is sent once; each post is a numbered entry in the user
   * prompt. The LLM returns a JSON array of decisions.
   *
   * Budget enforcement is applied per-post after the LLM returns, using the
   * budget values from each PostContext (which should reflect the state at the
   * time the batch was submitted).
   *
   * If the implementation doesn't support batching, the caller falls back to
   * individual decideAction() calls.
   *
   * @returns Array of decisions, one per input context, in the same order.
   */
  decideActionsBatch?(contexts: PostContext[]): Promise<ActionDecision[]>;

  /**
   * Generate a contextual comment for a post in brand voice.
   * Uses the local LlmService with brand-voice.md guidelines.
   */
  generateComment(context: PostContext): Promise<string>;

  /**
   * Generate contextual quote text (commentary for a quote-post/repost) in brand voice.
   * Uses the local LlmService with brand-voice.md guidelines.
   */
  generateQuoteText(context: PostContext): Promise<string>;
}
