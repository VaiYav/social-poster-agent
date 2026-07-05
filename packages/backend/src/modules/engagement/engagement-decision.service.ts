// EngagementDecisionService — LLM-driven implementation of IEngagementDecisionPort.
//
// Uses the local LlmService (multi-provider fallback: Groq → OpenRouter →
// DeepSeek → Cerebras → OpenAI → Ollama) to decide engagement actions and
// generate contextual comments in brand voice.
//
// Replaces the Math.random() approach in BrowsingSessionService with
// context-aware decisions that consider post content, brand relevance,
// and engagement budget.

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import {
  IEngagementDecisionPort,
  type PostContext,
  type ActionDecision,
} from '../../domain/ports/engagement-decision.port.js';
import {
  ENGAGEMENT_DECISION_SYSTEM_PROMPT,
  ENGAGEMENT_COMMENT_SYSTEM_PROMPT,
  ENGAGEMENT_QUOTE_SYSTEM_PROMPT,
  buildDecisionUserPrompt,
  buildCommentUserPrompt,
  buildQuoteUserPrompt,
  parseDecisionResponse,
  buildBatchDecisionUserPrompt,
  parseBatchDecisionResponse,
} from '../../infrastructure/llm/prompts/v0.4.0/engagement-decision.js';

@Injectable()
export class EngagementDecisionService implements IEngagementDecisionPort {
  private readonly logger = new Logger(EngagementDecisionService.name);

  constructor(@Inject(ILlmPort) @Optional() private readonly llm: ILlmPort) {}

  /**
   * Decide what action to take for a post, given the context.
   * Falls back to 'scroll' if LLM is unavailable or fails.
   */
  async decideAction(context: PostContext): Promise<ActionDecision> {
    if (!this.llm) {
      // No LLM configured — fall back to probabilistic decision
      return this.fallbackDecision(context);
    }

    try {
      const userPrompt = buildDecisionUserPrompt(context);
      const response = await this.llm.generateChat(
        ENGAGEMENT_DECISION_SYSTEM_PROMPT,
        userPrompt,
        { temperature: 0.3, maxTokens: 200 },
      );

      const decision = parseDecisionResponse(response.content);

      // If the LLM is non-committal about a non-engaging action, use the probabilistic
      // fallback so the session doesn't end up with zero interactions. The LLM still
      // gets to skip confidently when a post is clearly irrelevant.
      const nonEngagingActions = ['scroll', 'read', 'skip'];
      if (nonEngagingActions.includes(decision.action) && decision.confidence < 0.6) {
        this.logger.debug(`LLM was non-committal (${decision.action}, confidence ${decision.confidence}) — using fallback decision`);
        return this.fallbackDecision(context);
      }

      // Budget enforcement — even if LLM says "like" / "comment" / "repost" / "quote", respect the budget
      if (decision.action === 'like' && context.likesThisSession >= context.likesMaxPerSession) {
        this.logger.debug(`LLM said 'like' but budget exhausted — downgrading to 'read'`);
        return { action: 'read', reason: 'Like budget exhausted', confidence: 0.8 };
      }
      if (decision.action === 'comment' && context.commentsThisSession >= context.commentsMaxPerSession) {
        this.logger.debug(`LLM said 'comment' but budget exhausted — downgrading to 'read'`);
        return { action: 'read', reason: 'Comment budget exhausted', confidence: 0.8 };
      }
      const repostsMax = context.repostsMaxPerSession ?? 0;
      if (decision.action === 'repost' && (context.repostsThisSession ?? 0) >= repostsMax) {
        this.logger.debug(`LLM said 'repost' but budget exhausted — downgrading to 'read'`);
        return { action: 'read', reason: 'Repost budget exhausted', confidence: 0.8 };
      }
      const quotesMax = context.quotesMaxPerSession ?? 0;
      if (decision.action === 'quote' && (context.quotesThisSession ?? 0) >= quotesMax) {
        this.logger.debug(`LLM said 'quote' but budget exhausted — downgrading to 'read'`);
        return { action: 'read', reason: 'Quote budget exhausted', confidence: 0.8 };
      }

      // If LLM decided 'comment' but didn't provide commentText, generate it.
      // If generation fails (returns null), downgrade to like (or read if like
      // budget exhausted) — never post a generic fallback comment.
      if (decision.action === 'comment' && !decision.commentText) {
        const comment = await this.generateComment(context);
        if (comment === null) {
          if (context.likesThisSession < context.likesMaxPerSession) {
            this.logger.warn(`LLM comment generation failed — downgrading comment → like`);
            return { action: 'like', reason: 'Comment generation failed, downgraded to like', confidence: 0.6 };
          }
          this.logger.warn(`LLM comment generation failed and like budget exhausted — downgrading comment → read`);
          return { action: 'read', reason: 'Comment generation failed, like budget exhausted', confidence: 0.6 };
        }
        decision.commentText = comment;
      }

      // If LLM decided 'quote' but didn't provide quoteText, generate it.
      // If generation fails (returns null), downgrade to read — never post a
      // generic fallback quote.
      if (decision.action === 'quote' && !decision.quoteText) {
        const quote = await this.generateQuoteText(context);
        if (quote === null) {
          this.logger.warn(`LLM quote generation failed — downgrading quote → read`);
          return { action: 'read', reason: 'Quote generation failed, downgraded to read', confidence: 0.6 };
        }
        decision.quoteText = quote;
      }

      this.logger.debug(
        `Decision for ${context.network} post: ${decision.action} (confidence: ${decision.confidence}) — ${decision.reason}`,
      );
      return decision;
    } catch (err) {
      this.logger.warn(`LLM decision failed, using fallback: ${(err as Error).message.slice(0, 100)}`);
      return this.fallbackDecision(context);
    }
  }

  /**
   * Batch decision — decides actions for multiple posts in a single LLM call.
   *
   * Sends all posts in one user prompt; the LLM returns a JSON array of decisions.
   * Budget enforcement is applied per-post after parsing, using the budget values
   * from each PostContext.
   *
   * Falls back to individual decideAction() calls if the LLM is unavailable or
   * the batch call fails.
   */
  async decideActionsBatch(contexts: PostContext[]): Promise<ActionDecision[]> {
    if (contexts.length === 0) return [];

    // No LLM — fall back to individual fallback decisions
    if (!this.llm) {
      return contexts.map((ctx) => this.fallbackDecision(ctx));
    }

    try {
      const userPrompt = buildBatchDecisionUserPrompt(contexts);
      const response = await this.llm.generateChat(
        ENGAGEMENT_DECISION_SYSTEM_PROMPT,
        userPrompt,
        { temperature: 0.3, maxTokens: 200 * contexts.length },
      );

      const decisions = parseBatchDecisionResponse(response.content, contexts.length);

      // Budget enforcement per-post (same logic as decideAction)
      return decisions.map((decision, i) => {
        const ctx = contexts[i]!;

        if (decision.action === 'like' && ctx.likesThisSession >= ctx.likesMaxPerSession) {
          this.logger.debug(`Batch: LLM said 'like' but budget exhausted — downgrading to 'read'`);
          return { action: 'read' as const, reason: 'Like budget exhausted', confidence: 0.8 };
        }
        if (decision.action === 'comment' && ctx.commentsThisSession >= ctx.commentsMaxPerSession) {
          this.logger.debug(`Batch: LLM said 'comment' but budget exhausted — downgrading to 'read'`);
          return { action: 'read' as const, reason: 'Comment budget exhausted', confidence: 0.8 };
        }
        if (decision.action === 'repost' && (ctx.repostsThisSession ?? 0) >= (ctx.repostsMaxPerSession ?? 0)) {
          this.logger.debug(`Batch: LLM said 'repost' but budget exhausted — downgrading to 'read'`);
          return { action: 'read' as const, reason: 'Repost budget exhausted', confidence: 0.8 };
        }
        if (decision.action === 'quote' && (ctx.quotesThisSession ?? 0) >= (ctx.quotesMaxPerSession ?? 0)) {
          this.logger.debug(`Batch: LLM said 'quote' but budget exhausted — downgrading to 'read'`);
          return { action: 'read' as const, reason: 'Quote budget exhausted', confidence: 0.8 };
        }

        return decision;
      });
    } catch (err) {
      this.logger.warn(`LLM batch decision failed, falling back to individual: ${(err as Error).message.slice(0, 100)}`);
      // Fall back to individual calls (which have their own fallback logic)
      return Promise.all(contexts.map((ctx) => this.decideAction(ctx)));
    }
  }

  /**
   * Generate a contextual comment for a post in brand voice.
   * Returns `null` when the LLM is unavailable or fails — callers MUST downgrade
   * the action (comment → like → read) rather than posting a generic fallback.
   * Identical robotic comments on every post are worse than no comment at all.
   */
  async generateComment(context: PostContext): Promise<string | null> {
    if (!this.llm) {
      this.logger.warn('No LLM configured — generateComment returns null');
      return null;
    }

    try {
      const userPrompt = buildCommentUserPrompt(context);
      const response = await this.llm.generateChat(
        ENGAGEMENT_COMMENT_SYSTEM_PROMPT,
        userPrompt,
        { temperature: 0.7, maxTokens: 100 },
      );

      const comment = response.content.trim();

      if (!comment) {
        this.logger.warn('LLM returned empty comment — generateComment returns null');
        return null;
      }

      // Validate comment — reject if it contains forbidden patterns
      if (this.isForbiddenComment(comment)) {
        this.logger.warn(`LLM generated forbidden comment, returning null: "${comment.slice(0, 80)}"`);
        return null;
      }

      return comment;
    } catch (err) {
      this.logger.warn(`LLM comment generation failed, returning null: ${(err as Error).message.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Generate a contextual quote text for a post in brand voice.
   * Returns `null` when the LLM is unavailable or fails — callers MUST downgrade
   * the action (quote → read) rather than posting a generic fallback.
   */
  async generateQuoteText(context: PostContext): Promise<string | null> {
    if (!this.llm) {
      this.logger.warn('No LLM configured — generateQuoteText returns null');
      return null;
    }

    try {
      const userPrompt = buildQuoteUserPrompt(context);
      const response = await this.llm.generateChat(
        ENGAGEMENT_QUOTE_SYSTEM_PROMPT,
        userPrompt,
        { temperature: 0.7, maxTokens: 100 },
      );

      const quote = response.content.trim();

      if (!quote) {
        this.logger.warn('LLM returned empty quote — generateQuoteText returns null');
        return null;
      }

      if (this.isForbiddenComment(quote)) {
        this.logger.warn(`LLM generated forbidden quote, returning null: "${quote.slice(0, 80)}"`);
        return null;
      }

      return quote;
    } catch (err) {
      this.logger.warn(`LLM quote generation failed, returning null: ${(err as Error).message.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Probabilistic fallback decision (when LLM is unavailable).
   * Uses the same distribution as the original Math.random() approach
   * but with budget awareness.
   *
   * NOTE: 'comment' and 'quote' are intentionally excluded — they require
   * LLM-generated text, and posting a generic hardcoded fallback on every
   * post is worse than not commenting at all.
   */
  private fallbackDecision(context: PostContext): ActionDecision {
    const likesBudgetRemaining = context.likesMaxPerSession - context.likesThisSession;

    const random = Math.random();
    const likeProb = likesBudgetRemaining > 0 ? 0.3 : 0;

    if (random < likeProb) {
      return { action: 'like', reason: 'Fallback: random like', confidence: 0.4 };
    }
    if (random < likeProb + 0.15) {
      return { action: 'read', reason: 'Fallback: dwell and read', confidence: 0.4 };
    }
    return { action: 'scroll', reason: 'Fallback: continue scrolling', confidence: 0.4 };
  }

  /**
   * Check if a comment contains forbidden patterns (self-promo, links, spam).
   */
  private isForbiddenComment(comment: string): boolean {
    const lower = comment.toLowerCase();
    const forbidden = [
      'my-zodiac-ai.com', 'myzodiacai.com', 'myzodiac.ai', 'check out our', 'check out my',
      'http://', 'https://', 'bit.ly', 'tinyurl',
      'great post', 'love this', 'thanks for sharing', 'spot on',
      'this resonates', 'very interesting',
    ];
    return forbidden.some((f) => lower.includes(f));
  }
}
