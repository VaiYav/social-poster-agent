/**
 * Auto-Approve Listener — enables fully autonomous posting without human review.
 *
 * Listens to PostEvents.DRAFT_GENERATED and, when AUTO_APPROVE_ENABLED=true,
 * checks the LLM quality score and approves the draft only if it meets the
 * threshold (default: 7/10). Low-scoring drafts remain DRAFT for human review.
 *
 * Flow: generation → DRAFT_GENERATED → (quality gate) → APPROVED → enqueue → post
 *        generation → DRAFT_GENERATED → (quality gate FAIL) → stays DRAFT (human review)
 *
 * When AUTO_APPROVE_ENABLED=false (default for safety), this listener is a no-op
 * and the operator must manually approve drafts via the UI.
 *
 * Config:
 *   AUTO_APPROVE_ENABLED=true/false
 *   AUTO_APPROVE_MIN_SCORE=7  (1-10, drafts below this stay DRAFT)
 *
 * Circular dependency note: QueueService is resolved lazily via ModuleRef,
 * same pattern as PostsController — PostsModule → QueueModule → PostingModule
 * → PostsModule would be circular.
 */
import { Injectable, Logger, Inject } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ModuleRef } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { PostStatus, SocialNetwork } from "../../generated/prisma/client";
import type { JudgeScores } from "@spa/shared";
import { IPostingQueuePort } from "../../domain/ports/posting-queue.port.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { PostEvents } from "../../events/enums/post-events.enum";
import { parseBool } from "../../infrastructure/config/parse-bool.js";

@Injectable()
export class AutoApproveListener {
  private readonly logger = new Logger(AutoApproveListener.name);
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    configService: ConfigService,
    @Inject(IPostingQueuePort) private readonly postingQueue: IPostingQueuePort,
  ) {
    // SPA_DRY_RUN: disable auto-approve in dry-run mode — the dry-run runner
    // controls the flow manually (approve → postById) to avoid race conditions
    // with the BullMQ worker which would start posting before the session is ready.
    const isDryRun = parseBool(configService.get<string>("SPA_DRY_RUN", "false"));
    this.enabled =
      !isDryRun && parseBool(configService.get<string>("AUTO_APPROVE_ENABLED", "false"));
    if (isDryRun) {
      this.logger.warn(
        `AUTO_APPROVE disabled in dry-run mode (SPA_DRY_RUN=true) — runner controls flow manually`,
      );
    } else if (this.enabled) {
      this.logger.warn(
        "AUTO_APPROVE_ENABLED=true — drafts will be auto-approved via the AutoApprove gate " +
          "(AutoCheck + quality thresholds, fail-closed) and posted without human review",
      );
    }
  }

  @OnEvent(PostEvents.DRAFT_GENERATED)
  async handleDraftGenerated(payload: { postId: string; network: string }): Promise<void> {
    if (!this.enabled) return;

    try {
      const post = await this.prisma.post.findUnique({
        where: { id: payload.postId },
        select: {
          content: true,
          network: true,
          status: true,
          llmMetadata: true,
          threadPosition: true,
          threadId: true,
        },
      });
      if (!post) {
        this.logger.warn(`Auto-approve: post ${payload.postId} not found`);
        return;
      }
      if (post.status !== PostStatus.DRAFT) return; // already handled by another path

      const meta =
        (post.llmMetadata as { qualityScore?: number; judgeScores?: JudgeScores } | null) ?? {};
      const score = meta.qualityScore;
      const judgeScores = meta.judgeScores;

      // AU1: single gate — delegate to AutoApproveService.evaluate(), which runs the
      // full AutoCheck (engagement-bait, char-limit, forbidden phrases, SimHash) +
      // quality thresholds and is fail-closed on a missing score. Resolved lazily via
      // ModuleRef (AutonomyModule) so this listener's constructor — and the 11 test
      // paramtypes restorations that pin it — stay unchanged.
      const { AutoApproveService } = await import("./auto-approve.service.js");
      const autoApprove = this.moduleRef.get(AutoApproveService, { strict: false });
      if (!autoApprove) {
        this.logger.warn(`AutoApproveService not available — post ${payload.postId} left as DRAFT`);
        return;
      }

      const result = await autoApprove.evaluate(
        payload.postId,
        post.content,
        post.network,
        score,
        judgeScores,
      );

      if (result.decision === "AUTO_APPROVE") {
        const llmMetadata = (post.llmMetadata as { multiStage?: boolean } | null) ?? {};
        const isMultiStage = llmMetadata.multiStage === true;

        // F2: for multi-stage threads, only the root post starts the chain.
        // Continuations are scheduled by postById() once the previous stage is live,
        // preserving the 30-minute delay and sequential order.
        if (isMultiStage && post.threadPosition > 0) {
          this.logger.log(
            `Auto-approved continuation ${payload.postId} (position ${post.threadPosition}) — root will schedule`,
          );
        } else {
          // Enqueue to BullMQ posting queue — same lazy resolution as PostsController
          await this.enqueueForPosting(payload.postId, post.network as string);
          this.logger.log(`Auto-approved post ${payload.postId} (${post.network}) — enqueued`);
        }
      } else {
        this.logger.log(
          `Auto-approve [${result.decision}] post ${payload.postId}: ${result.reason}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Auto-approve failed for post ${payload.postId}: ${(err as Error).message}`,
      );
    }
  }

  private async enqueueForPosting(postId: string, network: string): Promise<void> {
    try {
      // A5: enqueue via IPostingQueuePort (no ModuleRef hack for the queue).
      await this.postingQueue.enqueuePosting(postId, network as SocialNetwork);
      this.logger.log(`Auto-approved post ${postId} enqueued for ${network}`);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue auto-approved post ${postId}: ${(err as Error).message}`,
      );
    }
  }
}
