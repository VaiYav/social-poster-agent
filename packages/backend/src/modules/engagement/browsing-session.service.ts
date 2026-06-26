// Browsing session service — simulates human-like browsing behavior.
// Opens a feed, scrolls for a duration, randomly likes/comments on posts,
// and records all interactions in the database.
//
// Purpose: anti-detection. Pure posting without engagement looks bot-like.
// Browsing sessions make the account look like a real user who reads and
// interacts with content, not just broadcasts.

import { Inject, Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class BrowsingSessionService {
  private readonly logger = new Logger(BrowsingSessionService.name);
  private readonly defaultDurationSec: number;
  private readonly likesMaxPerSession: number;
  private readonly commentsMaxPerSession: number;
  private readonly likeProbability: number;
  private readonly commentProbability: number;

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
    this.likeProbability = 0.3; // 30% chance to like a post seen during browsing
    this.commentProbability = 0.05; // 5% chance to comment on a post seen during browsing
  }

  /**
   * Run a browsing session for the given network.
   * Scrolls the feed, randomly likes/comments on posts, records interactions.
   */
  async runBrowsingSession(
    network: SocialNetwork,
    durationSec?: number,
  ): Promise<{ sessionId: string; postsViewed: number; interactionsCount: number }> {
    const duration = durationSec ?? this.defaultDurationSec;
    const engager = this.getEngager(network);

    // Get or create session
    const session = await this.sessionsService.getOrCreateSession(network);
    if (!session) {
      throw new Error(`No active session for ${network} — auto-login failed`);
    }

    // Create browsing session record
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
    let likesThisSession = 0;
    let commentsThisSession = 0;

    try {
      // Create browser context
      const storageState = session.storageState
        ? JSON.stringify(session.storageState)
        : undefined;
      const context = await this.browser.createContext(network, storageState);
      const page = await context.newPage();

      // Scroll the feed and collect post URLs
      const postUrls = await engager.scrollFeed(page, duration);

      // Process discovered posts — randomly like/comment
      for (const postUrl of postUrls) {
        postsViewed++;

        // Random like
        if (
          likesThisSession < this.likesMaxPerSession &&
          Math.random() < this.likeProbability
        ) {
          // Rate limit check
          const rateCheck = await this.rateLimitService.checkRateLimit(
            `${network as string}-like`,
          );
          if (rateCheck.allowed) {
            const interaction = await this.prisma.interaction.create({
              data: {
                accountId: session.accountId,
                type: InteractionType.LIKE,
                status: InteractionStatus.IN_PROGRESS,
                targetUrl: postUrl,
                browsingSessionId: browsingSession.id,
              },
            });

            const result = await engager.like(page, postUrl);
            await this.prisma.interaction.update({
              where: { id: interaction.id },
              data: {
                status: result.success
                  ? InteractionStatus.COMPLETED
                  : InteractionStatus.FAILED,
                errorMessage: result.error,
                screenshotPath: result.screenshotPath,
                completedAt: new Date(),
              },
            });

            if (result.success) {
              likesThisSession++;
              interactionsCount++;
              await this.rateLimitService.recordPost(`${network as string}-like`);
            }
          }
        }

        // Random comment (much rarer than likes)
        if (
          commentsThisSession < this.commentsMaxPerSession &&
          Math.random() < this.commentProbability
        ) {
          // Generate a short comment via LLM (or use a placeholder for now)
          const commentText = this.generateComment();
          if (commentText) {
            const rateCheck = await this.rateLimitService.checkRateLimit(
              `${network as string}-comment`,
            );
            if (rateCheck.allowed) {
              const interaction = await this.prisma.interaction.create({
                data: {
                  accountId: session.accountId,
                  type: InteractionType.COMMENT,
                  status: InteractionStatus.IN_PROGRESS,
                  targetUrl: postUrl,
                  content: commentText,
                  browsingSessionId: browsingSession.id,
                },
              });

              const result = await engager.comment(page, postUrl, commentText);
              await this.prisma.interaction.update({
                where: { id: interaction.id },
                data: {
                  status: result.success
                    ? InteractionStatus.COMPLETED
                    : InteractionStatus.FAILED,
                  errorMessage: result.error,
                  screenshotPath: result.screenshotPath,
                  completedAt: new Date(),
                },
              });

              if (result.success) {
                commentsThisSession++;
                interactionsCount++;
                await this.rateLimitService.recordPost(`${network as string}-comment`);
              }
            }
          }
        }

        // Human-like pause between interactions
        await this.browser.randomDelay(5000, 15000);
      }

      // Save updated session state
      const updatedState = await this.browser.saveStorageState(context);
      await this.sessionsService.updateStorageState(session.id, updatedState);
      await page.close();
      await context.close();

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
        `Browsing session completed for ${network}: ${postsViewed} posts viewed, ${interactionsCount} interactions`,
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
      this.logger.error(`Browsing session failed for ${network}: ${(err as Error).message}`);

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
   * Generate a short comment for engagement.
   * TODO: integrate with LLM service for contextual comments.
   * For now, returns a random generic positive comment.
   */
  private generateComment(): string {
    const comments = [
      'Great post! Thanks for sharing.',
      'This is really insightful.',
      'Love this perspective!',
      'Thanks for sharing this.',
      'Very interesting, bookmarked!',
      'This resonates with me.',
      'Spot on!',
    ];
    return comments[Math.floor(Math.random() * comments.length)] ?? 'Great post!';
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
