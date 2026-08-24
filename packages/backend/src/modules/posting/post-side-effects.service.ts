import { Injectable, Logger, Optional } from "@nestjs/common";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import type { SourceRef } from "@spa/shared";
import { ContentPillarTracker } from "../content-enhancements/content-pillar.tracker.js";
import { ABVariantService } from "../content-enhancements/ab-variant.service.js";

/**
 * REFACTOR-103: non-posting side effects extracted from PostingService so each
 * concern has one home. Nothing here may throw into the posting path — both
 * helpers are best-effort by contract.
 */
@Injectable()
export class PostSideEffectsService {
  private readonly logger = new Logger(PostSideEffectsService.name);

  constructor(
    @Optional() private readonly pillarTracker?: ContentPillarTracker,
    @Optional() private readonly abVariantService?: ABVariantService,
  ) {}

  /**
   * 2.8.2: Record a successfully posted draft against its content pillar.
   * Non-blocking — pillar tracking is not a posting dependency.
   */
  async recordPostPillar(post: { sourceRef: unknown; content: string }): Promise<void> {
    if (!this.pillarTracker) return;
    const sourceRef = post.sourceRef as SourceRef | null | undefined;
    const topic = sourceRef?.topic ?? sourceRef?.originalTopic ?? post.content;
    const keywords = sourceRef?.keywords ?? [];
    try {
      await this.pillarTracker.recordPost(topic, keywords);
    } catch (err) {
      this.logger.debug(`P6: Pillar recording failed (non-blocking): ${(err as Error).message}`);
    }
  }

  /**
   * P7: Resolve the A/B variant that should be used for a post. Returns the
   * selected content and records the selection in PostVariant. Non-blocking.
   */
  async resolveVariant(postId: string, network: SocialNetwork, content: string): Promise<string> {
    if (!this.abVariantService) return content;
    try {
      const selected = await this.abVariantService.selectAndApplyVariant(postId, network, content);
      return selected.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`A/B variant resolution failed for ${postId}: ${message}`);
      return content;
    }
  }

  /** P7: Record the selected variant's outcome timestamp. Best-effort. */
  async recordVariantPosted(postId: string): Promise<void> {
    if (!this.abVariantService) return;
    await this.abVariantService.recordPosted(postId, new Date()).catch(() => {});
  }
}
