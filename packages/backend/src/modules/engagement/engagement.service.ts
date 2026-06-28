// Engagement service — orchestrates individual engagement actions (like, comment, follow).
// Unlike browsing sessions (which are autonomous), these are explicit API-triggered actions.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import {
  InteractionStatus,
  InteractionType,
  SocialNetwork,
  type Prisma,
} from '@prisma/client';
import type { BaseEngager } from './engagers/base.engager.js';
import { XEngager } from './engagers/x.engager.js';
import { ThreadsEngager } from './engagers/threads.engager.js';
import { FacebookEngager } from './engagers/facebook.engager.js';
import type { EngagementResult } from '../posting/posters/base.poster.js';

@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly sseService: SseService,
    private readonly rateLimitService: RateLimitService,
    private readonly xEngager: XEngager,
    private readonly threadsEngager: ThreadsEngager,
    private readonly facebookEngager: FacebookEngager,
  ) {}

  /**
   * Like a post on the given network.
   */
  async like(network: SocialNetwork, postUrl: string): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(network, InteractionType.LIKE, postUrl, undefined, (engager, page) =>
      engager.like(page, postUrl),
    );
  }

  /**
   * Comment on a post on the given network.
   */
  async comment(
    network: SocialNetwork,
    postUrl: string,
    text: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(
      network,
      InteractionType.COMMENT,
      postUrl,
      text,
      (engager, page) => engager.comment(page, postUrl, text),
    );
  }

  /**
   * Follow a user/page on the given network.
   */
  async follow(
    network: SocialNetwork,
    handleOrUrl: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(
      network,
      InteractionType.FOLLOW,
      undefined,
      undefined,
      (engager, page) => engager.follow(page, handleOrUrl),
      handleOrUrl,
    );
  }

  /**
   * Reply to a post on the given network.
   */
  async reply(
    network: SocialNetwork,
    postUrl: string,
    text: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(
      network,
      InteractionType.REPLY,
      postUrl,
      text,
      (engager, page) => engager.reply(page, postUrl, text),
    );
  }

  /**
   * Core method for performing a single engagement interaction.
   * Creates an Interaction record, performs the action, updates the record.
   */
  private async performInteraction(
    network: SocialNetwork,
    type: InteractionType,
    targetUrl: string | undefined,
    content: string | undefined,
    action: (engager: BaseEngager, page: import('playwright-core').Page) => Promise<EngagementResult>,
    targetHandle?: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    // Rate limit check
    const rateKey = `${network as string}-${type.toLowerCase()}`;
    const rateCheck = await this.rateLimitService.checkRateLimit(rateKey);
    if (!rateCheck.allowed) {
      this.logger.warn(`Rate limited for ${rateKey}: ${rateCheck.reason}`);
      return {
        success: false,
        error: `Rate limited: ${rateCheck.reason}`,
        interactionId: '',
      };
    }

    // Get or create session
    const session = await this.sessionsService.getOrCreateSession(network);
    if (!session) {
      return {
        success: false,
        error: `No active session for ${network} — auto-login failed`,
        interactionId: '',
      };
    }

    // Create interaction record
    const interaction = await this.prisma.interaction.create({
      data: {
        accountId: session.accountId,
        type,
        status: InteractionStatus.IN_PROGRESS,
        targetUrl,
        targetHandle,
        content,
      },
    });

    // SSE event
    await this.sseService.publish({
      type: 'interaction_started',
      interactionId: interaction.id,
      interactionType: type,
      network: network as string,
      targetUrl,
    });

    try {
      const engager = this.getEngager(network);

      // Create browser context — decrypt storage state if encrypted (v1: prefix)
      const storageState = session.storageState
        ? this.sessionsService.decryptStorageState(session)
        : undefined;
      const context = await this.browser.createContext(network, storageState);
      const page = await context.newPage();

      // Perform the engagement action
      const result = await action(engager, page);

      // Save updated session state
      const updatedState = await this.browser.saveStorageState(context);
      await this.sessionsService.updateStorageState(session.id, updatedState);
      await page.close();
      await context.close();

      // Update interaction record
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
      }

      // SSE event
      await this.sseService.publish({
        type: result.success ? 'interaction_completed' : 'interaction_failed',
        interactionId: interaction.id,
        interactionType: type,
        network: network as string,
        targetUrl,
        error: result.error,
      });

      this.logger.log(
        `Interaction ${type} on ${network}: ${result.success ? 'success' : 'failed'}`,
      );

      return { ...result, interactionId: interaction.id };
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.logger.error(`Interaction ${type} failed on ${network}: ${errorMsg}`);

      await this.prisma.interaction.update({
        where: { id: interaction.id },
        data: {
          status: InteractionStatus.FAILED,
          errorMessage: errorMsg,
          completedAt: new Date(),
        },
      });

      await this.sseService.publish({
        type: 'interaction_failed',
        interactionId: interaction.id,
        interactionType: type,
        network: network as string,
        targetUrl,
        error: errorMsg,
      });

      return { success: false, error: errorMsg, interactionId: interaction.id };
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
   * Get engagement statistics.
   */
  async getStats(network?: SocialNetwork): Promise<{
    total: number;
    completed: number;
    failed: number;
    byType: Record<string, number>;
  }> {
    const where: Prisma.InteractionWhereInput = {};
    if (network) {
      where.account = { network };
    }

    const [total, completed, failed, byTypeRaw] = await Promise.all([
      this.prisma.interaction.count({ where }),
      this.prisma.interaction.count({ where: { ...where, status: InteractionStatus.COMPLETED } }),
      this.prisma.interaction.count({ where: { ...where, status: InteractionStatus.FAILED } }),
      this.prisma.interaction.groupBy({
        by: ['type'],
        where,
        _count: true,
      }),
    ]);

    const byType: Record<string, number> = {};
    for (const item of byTypeRaw) {
      byType[item.type] = item._count;
    }

    return { total, completed, failed, byType };
  }
}
