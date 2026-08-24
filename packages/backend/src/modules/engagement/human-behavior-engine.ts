// HumanBehaviorEngine — orchestrates LLM-driven human-like engagement behavior.
//
// Replaces the Math.random() loop in BrowsingSessionService with a
// context-aware decision engine that:
//   1. Extracts post text + metadata for each discovered post
//   2. Asks the LLM what action to take (scroll/read/like/comment/repost/quote/open-thread/...)
//   3. Executes the action with human-like timing (dwell, hover, varied scroll)
//   4. Records interactions in the database
//   5. Respects engagement budgets and warmup phase gating
//
// The engine is network-agnostic — it delegates to BaseEngager for all
// browser actions, so the same logic works across X, Threads, and Facebook.

import { Injectable, Logger, Inject, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Page } from "../../domain/ports/browser-primitives.js";
import { InteractionStatus, InteractionType, SocialNetwork } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { IBrowserPort } from "../../domain/ports/browser.port.js";
import { SseService, type SseInteractionEvent } from "../../infrastructure/sse/sse.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import {
  IEngagementDecisionPort,
  type PostContext,
  type ActionDecision,
  type EngagementSource,
} from "../../domain/ports/engagement-decision.port.js";
import type { BaseEngager } from "./engagers/base.engager.js";
import { calculateDwellTimeMs, calculateThreadReadTimeMs } from "./dwell-time-calculator.js";
import { withTimeout } from "../../infrastructure/util/with-timeout.js";
import {
  IRuntimeActionAuthorizer,
  type AuthorizePlatformActionParams,
  type PlatformAuthorizationDecision,
} from "../policy/policy.types.js";
import { EngagementCandidateScorer } from "./engagement-candidate-scorer.js";
import { EngagementSuggestionService } from "./engagement-suggestion.service.js";
import {
  IAuthorContextPort,
  type IAuthorContextPort as AuthorContextPort,
} from "../../domain/ports/author-context.port.js";
import { CreatorRelationshipService } from "../crm/creator-relationship.service.js";

/**
 * Result of a single post interaction within a browsing session.
 */
export interface PostInteractionResult {
  postUrl: string;
  decision: ActionDecision;
  interactionId?: string;
  success: boolean;
  error?: string;
  suggestionId?: string;
  suggested?: boolean;
}

/**
 * Configuration for a browsing session run.
 */
export interface BehaviorEngineConfig {
  network: SocialNetwork;
  accountId: string;
  browsingSessionId: string;
  source: EngagementSource;
  likesMaxPerSession: number;
  commentsMaxPerSession: number;
  /** Max reposts per session. Defaults to 0 if not set. */
  repostsMaxPerSession?: number;
  /** Max quotes per session. Defaults to 0 if not set. */
  quotesMaxPerSession?: number;
  /** Max discussions (repost + quote) per session. Defaults to repostsMax + quotesMax if not set. */
  discussionsMaxPerSession?: number;
  /** Max posts to evaluate per session (prevents infinite loops). */
  maxPosts: number;
  /** Total wall-clock budget for the session (scroll + interactions), in seconds. */
  durationSec: number;
  /** Optional absolute start timestamp of the session. When provided, the deadline is
   * sessionStartMs + durationSec * 1000, ensuring scroll + interactions share the
   * same total budget instead of each getting a fresh durationSec slice. */
  sessionStartMs?: number;
}

@Injectable()
export class HumanBehaviorEngine {
  private readonly logger = new Logger(HumanBehaviorEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly sseService: SseService,
    private readonly rateLimitService: RateLimitService,
    @Inject(IEngagementDecisionPort) private readonly decisionPort: IEngagementDecisionPort,
    @Optional()
    @Inject(IRuntimeActionAuthorizer)
    private readonly actionAuthorizer?: {
      authorize(params: AuthorizePlatformActionParams): Promise<PlatformAuthorizationDecision>;
      reauthorize(
        params: AuthorizePlatformActionParams,
        expectedPolicyHash: string,
      ): Promise<PlatformAuthorizationDecision>;
    },
    @Optional() private readonly candidateScorer?: EngagementCandidateScorer,
    @Optional() private readonly suggestionService?: EngagementSuggestionService,
    @Optional() @Inject(IAuthorContextPort) private readonly authorContext?: AuthorContextPort,
    @Optional() private readonly creatorRelationships?: CreatorRelationshipService,
  ) {}

  private async recordCreatorInteractionEvidence(
    context: PostContext,
    config: BehaviorEngineConfig,
    interactionId: string | undefined,
    kind: "like" | "comment" | "repost" | "quote",
  ): Promise<void> {
    if (!this.creatorRelationships || !context.authorHandle || !interactionId) return;
    try {
      await this.creatorRelationships.recordPublicInteraction({
        accountId: config.accountId,
        network: context.network,
        authorHandle: context.authorHandle,
        interactionId,
        postUrl: context.postUrl,
        kind,
      });
    } catch (err) {
      this.logger.warn(`CRM evidence recording skipped: ${errorMessage(err)}`);
    }
  }

  private async authorizeSideEffect(
    config: BehaviorEngineConfig,
    action: "like" | "comment" | "repost" | "quote",
    targetRelationship: "UNKNOWN" | "OWN_POST" = "UNKNOWN",
  ): Promise<string | null> {
    if (!this.actionAuthorizer) return null;
    const params: AuthorizePlatformActionParams = {
      accountId: config.accountId,
      network: config.network,
      action:
        action === "comment"
          ? "REPLY"
          : (action.toUpperCase() as AuthorizePlatformActionParams["action"]),
      transport: "BROWSER",
      targetRelationship,
      contentRiskTier: "LOW",
      requestedMode: "APPROVED_AUTOMATION",
    };
    const decision = await this.actionAuthorizer.authorize(params);
    if (decision.allowedMode !== "APPROVED_AUTOMATION") {
      return `Policy mode ${decision.allowedMode}: ${decision.blockReasons.join("; ")}`;
    }
    const current = await this.actionAuthorizer.reauthorize(params, decision.policyHash);
    return current.allowedMode === "APPROVED_AUTOMATION"
      ? null
      : `Policy changed before engagement side effect: ${current.blockReasons.join("; ")}`;
  }

  /**
   * Process a list of discovered posts with LLM-driven decisions.
   * This is the core human-emulation loop.
   *
   * @param page - The Playwright page (already on the feed)
   * @param postUrls - URLs discovered during feed scrolling
   * @param engager - The network-specific engager
   * @param config - Session configuration
   * @returns Array of interaction results
   */
  /** Batch size for batched LLM decisions. 5 posts per LLM call. */
  private static readonly BATCH_SIZE = 5;

  /** Per-post hard timeout so a single stuck navigation/click cannot hang the whole session. */
  private static readonly EXTRACT_TIMEOUT_MS = 15_000;
  private static readonly DECISION_TIMEOUT_MS = 30_000;
  private static readonly EXECUTE_TIMEOUT_MS = 60_000;

  async processPosts(
    page: Page,
    postUrls: string[],
    engager: BaseEngager,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult[]> {
    const results: PostInteractionResult[] = [];
    let likesThisSession = 0;
    let commentsThisSession = 0;
    let repostsThisSession = 0;
    let quotesThisSession = 0;
    let discussionsThisSession = 0;
    let postsProcessed = 0;

    // Respect the overall session duration budget. Scroll + interactions must fit.
    const sessionDeadline = config.sessionStartMs
      ? config.sessionStartMs + config.durationSec * 1000
      : Date.now() + config.durationSec * 1000;

    // Use batched decisions if the port supports it (1 LLM call per batch
    // instead of 1 per post). Falls back to individual calls otherwise.
    const supportsBatch = typeof this.decisionPort.decideActionsBatch === "function";

    // Step 2 helper: ensure the decision array has exactly one entry per context.
    // LLM batch responses can return the wrong length and would otherwise crash at decisions[i].
    const normalizeDecisions = (ctxs: PostContext[], raw: unknown): ActionDecision[] => {
      if (Array.isArray(raw) && raw.length === ctxs.length) {
        return raw as ActionDecision[];
      }
      this.logger.warn(
        `Decision length mismatch: expected ${ctxs.length}, got ${Array.isArray(raw) ? raw.length : typeof raw} — using fallbacks`,
      );
      return ctxs.map((c) => this.fallbackDecision(c));
    };

    // Process posts in batches
    const batchSize = supportsBatch ? HumanBehaviorEngine.BATCH_SIZE : 1;
    let urlIndex = 0;

    while (
      urlIndex < postUrls.length &&
      postsProcessed < config.maxPosts &&
      Date.now() < sessionDeadline
    ) {
      // Determine how many URLs to process in this batch
      const remaining = config.maxPosts - postsProcessed;
      const batchSlice = postUrls.slice(urlIndex, urlIndex + Math.min(batchSize, remaining));
      urlIndex += batchSlice.length;

      // Step 1: Extract post contexts for the batch (sequential — shares one page)
      const contexts: PostContext[] = [];

      for (const postUrl of batchSlice) {
        if (postsProcessed >= config.maxPosts || Date.now() >= sessionDeadline) break;
        // Check if the page is still alive before each extraction. X.com renderer
        // process can crash during navigation between posts, and continuing to
        // interact with a crashed page just produces more failures.
        if (page.isClosed?.()) {
          this.logger.warn(`Page closed during batch processing — aborting session`);
          throw new Error("Page was closed during post extraction");
        }
        try {
          const extracted = await withTimeout(
            engager.extractPostText(page, postUrl),
            HumanBehaviorEngine.EXTRACT_TIMEOUT_MS,
            `Extract post text for ${postUrl}`,
          );
          const discussionsMax =
            config.discussionsMaxPerSession ??
            (config.repostsMaxPerSession ?? 0) + (config.quotesMaxPerSession ?? 0);
          contexts.push({
            accountId: config.accountId,
            network: config.network,
            postUrl,
            postText: extracted.text,
            authorHandle: extracted.authorHandle,
            hasMedia: extracted.hasMedia,
            source: config.source,
            likesThisSession,
            commentsThisSession,
            repostsThisSession,
            quotesThisSession,
            discussionsThisSession,
            likesMaxPerSession: config.likesMaxPerSession,
            commentsMaxPerSession: config.commentsMaxPerSession,
            repostsMaxPerSession: config.repostsMaxPerSession ?? 0,
            quotesMaxPerSession: config.quotesMaxPerSession ?? 0,
            discussionsMaxPerSession: discussionsMax,
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          // Fatal browser errors during extraction mean the page/context is dead.
          // Continuing to the next post will just produce more failures — abort the session.
          if (this.isFatalBrowserError(errMsg)) {
            this.logger.warn(
              `Fatal browser error during extraction for ${postUrl} — aborting session`,
            );
            throw err;
          }
          this.logger.debug(
            `Failed to extract post context for ${postUrl}: ${errMsg.slice(0, 80)}`,
          );
          // Can't extract — just scroll past (no result recorded, matching original behavior)
          await this.browser.randomDelay(1000, 3000);
          postsProcessed++;
        }
      }

      if (contexts.length === 0) continue;

      // Deterministic candidate scoring is upstream of LLM action selection.
      // SKIP is terminal and never spends tokens or becomes a reply merely
      // because a session budget is still available.
      const candidateScores = new Map<string, ReturnType<EngagementCandidateScorer["score"]>>();
      const decisionContexts = this.candidateScorer
        ? contexts.filter((context) => {
            const score = this.candidateScorer!.score({
              network: context.network,
              postUrl: context.postUrl,
              postText: context.postText,
              authorHandle: context.authorHandle,
              source: context.source,
            });
            candidateScores.set(context.postUrl, score);
            return score.decision !== "SKIP";
          })
        : contexts;
      const mergeDecisions = (eligibleDecisions: ActionDecision[]): ActionDecision[] => {
        let eligibleIndex = 0;
        return contexts.map((context) => {
          const score = candidateScores.get(context.postUrl);
          if (score?.decision === "SKIP") {
            return {
              action: "skip",
              reason: `Candidate gate: ${score.reasons.join("; ")}`,
              confidence: 1,
            };
          }
          return eligibleDecisions[eligibleIndex++] ?? this.fallbackDecision(context);
        });
      };

      // Step 2: Get decisions (batched or individual) with a hard timeout so an LLM
      // provider that never responds cannot hang the whole browsing session. If batch
      // fails, fall back to individual calls; if those also fail, use safe read decisions.
      let decisions: ActionDecision[] = [];
      if (decisionContexts.length === 0) {
        decisions = mergeDecisions([]);
      }
      try {
        if (decisionContexts.length === 0) {
          // All candidates were terminal SKIP decisions.
        } else if (supportsBatch && decisionContexts.length > 1) {
          const raw = await withTimeout(
            this.decisionPort.decideActionsBatch!(decisionContexts),
            HumanBehaviorEngine.DECISION_TIMEOUT_MS,
            "Batch LLM decision",
          );
          decisions = mergeDecisions(normalizeDecisions(decisionContexts, raw));
        } else {
          const raw = await withTimeout(
            Promise.all(decisionContexts.map((ctx) => this.decisionPort.decideAction(ctx))),
            HumanBehaviorEngine.DECISION_TIMEOUT_MS,
            "Individual LLM decisions",
          );
          decisions = mergeDecisions(normalizeDecisions(decisionContexts, raw));
        }
      } catch (err) {
        const errorMessage = (err as Error).message.slice(0, 80);
        if (decisionContexts.length === 0) {
          decisions = mergeDecisions([]);
        } else if (supportsBatch && decisionContexts.length > 1) {
          this.logger.warn(
            `Batch decision failed/timed out, falling back to individual: ${errorMessage}`,
          );
          try {
            const raw = await withTimeout(
              Promise.all(decisionContexts.map((ctx) => this.decisionPort.decideAction(ctx))),
              HumanBehaviorEngine.DECISION_TIMEOUT_MS,
              "Individual LLM decisions",
            );
            decisions = mergeDecisions(normalizeDecisions(decisionContexts, raw));
          } catch (err2) {
            this.logger.warn(
              `Individual decision also failed/timed out, using fallback decisions: ${(err2 as Error).message.slice(0, 80)}`,
            );
            decisions = mergeDecisions(decisionContexts.map((ctx) => this.fallbackDecision(ctx)));
          }
        } else {
          this.logger.warn(
            `Decision call failed/timed out, using fallback decisions: ${errorMessage}`,
          );
          decisions = mergeDecisions(decisionContexts.map((ctx) => this.fallbackDecision(ctx)));
        }
      }

      // Step 3: Execute decisions sequentially (with human-like pauses)
      for (let i = 0; i < contexts.length && Date.now() < sessionDeadline; i++) {
        // Check page health before each execution — the page may have crashed
        // during extraction or LLM decision wait.
        if (page.isClosed?.()) {
          this.logger.warn(`Page closed before execution — aborting session`);
          throw new Error("Page was closed before action execution");
        }
        postsProcessed++;
        const context = contexts[i]!;
        let decision = decisions[i]!;

        // Runtime budget enforcement — the LLM may have decided an action for
        // multiple posts in a batch, but the budget only allows a few.
        // Downgrade to 'read' if the budget was exhausted by earlier posts in this batch.
        if (decision.action === "like" && likesThisSession >= config.likesMaxPerSession) {
          decision = { action: "read", reason: "Like budget exhausted mid-batch", confidence: 0.8 };
        }
        if (decision.action === "comment" && commentsThisSession >= config.commentsMaxPerSession) {
          decision = {
            action: "read",
            reason: "Comment budget exhausted mid-batch",
            confidence: 0.8,
          };
        }
        if (
          decision.action === "repost" &&
          repostsThisSession >= (config.repostsMaxPerSession ?? 0)
        ) {
          decision = {
            action: "read",
            reason: "Repost budget exhausted mid-batch",
            confidence: 0.8,
          };
        }
        if (decision.action === "quote" && quotesThisSession >= (config.quotesMaxPerSession ?? 0)) {
          decision = {
            action: "read",
            reason: "Quote budget exhausted mid-batch",
            confidence: 0.8,
          };
        }
        const discussionsMax =
          config.discussionsMaxPerSession ??
          (config.repostsMaxPerSession ?? 0) + (config.quotesMaxPerSession ?? 0);
        if (
          (decision.action === "repost" || decision.action === "quote") &&
          discussionsThisSession >= discussionsMax
        ) {
          decision = {
            action: "read",
            reason: "Discussion budget exhausted mid-batch",
            confidence: 0.8,
          };
        }

        // First-interaction quota: if the session has been entirely non-engaging
        // so far, convert a 'read'/'scroll'/'skip' decision into a like on a solid post
        // so the session doesn't finish with zero interactions. This is especially
        // important for feeds where the LLM is too conservative (e.g. Threads home feed).
        const totalInteractions =
          likesThisSession + commentsThisSession + repostsThisSession + quotesThisSession;
        const nonEngagingActions: ActionDecision["action"][] = ["scroll", "read", "skip"];
        if (
          nonEngagingActions.includes(decision.action) &&
          totalInteractions === 0 &&
          postsProcessed > 5 &&
          context.postText.length > 10 &&
          likesThisSession < config.likesMaxPerSession
        ) {
          decision = {
            action: "like",
            reason: "First-interaction quota: solid post gets a like",
            confidence: 0.6,
          };
        }

        // Generate comment text if the LLM decided 'comment' but didn't provide text.
        // If generation fails (returns null), downgrade to like (or read) — never
        // post a generic fallback comment.
        if (decision.action === "comment" && !decision.commentText) {
          try {
            const comment = await this.decisionPort.generateComment(context);
            if (comment === null) {
              if (likesThisSession < config.likesMaxPerSession) {
                this.logger.warn(
                  `LLM comment generation failed — downgrading comment → like for ${context.postUrl}`,
                );
                decision = {
                  action: "like",
                  reason: "Comment generation failed, downgraded to like",
                  confidence: 0.6,
                };
              } else {
                this.logger.warn(
                  `LLM comment generation failed and like budget exhausted — downgrading comment → read for ${context.postUrl}`,
                );
                decision = {
                  action: "read",
                  reason: "Comment generation failed, like budget exhausted",
                  confidence: 0.6,
                };
              }
            } else {
              decision.commentText = comment;
            }
          } catch {
            this.logger.warn(
              `generateComment threw — downgrading comment → read for ${context.postUrl}`,
            );
            decision = {
              action: "read",
              reason: "Comment generation threw, downgraded to read",
              confidence: 0.6,
            };
          }
        }

        // Generate quote text if the LLM decided 'quote' but didn't provide text.
        // If generation fails (returns null), downgrade to read — never post a
        // generic fallback quote.
        if (decision.action === "quote" && !decision.quoteText) {
          try {
            const quote = await this.decisionPort.generateQuoteText(context);
            if (quote === null) {
              this.logger.warn(
                `LLM quote generation failed — downgrading quote → read for ${context.postUrl}`,
              );
              decision = {
                action: "read",
                reason: "Quote generation failed, downgraded to read",
                confidence: 0.6,
              };
            } else {
              decision.quoteText = quote;
            }
          } catch {
            this.logger.warn(
              `generateQuoteText threw — downgrading quote → read for ${context.postUrl}`,
            );
            decision = {
              action: "read",
              reason: "Quote generation threw, downgraded to read",
              confidence: 0.6,
            };
          }
        }

        const suggestion = await this.createSuggestionIfRequired(decision, context, config);
        if (suggestion) {
          results.push(suggestion);
          await this.postActionPause(decision.action, context);
          continue;
        }

        const result = await withTimeout(
          this.executeDecision(
            page,
            engager,
            decision,
            context,
            config,
            likesThisSession,
            commentsThisSession,
            repostsThisSession,
            quotesThisSession,
          ),
          HumanBehaviorEngine.EXECUTE_TIMEOUT_MS,
          `Execute ${decision.action} for ${context.postUrl}`,
        ).catch((err) => ({
          postUrl: context.postUrl,
          decision,
          success: false,
          error: `Execution timed out: ${(err as Error).message}`,
        }));

        // If the browser context/page died during this interaction, subsequent
        // interactions will fail too. Abort the whole session so the queue can
        // retry with a fresh context instead of recording dozens of failed likes/comments.
        if (!result.success && this.isFatalBrowserError(result.error)) {
          throw new Error(result.error);
        }

        if (result.success) {
          if (decision.action === "like") likesThisSession++;
          if (decision.action === "comment") commentsThisSession++;
          if (decision.action === "repost") {
            repostsThisSession++;
            discussionsThisSession++;
          }
          if (decision.action === "quote") {
            quotesThisSession++;
            discussionsThisSession++;
          }
        }

        results.push(result);

        // Human-like pause between posts (varies by action)
        await this.postActionPause(decision.action, context);
      }
    }

    return results;
  }

  /**
   * Suggestion-first boundary for reply/quote actions. A suggestion is a
   * database write, not a network side effect, so SUGGEST_ONLY and
   * HUMAN_APPROVAL_REQUIRED may reach this method while APPROVED_AUTOMATION
   * continues through the normal executor below.
   */
  private async createSuggestionIfRequired(
    decision: ActionDecision,
    context: PostContext,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult | null> {
    if (
      (decision.action !== "comment" && decision.action !== "quote") ||
      !this.actionAuthorizer ||
      !this.suggestionService ||
      !this.authorContext
    ) {
      return null;
    }

    const policyParams: AuthorizePlatformActionParams = {
      accountId: config.accountId,
      network: config.network,
      action: decision.action === "comment" ? "REPLY" : "QUOTE",
      transport: "BROWSER",
      targetRelationship: config.source === "notifications" ? "MENTIONED_US" : "STRANGER",
      contentRiskTier: "LOW",
      requestedMode: "APPROVED_AUTOMATION",
    };
    const policy = await this.actionAuthorizer.authorize(policyParams);
    if (policy.allowedMode === "DISABLED" || policy.allowedMode === "APPROVED_AUTOMATION") {
      return null;
    }

    let authorContext;
    try {
      authorContext = await this.authorContext.resolve({
        accountId: config.accountId,
        network: config.network,
      });
    } catch (err) {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: `Author context unavailable for suggestion: ${errorMessage(err)}`,
      };
    }
    if (!authorContext.personaRevisionId || authorContext.source !== "PERSONA") {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: "Suggestion requires an assigned versioned persona",
      };
    }

    const content = decision.action === "comment" ? decision.commentText : decision.quoteText;
    if (!content) return null;
    try {
      const suggestion = await this.suggestionService.create({
        accountId: config.accountId,
        personaRevisionId: authorContext.personaRevisionId,
        network: config.network,
        targetUrl: context.postUrl,
        targetAuthorHandleHash: context.authorHandle
          ? createHash("sha256").update(context.authorHandle, "utf8").digest("hex")
          : undefined,
        sourceSnapshotHash: createHash("sha256")
          .update(`${context.postUrl}\n${context.postText}\n${config.source}`, "utf8")
          .digest("hex"),
        threadContextRef: {
          source: config.source,
          authorHandlePresent: Boolean(context.authorHandle),
        },
        voiceMode: authorContext.voiceMode,
        intent: decision.action === "comment" ? "ASK_SPECIFIC_QUESTION" : "ADD_NUANCE",
        content,
        claimTrace: { policyHash: policy.policyHash, policyVersionIds: policy.policyVersionIds },
        memoryTrace: { source: "IMMUTABLE_PERSONA_ONLY" },
        policyMode: policy.allowedMode,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      return {
        postUrl: context.postUrl,
        decision,
        success: true,
        suggested: true,
        suggestionId: suggestion.id,
      };
    } catch (err) {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: `Suggestion persistence failed: ${errorMessage(err)}`,
      };
    }
  }

  /**
   * Execute a single LLM decision.
   */
  private async executeDecision(
    page: Page,
    engager: BaseEngager,
    decision: ActionDecision,
    context: PostContext,
    config: BehaviorEngineConfig,
    _likesThisSession: number,
    _commentsThisSession: number,
    _repostsThisSession: number,
    _quotesThisSession: number,
  ): Promise<PostInteractionResult> {
    const baseResult: PostInteractionResult = {
      postUrl: context.postUrl,
      decision,
      success: true,
    };

    switch (decision.action) {
      case "scroll":
        // Already scrolled during discovery — just pause briefly
        await this.browser.randomDelay(500, 2000);
        return baseResult;

      case "read":
        // Dwell on the post (simulate reading) — no interaction
        await this.simulateReading(context);
        return baseResult;

      case "skip":
        // Do nothing — distinct from scroll (no movement)
        await this.browser.randomDelay(200, 800);
        return baseResult;

      case "like":
        return this.executeLike(page, engager, context, config);

      case "comment":
        return this.executeComment(page, engager, decision, context, config);

      case "repost":
        return this.executeRepost(page, engager, context, config);

      case "quote":
        return this.executeQuote(page, engager, decision, context, config);

      case "open-thread":
        return this.executeOpenThread(page, engager, context, config);

      case "visit-profile":
        return this.executeVisitProfile(page, engager, context, config);

      case "back":
        await engager.navigateBack(page);
        return baseResult;

      default:
        this.logger.warn(`Unknown action: ${decision.action} — treating as scroll`);
        return baseResult;
    }
  }

  /**
   * Execute a like action with full tracking.
   */
  private async executeLike(
    page: Page,
    engager: BaseEngager,
    context: PostContext,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult> {
    const policyError = await this.authorizeSideEffect(config, "like");
    if (policyError) {
      return {
        postUrl: context.postUrl,
        decision: { action: "like", reason: "Policy blocked", confidence: 0 },
        success: false,
        error: policyError,
      };
    }
    // Rate limit check — per network, account, and action
    const rateCheck = await this.rateLimitService.checkRateLimit(
      context.network as string,
      config.accountId,
      "like",
    );
    if (!rateCheck.allowed) {
      return {
        postUrl: context.postUrl,
        decision: { action: "like", reason: "Rate limited", confidence: 0 },
        success: false,
        error: `Rate limited: ${rateCheck.reason}`,
      };
    }

    // Create interaction record
    const interaction = await this.prisma.interaction.create({
      data: {
        accountId: config.accountId,
        type: InteractionType.LIKE,
        status: InteractionStatus.IN_PROGRESS,
        targetUrl: context.postUrl,
        browsingSessionId: config.browsingSessionId,
      },
    });

    try {
      const result = await engager.like(page, context.postUrl);

      await this.prisma.interaction.update({
        where: { id: interaction.id },
        data: {
          status: result.success ? InteractionStatus.COMPLETED : InteractionStatus.FAILED,
          errorMessage: result.error,
          screenshotPath: result.screenshotPath,
          completedAt: new Date(),
        },
      });

      if (result.success && !result.alreadyLiked) {
        await this.rateLimitService.recordPost(context.network as string, config.accountId, "like");
        await this.publishInteractionEvent(
          "interaction_completed",
          interaction.id,
          context,
          "like",
        );
      } else if (result.success) {
        await this.publishInteractionEvent(
          "interaction_completed",
          interaction.id,
          context,
          "like",
        );
      } else {
        await this.publishInteractionEvent(
          "interaction_failed",
          interaction.id,
          context,
          "like",
          result.error,
        );
      }

      if (result.success) {
        await this.recordCreatorInteractionEvidence(context, config, interaction.id, "like");
      }

      return {
        postUrl: context.postUrl,
        decision: { action: "like", reason: "Liked", confidence: 1 },
        interactionId: interaction.id,
        success: result.success,
        error: result.error,
      };
    } catch (err) {
      await this.markInteractionFailed(interaction.id, (err as Error).message);
      return {
        postUrl: context.postUrl,
        decision: { action: "like", reason: "Failed", confidence: 0 },
        interactionId: interaction.id,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Execute a comment action with full tracking.
   */
  private async executeComment(
    page: Page,
    engager: BaseEngager,
    decision: ActionDecision,
    context: PostContext,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult> {
    const commentText = decision.commentText ?? (await this.decisionPort.generateComment(context));
    if (!commentText) {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: "No comment text generated",
      };
    }

    // P0: comment-judge gate. Reject low-quality/spam comments before publishing.
    const judge = await this.decisionPort.judgeComment?.(context, commentText);
    if (judge && !judge.approved) {
      this.logger.warn(`Comment rejected by judge for ${context.postUrl}: ${judge.reason}`);
      // Downgrade to like if budget remains, otherwise read
      if (context.likesThisSession < context.likesMaxPerSession) {
        return {
          postUrl: context.postUrl,
          decision: {
            ...decision,
            action: "like",
            reason: `Comment judge rejected: ${judge.reason}`,
            confidence: 0.5,
          },
          success: true,
          error: `Comment judge rejected (downgraded to like): ${judge.reason}`,
        };
      }
      return {
        postUrl: context.postUrl,
        decision: {
          ...decision,
          action: "read",
          reason: `Comment judge rejected: ${judge.reason}`,
          confidence: 0.5,
        },
        success: true,
        error: `Comment judge rejected (downgraded to read): ${judge.reason}`,
      };
    }

    const policyError = await this.authorizeSideEffect(config, "comment");
    if (policyError) {
      return { postUrl: context.postUrl, decision, success: false, error: policyError };
    }

    // Rate limit check — per network, account, and action
    const rateCheck = await this.rateLimitService.checkRateLimit(
      context.network as string,
      config.accountId,
      "comment",
    );
    if (!rateCheck.allowed) {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: `Rate limited: ${rateCheck.reason}`,
      };
    }

    // Create interaction record
    const interaction = await this.prisma.interaction.create({
      data: {
        accountId: config.accountId,
        type: InteractionType.COMMENT,
        status: InteractionStatus.IN_PROGRESS,
        targetUrl: context.postUrl,
        content: commentText,
        browsingSessionId: config.browsingSessionId,
      },
    });

    try {
      const result = await engager.comment(page, context.postUrl, commentText);

      await this.prisma.interaction.update({
        where: { id: interaction.id },
        data: {
          status: result.success ? InteractionStatus.COMPLETED : InteractionStatus.FAILED,
          errorMessage: result.error,
          screenshotPath: result.screenshotPath,
          completedAt: new Date(),
        },
      });

      if (result.success) {
        await this.rateLimitService.recordPost(
          context.network as string,
          config.accountId,
          "comment",
        );
        await this.publishInteractionEvent(
          "interaction_completed",
          interaction.id,
          context,
          "comment",
        );
      }

      if (result.success) {
        await this.recordCreatorInteractionEvidence(context, config, interaction.id, "comment");
      }

      return {
        postUrl: context.postUrl,
        decision,
        interactionId: interaction.id,
        success: result.success,
        error: result.error,
      };
    } catch (err) {
      await this.markInteractionFailed(interaction.id, (err as Error).message);
      return {
        postUrl: context.postUrl,
        decision,
        interactionId: interaction.id,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Execute a repost action with full tracking.
   */
  private async executeRepost(
    page: Page,
    engager: BaseEngager,
    context: PostContext,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult> {
    const policyError = await this.authorizeSideEffect(config, "repost");
    if (policyError) {
      return {
        postUrl: context.postUrl,
        decision: { action: "repost", reason: "Policy blocked", confidence: 0 },
        success: false,
        error: policyError,
      };
    }
    // Rate limit check — per network, account, and action
    const rateCheck = await this.rateLimitService.checkRateLimit(
      context.network as string,
      config.accountId,
      "repost",
    );
    if (!rateCheck.allowed) {
      return {
        postUrl: context.postUrl,
        decision: { action: "repost", reason: "Rate limited", confidence: 0 },
        success: false,
        error: `Rate limited: ${rateCheck.reason}`,
      };
    }

    const interaction = await this.prisma.interaction.create({
      data: {
        accountId: config.accountId,
        type: InteractionType.REPOST,
        status: InteractionStatus.IN_PROGRESS,
        targetUrl: context.postUrl,
        browsingSessionId: config.browsingSessionId,
      },
    });

    try {
      const result = await engager.repost(page, context.postUrl);

      await this.prisma.interaction.update({
        where: { id: interaction.id },
        data: {
          status: result.success ? InteractionStatus.COMPLETED : InteractionStatus.FAILED,
          errorMessage: result.error,
          screenshotPath: result.screenshotPath,
          completedAt: new Date(),
        },
      });

      if (result.success && !result.alreadyReposted) {
        await this.rateLimitService.recordPost(
          context.network as string,
          config.accountId,
          "repost",
        );
        await this.publishInteractionEvent(
          "interaction_completed",
          interaction.id,
          context,
          "repost",
        );
      } else if (result.success) {
        await this.publishInteractionEvent(
          "interaction_completed",
          interaction.id,
          context,
          "repost",
        );
      } else {
        await this.publishInteractionEvent(
          "interaction_failed",
          interaction.id,
          context,
          "repost",
          result.error,
        );
      }

      if (result.success) {
        await this.recordCreatorInteractionEvidence(context, config, interaction.id, "repost");
      }

      return {
        postUrl: context.postUrl,
        decision: { action: "repost", reason: "Reposted", confidence: 1 },
        interactionId: interaction.id,
        success: result.success,
        error: result.error,
      };
    } catch (err) {
      await this.markInteractionFailed(interaction.id, (err as Error).message);
      return {
        postUrl: context.postUrl,
        decision: { action: "repost", reason: "Failed", confidence: 0 },
        interactionId: interaction.id,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Execute a quote action with full tracking.
   */
  private async executeQuote(
    page: Page,
    engager: BaseEngager,
    decision: ActionDecision,
    context: PostContext,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult> {
    const quoteText = decision.quoteText ?? (await this.decisionPort.generateQuoteText(context));
    if (!quoteText) {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: "No quote text generated",
      };
    }

    const policyError = await this.authorizeSideEffect(config, "quote");
    if (policyError) {
      return { postUrl: context.postUrl, decision, success: false, error: policyError };
    }

    const rateCheck = await this.rateLimitService.checkRateLimit(
      context.network as string,
      config.accountId,
      "quote",
    );
    if (!rateCheck.allowed) {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: `Rate limited: ${rateCheck.reason}`,
      };
    }

    const interaction = await this.prisma.interaction.create({
      data: {
        accountId: config.accountId,
        type: InteractionType.QUOTE,
        status: InteractionStatus.IN_PROGRESS,
        targetUrl: context.postUrl,
        content: quoteText,
        browsingSessionId: config.browsingSessionId,
      },
    });

    try {
      const result = await engager.quote(page, context.postUrl, quoteText);

      await this.prisma.interaction.update({
        where: { id: interaction.id },
        data: {
          status: result.success ? InteractionStatus.COMPLETED : InteractionStatus.FAILED,
          errorMessage: result.error,
          screenshotPath: result.screenshotPath,
          completedAt: new Date(),
        },
      });

      if (result.success) {
        await this.rateLimitService.recordPost(
          context.network as string,
          config.accountId,
          "quote",
        );
        await this.publishInteractionEvent(
          "interaction_completed",
          interaction.id,
          context,
          "quote",
        );
      }

      if (result.success) {
        await this.recordCreatorInteractionEvidence(context, config, interaction.id, "quote");
      }

      return {
        postUrl: context.postUrl,
        decision,
        interactionId: interaction.id,
        success: result.success,
        error: result.error,
      };
    } catch (err) {
      await this.markInteractionFailed(interaction.id, (err as Error).message);
      return {
        postUrl: context.postUrl,
        decision,
        interactionId: interaction.id,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Execute an open-comments-thread action (read replies, no interaction).
   */
  private async executeOpenThread(
    page: Page,
    engager: BaseEngager,
    context: PostContext,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult> {
    try {
      const replyCount = await engager.openCommentsThread(page, context.postUrl);
      const readTime = calculateThreadReadTimeMs(replyCount);
      await this.browser.randomDelay(readTime, readTime + 2000);

      // Record as a SCROLL_VIEW interaction (browsing, not engaging)
      await this.prisma.interaction.create({
        data: {
          accountId: config.accountId,
          type: InteractionType.SCROLL_VIEW,
          status: InteractionStatus.COMPLETED,
          targetUrl: context.postUrl,
          browsingSessionId: config.browsingSessionId,
          completedAt: new Date(),
        },
      });

      return {
        postUrl: context.postUrl,
        decision: { action: "open-thread", reason: `Read ${replyCount} replies`, confidence: 1 },
        success: true,
      };
    } catch (err) {
      return {
        postUrl: context.postUrl,
        decision: { action: "open-thread", reason: "Failed", confidence: 0 },
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Execute a visit-profile action (browse a user's profile, then return).
   */
  private async executeVisitProfile(
    page: Page,
    engager: BaseEngager,
    context: PostContext,
    _config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult> {
    if (!context.authorHandle) {
      return {
        postUrl: context.postUrl,
        decision: { action: "visit-profile", reason: "No handle available", confidence: 0 },
        success: false,
        error: "No author handle to visit",
      };
    }

    try {
      await engager.visitProfile(page, context.authorHandle);
      // Browse the profile feed briefly
      await this.browser.randomDelay(3000, 8000);
      // Return to the original feed
      await engager.navigateBack(page);

      return {
        postUrl: context.postUrl,
        decision: {
          action: "visit-profile",
          reason: `Visited @${context.authorHandle}`,
          confidence: 1,
        },
        success: true,
      };
    } catch (err) {
      return {
        postUrl: context.postUrl,
        decision: { action: "visit-profile", reason: "Failed", confidence: 0 },
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Simulate reading a post — dwell based on content length.
   */
  private async simulateReading(context: PostContext): Promise<void> {
    const dwellMs = calculateDwellTimeMs(context.postText, context.hasMedia);
    await this.browser.randomDelay(dwellMs, dwellMs + 1000);
  }

  /**
   * Human-like pause after an action — varies by action type.
   */
  private async postActionPause(action: string, _context: PostContext): Promise<void> {
    switch (action) {
      case "like":
        // Brief pause after liking
        await this.browser.randomDelay(2000, 6000);
        break;
      case "comment":
        // Longer pause after commenting (reflects real user behavior)
        await this.browser.randomDelay(5000, 15000);
        break;
      case "repost":
        // Pause after reposting
        await this.browser.randomDelay(3000, 8000);
        break;
      case "quote":
        // Longer pause after quote-posting
        await this.browser.randomDelay(5000, 15000);
        break;
      case "open-thread":
        // Pause after reading a thread
        await this.browser.randomDelay(3000, 8000);
        break;
      case "visit-profile":
        // Pause after returning from a profile
        await this.browser.randomDelay(2000, 5000);
        break;
      default:
        // Standard between-posts pause
        await this.browser.randomDelay(3000, 8000);
    }
  }

  /**
   * Detect errors that mean the browser/page/context is dead. Continuing to
   * interact after these errors just produces more failed records, so the
   * caller should abort the browsing session and let the queue retry.
   */
  private isFatalBrowserError(error?: string): boolean {
    if (!error) return false;
    const fatalPatterns = [
      "Target page, context or browser has been closed",
      "Browser has been closed",
      "Context has been closed",
      "Page has been closed",
      "Protocol error",
      "Target closed",
      "Connection closed",
    ];
    return fatalPatterns.some((pattern) => error.includes(pattern));
  }

  /**
   * Safe fallback decision when the LLM decision port times out or fails.
   * Keeps the session moving without interacting, so it never blocks on a provider.
   */
  private fallbackDecision(_context: PostContext): ActionDecision {
    return { action: "read", reason: "LLM decision fallback (timeout/error)", confidence: 0.5 };
  }

  private async markInteractionFailed(interactionId: string, error: string): Promise<void> {
    await this.prisma.interaction.update({
      where: { id: interactionId },
      data: {
        status: InteractionStatus.FAILED,
        errorMessage: error,
        completedAt: new Date(),
      },
    });
  }

  private async publishInteractionEvent(
    type: SseInteractionEvent["type"],
    interactionId: string,
    context: PostContext,
    interactionType: string,
    error?: string,
  ): Promise<void> {
    await this.sseService.publish({
      type,
      interactionId,
      interactionType,
      network: context.network as string,
      targetUrl: context.postUrl,
      error,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
