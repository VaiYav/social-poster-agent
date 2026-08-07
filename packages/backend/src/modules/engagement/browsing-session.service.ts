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
import { AccountsService } from '../accounts/accounts.service.js';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import {
  InteractionStatus,
  InteractionType,
  SocialNetwork,
  BrowsingSessionStatus,
  Session,
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
  DISTRIBUTED_LOCK_SERVICE,
  type DistributedLockService,
} from '../../infrastructure/multi-instance/distributed-lock.service.js';
import {
  buildEngagementGraph,
  createEngagementInitialState,
} from './engagement.graph.js';
import { withTimeout } from '../../infrastructure/util/with-timeout.js';
import { isNetworkEnabled } from '../../domain/enabled-networks.js';

@Injectable()
export class BrowsingSessionService {
  private readonly logger = new Logger(BrowsingSessionService.name);
  private readonly defaultDurationSec: number;
  private readonly likesMaxPerSession: number;
  private readonly commentsMaxPerSession: number;
  private readonly repostsMaxPerSession: number;
  private readonly quotesMaxPerSession: number;
  private readonly discussionsMaxPerSession: number;
  private readonly maxPostsPerSession: number;
  // F1 daily hard limits (per account, across all sessions)
  private readonly likesMaxPerDay: number;
  private readonly commentsMaxPerDay: number;
  private readonly repostsMaxPerDay: number;
  private readonly quotesMaxPerDay: number;
  // Distributed lock settings — only one browsing session can run at a time
  // across ALL networks. Two concurrent Camoufox contexts (e.g. X + THREADS)
  // cause renderer process crashes due to memory pressure in constrained
  // containers. The distributed lock serializes sessions across all instances.
  private readonly lockKey: string;
  private readonly lockTtlBufferMs: number;
  private readonly lockRetryMs: number;

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
    @Inject(DISTRIBUTED_LOCK_SERVICE) private readonly lockService: DistributedLockService,
    @Optional() private readonly warmupService?: WarmupService,
    @Optional() private readonly accountsService?: AccountsService,
  ) {
    this.defaultDurationSec = Number(
      this.configService.get<string>('F1_BROWSING_SESSION_MINUTES', '15'),
    ) * 60;
    this.likesMaxPerSession = Number(
      this.configService.get<string>('F1_LIKES_MAX_PER_DAY', '25'),
    );
    this.commentsMaxPerSession = Number(
      this.configService.get<string>('F1_COMMENTS_MAX_PER_DAY', '10'),
    );
    this.repostsMaxPerSession = Number(
      this.configService.get<string>('F1_REPOSTS_MAX_PER_DAY', '8'),
    );
    this.quotesMaxPerSession = Number(
      this.configService.get<string>('F1_QUOTES_MAX_PER_DAY', '3'),
    );
    this.discussionsMaxPerSession = Number(
      this.configService.get<string>('F1_DISCUSSIONS_MAX_PER_DAY', '2'),
    );
    this.maxPostsPerSession = Number(
      this.configService.get<string>('F1_MAX_POSTS_PER_SESSION', '40'),
    );
    this.likesMaxPerDay = Number(
      this.configService.get<string>('F1_MAX_LIKES_PER_DAY_GLOBAL', '150'),
    );
    this.commentsMaxPerDay = Number(
      this.configService.get<string>('F1_MAX_COMMENTS_PER_DAY_GLOBAL', '50'),
    );
    this.repostsMaxPerDay = Number(
      this.configService.get<string>('F1_MAX_REPOSTS_PER_DAY_GLOBAL', '40'),
    );
    this.quotesMaxPerDay = Number(
      this.configService.get<string>('F1_MAX_QUOTES_PER_DAY_GLOBAL', '15'),
    );
    this.lockKey = this.configService.get<string>('ENGAGEMENT_LOCK_KEY', 'spa:lock:engagement');
    this.lockTtlBufferMs = Number(this.configService.get<string>('ENGAGEMENT_LOCK_TTL_BUFFER_MS', '300000'));
    this.lockRetryMs = Number(this.configService.get<string>('ENGAGEMENT_LOCK_ACQUIRE_RETRY_MS', '1000'));
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
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; postsViewed: number; interactionsCount: number }> {
    if (!isNetworkEnabled(network)) {
      this.logger.warn(`Browsing session requested for disabled network ${network} — skipping`);
      return { sessionId: '', postsViewed: 0, interactionsCount: 0 };
    }
    const duration = durationSec ?? this.defaultDurationSec;
    const engager = this.getEngager(network);

    // Acquire the distributed session lock — only one browsing session runs at a time
    // across all networks and all instances. Two concurrent Camoufox contexts (X + THREADS)
    // cause renderer process crashes due to memory pressure. The lock serializes sessions;
    // the queue will retry the waiting job after the current one finishes.
    //
    // The lock TTL must be longer than the graph hard timeout (duration + 180s) so the
    // lock is not released before `withTimeout` aborts a stuck/hung session.
    const lockTtlMs = duration * 1000 + 180_000 + this.lockTtlBufferMs;
    // Wait slightly longer than the lock TTL so a crashed/orphaned previous
    // holder's lock can expire before we give up acquiring it.
    const lockTimeoutMs = lockTtlMs + this.lockRetryMs;
    const lock = await this.lockService.acquire(
      this.lockKey,
      lockTtlMs,
      lockTimeoutMs,
      this.lockRetryMs,
    );

    let browsingSession: { id: string; accountId: string } | null = null;
    let postsViewed = 0;
    let interactionsCount = 0;
    let session: Session | null = null;
    let context: Awaited<ReturnType<IBrowserPort['acquireContext']>> | null = null;
    let page: Awaited<ReturnType<Awaited<ReturnType<IBrowserPort['acquireContext']>>['newPage']>> | undefined;

    try {
      // Pick an account for this network (round-robin if multiple are configured).
      // Deferred: engagement must not force an inline form login in the
      // job hot-path (same reasoning as posting.service.ts) — recovery happens out-of-band via the
      // orchestrator's RECOVER_SESSION action, which has its own cooldown/circuit-breaker guards.
      let accountId: string | undefined;
      if (this.accountsService) {
        const account = await this.accountsService.getNextAccountForNetwork(network);
        accountId = account?.id;
      }
      session = accountId
        ? await this.sessionsService.getOrCreateSession(accountId, network, { deferFormLogin: true })
        : await this.sessionsService.getOrCreateSession(network, { deferFormLogin: true });
      if (!session) {
        throw new Error(`No active session for ${network} — auto-login failed`);
      }

      // F1 daily hard limits: clamp per-session budgets to the remaining daily global allowance.
      let likesBudget = this.likesMaxPerSession;
      let commentsBudget = this.commentsMaxPerSession;
      let repostsBudget = this.repostsMaxPerSession;
      let quotesBudget = this.quotesMaxPerSession;

      if (session.accountId) {
        const dailyCounts = await this.getDailyInteractionCounts(session.accountId);
        const likesMax = Math.max(0, this.likesMaxPerDay - dailyCounts.likes);
        const commentsMax = Math.max(0, this.commentsMaxPerDay - dailyCounts.comments);
        const repostsMax = Math.max(0, this.repostsMaxPerDay - dailyCounts.reposts);
        const quotesMax = Math.max(0, this.quotesMaxPerDay - dailyCounts.quotes);

        likesBudget = Math.min(this.likesMaxPerSession, likesMax);
        commentsBudget = Math.min(this.commentsMaxPerSession, commentsMax);
        repostsBudget = Math.min(this.repostsMaxPerSession, repostsMax);
        quotesBudget = Math.min(this.quotesMaxPerSession, quotesMax);

        this.logger.log(
          `F1 daily budget for account ${session.accountId}: likes ${likesBudget}/${this.likesMaxPerSession} ` +
            `(used ${dailyCounts.likes}/${this.likesMaxPerDay}), ` +
            `comments ${commentsBudget}/${this.commentsMaxPerSession} (used ${dailyCounts.comments}/${this.commentsMaxPerDay})`,
        );
      } else {
        this.logger.warn(`Session ${session.id} has no accountId — using per-session F1 budgets only`);
      }

      // Create browsing session record (feedUrl updated after graph picks source)
      browsingSession = await this.prisma.browsingSession.create({
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

      // Sprint K: Acquire browser context from pool (enables parallel sessions)
      // P0-H3: Decrypt storageState if encrypted (v1: prefix).
      const storageState = session.storageState
        ? this.sessionsService.decryptStorageState(session)
        : undefined;
      context = await this.browser.acquireContext(network, storageState, session.accountId);
      page = await context.newPage();

      await this.browser.suppressPageErrors(page);

      // Block heavy resources (images, video, fonts) to reduce memory pressure
      // and prevent renderer process crashes. Engagement sessions only need the
      // text content of posts — images/videos are not needed for liking or
      // commenting. X.com pages with many media-heavy tweets crash the Firefox
      // renderer under memory pressure in constrained containers.
      // Centralised in BrowserFactory.applyResourceBlocking so all read-only
      // call sites share the same blocking policy (gated by CAMOUFOX_BLOCK_IMAGES_READONLY).
      await this.browser.applyResourceBlocking(page, { blockImages: true });

      // Crash/close detection: the graph may be stuck in a long scroll/operation.
      // If the page dies, abort the session immediately instead of waiting for the full duration+180s timeout.
      let sessionActive = true;
      let crashReject: ((err: Error) => void) | undefined;
      const crashPromise = new Promise<never>((_, reject) => {
        crashReject = reject;
      });
      const crashError = (event: string) => new Error(`Page ${event} during ${network} browsing session`);

      if (typeof page.on === 'function') {
        page.on('crash', () => {
          if (!sessionActive) return;
          this.logger.warn(`Page crashed during ${network} browsing session — closing context`);
          void context?.close().catch(() => {});
          crashReject?.(crashError('crashed'));
        });
        page.on('close', () => {
          if (!sessionActive) return;
          this.logger.warn(`Page closed during ${network} browsing session — closing context`);
          void context?.close().catch(() => {});
          crashReject?.(crashError('closed'));
        });
      }

      // Pre-session health check: verify the page/browser is responsive before
      // committing to a full engagement graph run. A simple evaluate call catches
      // dead browsers/contexts early — without this, the first navigation inside
      // the graph fails after a long timeout and wastes session time.
      try {
        await withTimeout(
          page.evaluate(() => 1),
          10_000,
          `Pre-session health check ${network}`,
        );
      } catch (err) {
        const errMsg = (err as Error).message;
        this.logger.warn(`Pre-session health check failed for ${network}: ${errMsg}`);
        if (
          errMsg.includes('Target page, context or browser has been closed') ||
          errMsg.includes('Browser has been closed') ||
          errMsg.includes('Context has been closed') ||
          errMsg.includes('Page has been closed') ||
          errMsg.includes('Connection closed')
        ) {
          throw new Error(`Pre-session health check failed: ${errMsg}`);
        }
        // Non-fatal (e.g. timeout) — continue, the graph will handle it
      }

      // P0: conversation-ready targeting — check if this account has unreplied comments
      // on its own posts for this network. If so, the engagement graph will prefer
      // the 'notifications' source over the algorithmic feed.
      const newRepliesCount = await (this.prisma.incomingComment?.count({
        where: {
          network,
          status: 'NEW',
          post: { accountId: session.accountId },
        },
      }) ?? Promise.resolve(0)).catch(() => 0);
      const conversationReady = newRepliesCount > 0;

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
        likesMaxPerSession: likesBudget,
        commentsMaxPerSession: commentsBudget,
        repostsMaxPerSession: repostsBudget,
        quotesMaxPerSession: quotesBudget,
        discussionsMaxPerSession: this.discussionsMaxPerSession,
        conversationReady,
        page,
      });

      // Hard timeout: the graph should finish within the planned duration + a buffer.
      // If the page crashes/closes, crashPromise rejects immediately and aborts the session.
      try {
        const signalPromise = signal
          ? new Promise<never>((_, reject) => {
              const onAbort = () => reject(new Error(`Browsing session for ${network} aborted`));
              if (signal.aborted) {
                onAbort();
                return;
              }
              signal.addEventListener('abort', onAbort, { once: true });
            })
          : undefined;

        const finalState = await withTimeout(
          Promise.race(
            signalPromise
              ? [compiled.invoke(initialState), crashPromise, signalPromise]
              : [compiled.invoke(initialState), crashPromise],
          ),
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
      } finally {
        sessionActive = false;
      }
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
        errorMessage.includes('page.waitForTimeout: Target page, context or browser has been closed') ||
        errorMessage.includes('Page was closed during post extraction') ||
        errorMessage.includes('Page closed during batch processing')
      ) {
        this.logger.warn(`Fatal browser error for ${network} — closing context instead of returning to pool`);
        if (context) {
          await withTimeout(context.close(), 10_000, `context.close ${network}`).catch(() => {});
        }
      }

      if (browsingSession) {
        await this.prisma.browsingSession.update({
          where: { id: browsingSession.id },
          data: {
            status: BrowsingSessionStatus.FAILED,
            endedAt: new Date(),
            errorMessage: (err as Error).message,
            postsViewed,
            interactionsCount,
          },
        }).catch(() => {});

        await this.sseService.publish({
          type: 'browsing_session_failed',
          sessionId: browsingSession.id,
          network: network as string,
          error: (err as Error).message,
        }).catch(() => {});
      }

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
        this.browser.releaseContext(network, context, session?.accountId);
      }
      // Release the distributed session lock so the next job can start.
      await lock.release().catch(() => {});
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
   * F1 daily hard limits: count non-skipped, non-failed interactions for the
   * account in the current UTC day. Used to clamp per-session budgets.
   */
  private async getDailyInteractionCounts(accountId: string): Promise<{
    likes: number;
    comments: number;
    reposts: number;
    quotes: number;
  }> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setUTCHours(23, 59, 59, 999);

    const rows = await this.prisma.interaction.groupBy({
      by: ['type'],
      where: {
        accountId,
        createdAt: { gte: startOfDay, lte: endOfDay },
        status: { notIn: [InteractionStatus.FAILED, InteractionStatus.SKIPPED] },
      },
      _count: { type: true },
    });

    const counts: Record<string, number> = {};
    if (Array.isArray(rows)) {
      for (const row of rows) {
        counts[row.type] = (row._count?.type as number | undefined) ?? 0;
      }
    }

    return {
      likes: counts[InteractionType.LIKE] ?? 0,
      comments: counts[InteractionType.COMMENT] ?? 0,
      reposts: counts[InteractionType.REPOST] ?? 0,
      quotes: counts[InteractionType.QUOTE] ?? 0,
    };
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
