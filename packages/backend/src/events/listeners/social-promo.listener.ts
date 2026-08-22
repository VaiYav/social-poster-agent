/**
 * P2-04: Social promo trigger listener.
 *
 * Listens for the POST_VERIFIED domain event and triggers the social generation
 * graph to create platform-native promo posts from the published article or
 * social post. Generated drafts flow through the normal judge/auto-approve queue
 * and are posted to all enabled social networks.
 */
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { GenerationService } from "../../modules/generation/generation.service";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import type { PostVerifiedEvent } from "../post-verified.event.js";

@Injectable()
export class SocialPromoListener {
  private readonly logger = new Logger(SocialPromoListener.name);
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly generationService: GenerationService,
  ) {
    this.enabled = parseBool(this.configService.get<string>("SOCIAL_PROMO_ENABLED", "false"));
    if (this.enabled) {
      this.logger.log("Social promo listener enabled — will generate promo posts on POST_VERIFIED");
    }
  }

  @OnEvent("post.post_verified")
  async handlePostVerified(payload: PostVerifiedEvent): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`Social promo disabled — skipping POST_VERIFIED for ${payload.postId}`);
      return;
    }

    try {
      const post = await this.prisma.post.findUnique({
        where: { id: payload.postId },
      });
      if (!post) {
        this.logger.warn(`Social promo: post ${payload.postId} not found`);
        return;
      }

      this.logger.log(`Social promo triggered for ${payload.postId} (${post.network})`);
      await this.generationService.generateSocialPromo(post);
    } catch (err) {
      this.logger.error(
        `Social promo listener failed for ${payload.postId}: ${(err as Error).message}`,
      );
      // NEVER rethrow — event listeners must be fire-and-forget.
    }
  }
}
