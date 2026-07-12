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
import { ConfigService } from '@nestjs/config';
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
  parseCommentResponse,
  parseQuoteResponse,
} from '../../infrastructure/llm/prompts/v0.4.0/engagement-decision.js';
import { matchesScript, normalizeLanguage } from '../../infrastructure/util/script-check.js';
import { detectLanguage, isLanguageDetectable } from '../../infrastructure/util/language-detector.js';

@Injectable()
export class EngagementDecisionService implements IEngagementDecisionPort {
  private readonly logger = new Logger(EngagementDecisionService.name);
  private readonly commentTemperature: number;
  private readonly quoteTemperature: number;

  constructor(
    @Inject(ILlmPort) @Optional() private readonly llm: ILlmPort,
    private readonly configService: ConfigService,
  ) {
    this.commentTemperature = Number(this.configService.get('ENGAGEMENT_COMMENT_TEMPERATURE', 0.8));
    this.quoteTemperature = Number(this.configService.get('ENGAGEMENT_QUOTE_TEMPERATURE', 0.8));
  }

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
      const budgetOverride = this.enforceBudget(decision, context);
      if (budgetOverride) return budgetOverride;

      // If LLM decided 'comment', ensure commentText exists and is in the right language.
      // If generation fails (returns null), downgrade to like (or read if like
      // budget exhausted) — never post a generic fallback comment.
      if (decision.action === 'comment') {
        const comment = await this.validateOrGenerateText(context, decision.commentText, 'comment');
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

      // If LLM decided 'quote', ensure quoteText exists and is in the right language.
      // If generation fails (returns null), downgrade to read — never post a
      // generic fallback quote.
      if (decision.action === 'quote') {
        const quote = await this.validateOrGenerateText(context, decision.quoteText, 'quote');
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

      // Budget enforcement per-post (same logic as decideAction) plus language validation
      // for any comment/quote text the batch decision produced.
      return await Promise.all(
        decisions.map(async (decision, i) => {
          const ctx = contexts[i]!;
          const budgetOverride = this.enforceBudget(decision, ctx);
          if (budgetOverride) return budgetOverride;

          if (decision.action === 'comment') {
            const text = await this.validateOrGenerateText(ctx, decision.commentText, 'comment');
            if (text === null) {
              if (ctx.likesThisSession < ctx.likesMaxPerSession) {
                return { action: 'like' as const, reason: 'Comment generation failed in batch', confidence: 0.6 };
              }
              return { action: 'read' as const, reason: 'Comment generation failed in batch', confidence: 0.6 };
            }
            decision.commentText = text;
          }

          if (decision.action === 'quote') {
            const text = await this.validateOrGenerateText(ctx, decision.quoteText, 'quote');
            if (text === null) {
              return { action: 'read' as const, reason: 'Quote generation failed in batch', confidence: 0.6 };
            }
            decision.quoteText = text;
          }

          return decision;
        }),
      );
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
      const detectedLanguage = detectLanguage(context.postText);
      const systemPrompt = ENGAGEMENT_COMMENT_SYSTEM_PROMPT.replaceAll('{detectedLanguage}', detectedLanguage);
      const userPrompt = buildCommentUserPrompt(context);
      const response = await this.llm.generateChat(
        systemPrompt,
        userPrompt,
        { temperature: this.commentTemperature, maxTokens: 150 },
      );

      const { language, comment } = parseCommentResponse(response.content);

      if (!comment) {
        this.logger.warn('LLM returned empty comment — generateComment returns null');
        return null;
      }

      // Post-validation: verify the comment's script matches the detected language.
      // Catches the #1 bot tell — commenting in English on a non-English post.
      // If the LLM echoed a different language code, trust the deterministic detector.
      return this.validateGeneratedText(comment, language, detectedLanguage, 'comment');
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
      const detectedLanguage = detectLanguage(context.postText);
      const systemPrompt = ENGAGEMENT_QUOTE_SYSTEM_PROMPT.replaceAll('{detectedLanguage}', detectedLanguage);
      const userPrompt = buildQuoteUserPrompt(context);
      const response = await this.llm.generateChat(
        systemPrompt,
        userPrompt,
        { temperature: this.quoteTemperature, maxTokens: 150 },
      );

      const { language, quote } = parseQuoteResponse(response.content);

      if (!quote) {
        this.logger.warn('LLM returned empty quote — generateQuoteText returns null');
        return null;
      }

      // Post-validation: verify the quote's script matches the detected language.
      // Trust the deterministic detector if the LLM echoed a different code.
      return this.validateGeneratedText(quote, language, detectedLanguage, 'quote');
    } catch (err) {
      this.logger.warn(`LLM quote generation failed, returning null: ${(err as Error).message.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Validate a piece of text provided by a decision LLM. If it is missing or fails
   * language/script validation, generate a fresh one via the dedicated generation prompt.
   */
  private async validateOrGenerateText(
    context: PostContext,
    existingText: string | undefined,
    kind: 'comment' | 'quote',
  ): Promise<string | null> {
    const detectedLanguage = detectLanguage(context.postText);
    if (existingText) {
      const validated = this.validateGeneratedText(existingText, undefined, detectedLanguage, kind);
      if (validated) return validated;
      this.logger.warn(`LLM ${kind} text failed language validation, generating new ${kind}`);
    }
    return kind === 'comment' ? this.generateComment(context) : this.generateQuoteText(context);
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
      'great post', 'love this', 'love this post', 'thanks for sharing', 'spot on',
      'this resonates', 'very interesting',
      'nice one', 'well said', 'good point', 'great point', 'what a post',
      'agreed', 'absolutely', 'exactly', 'totally', 'so true', 'makes sense',
      'thanks', 'thank you',
    ];
    return forbidden.some((f) => lower.includes(f));
  }

  /**
   * Post-validation: verify that the LLM-generated text uses the script of the
   * target language. Catches the #1 bot tell — English text returned for a
   * non-English post/comment.
   *
   * @param text - The generated comment/quote text
   * @param language - The target language code (always normalized to the detected post language)
   * @param kind - 'comment' or 'quote' (for logging only)
   * @returns true if the script matches
   */
  private validateScriptMatch(text: string, language: string, kind: 'comment' | 'quote'): boolean {
    const lang = normalizeLanguage(language);
    if (matchesScript(text, lang)) return true;
    this.logger.warn(
      `${kind[0]!.toUpperCase() + kind.slice(1)} script mismatch: language=${lang}, ${kind}="${text.slice(0, 60)}" — returning null`,
    );
    return false;
  }

  /**
   * Shared post-processing for LLM-generated comment/quote text.
   * Validates detected language, script, and forbidden patterns.
   * The generated text must match the post's detected language. When the text is
   * too short for reliable language detection we keep the script+forbidden checks.
   */
  private validateGeneratedText(
    text: string,
    language: string | undefined,
    detectedLanguage: string,
    kind: 'comment' | 'quote',
  ): string | null {
    // The source of truth is the deterministic language detector on the post text;
    // the LLM's self-reported language is advisory only.
    const outputLanguage = language === detectedLanguage ? language : detectedLanguage;
    if (language && language !== detectedLanguage) {
      this.logger.warn(
        `${kind[0]!.toUpperCase() + kind.slice(1)} language mismatch: LLM said ${language}, detector said ${detectedLanguage} — using ${outputLanguage}`,
      );
    }

    if (!this.validateScriptMatch(text, outputLanguage, kind)) {
      return null;
    }

    if (this.isForbiddenComment(text)) {
      this.logger.warn(`LLM generated forbidden ${kind}, returning null: "${text.slice(0, 80)}"`);
      return null;
    }

    // For detectable text of reasonable length, run the actual language detector on the
    // generated text to catch Latin-to-Latin mismatches (e.g. English on Spanish).
    if (text.length >= 15 && isLanguageDetectable(text)) {
      const generatedLang = detectLanguage(text);
      if (generatedLang !== outputLanguage) {
        this.logger.warn(
          `${kind[0]!.toUpperCase() + kind.slice(1)} language mismatch: generated ${generatedLang}, expected ${outputLanguage} — "${text.slice(0, 80)}"`,
        );
        return null;
      }
    }

    return text;
  }

  /**
   * Enforce per-session engagement budget for a single decision.
   * Returns a downgraded 'read' decision if the chosen action is over budget.
   */
  private enforceBudget(decision: ActionDecision, context: PostContext): ActionDecision | null {
    if (decision.action === 'like' && context.likesThisSession >= context.likesMaxPerSession) {
      this.logger.debug(`LLM said 'like' but budget exhausted — downgrading to 'read'`);
      return { action: 'read', reason: 'Like budget exhausted', confidence: 0.8 };
    }
    if (decision.action === 'comment' && context.commentsThisSession >= context.commentsMaxPerSession) {
      this.logger.debug(`LLM said 'comment' but budget exhausted — downgrading to 'read'`);
      return { action: 'read', reason: 'Comment budget exhausted', confidence: 0.8 };
    }
    if (decision.action === 'repost' && (context.repostsThisSession ?? 0) >= (context.repostsMaxPerSession ?? 0)) {
      this.logger.debug(`LLM said 'repost' but budget exhausted — downgrading to 'read'`);
      return { action: 'read', reason: 'Repost budget exhausted', confidence: 0.8 };
    }
    if (decision.action === 'quote' && (context.quotesThisSession ?? 0) >= (context.quotesMaxPerSession ?? 0)) {
      this.logger.debug(`LLM said 'quote' but budget exhausted — downgrading to 'read'`);
      return { action: 'read', reason: 'Quote budget exhausted', confidence: 0.8 };
    }
    return null;
  }
}
