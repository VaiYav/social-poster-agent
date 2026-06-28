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
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostsService } from '../../modules/posts/posts.service';
import { PostEvents } from '../enums/post-events.enum';

@Injectable()
export class AutoApproveListener {
  private readonly logger = new Logger(AutoApproveListener.name);
  private readonly enabled: boolean;
  private readonly minScore: number;

  constructor(
    private readonly postsService: PostsService,
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    configService: ConfigService,
  ) {
    // SPA_DRY_RUN: disable auto-approve in dry-run mode — the dry-run runner
    // controls the flow manually (approve → postById) to avoid race conditions
    // with the BullMQ worker which would start posting before the session is ready.
    const isDryRun = configService.get<string>('SPA_DRY_RUN', 'false') === 'true';
    this.enabled = !isDryRun && configService.get<string>('AUTO_APPROVE_ENABLED', 'false') === 'true';
    const rawScore = Number(configService.get<string>('AUTO_APPROVE_MIN_SCORE', '7'));
    this.minScore = Number.isFinite(rawScore) && rawScore >= 1 && rawScore <= 10 ? rawScore : 7;
    if (isDryRun) {
      this.logger.warn(`AUTO_APPROVE disabled in dry-run mode (SPA_DRY_RUN=true) — runner controls flow manually`);
    } else if (this.enabled) {
      this.logger.warn(
        `AUTO_APPROVE_ENABLED=true — drafts with quality score ≥ ${this.minScore}/10 will be auto-approved and posted without human review`,
      );
    }
  }

  @OnEvent(PostEvents.DRAFT_GENERATED)
  async handleDraftGenerated(payload: { postId: string; network: string }): Promise<void> {
    if (!this.enabled) return;

    try {
      // Quality gate: check LLM quality score from llmMetadata
      const post = await this.prisma.post.findUnique({
        where: { id: payload.postId },
        select: { llmMetadata: true, content: true },
      });

      if (!post) {
        this.logger.warn(`Auto-approve: post ${payload.postId} not found`);
        return;
      }

      const metadata = post.llmMetadata as { qualityScore?: number } | null;
      const score = metadata?.qualityScore;

      if (score === undefined || score === null) {
        // No score — fail open (approve) to maintain backward compatibility
        this.logger.warn(
          `Auto-approve: post ${payload.postId} has no quality score — approving (backward compat)`,
        );
      } else if (score < this.minScore) {
        // Score below threshold — keep as DRAFT for human review
        this.logger.log(
          `Auto-approve: post ${payload.postId} score ${score}/10 < ${this.minScore} — kept as DRAFT for human review`,
        );
        return;
      } else {
        this.logger.log(
          `Auto-approve: post ${payload.postId} score ${score}/10 ≥ ${this.minScore} — auto-approving`,
        );
      }

      // Approve the draft — transitions DRAFT → APPROVED, emits PostEvents.APPROVED
      const approvedPost = await this.postsService.approve(payload.postId);
      this.logger.log(`Auto-approved post ${payload.postId} (${payload.network})`);

      // Enqueue to BullMQ posting queue — same lazy resolution as PostsController
      await this.enqueueForPosting(approvedPost.id, approvedPost.network as string);
    } catch (err) {
      this.logger.error(
        `Auto-approve failed for post ${payload.postId}: ${(err as Error).message}`,
      );
    }
  }

  private async enqueueForPosting(postId: string, network: string): Promise<void> {
    try {
      const { QueueService } = await import('../../modules/queue/queue.service.js');
      const queueService = this.moduleRef.get(QueueService, { strict: false });
      if (queueService) {
        await queueService.enqueuePosting(postId, network as 'X' | 'THREADS' | 'FACEBOOK');
        this.logger.log(`Auto-approved post ${postId} enqueued for ${network}`);
      } else {
        this.logger.warn(
          `QueueService not available — post ${postId} auto-approved but not enqueued (reconciliation cron will pick it up)`,
        );
      }
    } catch (err) {
      this.logger.error(`Failed to enqueue auto-approved post ${postId}: ${(err as Error).message}`);
    }
  }
}
