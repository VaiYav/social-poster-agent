// EngagementDecisionService — LLM-driven implementation of IEngagementDecisionPort.
//
// Uses the local LlmService (multi-provider fallback: Groq → OpenRouter →
// DeepSeek → Cerebras → OpenAI → Ollama) to decide engagement actions and
// generate contextual comments in brand voice.
//
// Replaces the Math.random() approach in BrowsingSessionService with
// context-aware decisions that consider post content, brand relevance,
// and engagement budget.

import { Injectable, Logger, Inject, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ILlmPort } from "../../domain/ports/llm.port.js";
import { IPromptPort, type CompiledChatPrompt } from "../../domain/ports/prompt.port.js";
import {
  IEngagementDecisionPort,
  type PostContext,
  type ActionDecision,
} from "../../domain/ports/engagement-decision.port.js";
import {
  ENGAGEMENT_DECISION_PROMPT,
  ENGAGEMENT_BATCH_DECISION_PROMPT,
  ENGAGEMENT_COMMENT_PROMPT,
  ENGAGEMENT_QUOTE_PROMPT,
  COMMENT_JUDGE_PROMPT,
  parseDecisionResponse,
  parseBatchDecisionResponse,
  parseCommentResponse,
  parseQuoteResponse,
  parseCommentJudgeResponse,
} from "../../infrastructure/llm/prompts/v0.4.0/engagement-decision.js";
import { interpolate } from "../../domain/prompt-interpolation.js";
import { sanitizeUntrustedInput } from "../../infrastructure/llm/sanitize-untrusted-input.js";
import { matchesScript, normalizeLanguage } from "../../infrastructure/util/script-check.js";
import {
  detectLanguage,
  isLanguageDetectable,
} from "../../infrastructure/util/language-detector.js";
import { EngagementSafetyService } from "./engagement-safety.service.js";

@Injectable()
export class EngagementDecisionService implements IEngagementDecisionPort {
  private readonly logger = new Logger(EngagementDecisionService.name);
  private readonly commentTemperature: number;
  private readonly quoteTemperature: number;
  private readonly commentJudgeMinScore: number;
  private readonly commentFirst: boolean;

  constructor(
    @Inject(ILlmPort) @Optional() private readonly llm: ILlmPort,
    private readonly configService: ConfigService,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
    private readonly engagementSafetyService: EngagementSafetyService = new EngagementSafetyService(),
  ) {
    this.commentTemperature = Number(this.configService.get("ENGAGEMENT_COMMENT_TEMPERATURE", 0.8));
    this.quoteTemperature = Number(this.configService.get("ENGAGEMENT_QUOTE_TEMPERATURE", 0.8));
    const rawMin = Number(this.configService.get("COMMENT_JUDGE_MIN_SCORE", "0.6"));
    this.commentJudgeMinScore =
      Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 1 ? rawMin : 0.6;
    this.commentFirst =
      this.configService.get<string>("ENGAGEMENT_COMMENT_FIRST", "false") === "true";
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
      const detectedLanguage = detectLanguage(context.postText);
      const compiled = await this.getCompiledChat(
        "engagement-decision",
        {
          network: context.network,
          source: sanitizeUntrustedInput(context.source, 80),
          authorHandle: sanitizeUntrustedInput(context.authorHandle ?? "unknown", 80),
          hasMedia: String(context.hasMedia),
          postText: sanitizeUntrustedInput(context.postText, 500),
          detectedLanguage,
          likesThisSession: String(context.likesThisSession),
          likesMaxPerSession: String(context.likesMaxPerSession),
          commentsThisSession: String(context.commentsThisSession),
          commentsMaxPerSession: String(context.commentsMaxPerSession),
          repostsThisSession: String(context.repostsThisSession ?? 0),
          repostsMaxPerSession: String(context.repostsMaxPerSession ?? 0),
          quotesThisSession: String(context.quotesThisSession ?? 0),
          quotesMaxPerSession: String(context.quotesMaxPerSession ?? 0),
          discussionsThisSession: String(
            context.discussionsThisSession ??
              (context.repostsThisSession ?? 0) + (context.quotesThisSession ?? 0),
          ),
          discussionsMaxPerSession: String(
            context.discussionsMaxPerSession ??
              (context.repostsMaxPerSession ?? 0) + (context.quotesMaxPerSession ?? 0),
          ),
        },
        ENGAGEMENT_DECISION_PROMPT,
      );
      const response = await this.llm.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: 0.3,
        maxTokens: 120,
        accountId: context.accountId,
      });

      const decision = parseDecisionResponse(response.content);

      if (decision.action === "comment" && !this.isEnglishPost(context)) {
        this.logger.debug("Skipping comment: source post is not English");
        return {
          action: "read",
          reason: "Comments are restricted to English posts",
          confidence: 1,
        };
      }

      const preferredComment = await this.preferCommentWhenConfigured(decision, context);
      if (preferredComment) return preferredComment;

      // If the LLM is non-committal about a non-engaging action, use the probabilistic
      // fallback so the session doesn't end up with zero interactions. The LLM still
      // gets to skip confidently when a post is clearly irrelevant.
      const nonEngagingActions = ["scroll", "read", "skip"];
      if (nonEngagingActions.includes(decision.action) && decision.confidence < 0.6) {
        this.logger.debug(
          `LLM was non-committal (${decision.action}, confidence ${decision.confidence}) — using fallback decision`,
        );
        return this.fallbackDecision(context);
      }

      // Budget enforcement — even if LLM says "like" / "comment" / "repost" / "quote", respect the budget
      const budgetOverride = this.enforceBudget(decision, context);
      if (budgetOverride) return budgetOverride;

      // If LLM decided 'comment', ensure commentText exists and is in the right language.
      // If generation fails (returns null), downgrade to like (or read if like
      // budget exhausted) — never post a generic fallback comment.
      if (decision.action === "comment") {
        const comment = await this.validateOrGenerateText(context, decision.commentText, "comment");
        if (comment === null) {
          if (context.likesThisSession < context.likesMaxPerSession) {
            this.logger.warn(`LLM comment generation failed — downgrading comment → like`);
            return {
              action: "like",
              reason: "Comment generation failed, downgraded to like",
              confidence: 0.6,
            };
          }
          this.logger.warn(
            `LLM comment generation failed and like budget exhausted — downgrading comment → read`,
          );
          return {
            action: "read",
            reason: "Comment generation failed, like budget exhausted",
            confidence: 0.6,
          };
        }
        decision.commentText = comment;
      }

      // If LLM decided 'quote', ensure quoteText exists and is in the right language.
      // If generation fails (returns null), downgrade to read — never post a
      // generic fallback quote.
      if (decision.action === "quote") {
        const quote = await this.validateOrGenerateText(context, decision.quoteText, "quote");
        if (quote === null) {
          this.logger.warn(`LLM quote generation failed — downgrading quote → read`);
          return {
            action: "read",
            reason: "Quote generation failed, downgraded to read",
            confidence: 0.6,
          };
        }
        decision.quoteText = quote;
      }

      this.logger.debug(
        `Decision for ${context.network} post: ${decision.action} (confidence: ${decision.confidence}) — ${decision.reason}`,
      );
      return decision;
    } catch (err) {
      this.logger.warn(
        `LLM decision failed, using fallback: ${(err as Error).message.slice(0, 100)}`,
      );
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
      const compiled = await this.getCompiledChat(
        "engagement-batch-decision",
        {
          count: String(contexts.length),
          posts: this.buildBatchPostsVariable(contexts),
        },
        ENGAGEMENT_BATCH_DECISION_PROMPT,
      );
      const response = await this.llm.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: 0.3,
        maxTokens: 120 * contexts.length,
        accountId: contexts[0]?.accountId,
      });

      const decisions = parseBatchDecisionResponse(response.content, contexts.length);

      // Budget enforcement per-post (same logic as decideAction) plus language validation
      // for any comment/quote text the batch decision produced.
      return await Promise.all(
        decisions.map(async (decision, i) => {
          const ctx = contexts[i]!;
          if (decision.action === "comment" && !this.isEnglishPost(ctx)) {
            return {
              action: "read" as const,
              reason: "Comments are restricted to English posts",
              confidence: 1,
            };
          }
          const preferredComment = await this.preferCommentWhenConfigured(decision, ctx);
          if (preferredComment) return preferredComment;
          const budgetOverride = this.enforceBudget(decision, ctx);
          if (budgetOverride) return budgetOverride;

          if (decision.action === "comment") {
            const text = await this.validateOrGenerateText(ctx, decision.commentText, "comment");
            if (text === null) {
              if (ctx.likesThisSession < ctx.likesMaxPerSession) {
                return {
                  action: "like" as const,
                  reason: "Comment generation failed in batch",
                  confidence: 0.6,
                };
              }
              return {
                action: "read" as const,
                reason: "Comment generation failed in batch",
                confidence: 0.6,
              };
            }
            decision.commentText = text;
          }

          if (decision.action === "quote") {
            const text = await this.validateOrGenerateText(ctx, decision.quoteText, "quote");
            if (text === null) {
              return {
                action: "read" as const,
                reason: "Quote generation failed in batch",
                confidence: 0.6,
              };
            }
            decision.quoteText = text;
          }

          return decision;
        }),
      );
    } catch (err) {
      this.logger.warn(
        `LLM batch decision failed, falling back to individual: ${(err as Error).message.slice(0, 100)}`,
      );
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
    if (!this.isEnglishPost(context)) {
      this.logger.debug("Skipping comment: source post is not English");
      return null;
    }
    if (!this.llm) {
      this.logger.warn("No LLM configured — generateComment returns null");
      return null;
    }

    try {
      const detectedLanguage = detectLanguage(context.postText);
      const compiled = await this.getCompiledChat(
        "engagement-comment",
        {
          network: context.network,
          authorHandle: sanitizeUntrustedInput(context.authorHandle ?? "unknown", 80),
          postText: sanitizeUntrustedInput(context.postText, 500),
          detectedLanguage,
        },
        ENGAGEMENT_COMMENT_PROMPT,
      );
      const response = await this.llm.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: this.commentTemperature,
        maxTokens: 120,
        accountId: context.accountId,
      });

      const { language, comment } = parseCommentResponse(response.content);

      if (!comment) {
        this.logger.warn("LLM returned empty comment — generateComment returns null");
        return null;
      }

      // Post-validation: verify the comment's script matches the detected language.
      // Catches the #1 bot tell — commenting in English on a non-English post.
      // If the LLM echoed a different language code, trust the deterministic detector.
      return this.validateGeneratedText(comment, language, detectedLanguage, "comment");
    } catch (err) {
      this.logger.warn(
        `LLM comment generation failed, returning null: ${(err as Error).message.slice(0, 100)}`,
      );
      return null;
    }
  }

  /**
   * Generate a contextual quote text for a post in brand voice.
   * Returns `null` when the LLM is unavailable or fails — callers MUST downgrade
   * the action (quote → read) rather than posting a generic fallback.
   */
  async generateQuoteText(context: PostContext): Promise<string | null> {
    if (!this.isEnglishPost(context)) {
      this.logger.debug("Skipping quote: source post is not English");
      return null;
    }
    if (!this.llm) {
      this.logger.warn("No LLM configured — generateQuoteText returns null");
      return null;
    }

    try {
      const detectedLanguage = detectLanguage(context.postText);
      const compiled = await this.getCompiledChat(
        "engagement-quote",
        {
          network: context.network,
          authorHandle: sanitizeUntrustedInput(context.authorHandle ?? "unknown", 80),
          postText: sanitizeUntrustedInput(context.postText, 500),
          detectedLanguage,
        },
        ENGAGEMENT_QUOTE_PROMPT,
      );
      const response = await this.llm.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: this.quoteTemperature,
        maxTokens: 120,
        accountId: context.accountId,
      });

      const { language, quote } = parseQuoteResponse(response.content);

      if (!quote) {
        this.logger.warn("LLM returned empty quote — generateQuoteText returns null");
        return null;
      }

      // Post-validation: verify the quote's script matches the detected language.
      // Trust the deterministic detector if the LLM echoed a different code.
      return this.validateGeneratedText(quote, language, detectedLanguage, "quote");
    } catch (err) {
      this.logger.warn(
        `LLM quote generation failed, returning null: ${(err as Error).message.slice(0, 100)}`,
      );
      return null;
    }
  }

  /**
   * P0: Judge a generated comment before it is published.
   * Returns approved=true only when the comment is relevant, human-sounding,
   * safe (no spam/self-promo), and language-matched. Uses a score threshold
   * from COMMENT_JUDGE_MIN_SCORE env (default 0.6).
   */
  async judgeComment(
    context: PostContext,
    commentText: string,
  ): Promise<{ approved: boolean; reason: string; score: number }> {
    if (!this.llm) {
      this.logger.warn("No LLM configured — comment judge rejects by default");
      return { approved: false, reason: "No LLM configured for comment judge", score: 0 };
    }

    try {
      const detectedLanguage = detectLanguage(context.postText);
      const compiled = await this.getCompiledChat(
        "comment-judge",
        {
          network: context.network,
          postText: sanitizeUntrustedInput(context.postText, 500),
          detectedLanguage,
          commentText: sanitizeUntrustedInput(commentText, 500),
        },
        COMMENT_JUDGE_PROMPT,
      );

      const response = await this.llm.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: 0.3,
        maxTokens: 120,
        accountId: context.accountId,
      });

      const judged = parseCommentJudgeResponse(response.content);
      const approved = judged.approved && judged.score >= this.commentJudgeMinScore;
      this.logger.debug(
        `Comment judge: approved=${approved}, score=${judged.score.toFixed(2)}, reason=${judged.reason}`,
      );
      return { approved, reason: judged.reason, score: judged.score };
    } catch (err) {
      this.logger.warn(
        `Comment judge failed, rejecting by default: ${(err as Error).message.slice(0, 100)}`,
      );
      return { approved: false, reason: "Comment judge failed", score: 0 };
    }
  }

  /**
   * Validate a piece of text provided by a decision LLM. If it is missing or fails
   * language/script validation, generate a fresh one via the dedicated generation prompt.
   */
  private async validateOrGenerateText(
    context: PostContext,
    existingText: string | undefined,
    kind: "comment" | "quote",
  ): Promise<string | null> {
    const detectedLanguage = detectLanguage(context.postText);
    if (existingText) {
      const validated = this.validateGeneratedText(existingText, undefined, detectedLanguage, kind);
      if (validated) return validated;
      this.logger.warn(`LLM ${kind} text failed language validation, generating new ${kind}`);
    }
    return kind === "comment" ? this.generateComment(context) : this.generateQuoteText(context);
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
      return { action: "like", reason: "Fallback: random like", confidence: 0.4 };
    }
    if (random < likeProb + 0.15) {
      return { action: "read", reason: "Fallback: dwell and read", confidence: 0.4 };
    }
    return { action: "scroll", reason: "Fallback: continue scrolling", confidence: 0.4 };
  }

  private async preferCommentWhenConfigured(
    decision: ActionDecision,
    context: PostContext,
  ): Promise<ActionDecision | null> {
    if (
      !this.commentFirst ||
      !this.isEnglishPost(context) ||
      context.commentsThisSession >= context.commentsMaxPerSession ||
      decision.action === "comment" ||
      decision.action === "repost" ||
      decision.action === "quote"
    ) {
      return null;
    }

    const comment = await this.validateOrGenerateText(context, decision.commentText, "comment");
    if (!comment) return null;

    this.logger.debug("Comment-first policy: converting non-comment action to contextual comment");
    return {
      action: "comment",
      commentText: comment,
      reason: "Comment-first policy",
      confidence: Math.max(decision.confidence, 0.6),
    };
  }

  private isEnglishPost(context: PostContext): boolean {
    return detectLanguage(context.postText) === "en";
  }

  /**
   * Check if a comment contains forbidden patterns (self-promo, links, spam).
   */
  private isForbiddenComment(comment: string): boolean {
    const lower = comment.toLowerCase();
    const forbidden = [
      "check out our",
      "check out my",
      "http://",
      "https://",
      "bit.ly",
      "tinyurl",
      "great post",
      "love this",
      "love this post",
      "thanks for sharing",
      "spot on",
      "this resonates",
      "very interesting",
      "nice one",
      "well said",
      "good point",
      "great point",
      "what a post",
      "agreed",
      "absolutely",
      "exactly",
      "totally",
      "so true",
      "makes sense",
      "thanks",
      "thank you",
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
  private validateScriptMatch(text: string, language: string, kind: "comment" | "quote"): boolean {
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
    kind: "comment" | "quote",
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

    // F1 safety: block self-promo, troll/spam, sensitive, or low-value generated text.
    const safety = this.engagementSafetyService.checkContentSafety(text);
    if (!safety.safe) {
      this.logger.warn(`LLM generated unsafe ${kind}, returning null: ${safety.reason}`);
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
    if (decision.action === "like" && context.likesThisSession >= context.likesMaxPerSession) {
      this.logger.debug(`LLM said 'like' but budget exhausted — downgrading to 'read'`);
      return { action: "read", reason: "Like budget exhausted", confidence: 0.8 };
    }
    if (
      decision.action === "comment" &&
      context.commentsThisSession >= context.commentsMaxPerSession
    ) {
      this.logger.debug(`LLM said 'comment' but budget exhausted — downgrading to 'read'`);
      return { action: "read", reason: "Comment budget exhausted", confidence: 0.8 };
    }
    if (
      decision.action === "repost" &&
      (context.repostsThisSession ?? 0) >= (context.repostsMaxPerSession ?? 0)
    ) {
      this.logger.debug(`LLM said 'repost' but budget exhausted — downgrading to 'read'`);
      return { action: "read", reason: "Repost budget exhausted", confidence: 0.8 };
    }
    if (
      decision.action === "quote" &&
      (context.quotesThisSession ?? 0) >= (context.quotesMaxPerSession ?? 0)
    ) {
      this.logger.debug(`LLM said 'quote' but budget exhausted — downgrading to 'read'`);
      return { action: "read", reason: "Quote budget exhausted", confidence: 0.8 };
    }
    // F1: discussions = repost + quote combined. If a session has e.g. reposts=1/quotes=1,
    // the combined discussion budget may be 1, so a quote after a repost must be blocked.
    if (decision.action === "repost" || decision.action === "quote") {
      const discussionsThisSession =
        context.discussionsThisSession ??
        (context.repostsThisSession ?? 0) + (context.quotesThisSession ?? 0);
      const discussionsMaxPerSession =
        context.discussionsMaxPerSession ??
        (context.repostsMaxPerSession ?? 0) + (context.quotesMaxPerSession ?? 0);
      if (discussionsThisSession >= discussionsMaxPerSession) {
        this.logger.debug(
          `LLM said '${decision.action}' but discussion budget exhausted — downgrading to 'read'`,
        );
        return { action: "read", reason: "Discussion budget exhausted", confidence: 0.8 };
      }
    }
    return null;
  }

  /**
   * Fetch the prompt from Langfuse Prompt Management when available,
   * otherwise interpolate the local fallback.
   */
  private async getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback: CompiledChatPrompt,
  ): Promise<CompiledChatPrompt> {
    if (this.promptPort) {
      return this.promptPort.getCompiledChat(name, variables, fallback);
    }
    return {
      systemPrompt: interpolate(fallback.systemPrompt, variables),
      userPrompt: interpolate(fallback.userPrompt, variables),
      isFallback: true,
    };
  }

  /**
   * Build the pre-formatted posts block for the batched decision prompt.
   */
  private buildBatchPostsVariable(contexts: PostContext[]): string {
    return contexts
      .map((ctx, i) => {
        const postNum = i + 1;
        const discussionsThisSession =
          ctx.discussionsThisSession ??
          (ctx.repostsThisSession ?? 0) + (ctx.quotesThisSession ?? 0);
        const discussionsMaxPerSession =
          ctx.discussionsMaxPerSession ??
          (ctx.repostsMaxPerSession ?? 0) + (ctx.quotesMaxPerSession ?? 0);
        return `--- Post ${postNum} ---
|- Platform: ${ctx.network}
|- From: ${sanitizeUntrustedInput(ctx.source, 80)} (@${sanitizeUntrustedInput(ctx.authorHandle ?? "unknown", 80)})
|- Has media: ${ctx.hasMedia}
|- Text: "${sanitizeUntrustedInput(ctx.postText, 300)}"
||- Detected language: ${detectLanguage(ctx.postText)}
|- Budget: likes ${ctx.likesThisSession}/${ctx.likesMaxPerSession}, comments ${ctx.commentsThisSession}/${ctx.commentsMaxPerSession}, reposts ${ctx.repostsThisSession ?? 0}/${ctx.repostsMaxPerSession ?? 0}, quotes ${ctx.quotesThisSession ?? 0}/${ctx.quotesMaxPerSession ?? 0}, discussions ${discussionsThisSession}/${discussionsMaxPerSession}`;
      })
      .join("\n\n");
  }
}
