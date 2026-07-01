/**
 * StateCollector — OBSERVE node implementation.
 *
 * Collects a complete WorldState snapshot from DB, Redis, and services
 * on every orchestrator cycle. All collectors run in parallel for speed.
 * Partial failures don't abort — degraded fields are tracked.
 *
 * V-Model: WS-1 (critical — all decisions depend on accurate state)
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { SessionStatus, PostStatus, SocialNetwork } from '@prisma/client';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { FlowControlService } from '../flow-control/flow-control.service.js';
import { QueueFactory } from '../../infrastructure/queue/queue.factory.js';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import type { WorldState, SessionState, RateLimitState, HealthState, FlowControlState, PostMetricsSummary } from './types.js';

@Injectable()
export class StateCollectorService {
  private readonly logger = new Logger(StateCollectorService.name);
  private readonly topicPoolThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    private readonly rateLimitService: RateLimitService,
    private readonly flowControlService: FlowControlService,
    private readonly queueFactory: QueueFactory,
  ) {
    this.topicPoolThreshold = Number(this.configService.get<string>('TOPIC_POOL_MIN', '30'));
  }

  /**
   * Collect full WorldState — all sources in parallel.
   * Never throws — returns partial state on error.
   */
  async collectWorldState(): Promise<WorldState> {
    const startTime = Date.now();
    const degraded: string[] = [];
    const networks = getEnabledNetworks();

    // Run all collectors in parallel — each catches its own errors
    const [
      topicPool,
      drafts,
      queueDepth,
      sessions,
      rateLimits,
      timing,
      performance,
      engagement,
      health,
      flowControl,
      trends,
    ] = await Promise.all([
      this.collectTopicPool().catch((e) => { degraded.push('topicPool'); this.logger.warn(`topicPool degraded: ${e.message}`); return null; }),
      this.collectDraftCounts().catch((e) => { degraded.push('drafts'); this.logger.warn(`drafts degraded: ${e.message}`); return null; }),
      this.collectQueueDepth(networks).catch((e) => { degraded.push('queueDepth'); this.logger.warn(`queueDepth degraded: ${e.message}`); return null; }),
      this.collectSessions(networks).catch((e) => { degraded.push('sessions'); this.logger.warn(`sessions degraded: ${e.message}`); return null; }),
      this.collectRateLimits(networks).catch((e) => { degraded.push('rateLimits'); this.logger.warn(`rateLimits degraded: ${e.message}`); return null; }),
      this.collectTiming().catch((e) => { degraded.push('timing'); this.logger.warn(`timing degraded: ${e.message}`); return null; }),
      this.collectPerformance(networks).catch((e) => { degraded.push('performance'); this.logger.warn(`performance degraded: ${e.message}`); return null; }),
      this.collectEngagement(networks).catch((e) => { degraded.push('engagement'); this.logger.warn(`engagement degraded: ${e.message}`); return null; }),
      this.collectHealth(networks).catch((e) => { degraded.push('health'); this.logger.warn(`health degraded: ${e.message}`); return null; }),
      this.collectFlowControl().catch((e) => { degraded.push('flowControl'); this.logger.warn(`flowControl degraded: ${e.message}`); return null; }),
      this.collectTrends().catch((e) => { degraded.push('trends'); this.logger.warn(`trends degraded: ${e.message}`); return null; }),
    ]);

    const elapsed = Date.now() - startTime;
    if (degraded.length > 0) {
      this.logger.warn(`State collected in ${elapsed}ms with ${degraded.length} degraded fields: ${degraded.join(', ')}`);
    } else {
      this.logger.debug(`State collected in ${elapsed}ms — all sources OK`);
    }

    return {
      timestamp: Date.now(),
      topicPool: topicPool ?? { count: 0, threshold: this.topicPoolThreshold, oldestAgeMs: 0 },
      drafts: drafts ?? { pending: 0, approved: 0, rejected: 0 },
      queueDepth: queueDepth ?? {},
      sessions: sessions ?? {},
      rateLimits: rateLimits ?? {},
      now: timing?.now ?? Date.now(),
      utcHour: timing?.utcHour ?? new Date().getUTCHours(),
      utcDayOfWeek: timing?.utcDayOfWeek ?? new Date().getUTCDay(),
      postingWindows: {}, // Filled by PostingWindowService in Phase 2
      inPostingWindow: {},
      performance: performance ?? {},
      engagement: engagement ?? { lastBrowseMs: {}, uncheckedReplies: 0, warmupPhase: {} },
      health: health ?? { bans: 0, dlqDepth: 0, stuckPosting: 0, orphanedPosts: 0, killSwitch: false },
      flowControl: flowControl ?? { pauseAll: false, pauseGeneration: false, pausePosting: false, pauseEngagement: false, pauseReplies: false },
      trends: trends ?? { lastRefreshMs: 0, count: 0 },
      _degraded: degraded,
      _collectedAt: Date.now(),
    };
  }

  // ── Individual collectors ────────────────────────────────────────────────

  private async collectTopicPool() {
    const count = await this.prisma.topic.count({ where: { status: 'active' } });
    const oldest = await this.prisma.topic.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const oldestAgeMs = oldest ? Date.now() - oldest.createdAt.getTime() : 0;
    return { count, threshold: this.topicPoolThreshold, oldestAgeMs };
  }

  private async collectDraftCounts() {
    const [pending, approved, rejected] = await Promise.all([
      this.prisma.post.count({ where: { status: PostStatus.DRAFT } }),
      this.prisma.post.count({ where: { status: PostStatus.APPROVED } }),
      this.prisma.post.count({ where: { status: PostStatus.REJECTED } }),
    ]);
    return { pending, approved, rejected };
  }

  private async collectQueueDepth(networks: string[]): Promise<Record<string, number>> {
    const entries = await Promise.all(
      networks.map(async (network) => {
        try {
          const counts = await this.queueFactory.getJobCounts(network, 'posting');
          return [network, (counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0)] as const;
        } catch {
          return [network, 0] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private async collectSessions(networks: string[]): Promise<Record<string, SessionState>> {
    // Parallelize per-network queries (was sequential for...of — N+1 pattern)
    const entries = await Promise.all(
      networks.map(async (network) => {
        try {
          const account = await this.prisma.socialAccount.findFirst({
            where: { network: network as SocialNetwork, active: true },
          });
          if (!account) {
            return [network, { status: 'unknown', lastCheckMs: 0, circuitBreaker: 'unknown' }] as const;
          }

          const [session, recentPosts] = await Promise.all([
            this.prisma.session.findFirst({
              where: { accountId: account.id, status: SessionStatus.ACTIVE },
              orderBy: { createdAt: 'desc' },
            }),
            this.prisma.post.findMany({
              where: { network: network as SocialNetwork },
              orderBy: { createdAt: 'desc' },
              take: 3,
              select: { status: true },
            }),
          ]);

          const recentFails = recentPosts.filter((p) => p.status === PostStatus.FAILED).length;
          const circuitBreaker = recentFails >= 3 ? 'open' : recentFails >= 1 ? 'half_open' : 'closed';

          return [
            network,
            {
              status: session?.status ?? SessionStatus.EXPIRED,
              lastCheckMs: session?.lastHealthCheck?.getTime() ?? 0,
              circuitBreaker: circuitBreaker as SessionState['circuitBreaker'],
            },
          ] as const;
        } catch {
          return [network, { status: 'unknown', lastCheckMs: 0, circuitBreaker: 'unknown' }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private async collectRateLimits(networks: string[]): Promise<Record<string, RateLimitState>> {
    const entries = await Promise.all(
      networks.map(async (network) => {
        try {
          const status = await this.rateLimitService.getStatus(network);
          return [
            network,
            {
              dailyRemaining: Math.max(0, status.dailyLimit - status.dailyCount),
              weeklyRemaining: Math.max(0, status.weeklyLimit - status.weeklyCount),
              minIntervalMs: status.minIntervalMs,
              lastPostMs: status.lastPostAt ?? 0,
            },
          ] as const;
        } catch {
          return [network, { dailyRemaining: 0, weeklyRemaining: 0, minIntervalMs: 0, lastPostMs: 0 }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private async collectTiming() {
    const now = new Date();
    return {
      now: now.getTime(),
      utcHour: now.getUTCHours(),
      utcDayOfWeek: now.getUTCDay(),
    };
  }

  private async collectPerformance(networks: string[]) {
    const performance: Record<string, PostMetricsSummary> = {};
    for (const network of networks) {
      try {
        const recentMetrics = await this.prisma.postMetrics.findMany({
          where: { post: { network: network as SocialNetwork } },
          orderBy: { collectedAt: 'desc' },
          take: 10,
          include: { post: { select: { postedAt: true } } },
        });

        if (recentMetrics.length === 0) {
          performance[network] = { recentAvgEngagement: 0, bestHours: [] };
          continue;
        }

        const lastMetrics = recentMetrics[0];
        const avgEngagement = recentMetrics.reduce((sum, m) => {
          return sum + (m.likes + m.comments * 2 + m.shares * 3);
        }, 0) / recentMetrics.length;

        // Build hour histogram from post times
        const hourCounts = new Map<number, number>();
        for (const m of recentMetrics) {
          if (m.post?.postedAt) {
            const hour = m.post.postedAt.getUTCHours();
            const score = m.likes + m.comments * 2 + m.shares * 3;
            hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + score);
          }
        }
        const bestHours = [...hourCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([h]) => h);

        performance[network] = {
          lastPostMetrics: {
            impressions: lastMetrics?.impressions ?? 0,
            likes: lastMetrics?.likes ?? 0,
            comments: lastMetrics?.comments ?? 0,
            shares: lastMetrics?.shares ?? 0,
          },
          recentAvgEngagement: avgEngagement,
          bestHours,
        };
      } catch {
        performance[network] = { recentAvgEngagement: 0, bestHours: [] };
      }
    }
    return performance;
  }

  private async collectEngagement(networks: string[]) {
    // Parallelize per-network account+browsing session queries
    const [engagementEntries, uncheckedReplies] = await Promise.all([
      Promise.all(
        networks.map(async (network) => {
          try {
            const account = await this.prisma.socialAccount.findFirst({
              where: { network: network as SocialNetwork, active: true },
            });
            if (account) {
              const lastSession = await this.prisma.browsingSession.findFirst({
                where: { accountId: account.id },
                orderBy: { startedAt: 'desc' },
                select: { startedAt: true },
              });
              return [
                network,
                lastSession?.startedAt?.getTime() ?? 0,
                account.warmupEnabled ? 'warmup' : 'full',
              ] as const;
            }
            return [network, 0, 'unknown'] as const;
          } catch {
            return [network, 0, 'unknown'] as const;
          }
        }),
      ),
      this.prisma.incomingComment.count({ where: { status: 'NEW' } }).catch(() => 0),
    ]);

    const lastBrowseMs: Record<string, number> = {};
    const warmupPhase: Record<string, string> = {};
    for (const [network, browseMs, phase] of engagementEntries) {
      lastBrowseMs[network] = browseMs;
      warmupPhase[network] = phase;
    }

    return { lastBrowseMs, uncheckedReplies, warmupPhase };
  }

  private async collectHealth(networks: string[]): Promise<HealthState> {
    // Run stuck-post count, ban detection (parallel per network), and DLQ depth in parallel
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);

    const [stuckPosting, banResults, dlqResults] = await Promise.all([
      this.prisma.post.count({
        where: { status: PostStatus.POSTING, postedAt: { lt: tenMinAgo } },
      }).catch(() => 0),

      // Ban detection — parallel per network
      Promise.all(
        networks.map(async (network): Promise<number> => {
          try {
            const recentPosts = await this.prisma.post.findMany({
              where: { network: network as SocialNetwork },
              orderBy: { createdAt: 'desc' },
              take: 5,
              select: { status: true },
            });
            let consecutiveFails = 0;
            for (const p of recentPosts) {
              if (p.status === PostStatus.FAILED) consecutiveFails++;
              else break;
            }
            return consecutiveFails >= 5 ? 1 : 0;
          } catch {
            return 0;
          }
        }),
      ),

      // DLQ depth — parallel per network
      Promise.all(
        networks.map((network) =>
          this.queueFactory.getJobCounts(network, 'posting').then((c) => c.failed ?? 0).catch(() => 0),
        ),
      ),
    ]);

    const bans = banResults.reduce((sum, n) => sum + n, 0);
    const dlqDepth = dlqResults.reduce((sum, n) => sum + n, 0);

    return {
      bans,
      dlqDepth,
      stuckPosting,
      orphanedPosts: 0, // Computed by health monitor, not critical for orchestrator
      killSwitch: false, // Set from flowControl below
    };
  }

  private async collectFlowControl(): Promise<FlowControlState> {
    const status = await this.flowControlService.getStatus();
    return {
      pauseAll: status.pauseAll,
      pauseGeneration: status.flows?.generation ?? false,
      pausePosting: status.flows?.posting ?? false,
      pauseEngagement: status.flows?.engagement ?? false,
      pauseReplies: status.flows?.replies ?? false,
    };
  }

  private async collectTrends() {
    // Trend cache age is tracked by TrendingScraperService internally.
    // We approximate by checking when the last topic with sourceType 'trending' was created.
    try {
      const lastTrending = await this.prisma.topic.findFirst({
        where: { sourceType: 'trending' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const lastRefreshMs = lastTrending?.createdAt?.getTime() ?? 0;
      const count = await this.prisma.topic.count({
        where: { sourceType: 'trending', status: 'active' },
      });
      return { lastRefreshMs, count };
    } catch {
      return { lastRefreshMs: 0, count: 0 };
    }
  }
}
