// HumanBehaviorEngine — orchestrates LLM-driven human-like engagement behavior.
//
// Replaces the Math.random() loop in BrowsingSessionService with a
// context-aware decision engine that:
//   1. Extracts post text + metadata for each discovered post
//   2. Asks the LLM what action to take (scroll/read/like/comment/open-thread/...)
//   3. Executes the action with human-like timing (dwell, hover, varied scroll)
//   4. Records interactions in the database
//   5. Respects engagement budgets and warmup phase gating
//
// The engine is network-agnostic — it delegates to BaseEngager for all
// browser actions, so the same logic works across X, Threads, and Facebook.

import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Page } from '../../domain/ports/browser-primitives';
import {
  InteractionStatus,
  InteractionType,
  SocialNetwork,
} from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import {
  IEngagementDecisionPort,
  type PostContext,
  type ActionDecision,
  type EngagementSource,
} from '../../domain/ports/engagement-decision.port.js';
import type { BaseEngager } from './engagers/base.engager.js';
import { calculateDwellTimeMs, calculateThreadReadTimeMs } from './dwell-time-calculator.js';

/**
 * Result of a single post interaction within a browsing session.
 */
export interface PostInteractionResult {
  postUrl: string;
  decision: ActionDecision;
  interactionId?: string;
  success: boolean;
  error?: string;
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
  /** Max posts to evaluate per session (prevents infinite loops). */
  maxPosts: number;
  /** Total wall-clock budget for the session (scroll + interactions), in seconds. */
  durationSec: number;
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
  ) {}

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

  async processPosts(
    page: Page,
    postUrls: string[],
    engager: BaseEngager,
    config: BehaviorEngineConfig,
  ): Promise<PostInteractionResult[]> {
    const results: PostInteractionResult[] = [];
    let likesThisSession = 0;
    let commentsThisSession = 0;
    let postsProcessed = 0;

    // Respect the overall session duration budget. Scroll + interactions must fit.
    const sessionDeadline = Date.now() + config.durationSec * 1000;

    // Use batched decisions if the port supports it (1 LLM call per batch
    // instead of 1 per post). Falls back to individual calls otherwise.
    const supportsBatch = typeof this.decisionPort.decideActionsBatch === 'function';

    // Process posts in batches
    const batchSize = supportsBatch ? HumanBehaviorEngine.BATCH_SIZE : 1;
    let urlIndex = 0;

    while (urlIndex < postUrls.length && postsProcessed < config.maxPosts && Date.now() < sessionDeadline) {
      // Determine how many URLs to process in this batch
      const remaining = config.maxPosts - postsProcessed;
      const batchSlice = postUrls.slice(urlIndex, urlIndex + Math.min(batchSize, remaining));
      urlIndex += batchSlice.length;

      // Step 1: Extract post contexts for the batch (sequential — shares one page)
      const contexts: PostContext[] = [];

      for (const postUrl of batchSlice) {
        if (postsProcessed >= config.maxPosts || Date.now() >= sessionDeadline) break;
        try {
          const extracted = await engager.extractPostText(page, postUrl);
          contexts.push({
            network: config.network,
            postUrl,
            postText: extracted.text,
            authorHandle: extracted.authorHandle,
            hasMedia: extracted.hasMedia,
            source: config.source,
            likesThisSession,
            commentsThisSession,
            likesMaxPerSession: config.likesMaxPerSession,
            commentsMaxPerSession: config.commentsMaxPerSession,
          });
        } catch (err) {
          this.logger.debug(`Failed to extract post context for ${postUrl}: ${(err as Error).message.slice(0, 80)}`);
          // Can't extract — just scroll past (no result recorded, matching original behavior)
          await this.browser.randomDelay(1000, 3000);
          postsProcessed++;
        }
      }

      if (contexts.length === 0) continue;

      // Step 2: Get decisions (batched or individual)
      let decisions: ActionDecision[];
      if (supportsBatch && contexts.length > 1) {
        try {
          decisions = await this.decisionPort.decideActionsBatch!(contexts);
        } catch (err) {
          this.logger.warn(`Batch decision failed, falling back to individual: ${(err as Error).message.slice(0, 80)}`);
          decisions = await Promise.all(contexts.map((ctx) => this.decisionPort.decideAction(ctx)));
        }
      } else {
        decisions = await Promise.all(contexts.map((ctx) => this.decisionPort.decideAction(ctx)));
      }

      // Step 3: Execute decisions sequentially (with human-like pauses)
      for (let i = 0; i < contexts.length && Date.now() < sessionDeadline; i++) {
        postsProcessed++;
        const context = contexts[i]!;
        let decision = decisions[i]!;

        // Runtime budget enforcement — the LLM may have decided "like" for
        // multiple posts in a batch, but the budget only allows a few.
        // Downgrade to 'read' if the budget was exhausted by earlier posts in this batch.
        if (decision.action === 'like' && likesThisSession >= config.likesMaxPerSession) {
          decision = { action: 'read', reason: 'Like budget exhausted mid-batch', confidence: 0.8 };
        }
        if (decision.action === 'comment' && commentsThisSession >= config.commentsMaxPerSession) {
          decision = { action: 'read', reason: 'Comment budget exhausted mid-batch', confidence: 0.8 };
        }

        // Generate comment text if the LLM decided 'comment' but didn't provide text
        if (decision.action === 'comment' && !decision.commentText) {
          try {
            decision.commentText = await this.decisionPort.generateComment(context);
          } catch {
            // generateComment has its own fallback
          }
        }

        const result = await this.executeDecision(
          page,
          engager,
          decision,
          context,
          config,
          likesThisSession,
          commentsThisSession,
        );

        if (result.success) {
          if (decision.action === 'like') likesThisSession++;
          if (decision.action === 'comment') commentsThisSession++;
        }

        results.push(result);

        // Human-like pause between posts (varies by action)
        await this.postActionPause(decision.action, context);
      }
    }

    return results;
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
  ): Promise<PostInteractionResult> {
    const baseResult: PostInteractionResult = {
      postUrl: context.postUrl,
      decision,
      success: true,
    };

    switch (decision.action) {
      case 'scroll':
        // Already scrolled during discovery — just pause briefly
        await this.browser.randomDelay(500, 2000);
        return baseResult;

      case 'read':
        // Dwell on the post (simulate reading) — no interaction
        await this.simulateReading(context);
        return baseResult;

      case 'skip':
        // Do nothing — distinct from scroll (no movement)
        await this.browser.randomDelay(200, 800);
        return baseResult;

      case 'like':
        return this.executeLike(page, engager, context, config);

      case 'comment':
        return this.executeComment(page, engager, decision, context, config);

      case 'open-thread':
        return this.executeOpenThread(page, engager, context, config);

      case 'visit-profile':
        return this.executeVisitProfile(page, engager, context, config);

      case 'back':
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
    // Rate limit check
    const rateKey = `${context.network as string}-like`;
    const rateCheck = await this.rateLimitService.checkRateLimit(rateKey);
    if (!rateCheck.allowed) {
      return {
        postUrl: context.postUrl,
        decision: { action: 'like', reason: 'Rate limited', confidence: 0 },
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

      if (result.success) {
        await this.rateLimitService.recordPost(rateKey);
        await this.publishInteractionEvent('interaction_completed', interaction.id, context, 'like');
      } else {
        await this.publishInteractionEvent('interaction_failed', interaction.id, context, 'like', result.error);
      }

      return {
        postUrl: context.postUrl,
        decision: { action: 'like', reason: 'Liked', confidence: 1 },
        interactionId: interaction.id,
        success: result.success,
        error: result.error,
      };
    } catch (err) {
      await this.markInteractionFailed(interaction.id, (err as Error).message);
      return {
        postUrl: context.postUrl,
        decision: { action: 'like', reason: 'Failed', confidence: 0 },
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
    const commentText = decision.commentText ?? await this.decisionPort.generateComment(context);
    if (!commentText) {
      return {
        postUrl: context.postUrl,
        decision,
        success: false,
        error: 'No comment text generated',
      };
    }

    // Rate limit check
    const rateKey = `${context.network as string}-comment`;
    const rateCheck = await this.rateLimitService.checkRateLimit(rateKey);
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
        await this.rateLimitService.recordPost(rateKey);
        await this.publishInteractionEvent('interaction_completed', interaction.id, context, 'comment');
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
        decision: { action: 'open-thread', reason: `Read ${replyCount} replies`, confidence: 1 },
        success: true,
      };
    } catch (err) {
      return {
        postUrl: context.postUrl,
        decision: { action: 'open-thread', reason: 'Failed', confidence: 0 },
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
        decision: { action: 'visit-profile', reason: 'No handle available', confidence: 0 },
        success: false,
        error: 'No author handle to visit',
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
        decision: { action: 'visit-profile', reason: `Visited @${context.authorHandle}`, confidence: 1 },
        success: true,
      };
    } catch (err) {
      return {
        postUrl: context.postUrl,
        decision: { action: 'visit-profile', reason: 'Failed', confidence: 0 },
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
      case 'like':
        // Brief pause after liking
        await this.browser.randomDelay(2000, 6000);
        break;
      case 'comment':
        // Longer pause after commenting (reflects real user behavior)
        await this.browser.randomDelay(5000, 15000);
        break;
      case 'open-thread':
        // Pause after reading a thread
        await this.browser.randomDelay(3000, 8000);
        break;
      case 'visit-profile':
        // Pause after returning from a profile
        await this.browser.randomDelay(2000, 5000);
        break;
      default:
        // Standard between-posts pause
        await this.browser.randomDelay(3000, 8000);
    }
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
    type: string,
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
