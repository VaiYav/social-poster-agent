/**
 * Action handlers — one per action type (X18 strategy pattern).
 *
 * Each handler implements IActionHandler and is registered in ActionExecutorService
 * via a Map<ActionType, IActionHandler>. New actions = new handler class + registration,
 * no modification to the executor's dispatch logic.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PostStatus, SocialNetwork, GenerationTrigger } from '@prisma/client';
import type { JudgeScores } from '@spa/shared';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { GenerationService } from '../generation/generation.service.js';
import { QueueService } from '../queue/queue.service.js';
import { QueueTriageService } from '../queue/queue-triage.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { HealthMonitorService } from '../health-monitor/health-monitor.service.js';
import { TrendingScraperService } from '../trending/trending-scraper.service.js';
import { MetricsScraperService } from '../analytics/metrics-scraper.service.js';
import { RecyclingService } from '../recycling/recycling.service.js';
import { HookPerformanceBank } from '../content-enhancements/hook-performance-bank.js';
import { AutoApproveService } from '../autonomy/auto-approve.service.js';
import { TopicGenerationService } from '../../infrastructure/content/topic-generation.service.js';
import { IBrowsingSessionPort, IRepliesMonitorPort } from './ports.js';
import type { IActionHandler } from './action-handler.interface.js';
import type { Action } from './types.js';

/** Type guard for judgeScores stored in Post.llmMetadata (JSON). */
function isJudgeScores(value: unknown): value is JudgeScores {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.anti_ai_tone === 'number' &&
    typeof v.factual_accuracy === 'number' &&
    typeof v.hook_strength === 'number' &&
    typeof v.character_limit === 'number'
  );
}

// ── Shared base ────────────────────────────────────────────────────────────

/**
 * Base class providing ModuleRef resolution for optional services.
 * Feature-flagged services may not be registered — resolveOptional returns null.
 */
// Constructor type for NestJS service classes — `any[]` is the standard pattern
// for generic constructor types (NestJS itself uses this in ModuleRef.get).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T> = new (...args: any[]) => T;

function resolveOptional<T>(moduleRef: ModuleRef, serviceClass: Constructor<T>): T | null {
  try {
    return moduleRef.get(serviceClass, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

// ── GENERATE_TOPICS ────────────────────────────────────────────────────────

@Injectable()
export class GenerateTopicsHandler implements IActionHandler {
  readonly actionType = 'GENERATE_TOPICS';
  private readonly logger = new Logger(GenerateTopicsHandler.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
  ) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const service = resolveOptional(this.moduleRef, TopicGenerationService);
    if (!service) throw new Error('TopicGenerationService not available');
    const count = Number(this.configService.get<string>('TOPIC_BATCH_SIZE', '20'));
    const generated = await service.generateBatch(count);
    return { topicsGenerated: generated };
  }
}

// ── GENERATE_POSTS ─────────────────────────────────────────────────────────

@Injectable()
export class GeneratePostsHandler implements IActionHandler {
  readonly actionType = 'GENERATE_POSTS';
  private readonly logger = new Logger(GeneratePostsHandler.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
  ) {}

  async execute(action: Action, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const service = resolveOptional(this.moduleRef, GenerationService);
    if (!service) throw new Error('GenerationService not available');

    const postsPerRun = Number(this.configService.get<string>('AUTONOMOUS_POSTS_PER_RUN', '3'));
    let networks = action.network
      ? [action.network]
      : (this.configService.get<string>('AUTONOMOUS_TARGET_NETWORKS', 'X,THREADS')).split(',').map((n) => n.trim()) as SocialNetwork[];

    // Skip generation for networks whose daily/weekly budget is already consumed
    // by successful posts plus in-flight approved/posting posts. This prevents the
    // orchestrator from burning LLM quota on posts that will immediately fail rate checks.
    const rateLimitService = resolveOptional(this.moduleRef, RateLimitService);
    let effectivePostsPerRun = postsPerRun;
    if (rateLimitService) {
      const readyNetworks: SocialNetwork[] = [];
      let minDailyRemaining = Number.MAX_SAFE_INTEGER;
      let minWeeklyRemaining = Number.MAX_SAFE_INTEGER;
      for (const network of networks) {
        const [status, inFlight] = await Promise.all([
          rateLimitService.getStatus(network),
          this.prisma.post.count({
            where: {
              network,
              status: { in: [PostStatus.APPROVED, PostStatus.POSTING] },
            },
          }),
        ]);
        const dailyRemaining =
          status.dailyLimit > 0
            ? Math.max(0, status.dailyLimit - status.dailyCount - inFlight)
            : Number.MAX_SAFE_INTEGER;
        const weeklyRemaining =
          status.weeklyLimit > 0
            ? Math.max(0, status.weeklyLimit - status.weeklyCount - inFlight)
            : Number.MAX_SAFE_INTEGER;
        if (dailyRemaining > 0 && weeklyRemaining > 0) {
          readyNetworks.push(network);
          minDailyRemaining = Math.min(minDailyRemaining, dailyRemaining);
          minWeeklyRemaining = Math.min(minWeeklyRemaining, weeklyRemaining);
        } else {
          this.logger.warn(
            `Skipping generation for ${network}: daily=${status.dailyCount}/${status.dailyLimit}, weekly=${status.weeklyCount}/${status.weeklyLimit}, inFlight=${inFlight}`,
          );
        }
      }
      networks = readyNetworks;
      // Do not generate more posts per network than the smallest remaining budget.
      // GenerationService.generate(count, networks) creates `count` posts per network.
      effectivePostsPerRun = Math.min(postsPerRun, minDailyRemaining, minWeeklyRemaining);
    }

    if (networks.length === 0) {
      return {
        runId: null,
        postsGenerated: 0,
        postsApproved: 0,
        reason: 'No ready networks (rate limits or in-flight posts)',
      };
    }

    const runId = await service.generate(effectivePostsPerRun, networks, GenerationTrigger.AUTONOMOUS, false, false, options?.signal);

    let postsApproved = 0;
    if (parseBool(this.configService.get<string>('AUTO_APPROVE_ENABLED', 'false'))) {
      const autoApprove = resolveOptional(this.moduleRef, AutoApproveService);
      if (autoApprove) {
        const posts = await this.prisma.post.findMany({
          where: { generationRunId: runId, status: PostStatus.DRAFT },
        });
        for (const post of posts) {
          try {
            const meta = post.llmMetadata && typeof post.llmMetadata === 'object'
              ? (post.llmMetadata as Record<string, unknown>)
              : {};
            const qualityScore = typeof meta.qualityScore === 'number' ? meta.qualityScore : undefined;
            const judgeScores = isJudgeScores(meta.judgeScores) ? meta.judgeScores : undefined;
            const result = await autoApprove.evaluate(post.id, post.content, post.network, qualityScore, judgeScores);
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
}

// ── POST ───────────────────────────────────────────────────────────────────

@Injectable()
export class PostHandler implements IActionHandler {
  readonly actionType = 'POST';

  constructor(
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
  ) {}

  async execute(action: Action, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    if (!action.network) throw new Error('POST action requires network');

    const post = await this.prisma.post.findFirst({
      where: { status: PostStatus.APPROVED, network: action.network },
      orderBy: { approvedAt: 'asc' },
    });

    if (!post) {
      return { enqueued: false, reason: 'No approved drafts for this network' };
    }

    const queueService = resolveOptional(this.moduleRef, QueueService);
    if (!queueService) throw new Error('QueueService not available');

    const delayMin = Number(this.configService.get<string>('AUTONOMOUS_POSTING_DELAY_MIN_MS', '600000'));
    const delayMax = Number(this.configService.get<string>('AUTONOMOUS_POSTING_DELAY_MAX_MS', '3600000'));
    const delay = delayMin + Math.random() * (delayMax - delayMin);
    const delayMs = Math.round(delay);

    await queueService.enqueuePosting(post.id, action.network, { delay: delayMs });

    return { enqueued: true, postId: post.id, delayMs };
  }
}

// ── BROWSE ─────────────────────────────────────────────────────────────────

@Injectable()
export class BrowseHandler implements IActionHandler {
  readonly actionType = 'BROWSE';

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(IBrowsingSessionPort) private readonly browsingSession?: IBrowsingSessionPort,
  ) {}

  async execute(action: Action, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    if (!action.network) throw new Error('BROWSE action requires network');

    if (!this.browsingSession) {
      return { browsed: false, reason: 'Engagement module not enabled' };
    }

    const durationSec = Number(this.configService.get<string>('F1_BROWSING_SESSION_MINUTES', '15')) * 60;
    const result = await this.browsingSession.runBrowsingSession(action.network, durationSec, options?.signal);
    return { browsed: true, sessionId: result.sessionId, interactions: result.interactionsCount };
  }
}

// ── RECOVER_SESSION ────────────────────────────────────────────────────────

@Injectable()
export class RecoverSessionHandler implements IActionHandler {
  readonly actionType = 'RECOVER_SESSION';

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(action: Action, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    if (!action.network) throw new Error('RECOVER_SESSION action requires network');

    const sessionsService = resolveOptional(this.moduleRef, SessionsService);
    if (!sessionsService) throw new Error('SessionsService not available');

    let accountId: string | undefined;
    const accountsService = resolveOptional(this.moduleRef, AccountsService);
    if (accountsService) {
      const account = await accountsService.getNextAccountForNetwork(action.network);
      accountId = account?.id;
    }
    const session = accountId
      ? await sessionsService.getOrCreateSession(accountId, action.network)
      : await sessionsService.getOrCreateSession(action.network);
    return {
      recovered: session !== null,
      sessionStatus: session?.status ?? 'FAILED',
    };
  }
}

// ── CHECK_REPLIES ──────────────────────────────────────────────────────────

@Injectable()
export class CheckRepliesHandler implements IActionHandler {
  readonly actionType = 'CHECK_REPLIES';

  constructor(
    @Optional() @Inject(IRepliesMonitorPort) private readonly repliesMonitor?: IRepliesMonitorPort,
  ) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    if (!this.repliesMonitor) {
      return { checked: false, reason: 'Replies module not enabled' };
    }

    const result = await this.repliesMonitor.runMonitoringCycle();
    return {
      checked: true,
      postsChecked: result.postsChecked,
      commentsScraped: result.commentsScraped,
      repliesPosted: result.repliesPosted,
      repliesScheduled: result.repliesScheduled,
      humanReview: result.humanReview,
    };
  }
}

// ── REFRESH_TRENDS ─────────────────────────────────────────────────────────

@Injectable()
export class RefreshTrendsHandler implements IActionHandler {
  readonly actionType = 'REFRESH_TRENDS';

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const trendingScraper = resolveOptional(this.moduleRef, TrendingScraperService);
    if (!trendingScraper) {
      return { refreshed: false, reason: 'TrendingScraperService not available' };
    }

    const [google, x] = await Promise.all([
      trendingScraper.getGoogleTrends(20).catch(() => []),
      trendingScraper.getXTrends(20).catch(() => []),
    ]);

    return { refreshed: true, googleTrends: google.length, xTrends: x.length };
  }
}

// ── HEALTH_CHECK ───────────────────────────────────────────────────────────

@Injectable()
export class HealthCheckHandler implements IActionHandler {
  readonly actionType = 'HEALTH_CHECK';

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const healthMonitor = resolveOptional(this.moduleRef, HealthMonitorService);
    if (!healthMonitor) throw new Error('HealthMonitorService not available');

    const report = await healthMonitor.runHealthCheck();
    return { report };
  }
}

// ── RECONCILE ──────────────────────────────────────────────────────────────

@Injectable()
export class ReconcileHandler implements IActionHandler {
  readonly actionType = 'RECONCILE';

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const healthMonitor = resolveOptional(this.moduleRef, HealthMonitorService);
    if (!healthMonitor) throw new Error('HealthMonitorService not available');

    const result = await healthMonitor.runReconciliation();
    const reapedBrowsing = await healthMonitor.reapStuckBrowsingSessions();
    const reapedPosting = await healthMonitor.reapStuckPosting();
    return {
      requeued: result.requeued,
      skipped: result.skipped,
      deduplicated: result.deduplicated,
      reapedBrowsingSessions: reapedBrowsing.reaped,
      reapedStuckPosting: reapedPosting.reaped,
    };
  }
}

// ── SCRAPE_METRICS ─────────────────────────────────────────────────────────

@Injectable()
export class ScrapeMetricsHandler implements IActionHandler {
  readonly actionType = 'SCRAPE_METRICS';

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const metricsScraper = resolveOptional(this.moduleRef, MetricsScraperService);
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
}

// ── RECYCLE_CONTENT ────────────────────────────────────────────────────────

@Injectable()
export class RecycleContentHandler implements IActionHandler {
  readonly actionType = 'RECYCLE_CONTENT';

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const recyclingService = resolveOptional(this.moduleRef, RecyclingService);
    if (!recyclingService) {
      return { recycled: false, reason: 'RecyclingService not available' };
    }

    const result = await recyclingService.runRecycling();
    return {
      recycled: result.recycled,
      skipped: result.skipped,
    };
  }
}

// ── AGGREGATE_HOOKS ────────────────────────────────────────────────────────

@Injectable()
export class AggregateHooksHandler implements IActionHandler {
  readonly actionType = 'AGGREGATE_HOOKS';

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const hookBank = resolveOptional(this.moduleRef, HookPerformanceBank);
    if (!hookBank) {
      return { aggregated: false, reason: 'HookPerformanceBank not available' };
    }

    await hookBank.aggregateStats();
    return { aggregated: true };
  }
}

// ── TRIAGE_QUEUE ───────────────────────────────────────────────────────────

@Injectable()
export class TriageQueueHandler implements IActionHandler {
  readonly actionType = 'TRIAGE_QUEUE';
  private readonly logger = new Logger(TriageQueueHandler.name);

  constructor(
    private readonly queueTriageService: QueueTriageService,
    private readonly configService: ConfigService,
  ) {}

  async execute(_action: Action, _options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const enabled = parseBool(this.configService.get<string>('LLM_QUEUE_TRIAGE_ENABLED', 'false'));
    if (!enabled) {
      return { triaged: false, reason: 'LLM_QUEUE_TRIAGE_ENABLED=false' };
    }

    try {
      const results = await this.queueTriageService.triageAll();
      const totals = results.reduce(
        (acc, r) => ({
          examined: acc.examined + r.examined,
          retried: acc.retried + r.retried,
          requeuedDelayed: acc.requeuedDelayed + r.requeuedDelayed,
          rejected: acc.rejected + r.rejected,
          escalated: acc.escalated + r.escalated,
          skipped: acc.skipped + r.skipped,
          errors: acc.errors + r.errors,
        }),
        { examined: 0, retried: 0, requeuedDelayed: 0, rejected: 0, escalated: 0, skipped: 0, errors: 0 },
      );
      this.logger.log(`TRIAGE_QUEUE: ${JSON.stringify(totals)}`);
      return { triaged: true, results, totals };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`TRIAGE_QUEUE failed: ${message}`);
      return { triaged: false, reason: message };
    }
  }
}
