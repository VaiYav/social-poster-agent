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

      // If LLM decided 'comment' but didn't provide commentText, generate it
      if (decision.action === 'comment' && !decision.commentText) {
        decision.commentText = await this.generateComment(context);
      }

      // If LLM decided 'quote' but didn't provide quoteText, generate it
      if (decision.action === 'quote' && !decision.quoteText) {
        decision.quoteText = await this.generateQuoteText(context);
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
   * Falls back to a safe generic comment if LLM is unavailable.
   */
  async generateComment(context: PostContext): Promise<string> {
    if (!this.llm) {
      return this.fallbackComment();
    }

    try {
      const userPrompt = buildCommentUserPrompt(context);
      const response = await this.llm.generateChat(
        ENGAGEMENT_COMMENT_SYSTEM_PROMPT,
        userPrompt,
        { temperature: 0.7, maxTokens: 100 },
      );

      const comment = response.content.trim();

      // Validate comment — reject if it contains forbidden patterns
      if (this.isForbiddenComment(comment)) {
        this.logger.warn(`LLM generated forbidden comment, using fallback: "${comment.slice(0, 80)}"`);
        return this.fallbackComment();
      }

      return comment;
    } catch (err) {
      this.logger.warn(`LLM comment generation failed, using fallback: ${(err as Error).message.slice(0, 100)}`);
      return this.fallbackComment();
    }
  }

  /**
   * Generate a contextual quote text for a post in brand voice.
   * Falls back to a safe generic quote if LLM is unavailable.
   */
  async generateQuoteText(context: PostContext): Promise<string> {
    if (!this.llm) {
      return this.fallbackQuote();
    }

    try {
      const userPrompt = buildQuoteUserPrompt(context);
      const response = await this.llm.generateChat(
        ENGAGEMENT_QUOTE_SYSTEM_PROMPT,
        userPrompt,
        { temperature: 0.7, maxTokens: 100 },
      );

      const quote = response.content.trim();

      if (this.isForbiddenComment(quote)) {
        this.logger.warn(`LLM generated forbidden quote, using fallback: "${quote.slice(0, 80)}"`);
        return this.fallbackQuote();
      }

      return quote;
    } catch (err) {
      this.logger.warn(`LLM quote generation failed, using fallback: ${(err as Error).message.slice(0, 100)}`);
      return this.fallbackQuote();
    }
  }

  /**
   * Probabilistic fallback decision (when LLM is unavailable).
   * Uses the same distribution as the original Math.random() approach
   * but with budget awareness.
   */
  private fallbackDecision(context: PostContext): ActionDecision {
    const likesBudgetRemaining = context.likesMaxPerSession - context.likesThisSession;
    const commentsBudgetRemaining = context.commentsMaxPerSession - context.commentsThisSession;
    const repostsBudgetRemaining = (context.repostsMaxPerSession ?? 0) - (context.repostsThisSession ?? 0);
    const quotesBudgetRemaining = (context.quotesMaxPerSession ?? 0) - (context.quotesThisSession ?? 0);

    const random = Math.random();
    // Budget-adjusted probabilities (reposts and quotes are much rarer than likes/comments)
    const likeProb = likesBudgetRemaining > 0 ? 0.3 : 0;
    const commentProb = commentsBudgetRemaining > 0 ? 0.05 : 0;
    const repostProb = repostsBudgetRemaining > 0 ? 0.02 : 0;
    const quoteProb = quotesBudgetRemaining > 0 ? 0.01 : 0;

    if (random < quoteProb) {
      return { action: 'quote', reason: 'Fallback: random quote', confidence: 0.4 };
    }
    if (random < quoteProb + repostProb) {
      return { action: 'repost', reason: 'Fallback: random repost', confidence: 0.4 };
    }
    if (random < quoteProb + repostProb + commentProb) {
      return { action: 'comment', reason: 'Fallback: random comment', confidence: 0.4 };
    }
    if (random < quoteProb + repostProb + commentProb + likeProb) {
      return { action: 'like', reason: 'Fallback: random like', confidence: 0.4 };
    }
    if (random < quoteProb + repostProb + commentProb + likeProb + 0.15) {
      return { action: 'read', reason: 'Fallback: dwell and read', confidence: 0.4 };
    }
    return { action: 'scroll', reason: 'Fallback: continue scrolling', confidence: 0.4 };
  }

  /**
   * Safe fallback comment (only used when LLM is unavailable).
   */
  private fallbackComment(): string {
    // Minimal, non-generic — acknowledge the limitation
    return 'This is a really interesting take.';
  }

  /**
   * Safe fallback quote text (only used when LLM is unavailable).
   */
  private fallbackQuote(): string {
    return 'This is a sharp take — worth sharing.';
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
