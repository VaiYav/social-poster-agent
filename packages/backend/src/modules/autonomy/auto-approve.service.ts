/**
 * ADR-006: AutoApprove Gate Service — replaces manual HITL approval.
 *
 * Uses LLM quality score + AutoCheck results to make an automated decision:
 *
 *   qualityScore ≥ 8 + AutoCheck pass → AUTO_APPROVE (enqueue for posting)
 *   qualityScore 6-7 + AutoCheck pass → AUTO_APPROVE (configurable)
 *   qualityScore 4-5 + AutoCheck pass → HUMAN_REVIEW (optional operator review)
 *   qualityScore < 4 + AutoCheck pass → REJECT (regenerate with different hook)
 *   any score + AutoCheck fail      → REJECT (log rejection reason)
 *
 * Feature flag: AUTO_APPROVE_ENABLED (default: false).
 * When disabled, posts stay as DRAFT for manual HITL (backward compatible).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork, PostStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SseService } from '../../infrastructure/sse/sse.service';
import { AutoCheckService, type AutoCheckResult } from './auto-check.service';

export type ApproveDecision = 'AUTO_APPROVE' | 'HUMAN_REVIEW' | 'REJECT';

export interface ApproveResult {
  decision: ApproveDecision;
  postId: string;
  qualityScore: number | null;
  checkResult: AutoCheckResult;
  reason: string;
}

@Injectable()
export class AutoApproveService {
  private readonly logger = new Logger(AutoApproveService.name);
  private readonly enabled: boolean;
  private readonly autoApproveThreshold: number;  // ≥ this → auto-approve
  private readonly humanReviewThreshold: number;   // ≥ this → human review
  private readonly rejectStreakAlertLimit: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly autoCheck: AutoCheckService,
  ) {
    this.enabled = this.configService.get<string>('AUTO_APPROVE_ENABLED', 'false') === 'true';
    this.autoApproveThreshold = this.configService.get<number>('AUTO_APPROVE_MIN_SCORE', 7);
    this.humanReviewThreshold = this.configService.get<number>('AUTO_APPROVE_REVIEW_SCORE', 4);
    this.rejectStreakAlertLimit = this.configService.get<number>('AUTO_APPROVE_REJECT_STREAK_ALERT', 3);
  }

  /**
   * Evaluate a generated post and make an auto-approve decision.
   *
   * @param postId Post ID (must be in DRAFT status)
   * @param content Post text
   * @param network Target network
   * @param qualityScore LLM quality score (1-10) from critique node
   * @returns ApproveResult with decision + reasoning
   */
  async evaluate(
    postId: string,
    content: string,
    network: SocialNetwork,
    qualityScore?: number,
  ): Promise<ApproveResult> {
    // Run AutoCheck first
    const checkResult = await this.autoCheck.check(content, network, qualityScore);

    // If AutoCheck fails → always reject regardless of score
    if (!checkResult.passed) {
      return this.makeDecision(postId, 'REJECT', qualityScore ?? null, checkResult,
        `AutoCheck failed: ${checkResult.rejectionReason}`);
    }

    // If auto-approve is disabled → leave as DRAFT for manual review
    if (!this.enabled) {
      return this.makeDecision(postId, 'HUMAN_REVIEW', qualityScore ?? null, checkResult,
        'Auto-approve disabled — manual review required');
    }

    const score = qualityScore ?? 0;

    // Decision matrix
    let decision: ApproveDecision;
    let reason: string;

    if (score >= this.autoApproveThreshold) {
      decision = 'AUTO_APPROVE';
      reason = `Quality score ${score} ≥ threshold ${this.autoApproveThreshold} — auto-approved`;
    } else if (score >= this.humanReviewThreshold) {
      decision = 'HUMAN_REVIEW';
      reason = `Quality score ${score} in review range [${this.humanReviewThreshold}, ${this.autoApproveThreshold}) — flagged for optional review`;
    } else {
      decision = 'REJECT';
      reason = `Quality score ${score} < minimum ${this.humanReviewThreshold} — rejected`;
    }

    return this.makeDecision(postId, decision, qualityScore ?? null, checkResult, reason);
  }

  /**
   * Apply the decision to the post (transition status) and emit SSE.
   */
  private async makeDecision(
    postId: string,
    decision: ApproveDecision,
    qualityScore: number | null,
    checkResult: AutoCheckResult,
    reason: string,
  ): Promise<ApproveResult> {
    const result: ApproveResult = { decision, postId, qualityScore, checkResult, reason };

    // Apply status transition
    const newStatus = decision === 'AUTO_APPROVE'
      ? PostStatus.APPROVED
      : decision === 'REJECT'
        ? PostStatus.REJECTED
        : PostStatus.DRAFT; // HUMAN_REVIEW stays as DRAFT

    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: newStatus,
        llmMetadata: {
          autoApproveDecision: decision,
          autoApproveReason: reason,
          autoCheckChecks: checkResult.checks.map((c) => ({ name: c.name, passed: c.passed, reason: c.reason })),
        },
      },
    });

    // SSE event for dashboard
    await this.sseService.publish({
      type: 'auto_approve',
      postId,
      decision,
      qualityScore,
      reason,
    });

    this.logger.log(`AutoApprove [${decision}] post ${postId}: ${reason}`);

    // Alert on reject streaks
    if (decision === 'REJECT') {
      await this.checkRejectStreak();
    }

    return result;
  }

  /**
   * Check for consecutive reject streak and alert via Discord if threshold exceeded.
   */
  private async checkRejectStreak(): Promise<void> {
    const recent = await this.prisma.post.findMany({
      where: { status: PostStatus.REJECTED },
      orderBy: { createdAt: 'desc' },
      take: this.rejectStreakAlertLimit,
      select: { createdAt: true },
    });

    if (recent.length >= this.rejectStreakAlertLimit) {
      // Check if all rejects are within last 1 hour
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const allRecent = recent.every((p) => p.createdAt >= oneHourAgo);
      if (allRecent) {
        this.logger.error(
          `Reject streak alert: ${recent.length} consecutive rejects in last hour — ` +
            `check LLM quality or content source`,
        );
        // Discord notification is handled by DiscordNotificationService via SSE health_alert
        await this.sseService.publish({
          type: 'health_alert',
          severity: 'warning',
          error: `Auto-approve reject streak: ${recent.length} rejects in last hour`,
        });
      }
    }
  }
}
