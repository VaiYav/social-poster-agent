/**
 * P1-07: IndexNow listener.
 *
 * Listens for POST_VERIFIED and submits the canonical URL to Bing/Yandex via
 * the IndexNow protocol. Only submits canonical URLs that belong to the
 * operator's own host (the POSSE source), not third-party syndicated URLs.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { IndexNowService } from '../../infrastructure/indexnow/indexnow.service';
import { parseBool } from '../../infrastructure/config/parse-bool.js';

interface PostVerifiedEvent {
  postId: string;
  network: string;
  postUrl?: string;
}

@Injectable()
export class IndexNowListener {
  private readonly logger = new Logger(IndexNowListener.name);
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly indexNow: IndexNowService,
  ) {
    this.enabled = parseBool(this.configService.get<string>('INDEXNOW_ENABLED', 'false'));
  }

  @OnEvent('post.post_verified')
  async handlePostVerified(payload: PostVerifiedEvent): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`IndexNow disabled — skipping POST_VERIFIED for ${payload.postId}`);
      return;
    }

    try {
      const post = await this.prisma.post.findUnique({
        where: { id: payload.postId },
        select: { canonicalUrl: true, contentType: true, network: true },
      });
      if (!post) {
        this.logger.warn(`IndexNow: post ${payload.postId} not found`);
        return;
      }

      // IndexNow is for the canonical/owned URL (POSSE source), not syndicated platforms
      const url = post.canonicalUrl || payload.postUrl;
      if (!url) {
        this.logger.debug(`IndexNow: no URL to submit for ${payload.postId}`);
        return;
      }

      this.logger.log(`IndexNow: submitting ${url} for ${payload.postId} (${post.network})`);
      await this.indexNow.submit(url);
    } catch (err) {
      this.logger.error(`IndexNow listener failed for ${payload.postId}: ${(err as Error).message}`);
      // NEVER rethrow — event listeners must be fire-and-forget.
    }
  }
}
