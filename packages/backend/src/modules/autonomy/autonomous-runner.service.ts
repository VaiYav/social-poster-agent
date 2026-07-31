/**
 * ADR-006: Autonomous Runner Service — cron-driven full pipeline.
 *
 * Runs the complete autonomous cycle without operator intervention:
 *   1. Check flow-control flags (skip if paused)
 *   2. Generate content via GenerationService (picks topics internally)
 *   3. Load generated posts from the run
 *   4. Run AutoApprove gate on each post (AutoCheck runs inside)
 *   5. If AUTO_APPROVE → enqueue for posting (with delay for human-like cadence)
 *   6. If HUMAN_REVIEW → leave as DRAFT (operator can review in dashboard)
 *   7. If REJECT → mark as REJECTED, log reason
 *
 * Schedule: configurable via AUTONOMOUS_RUNNER_SCHEDULE (default: every 4 hours).
 * Feature flag: AUTONOMOUS_RUNNER_ENABLED (default: false).
 */
import { Injectable, Logger, Inject, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork, PostStatus } from '@prisma/client';
import type { JudgeScores } from '@spa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SseService } from '../../infrastructure/sse/sse.service';
import { FlowControlService } from '../flow-control/flow-control.service';
import { AutoApproveService } from './auto-approve.service';
import { ModuleRef } from '@nestjs/core';
import { parseBool } from '../../infrastructure/config/parse-bool';
import { isOrchestratorEnabled } from '../orchestrator/feature-flag.js';
import { IPostingQueuePort } from '../../domain/ports/posting-queue.port.js';
import { parseTargetNetworks } from './parse-networks';

@Injectable()
export class AutonomousRunnerService implements OnModuleInit {
  private readonly logger = new Logger(AutonomousRunnerService.name);
  private readonly enabled: boolean;
  private readonly postsPerRun: number;
  private readonly targetNetworks: SocialNetwork[];
  private readonly postingDelayMinMs: number;
  private readonly postingDelayMaxMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly flowControl: FlowControlService,
    private readonly autoApprove: AutoApproveService,
    private readonly moduleRef: ModuleRef,
    @Inject(IPostingQueuePort) private readonly postingQueue: IPostingQueuePort,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.enabled = parseBool(this.configService.get<string>('AUTONOMOUS_RUNNER_ENABLED', 'false'));
    this.postsPerRun = Number(this.configService.get<string>('AUTONOMOUS_POSTS_PER_RUN', '3'));
    this.postingDelayMinMs = Number(this.configService.get<string>('AUTONOMOUS_POSTING_DELAY_MIN_MS', '600000')); // 10 min
    this.postingDelayMaxMs = Number(this.configService.get<string>('AUTONOMOUS_POSTING_DELAY_MAX_MS', '3600000')); // 1 hour

    // AU4: parse + validate target networks from env (default: X,THREADS — Facebook disabled
    // due to session instability). Unknown tokens are dropped (not cast blindly) so a typo
    // can't create a never-drained queue.
    const networksStr = this.configService.get<string>('AUTONOMOUS_TARGET_NETWORKS', 'X,THREADS');
    const { networks, invalid } = parseTargetNetworks(networksStr);
    if (invalid.length > 0) {
      this.logger.warn(`AUTONOMOUS_TARGET_NETWORKS: ignoring unknown network(s): ${invalid.join(', ')}`);
    }
    this.targetNetworks = networks;
  }

  /**
   * Cron-driven autonomous cycle.
   * Default: every 4 hours. Configurable via AUTONOMOUS_RUNNER_SCHEDULE.
   *
   * Dynamically registered (not @Cron) so it is NOT created when orchestrator is enabled.
   */
  onModuleInit(): void {
    if (isOrchestratorEnabled()) {
      this.logger.log('Orchestrator is enabled — autonomous runner cron NOT registered');
      return;
    }
    if (!this.enabled) return;

    const cronExpr = this.configService.get<string>('AUTONOMOUS_RUNNER_SCHEDULE', '0 */4 * * *');
    const job = new CronJob(cronExpr, async () => { await this.runAutonomousCycle(); });
    try {
      this.schedulerRegistry.addCronJob('autonomous-runner', job);
      job.start();
      this.logger.log(`Autonomous runner cron registered: ${cronExpr}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — autonomous runner cron will not run');
    }
  }

  async runAutonomousCycle(): Promise<void> {
    if (!this.enabled) return;

    // Check flow control
    if (await this.flowControl.isPaused('generation')) {
      this.logger.debug('Autonomous cycle skipped — generation flow is paused');
      return;
    }

    this.logger.log('Autonomous cycle started');
    await this.sseService.publish({
      type: 'autonomous_cycle',
      action: 'started',
    });

    try {
      // Step 1: Generate content (GenerationService picks topics internally,
      // including trending enrichment and SimHash dedup)
      const generationService = this.moduleRef.get(
        await import('../generation/generation.service.js').then((m) => m.GenerationService),
        { strict: false },
      );

      if (!generationService) {
        this.logger.error('GenerationService not available — cannot run autonomous cycle');
        return;
      }

      // Check flow control again before generation (pause might have been triggered)
      if (await this.flowControl.isPaused('generation')) {
        this.logger.log('Autonomous cycle interrupted — generation flow paused');
        return;
      }

      // generate(count, networks, triggeredBy) — returns runId
      const { GenerationTrigger } = await import('@prisma/client');
      const runId = await generationService.generate(
        this.postsPerRun,
        this.targetNetworks,
        GenerationTrigger.AUTONOMOUS,
      );

      // Step 2: Load generated posts from the run
      const posts = await this.prisma.post.findMany({
        where: { generationRunId: runId, status: PostStatus.DRAFT },
        select: {
          id: true,
          content: true,
          network: true,
          llmMetadata: true,
        },
      });

      let totalAutoApproved = 0;
      let totalRejected = 0;
      let totalHumanReview = 0;

      // Step 3: AutoApprove each post
      for (const post of posts) {
        if (await this.flowControl.isPaused('posting')) {
          this.logger.log('Posting flow paused — skipping auto-approve for remaining posts');
          break;
        }

        const metadata = post.llmMetadata as { qualityScore?: number; judgeScores?: JudgeScores } | null;
        const qualityScore = metadata?.qualityScore;
        const judgeScores = metadata?.judgeScores;

        const approveResult = await this.autoApprove.evaluate(
          post.id,
          post.content,
          post.network,
          qualityScore,
          judgeScores,
        );

        if (approveResult.decision === 'AUTO_APPROVE') {
          totalAutoApproved++;
          // Enqueue for posting with human-like delay
          await this.enqueueForPosting(post.id, post.network);
        } else if (approveResult.decision === 'REJECT') {
          totalRejected++;
        } else {
          totalHumanReview++;
        }
      }

      const totalGenerated = posts.length;
      this.logger.log(
        `Autonomous cycle complete: ${totalGenerated} generated, ` +
          `${totalAutoApproved} auto-approved, ${totalHumanReview} human-review, ${totalRejected} rejected`,
      );

      await this.sseService.publish({
        type: 'autonomous_cycle',
        action: 'completed',
        generated: totalGenerated,
        autoApproved: totalAutoApproved,
        rejected: totalRejected,
        humanReview: totalHumanReview,
      });
    } catch (err) {
      this.logger.error(`Autonomous cycle failed: ${(err as Error).message}`);
      await this.sseService.publish({
        type: 'autonomous_cycle',
        action: 'failed',
        error: (err as Error).message,
      });
    }
  }

  /**
   * Enqueue a post for posting with a human-like delay.
   */
  private async enqueueForPosting(postId: string, network: SocialNetwork): Promise<void> {
    try {
      // AU7: clamp so a misconfig (min > max) can't yield a negative delay → immediate post.
      const lo = Math.min(this.postingDelayMinMs, this.postingDelayMaxMs);
      const hi = Math.max(this.postingDelayMinMs, this.postingDelayMaxMs);
      const delay = lo + Math.floor(Math.random() * Math.max(0, hi - lo));
      // A5: enqueue via IPostingQueuePort (no ModuleRef hack for the queue).
      await this.postingQueue.enqueuePosting(postId, network, { delay });
      this.logger.log(`Post ${postId} enqueued for ${network} (delay: ${Math.round(delay / 60000)}min)`);
    } catch (err) {
      this.logger.error(`Failed to enqueue post ${postId}: ${(err as Error).message}`);
    }
  }
}
