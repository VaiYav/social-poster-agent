// Browsing session service — simulates human-like browsing behavior.
// Opens a feed, scrolls for a duration, uses LLM-driven decisions to
// like/comment/read/scroll, and records all interactions in the database.
//
// Purpose: anti-detection. Pure posting without engagement looks bot-like.
// Browsing sessions make the account look like a real user who reads and
// interacts with content, not just broadcasts.
//
// The actual decision-making is delegated to HumanBehaviorEngine (LLM-driven).
// This service handles orchestration: session creation, browser context,
// feed scrolling, and result recording.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import {
  InteractionStatus,
  InteractionType,
  SocialNetwork,
  BrowsingSessionStatus,
  type Prisma,
} from '@prisma/client';
import type { BaseEngager } from './engagers/base.engager.js';
import { XEngager } from './engagers/x.engager.js';
import { ThreadsEngager } from './engagers/threads.engager.js';
import { FacebookEngager } from './engagers/facebook.engager.js';
import { HumanBehaviorEngine } from './human-behavior-engine.js';
import { TargetingService } from './targeting.service.js';
import { WarmupService } from '../sessions/warmup.service.js';
import {
  buildEngagementGraph,
  createEngagementInitialState,
} from './engagement.graph.js';
import { withTimeout } from '../../infrastructure/util/with-timeout.js';

@Injectable()
export class BrowsingSessionService {
  private readonly logger = new Logger(BrowsingSessionService.name);
  private readonly defaultDurationSec: number;
  private readonly likesMaxPerSession: number;
  private readonly commentsMaxPerSession: number;
  private readonly repostsMaxPerSession: number;
  private readonly quotesMaxPerSession: number;
  private readonly maxPostsPerSession: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly configService: ConfigService,
    private readonly sseService: SseService,
    private readonly rateLimitService: RateLimitService,
    private readonly xEngager: XEngager,
    private readonly threadsEngager: ThreadsEngager,
    private readonly facebookEngager: FacebookEngager,
    private readonly humanBehaviorEngine: HumanBehaviorEngine,
    private readonly targetingService: TargetingService,
    @Optional() private readonly warmupService?: WarmupService,
  ) {
    this.defaultDurationSec = Number(
      this.configService.get<string>('F1_BROWSING_SESSION_MINUTES', '10'),
    ) * 60;
    this.likesMaxPerSession = Number(
      this.configService.get<string>('F1_LIKES_MAX_PER_DAY', '15'),
    );
    this.commentsMaxPerSession = Number(
      this.configService.get<string>('F1_COMMENTS_MAX_PER_DAY', '4'),
    );
    this.repostsMaxPerSession = Number(
      this.configService.get<string>('F1_REPOSTS_MAX_PER_DAY', '5'),
    );
    this.quotesMaxPerSession = Number(
      this.configService.get<string>('F1_QUOTES_MAX_PER_DAY', '2'),
    );
    this.maxPostsPerSession = Number(
      this.configService.get<string>('F1_MAX_POSTS_PER_SESSION', '30'),
    );
  }

  /**
   * Run a browsing session for the given network.
   *
   * Uses EngagementGraph (LangGraph) to orchestrate the session:
   *   1. check_warmup — determine warmup phase, adjust interaction budget
   *   2. pick_source — choose targeting source (hashtag, competitor, feed)
   *   3. scroll_feed — scroll the feed and collect post URLs
   *   4. decide_per_post — LLM-driven per-post decisions (via HumanBehaviorEngine)
   *   5. record — finalize results
   *
   * The graph handles warmup gating and source selection internally.
   * This service handles browser context, DB session records, and SSE events.
   */
  async runBrowsingSession(
    network: SocialNetwork,
    durationSec?: number,
  ): Promise<{ sessionId: string; postsViewed: number; interactionsCount: number }> {
    const duration = durationSec ?? this.defaultDurationSec;
    const engager = this.getEngager(network);

    // Get or create session. Deferred: engagement must not force an inline form login in the
    // job hot-path (same reasoning as posting.service.ts) — recovery happens out-of-band via the
    // orchestrator's RECOVER_SESSION action, which has its own cooldown/circuit-breaker guards.
    const session = await this.sessionsService.getOrCreateSession(network, { deferFormLogin: true });
    if (!session) {
      throw new Error(`No active session for ${network} — auto-login failed`);
    }

    // Create browsing session record (feedUrl updated after graph picks source)
    const browsingSession = await this.prisma.browsingSession.create({
      data: {
        accountId: session.accountId,
        status: BrowsingSessionStatus.ACTIVE,
        feedUrl: this.getFeedUrl(network),
      },
    });

    this.logger.log(
      `Starting browsing session for ${network} (${duration}s) — session ${browsingSession.id}`,
    );

    // SSE event
    await this.sseService.publish({
      type: 'browsing_session_started',
      sessionId: browsingSession.id,
      network: network as string,
      durationSec: duration,
    });

    let postsViewed = 0;
    let interactionsCount = 0;
    let context: Awaited<ReturnType<IBrowserPort['acquireContext']>> | null = null;
    let page: Awaited<ReturnType<Awaited<ReturnType<IBrowserPort['acquireContext']>>['newPage']>> | undefined;

    try {
      // Sprint K: Acquire browser context from pool (enables parallel sessions)
      // P0-H3: Decrypt storageState if encrypted (v1: prefix).
      const storageState = session.storageState
        ? this.sessionsService.decryptStorageState(session)
        : undefined;
      context = await this.browser.acquireContext(network, storageState);
      page = await context.newPage();

      // Detect renderer/page crashes so we can close the context early. If the
      // renderer dies, the next Playwright call will fail with "Target page,
      // context or browser has been closed"; closing the context now lets the
      // BrowsingSessionService catch a fatal error and discard it instead of
      // reusing it.
      if (typeof page.on === 'function') {
        page.on('crash', () => {
          this.logger.warn(`Page crashed during ${network} browsing session — closing context`);
          void context?.close().catch(() => {});
        });
      }

      await this.browser.suppressPageErrors(page);

      // Build and invoke the EngagementGraph (LangGraph)
      const graph = buildEngagementGraph(engager, {
        targetingService: this.targetingService,
        warmupService: this.warmupService,
        humanBehaviorEngine: this.humanBehaviorEngine,
      });

      const compiled = graph.compile();
      const initialState = createEngagementInitialState({
        network,
        accountId: session.accountId,
        browsingSessionId: browsingSession.id,
        durationSec: duration,
        maxPosts: this.maxPostsPerSession,
        likesMaxPerSession: this.likesMaxPerSession,
        commentsMaxPerSession: this.commentsMaxPerSession,
        repostsMaxPerSession: this.repostsMaxPerSession,
        quotesMaxPerSession: this.quotesMaxPerSession,
        page,
      });

      // Hard timeout: the graph should finish within the planned duration + a buffer.
      // If a browser operation hangs (e.g. a stuck page), this prevents the job from running forever.
      // Buffer is generous because scroll + interactions must share the full duration budget.
      const finalState = await withTimeout(
        compiled.invoke(initialState),
        duration * 1000 + 180_000,
        `Browsing session for ${network}`,
      );

      postsViewed = finalState.postsProcessed ?? 0;
      interactionsCount = (finalState.results ?? []).filter(
        (r) => r.success && r.interactionId,
      ).length;

      // Update feedUrl from graph's source selection
      if (finalState.sourceUrl) {
        await this.prisma.browsingSession.update({
          where: { id: browsingSession.id },
          data: { feedUrl: finalState.sourceUrl },
        });
      }

      // Save updated session state — best effort, don't let a closed context block
      // the session completion record. If the browser crashed, there is no state to save.
      try {
        const updatedState = await withTimeout(
          this.browser.saveStorageState(context),
          10_000,
          `saveStorageState ${network}`,
        );
        await this.sessionsService.updateStorageState(session.id, updatedState);
      } catch (saveErr) {
        this.logger.warn(`Failed to save storage state for ${network}: ${(saveErr as Error).message}`);
      }

      // Update browsing session record
      await this.prisma.browsingSession.update({
        where: { id: browsingSession.id },
        data: {
          status: BrowsingSessionStatus.COMPLETED,
          endedAt: new Date(),
          durationSec: duration,
          postsViewed,
          interactionsCount,
        },
      });

      this.logger.log(
        `Browsing session completed for ${network}: ${postsViewed} posts, ${interactionsCount} interactions ` +
          `(source: ${finalState.sourceLabel ?? 'unknown'}, warmup: ${finalState.warmupPhase ?? 'none'})`,
      );

      // SSE event
      await this.sseService.publish({
        type: 'browsing_session_completed',
        sessionId: browsingSession.id,
        network: network as string,
        postsViewed,
        interactionsCount,
      });

      return { sessionId: browsingSession.id, postsViewed, interactionsCount };
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.error(`Browsing session failed for ${network}: ${errorMessage}`);

      // Fatal browser errors leave the context in a broken state. If we return it to
      // the pool, the next session will reuse it and fail immediately with the same error.
      // Close the context so releaseContext() discards it instead of reusing it.
      if (
        errorMessage.includes('Target page, context or browser has been closed') ||
        errorMessage.includes('browserContext.storageState') ||
        errorMessage.includes('page.goto: Target page, context or browser has been closed') ||
        errorMessage.includes('page.waitForTimeout: Target page, context or browser has been closed')
      ) {
        this.logger.warn(`Fatal browser error for ${network} — closing context instead of returning to pool`);
        if (context) {
          await withTimeout(context.close(), 10_000, `context.close ${network}`).catch(() => {});
        }
      }

      await this.prisma.browsingSession.update({
        where: { id: browsingSession.id },
        data: {
          status: BrowsingSessionStatus.FAILED,
          endedAt: new Date(),
          errorMessage: (err as Error).message,
          postsViewed,
          interactionsCount,
        },
      });

      await this.sseService.publish({
        type: 'browsing_session_failed',
        sessionId: browsingSession.id,
        network: network as string,
        error: (err as Error).message,
      });

      throw err;
    } finally {
      // Always close the page we opened — releaseContext() returns the
      // context to the pool as-is and does not close pages itself, so a
      // page left open here leaks for the lifetime of the pooled context.
      if (page) {
        await withTimeout(page.close(), 10_000, `page.close ${network}`).catch(() => {});
      }
      // Sprint K: Release context back to pool for reuse
      if (context) {
        this.browser.releaseContext(network, context);
      }
    }
  }

  /**
   * Get the appropriate engager for the network.
   */
  private getEngager(network: SocialNetwork): BaseEngager {
    switch (network) {
      case SocialNetwork.X:
        return this.xEngager;
      case SocialNetwork.THREADS:
        return this.threadsEngager;
      case SocialNetwork.FACEBOOK:
        return this.facebookEngager;
      default:
        throw new Error(`Unknown network: ${network as string}`);
    }
  }

  /**
   * Get the feed URL for a network.
   */
  private getFeedUrl(network: SocialNetwork): string {
    switch (network) {
      case SocialNetwork.X:
        return 'https://x.com/home';
      case SocialNetwork.THREADS:
        return 'https://www.threads.com/';
      case SocialNetwork.FACEBOOK:
        return this.facebookEngager.getPageUrl();
      default:
        throw new Error(`Unknown network: ${network as string}`);
    }
  }

  /**
   * Find all browsing sessions with optional filtering.
   */
  async findAll(opts?: {
    network?: SocialNetwork;
    status?: BrowsingSessionStatus;
    limit?: number;
  }): Promise<Prisma.BrowsingSessionGetPayload<{ include: { interactions: true } }>[]> {
    const where: Prisma.BrowsingSessionWhereInput = {};
    if (opts?.status) where.status = opts.status;
    if (opts?.network) {
      where.account = { network: opts.network };
    }

    return this.prisma.browsingSession.findMany({
      where,
      include: { interactions: true },
      orderBy: { startedAt: 'desc' },
      take: opts?.limit ?? 20,
    });
  }

  /**
   * Find all interactions with optional filtering.
   */
  async findInteractions(opts?: {
    network?: SocialNetwork;
    type?: InteractionType;
    status?: InteractionStatus;
    limit?: number;
  }): Promise<Prisma.InteractionGetPayload<{ include: { account: true } }>[]> {
    const where: Prisma.InteractionWhereInput = {};
    if (opts?.type) where.type = opts.type;
    if (opts?.status) where.status = opts.status;
    if (opts?.network) {
      where.account = { network: opts.network };
    }

    return this.prisma.interaction.findMany({
      where,
      include: { account: true },
      orderBy: { createdAt: 'desc' },
      take: opts?.limit ?? 50,
    });
  }
}
