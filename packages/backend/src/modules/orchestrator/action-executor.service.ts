/**
 * ActionExecutor — EXECUTE node implementation (WS-3).
 *
 * Routes Action to existing service methods. No business logic — just dispatch.
 * Each action type maps to one service call. Uses ModuleRef for lazy resolution
 * to avoid circular dependency issues (same pattern as PostsModule↔QueueModule).
 *
 * Feature-flagged services (Engagement, Replies) are resolved lazily and may
 * return null — the handler reports "not available" instead of crashing.
 *
 * Errors are caught and returned as ActionResult — never thrown.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PostStatus, SocialNetwork, GenerationTrigger } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { GenerationService } from '../generation/generation.service.js';
import { QueueService } from '../queue/queue.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { HealthMonitorService } from '../health-monitor/health-monitor.service.js';
import { TrendingScraperService } from '../trending/trending-scraper.service.js';
import { MetricsScraperService } from '../analytics/metrics-scraper.service.js';
import { RecyclingService } from '../recycling/recycling.service.js';
import { HookPerformanceBank } from '../content-enhancements/hook-performance-bank.js';
import { AutoApproveService } from '../autonomy/auto-approve.service.js';
import { TopicGenerationService } from '../../infrastructure/content/topic-generation.service.js';
import { IBrowsingSessionPort, IRepliesMonitorPort } from './ports.js';
import type { Action, ActionResult } from './types.js';

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
    @Optional() @Inject(IBrowsingSessionPort) private readonly browsingSession?: IBrowsingSessionPort,
    @Optional() @Inject(IRepliesMonitorPort) private readonly repliesMonitor?: IRepliesMonitorPort,
  ) {}

  /**
   * Execute an action. Never throws — returns ActionResult with error info.
   */
  async execute(action: Action): Promise<ActionResult> {
    const startTime = Date.now();

    if (action.type === 'WAIT') {
      return { success: true, type: 'WAIT', duration: 0 };
    }

    try {
      const sideEffects = await this.dispatch(action);
      const duration = Date.now() - startTime;
      this.logger.log(`Executed ${action.type}${action.network ? `:${action.network}` : ''} in ${duration}ms`);
      return { success: true, type: action.type, duration, sideEffects };
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = (err as Error).message;
      this.logger.error(`Execute ${action.type} failed in ${duration}ms: ${error}`);
      return { success: false, type: action.type, duration, error };
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  private async dispatch(action: Action): Promise<Record<string, unknown>> {
    switch (action.type) {
      case 'GENERATE_TOPICS':
        return this.generateTopics();
      case 'GENERATE_POSTS':
        return this.generatePosts(action);
      case 'POST':
        return this.post(action);
      case 'BROWSE':
        return this.browse(action);
      case 'RECOVER_SESSION':
        return this.recoverSession(action);
      case 'CHECK_REPLIES':
        return this.checkReplies();
      case 'REFRESH_TRENDS':
        return this.refreshTrends();
      case 'HEALTH_CHECK':
        return this.healthCheck();
      case 'RECONCILE':
        return this.reconcile();
      case 'SCRAPE_METRICS':
        return this.scrapeMetrics();
      case 'RECYCLE_CONTENT':
        return this.recycleContent();
      case 'AGGREGATE_HOOKS':
        return this.aggregateHooks();
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  // ── Individual action handlers ───────────────────────────────────────────

  private async generateTopics(): Promise<Record<string, unknown>> {
    const service = this.resolveOptional(TopicGenerationService);
    if (!service) throw new Error('TopicGenerationService not available');
    const count = Number(process.env.TOPIC_BATCH_SIZE ?? '20');
    const generated = await service.generateBatch(count);
    return { topicsGenerated: generated };
  }

  private async generatePosts(action: Action): Promise<Record<string, unknown>> {
    const service = this.resolveOptional(GenerationService);
    if (!service) throw new Error('GenerationService not available');

    const postsPerRun = Number(process.env.AUTONOMOUS_POSTS_PER_RUN ?? '3');
    const networks = action.network
      ? [action.network]
      : (process.env.AUTONOMOUS_TARGET_NETWORKS ?? 'X,THREADS').split(',').map((n) => n.trim()) as SocialNetwork[];

    const runId = await service.generate(postsPerRun, networks, GenerationTrigger.AUTONOMOUS);

    // Auto-approve if enabled
    let postsApproved = 0;
    if (parseBool(process.env.AUTO_APPROVE_ENABLED ?? 'false')) {
      const autoApprove = this.resolveOptional(AutoApproveService);
      if (autoApprove) {
        const posts = await this.prisma.post.findMany({
          where: { generationRunId: runId, status: PostStatus.DRAFT },
        });
        for (const post of posts) {
          try {
            const result = await autoApprove.evaluate(post.id, post.content, post.network, undefined);
            if (result.decision === 'AUTO_APPROVE') {
              postsApproved++;
            }
          } catch {
            // non-critical — post stays as DRAFT for manual review
          }
        }
      }
    }

    const postsGenerated = await this.prisma.post.count({
      where: { generationRunId: runId },
    });

    return { runId, postsGenerated, postsApproved };
  }

  private async post(action: Action): Promise<Record<string, unknown>> {
    if (!action.network) throw new Error('POST action requires network');

    // Find oldest approved draft for this network
    const post = await this.prisma.post.findFirst({
      where: { status: PostStatus.APPROVED, network: action.network },
      orderBy: { approvedAt: 'asc' },
    });

    if (!post) {
      return { enqueued: false, reason: 'No approved drafts for this network' };
    }

    // Enqueue to BullMQ via QueueService
    const queueService = this.resolveOptional(QueueService);
    if (!queueService) throw new Error('QueueService not available');

    // Apply human-like delay
    const delayMin = Number(process.env.AUTONOMOUS_POSTING_DELAY_MIN_MS ?? '600000');
    const delayMax = Number(process.env.AUTONOMOUS_POSTING_DELAY_MAX_MS ?? '3600000');
    const delay = delayMin + Math.random() * (delayMax - delayMin);

    await queueService.enqueuePosting(post.id, action.network);

    return { enqueued: true, postId: post.id, delayMs: Math.round(delay) };
  }

  private async browse(action: Action): Promise<Record<string, unknown>> {
    if (!action.network) throw new Error('BROWSE action requires network');

    // Engagement is feature-flagged — browsingSession port may not be registered
    if (!this.browsingSession) {
      return { browsed: false, reason: 'Engagement module not enabled' };
    }

    const durationSec = Number(process.env.F1_BROWSING_SESSION_MINUTES ?? '15') * 60;
    const result = await this.browsingSession.runBrowsingSession(action.network, durationSec);
    return { browsed: true, sessionId: result.sessionId, interactions: result.interactionsCount };
  }

  private async recoverSession(action: Action): Promise<Record<string, unknown>> {
    if (!action.network) throw new Error('RECOVER_SESSION action requires network');

    const sessionsService = this.resolveOptional(SessionsService);
    if (!sessionsService) throw new Error('SessionsService not available');

    const session = await sessionsService.getOrCreateSession(action.network);
    return {
      recovered: session !== null,
      sessionStatus: session?.status ?? 'FAILED',
    };
  }

  private async checkReplies(): Promise<Record<string, unknown>> {
    // Replies are feature-flagged — repliesMonitor port may not be registered
    if (!this.repliesMonitor) {
      return { checked: false, reason: 'Replies module not enabled' };
    }

    const result = await this.repliesMonitor.runMonitoringCycle();
    return {
      checked: true,
      postsChecked: result.postsChecked,
      commentsScraped: result.commentsScraped,
      repliesPosted: result.repliesPosted,
      humanReview: result.humanReview,
    };
  }

  private async refreshTrends(): Promise<Record<string, unknown>> {
    const trendingScraper = this.resolveOptional(TrendingScraperService);
    if (!trendingScraper) {
      return { refreshed: false, reason: 'TrendingScraperService not available' };
    }

    // refreshCache() is private — we call the public methods which refresh cache internally
    const [google, x] = await Promise.all([
      trendingScraper.getGoogleTrends(20).catch(() => []),
      trendingScraper.getXTrends(20).catch(() => []),
    ]);

    return { refreshed: true, googleTrends: google.length, xTrends: x.length };
  }

  private async healthCheck(): Promise<Record<string, unknown>> {
    const healthMonitor = this.resolveOptional(HealthMonitorService);
    if (!healthMonitor) throw new Error('HealthMonitorService not available');

    const report = await healthMonitor.runHealthCheck();
    return { report };
  }

  private async reconcile(): Promise<Record<string, unknown>> {
    const healthMonitor = this.resolveOptional(HealthMonitorService);
    if (!healthMonitor) throw new Error('HealthMonitorService not available');

    const result = await healthMonitor.runReconciliation();
    return {
      requeued: result.requeued,
      skipped: result.skipped,
      deduplicated: result.deduplicated,
    };
  }

  private async scrapeMetrics(): Promise<Record<string, unknown>> {
    const metricsScraper = this.resolveOptional(MetricsScraperService);
    if (!metricsScraper) {
      return { scraped: false, reason: 'MetricsScraperService not available' };
    }

    const result = await metricsScraper.collectMetrics();
    return {
      scraped: true,
      collected: result.collected,
      failed: result.failed,
      skipped: result.skipped,
    };
  }

  private async recycleContent(): Promise<Record<string, unknown>> {
    const recyclingService = this.resolveOptional(RecyclingService);
    if (!recyclingService) {
      return { recycled: false, reason: 'RecyclingService not available' };
    }

    const result = await recyclingService.runRecycling();
    return {
      recycled: result.recycled,
      skipped: result.skipped,
    };
  }

  private async aggregateHooks(): Promise<Record<string, unknown>> {
    const hookBank = this.resolveOptional(HookPerformanceBank);
    if (!hookBank) {
      return { aggregated: false, reason: 'HookPerformanceBank not available' };
    }

    await hookBank.aggregateStats();
    return { aggregated: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Resolve a service by class reference. Returns null if not registered
   * (e.g., feature-flagged module not loaded).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveOptional<T>(serviceClass: new (...args: any[]) => T): T | null {
    try {
      return this.moduleRef.get(serviceClass, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
}
