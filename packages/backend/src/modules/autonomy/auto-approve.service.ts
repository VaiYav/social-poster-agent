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
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork, PostStatus } from '@prisma/client';
import type { JudgeScores } from '@spa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SseService } from '../../infrastructure/sse/sse.service';
import { FlowControlService } from '../flow-control/flow-control.service.js';
import { AutoCheckService, type AutoCheckResult } from './auto-check.service';
import { parseBool } from '../../infrastructure/config/parse-bool.js';

export type ApproveDecision = 'AUTO_APPROVE' | 'HUMAN_REVIEW' | 'REJECT' | 'SKIP';

/** Synthetic AutoCheck result for SKIP outcomes (no checks were run). */
const SKIPPED_CHECK: AutoCheckResult = { passed: true, checks: [] };

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
  private readonly autoApproveThreshold: number;  // ≥ this → auto-approve (global default)
  private readonly humanReviewThreshold: number;   // ≥ this → human review
  private readonly rejectStreakAlertLimit: number;
  private readonly failOpenMissingScore: boolean;

  // P1-06: Per-platform auto-approve thresholds (fallback to global default)
  private readonly perPlatformThresholds: Map<SocialNetwork, number>;

  // P1: LLM-as-a-Judge gate (AutoApprove now uses judgeScores, not just critique qualityScore)
  private readonly useJudgeScores: boolean;
  private readonly minJudgeAntiAi: number;
  private readonly minJudgeFactual: number;
  private readonly minJudgeHook: number;
  private readonly minJudgeCharacter: number;
  // P1: hard-reject thresholds — any of these → REJECT regardless of quality score
  private readonly rejectJudgeAntiAi: number;
  private readonly rejectJudgeFactual: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly autoCheck: AutoCheckService,
    @Optional() private readonly flowControl?: FlowControlService,
  ) {
    this.enabled = parseBool(this.configService.get<string>('AUTO_APPROVE_ENABLED', 'false'));
    this.autoApproveThreshold = this.configService.get<number>('AUTO_APPROVE_MIN_SCORE', 7);
    this.humanReviewThreshold = this.configService.get<number>('AUTO_APPROVE_REVIEW_SCORE', 4);
    this.rejectStreakAlertLimit = this.configService.get<number>('AUTO_APPROVE_REJECT_STREAK_ALERT', 3);
    this.failOpenMissingScore = parseBool(
      this.configService.get<string>('AUTO_APPROVE_MISSING_SCORE_FAIL_OPEN', 'false'),
    );
    this.useJudgeScores = parseBool(
      this.configService.get<string>('AUTO_APPROVE_USE_JUDGE_SCORES', 'true'),
    );
    this.minJudgeAntiAi = Number(this.configService.get<string>('AUTO_APPROVE_MIN_JUDGE_ANTI_AI', '0.7'));
    this.minJudgeFactual = Number(this.configService.get<string>('AUTO_APPROVE_MIN_JUDGE_FACTUAL', '0.6'));
    this.minJudgeHook = Number(this.configService.get<string>('AUTO_APPROVE_MIN_JUDGE_HOOK', '0.6'));
    this.minJudgeCharacter = Number(this.configService.get<string>('AUTO_APPROVE_MIN_JUDGE_CHARACTER', '0.8'));
    this.rejectJudgeAntiAi = Number(this.configService.get<string>('AUTO_APPROVE_REJECT_JUDGE_ANTI_AI', '0.3'));
    this.rejectJudgeFactual = Number(this.configService.get<string>('AUTO_APPROVE_REJECT_JUDGE_FACTUAL', '0.3'));

    // P1-06: Load per-platform thresholds from env (fallback to global default)
    this.perPlatformThresholds = new Map<SocialNetwork, number>([
      [SocialNetwork.X, this.autoApproveThreshold], // X uses global default
      [SocialNetwork.THREADS, this.autoApproveThreshold],
      [SocialNetwork.FACEBOOK, this.autoApproveThreshold],
      [SocialNetwork.DEVTO, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_DEVTO', this.autoApproveThreshold)],
      [SocialNetwork.HASHNODE, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_HASHNODE', this.autoApproveThreshold)],
      [SocialNetwork.LINKEDIN, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_LINKEDIN', this.autoApproveThreshold)],
      [SocialNetwork.BLUESKY, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_BLUESKY', this.autoApproveThreshold)],
      [SocialNetwork.MASTODON, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_MASTODON', this.autoApproveThreshold)],
      [SocialNetwork.TELEGRAM, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_TELEGRAM', this.autoApproveThreshold)],
      [SocialNetwork.MEDIUM, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_MEDIUM', this.autoApproveThreshold)],
      [SocialNetwork.SUBSTACK, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_SUBSTACK', this.autoApproveThreshold)],
      [SocialNetwork.REDDIT, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_REDDIT', this.autoApproveThreshold)],
      [SocialNetwork.QUORA, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_QUORA', this.autoApproveThreshold)],
      [SocialNetwork.PINTEREST, this.configService.get<number>('AUTO_APPROVE_MIN_SCORE_PINTEREST', this.autoApproveThreshold)],
    ]);
  }

  /**
   * P1-06: Get the auto-approve threshold for a specific network.
   * Falls back to the global default if no per-platform override is set.
   */
  getThresholdForNetwork(network: SocialNetwork): number {
    return this.perPlatformThresholds.get(network) ?? this.autoApproveThreshold;
  }

  /**
   * Evaluate a generated post and make an auto-approve decision.
   *
   * @param postId Post ID (must be in DRAFT status)
   * @param content Post text
   * @param network Target network
   * @param qualityScore LLM quality score (1-10) from critique node
   * @param judgeScores LLM-as-a-Judge scores (P1)
   * @returns ApproveResult with decision + reasoning
   */
  async evaluate(
    postId: string,
    content: string,
    network: SocialNetwork,
    qualityScore?: number,
    judgeScores?: JudgeScores,
  ): Promise<ApproveResult> {
    // AU3: idempotency — only act on posts still in DRAFT. Prevents double-processing
    // when both the DRAFT_GENERATED listener and the autonomous runner evaluate the
    // same post (they would otherwise race on Post.status and may diverge).
    const existing = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { status: true },
    });
    if (!existing) {
      return { decision: 'SKIP', postId, qualityScore: qualityScore ?? null, checkResult: SKIPPED_CHECK, reason: 'Post not found' };
    }

    // P1: kill-switch — if flow:pause_auto_approve is set, force HUMAN_REVIEW and emit SSE.
    if (this.flowControl && await this.flowControl.isPaused('auto_approve')) {
      this.logger.warn(`Auto-approve is paused for ${postId} — flow:pause_auto_approve`);
      return {
        decision: 'HUMAN_REVIEW',
        postId,
        qualityScore: qualityScore ?? null,
        checkResult: SKIPPED_CHECK,
        reason: 'flow:pause_auto_approve — paused for human review',
      };
    }

    if (existing.status !== PostStatus.DRAFT) {
      return {
        decision: 'SKIP',
        postId,
        qualityScore: qualityScore ?? null,
        checkResult: SKIPPED_CHECK,
        reason: `Post not in DRAFT (status=${existing.status}) — already handled`,
      };
    }

    // Run AutoCheck first (pure content-safety gate — no score floor; the score
    // decision is owned solely by the band matrix below — A1/BUG-12).
    // BUG-1: pass postId so the dedup corpus excludes this already-saved post.
    const checkResult = await this.autoCheck.check(content, network, postId);

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

    // AU2: Missing quality score — critique or judge LLM call failed (429/etc).
    // Default is fail-closed to HUMAN_REVIEW so that a missing score does not
    // auto-approve low-quality content. For fully autonomous deployments where
    // the operator accepts the risk, set AUTO_APPROVE_MISSING_SCORE_FAIL_OPEN=true
    // to auto-approve with the threshold score when AutoCheck passed.
    if (qualityScore === undefined || qualityScore === null) {
      if (this.enabled && this.failOpenMissingScore) {
        const defaultScore = this.getThresholdForNetwork(network); // assume "good enough" — AutoCheck already filtered unsafe content
        this.logger.warn(
          `Missing quality score for ${postId} — AutoCheck passed, auto-approving with default score ${defaultScore}`,
        );
        return this.makeDecision(postId, 'AUTO_APPROVE', defaultScore, checkResult,
          `Missing quality score — AutoCheck passed, auto-approved with default score ${defaultScore}`);
      }

      return this.makeDecision(postId, 'HUMAN_REVIEW', null, checkResult,
        'Missing quality score — flagged for human review');
    }

    const score = qualityScore;

    // P1-06: Use per-platform threshold (falls back to global default)
    const threshold = this.getThresholdForNetwork(network);

    // Decision matrix
    let decision: ApproveDecision;
    let reason: string;

    if (score >= threshold) {
      decision = 'AUTO_APPROVE';
      reason = `Quality score ${score} ≥ threshold ${threshold} for ${network} — auto-approved`;
    } else if (score >= this.humanReviewThreshold) {
      decision = 'HUMAN_REVIEW';
      reason = `Quality score ${score} in review range [${this.humanReviewThreshold}, ${threshold}) for ${network} — flagged for optional review`;
    } else {
      decision = 'REJECT';
      reason = `Quality score ${score} < minimum ${this.humanReviewThreshold} — rejected`;
    }

    // P1: LLM-as-a-Judge decision matrix. The judge is the final gate; it can
    // override a high critique score or hard-reject a low-quality post.
    if (this.useJudgeScores) {
      const judgeDecision = this.classifyByJudge(judgeScores);
      if (judgeDecision) {
        // Hard-reject always wins; missing judge drops to human review.
        if (judgeDecision.decision === 'REJECT' || judgeDecision.decision === 'HUMAN_REVIEW') {
          decision = judgeDecision.decision;
          reason = judgeDecision.reason;
        } else if (judgeDecision.decision === 'AUTO_APPROVE') {
          // Judge is strong enough to auto-approve regardless of the critique band.
          decision = 'AUTO_APPROVE';
          reason = judgeDecision.reason;
        }
      }
    }

    return this.makeDecision(postId, decision, qualityScore ?? null, checkResult, reason);
  }

  /**
   * P1: LLM-as-a-Judge matrix.
   *
   *   anti_ai_tone < reject || factual_accuracy < reject → REJECT
   *   anti >= minAnti && hook >= minHook && factual >= minFactual && char >= minChar → AUTO_APPROVE
   *   otherwise → HUMAN_REVIEW
   *
   * Missing judge scores fail closed (HUMAN_REVIEW) when the judge is enabled.
   */
  private classifyByJudge(judgeScores?: JudgeScores): { decision: ApproveDecision; reason: string } | null {
    if (!judgeScores) {
      return { decision: 'HUMAN_REVIEW', reason: 'Judge scores missing — flagged for human review' };
    }

    const anti = judgeScores.anti_ai_tone;
    const factual = judgeScores.factual_accuracy;
    const hook = judgeScores.hook_strength;
    const char = judgeScores.character_limit;

    if (anti < this.rejectJudgeAntiAi || factual < this.rejectJudgeFactual) {
      const reasons: string[] = [];
      if (anti < this.rejectJudgeAntiAi) reasons.push(`anti_ai_tone=${anti.toFixed(2)} < ${this.rejectJudgeAntiAi}`);
      if (factual < this.rejectJudgeFactual) reasons.push(`factual_accuracy=${factual.toFixed(2)} < ${this.rejectJudgeFactual}`);
      return { decision: 'REJECT', reason: `Judge hard-reject: ${reasons.join(', ')}` };
    }

    if (
      anti >= this.minJudgeAntiAi &&
      hook >= this.minJudgeHook &&
      factual >= this.minJudgeFactual &&
      char >= this.minJudgeCharacter
    ) {
      return {
        decision: 'AUTO_APPROVE',
        reason: `Judge matrix: anti=${anti.toFixed(2)}, hook=${hook.toFixed(2)}, factual=${factual.toFixed(2)}, char=${char.toFixed(2)} — auto-approved`,
      };
    }

    return { decision: 'HUMAN_REVIEW', reason: 'Judge scores in review range — flagged for human review' };
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

    // Merge with existing llmMetadata — do NOT clobber generation metadata
    // (model, tokens, qualityScore, angleType, simhash live here too).
    const current = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { llmMetadata: true },
    });
    const prevMeta =
      current?.llmMetadata && typeof current.llmMetadata === 'object'
        ? (current.llmMetadata as Record<string, unknown>)
        : {};

    // AU3: conditional transition — only from DRAFT, so concurrent paths can't
    // double-apply or diverge. If the row is no longer DRAFT, another path won.
    const updated = await this.prisma.post.updateMany({
      where: { id: postId, status: PostStatus.DRAFT },
      data: {
        status: newStatus,
        ...(decision === 'AUTO_APPROVE' ? { approvedAt: new Date() } : {}),
        llmMetadata: {
          ...prevMeta,
          autoApproveDecision: decision,
          autoApproveReason: reason,
          autoCheckChecks: checkResult.checks.map((c) => ({ name: c.name, passed: c.passed, reason: c.reason })),
        },
      },
    });

    if (updated.count === 0) {
      this.logger.debug(`AutoApprove skip: post ${postId} no longer DRAFT (concurrent transition)`);
      return { ...result, decision: 'SKIP', reason: 'Concurrent transition — already handled' };
    }

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
      orderBy: { createdAt: 'desc' },
      take: this.rejectStreakAlertLimit,
      select: { status: true, createdAt: true },
    });

    // A streak means the last N posts are ALL rejected, not just N rejected posts
    // scattered among approvals/reviews.
    if (recent.length < this.rejectStreakAlertLimit || recent.some((p) => p.status !== PostStatus.REJECTED)) {
      return;
    }

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
