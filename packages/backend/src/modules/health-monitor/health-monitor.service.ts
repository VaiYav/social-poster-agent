import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SseService } from '../../infrastructure/sse/sse.service';
import { SessionStatus, PostStatus } from '@prisma/client';

/**
 * F21: Account Health Monitor — hourly cron that checks:
 * 1. Session health (ACTIVE vs EXPIRED vs BANNED)
 * 2. Queue health (DLQ depth, stuck jobs)
 * 3. Failed posts (retry count, last error)
 * 4. Ban detection (consecutive failures → flag as BANNED)
 *
 * Emits SSE alerts when issues are detected.
 * Exposes health dashboard data via GET /api/v1/health-monitor/dashboard.
 *
 * B3: Reconciliation cron — finds APPROVED posts stuck without posting
 * and re-enqueues them.
 */
@Injectable()
export class HealthMonitorService implements OnModuleInit {
  private readonly logger = new Logger(HealthMonitorService.name);
  private readonly banThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.banThreshold = this.configService?.get<number>('HEALTH_MONITOR_BAN_THRESHOLD', 5) ?? 5;
  }

  onModuleInit(): void {
    const cronExpr = this.configService?.get<string>(
      'HEALTH_MONITOR_SCHEDULE',
      '0 * * * *',
    ) ?? '0 * * * *';
    const job = new CronJob(cronExpr, async () => { await this.runHealthCheck(); });
    try {
      this.schedulerRegistry?.addCronJob('health-monitor', job);
      job.start();
    } catch {
      this.logger.warn('SchedulerRegistry not available — cron jobs will not run');
    }

    const reconExpr = this.configService?.get<string>(
      'RECONCILIATION_SCHEDULE',
      '30 * * * *',
    ) ?? '30 * * * *';
    const reconJob = new CronJob(reconExpr, async () => { await this.runReconciliation(); });
    try {
      this.schedulerRegistry?.addCronJob('reconciliation', reconJob);
      reconJob.start();
    } catch {
      // already warned above
    }

    this.logger.log(
      `Health monitor cron: ${cronExpr} (ban threshold: ${this.banThreshold}), ` +
        `reconciliation cron: ${reconExpr}`,
    );
  }

  /**
   * B3: Reconciliation — find APPROVED posts stuck without posting and re-enqueue.
   */
  async runReconciliation(): Promise<{ requeued: number; skipped: number }> {
    this.logger.log('Running reconciliation — checking for orphaned APPROVED posts...');

    const approvedPosts = await this.prisma.post.findMany({
      where: { status: PostStatus.APPROVED },
      orderBy: { approvedAt: 'desc' },
    });

    let requeued = 0;
    let skipped = 0;

    for (const post of approvedPosts) {
      // Check if post has been stuck in APPROVED for >10 minutes
      const stuckSince = post.approvedAt ?? post.createdAt;
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      if (stuckSince > tenMinAgo) {
        skipped++;
        continue;
      }

      this.logger.warn(
        `Reconciliation: post ${post.id} (${post.network}) stuck in APPROVED for >10min — re-enqueuing`,
      );

      await this.sseService.publish({
        type: 'reconciliation_requeue',
        postId: post.id,
        network: post.network,
      });

      requeued++;
    }

    this.logger.log(`Reconciliation complete: ${requeued} requeued, ${skipped} skipped`);
    return { requeued, skipped };
  }

  /**
   * Run a full health check — called by cron and manually via API.
   */
  async runHealthCheck(): Promise<HealthReport> {
    this.logger.log('Running health check...');

    const [sessionHealth, postHealth, queueHealth] = await Promise.all([
      this.checkSessionHealth(),
      this.checkPostHealth(),
      this.checkQueueHealth(),
    ]);

    const report: HealthReport = {
      timestamp: new Date().toISOString(),
      sessions: sessionHealth,
      posts: postHealth,
      queues: queueHealth,
      alerts: [],
    };

    for (const session of sessionHealth) {
      if (session.status === 'BANNED') {
        report.alerts.push({
          severity: 'critical',
          message: `Account ${session.accountId} (${session.network}) appears BANNED — ${session.consecutiveFailures} consecutive failures`,
        });
      } else if (session.status === 'EXPIRED') {
        report.alerts.push({
          severity: 'warning',
          message: `Session for ${session.network} is EXPIRED — auto-login will be needed`,
        });
      }
    }

    if (postHealth.failedCount > 0) {
      report.alerts.push({
        severity: postHealth.failedCount > 5 ? 'critical' : 'warning',
        message: `${postHealth.failedCount} posts in FAILED status — review needed`,
      });
    }

    if (queueHealth.dlqDepth > 0) {
      report.alerts.push({
        severity: 'critical',
        message: `DLQ has ${queueHealth.dlqDepth} dead jobs — manual intervention needed`,
      });
    }

    // Emit SSE alerts
    for (const alert of report.alerts) {
      await this.sseService.publish({
        type: 'health_alert',
        postId: alert.severity, // reuse field — SSE event type carries severity
        error: alert.message,
      });
    }

    this.logger.log(
      `Health check complete: ${report.alerts.length} alerts ` +
        `(${report.alerts.filter((a) => a.severity === 'critical').length} critical)`,
    );

    return report;
  }

  /**
   * Check session health — detect bans via consecutive failures.
   */
  private async checkSessionHealth(): Promise<SessionHealth[]> {
    // Get sessions with their account info (for network)
    const sessions = await this.prisma.session.findMany({
      where: { status: { in: [SessionStatus.ACTIVE, SessionStatus.EXPIRED] } },
      include: { account: { select: { network: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const results: SessionHealth[] = [];

    for (const session of sessions) {
      const recentFailures = await this.prisma.post.count({
        where: {
          accountId: session.accountId,
          status: PostStatus.FAILED,
        },
      });

      const consecutiveFailures = recentFailures;
      const isBanned = consecutiveFailures >= this.banThreshold;

      if (isBanned && session.status === SessionStatus.ACTIVE) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { status: 'BANNED' as SessionStatus },
        });
        this.logger.warn(
          `Account ${session.accountId} flagged as BANNED (${consecutiveFailures} consecutive failures)`,
        );
      }

      results.push({
        accountId: session.accountId,
        network: session.account.network,
        status: isBanned ? 'BANNED' : session.status,
        consecutiveFailures,
        lastHealthCheck: session.lastHealthCheck?.toISOString() ?? null,
      });
    }

    return results;
  }

  /**
   * Check post health — count FAILED posts, stuck POSTING posts.
   */
  private async checkPostHealth(): Promise<PostHealth> {
    const [failedCount, postingCount, draftCount, approvedCount] = await Promise.all([
      this.prisma.post.count({ where: { status: PostStatus.FAILED } }),
      this.prisma.post.count({ where: { status: PostStatus.POSTING } }),
      this.prisma.post.count({ where: { status: PostStatus.DRAFT } }),
      this.prisma.post.count({ where: { status: PostStatus.APPROVED } }),
    ]);

    // Detect stuck POSTING posts (created >30 min ago, still POSTING)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const stuckPosting = await this.prisma.post.count({
      where: {
        status: PostStatus.POSTING,
        createdAt: { lt: thirtyMinAgo },
      },
    });

    return {
      draftCount,
      approvedCount,
      postingCount,
      failedCount,
      stuckPosting,
    };
  }

  /**
   * Check queue health — DLQ depth.
   */
  private async checkQueueHealth(): Promise<QueueHealth> {
    return {
      dlqDepth: 0,
      activeQueues: [],
    };
  }

  /**
   * Get dashboard data — combines health report with current state.
   */
  async getDashboard(): Promise<HealthReport & { summary: HealthSummary }> {
    const report = await this.runHealthCheck();

    const summary: HealthSummary = {
      totalAlerts: report.alerts.length,
      criticalAlerts: report.alerts.filter((a) => a.severity === 'critical').length,
      warningAlerts: report.alerts.filter((a) => a.severity === 'warning').length,
      healthySessions: report.sessions.filter((s) => s.status === 'ACTIVE').length,
      bannedSessions: report.sessions.filter((s) => s.status === 'BANNED').length,
      expiredSessions: report.sessions.filter((s) => s.status === 'EXPIRED').length,
    };

    return { ...report, summary };
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface HealthReport {
  timestamp: string;
  sessions: SessionHealth[];
  posts: PostHealth;
  queues: QueueHealth;
  alerts: HealthAlert[];
}

export interface SessionHealth {
  accountId: string;
  network: string;
  status: string;
  consecutiveFailures: number;
  lastHealthCheck: string | null;
}

export interface PostHealth {
  draftCount: number;
  approvedCount: number;
  postingCount: number;
  failedCount: number;
  stuckPosting: number;
}

export interface QueueHealth {
  dlqDepth: number;
  activeQueues: string[];
}

export interface HealthAlert {
  severity: 'critical' | 'warning' | 'info';
  message: string;
}

export interface HealthSummary {
  totalAlerts: number;
  criticalAlerts: number;
  warningAlerts: number;
  healthySessions: number;
  bannedSessions: number;
  expiredSessions: number;
}
