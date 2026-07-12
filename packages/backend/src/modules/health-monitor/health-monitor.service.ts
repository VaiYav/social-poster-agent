import { Injectable, Logger, Inject, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SseService } from '../../infrastructure/sse/sse.service';
import { DiscordNotificationService } from '../../infrastructure/notifications/discord-notification.service';
import { QueueService } from '../queue/queue.service';
import { QueueFactory } from '../../infrastructure/queue/queue.factory';
import { isJobInFlight } from '../../infrastructure/queue/queue-state-utils.js';
import { SessionStatus, PostStatus, SocialNetwork, BrowsingSessionStatus } from '@prisma/client';
import { parseBool } from '../../infrastructure/config/parse-bool';
import { isOrchestratorEnabled } from '../orchestrator/feature-flag.js';
import { getEnabledNetworks, isNetworkEnabled } from '../../domain/enabled-networks.js';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';

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
  // M1: a POSTING post older than this grace window with no active BullMQ job is treated
  // as orphaned (crash mid-post) and reaped to FAILED. Grace avoids racing a just-started post.
  private readonly stuckPostingGraceMin: number;
  private readonly engagementLockKey: string;

  // Cache the last health report so the metrics SSE collector doesn't run
  // the full expensive health check every 5 seconds.
  private lastReport: HealthReport | null = null;
  private lastReportAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly discord: DiscordNotificationService,
    private readonly queueService: QueueService,
    private readonly queueFactory: QueueFactory,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
  ) {
    this.banThreshold = this.configService?.get<number>('HEALTH_MONITOR_BAN_THRESHOLD', 5) ?? 5;
    this.stuckPostingGraceMin = this.configService?.get<number>('STUCK_POSTING_GRACE_MIN', 5) ?? 5;
    this.engagementLockKey = this.configService?.get<string>('ENGAGEMENT_LOCK_KEY', 'spa:lock:engagement') ?? 'spa:lock:engagement';
  }

  onModuleInit(): void {
    // SPA_DRY_RUN: skip cron registration in dry-run mode
    const isDryRun = parseBool(this.configService?.get<string>('SPA_DRY_RUN', 'false'));
    if (isDryRun) {
      this.logger.warn('SPA_DRY_RUN=true — health monitor cron jobs NOT registered');
      return;
    }

    // Orchestrator mode: health checks + reconciliation are handled by the
    // orchestrator decision loop (HEALTH_CHECK, RECONCILE actions), no crons needed.
    if (isOrchestratorEnabled()) {
      this.logger.log('Orchestrator is enabled — health monitor crons NOT registered');
      return;
    }

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
    const reconJob = new CronJob(reconExpr, async () => {
      await this.runReconciliation();
      await this.reapStuckPosting();
    });
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

    // On startup, reap any browsing sessions that were left ACTIVE after a previous
    // container crash or browser hang. This unblocks the engagement scheduler, which
    // otherwise refuses to start a new session while one is still marked ACTIVE.
    this.reapStuckBrowsingSessions().catch((err) => {
      this.logger.warn(`Startup reaper for browsing sessions failed: ${(err as Error).message}`);
    });
  }

  /**
   * B3: Reconciliation — find APPROVED posts stuck without posting and re-enqueue.
   * A post is "stuck" if it's been APPROVED for >10 minutes without being posted.
   *
   * P0-H5: Duplicate detection — before re-enqueuing, check if BullMQ already
   * has an active/waiting/delayed job for this post. Previously, reconciliation
   * could create duplicate jobs, leading to double-posting.
   */
  async runReconciliation(): Promise<{ requeued: number; skipped: number; deduplicated: number }> {
    this.logger.log('Running reconciliation — checking for orphaned APPROVED posts...');

    // P1: Paginate through ALL APPROVED posts instead of capping at 1000.
    // Uses cursor-based pagination on approvedAt to avoid loading everything
    // into memory at once. Each page is small (100) to bound Redis queue
    // lookups per tick.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const PAGE_SIZE = 100;
    let cursor: Date | null = null;
    let hasMore = true;

    // 2.5.3: process sequentially to avoid 1000 parallel Redis calls;
    // also deduplicate completed/failed jobs so we don't re-enqueue terminal jobs.
    let requeued = 0;
    let skipped = 0;
    let deduplicated = 0;
    let totalScanned = 0;

    while (hasMore) {
      const page: Array<{ id: string; network: string; approvedAt: Date | null; createdAt: Date }> =
        await this.prisma.post.findMany({
          where: {
            status: PostStatus.APPROVED,
            ...(cursor ? { approvedAt: { lt: cursor } } : {}),
          },
          orderBy: { approvedAt: 'desc' },
          take: PAGE_SIZE,
          select: {
            id: true,
            network: true,
            approvedAt: true,
            createdAt: true,
          },
        });

      if (page.length === 0) {
        hasMore = false;
        break;
      }

      // The last item's approvedAt is the cursor for the next page.
      // Fall back to createdAt if approvedAt is null (shouldn't happen for APPROVED).
      const last: { approvedAt: Date | null; createdAt: Date } = page[page.length - 1]!;
      cursor = last.approvedAt ?? last.createdAt;

      for (const post of page) {
        totalScanned += 1;
        if (!isNetworkEnabled(post.network as SocialNetwork)) {
          skipped += 1;
          continue;
        }
        // Post is stuck if it was approved MORE than 10 minutes ago
        const stuckSince = post.approvedAt ?? post.createdAt;
        if (stuckSince > tenMinAgo) {
          skipped += 1;
          continue;
        }

        // P0-H5: Check if BullMQ already has this job
        try {
          const queue = this.queueFactory.getQueue(post.network, 'posting');
          const existingJob = await queue.getJob(post.id);
          if (existingJob) {
            const state = await existingJob.getState();
            if (
              state === 'active' ||
              state === 'waiting' ||
              state === 'delayed' ||
              state === 'completed' ||
              state === 'failed'
            ) {
              this.logger.warn(
                `Reconciliation: post ${post.id} already has a ${state} job in BullMQ — skipping (dedup)`,
              );
              deduplicated += 1;
              continue;
            }
          }
        } catch (queueErr) {
          this.logger.debug(
            `Reconciliation: could not check queue state for post ${post.id}: ${(queueErr as Error).message}`,
          );
        }

        this.logger.warn(
          `Reconciliation: post ${post.id} (${post.network}) stuck in APPROVED for >10min — re-enqueuing`,
        );

        try {
          await this.queueService.enqueuePosting(post.id, post.network as SocialNetwork);
        } catch (err) {
          this.logger.error(
            `Reconciliation: failed to re-enqueue post ${post.id}: ${(err as Error).message}`,
          );
          skipped += 1;
          continue;
        }

        await this.sseService.publish({
          type: 'reconciliation_requeue',
          postId: post.id,
          network: post.network,
        });

        requeued += 1;
      }

      // If we got fewer than PAGE_SIZE, we've reached the end.
      if (page.length < PAGE_SIZE) {
        hasMore = false;
      }
    }

    this.logger.log(
      `Reconciliation complete: scanned ${totalScanned}, ${requeued} requeued, ${skipped} skipped, ${deduplicated} deduplicated`,
    );
    return { requeued, skipped, deduplicated };
  }

  /**
   * M1: Reaper for orphaned POSTING posts.
   *
   * A post in POSTING means a worker picked it up and set the status, then was expected to
   * finish. If the process/browser crashed mid-post, the post stays POSTING forever — and the
   * worker's status guard (POSTING → "already being posted") blocks any re-attempt, so it is
   * silently lost (orphaned-POSTING, audit `03 §1`).
   *
   * Detection is by the absence of an in-flight BullMQ job: with concurrency=1 and jobId=postId,
   * a post is only set to POSTING by the active job processing it. If there is no
   * active/waiting/delayed job for this post, no worker is (or will be) processing it → orphaned.
   *
   * Policy: mark FAILED with an explicit warning. We deliberately do NOT auto-re-enqueue —
   * we cannot know whether the post went live before the crash, and a blind re-post would risk
   * a duplicate. A human verifies the timeline. (Reliable verify-then-resolve lands with P1.)
   */
  async reapStuckPosting(): Promise<{ reaped: number; skipped: number }> {
    const graceMs = Number(this.stuckPostingGraceMin) * 60 * 1000;
    const cutoff = new Date(Date.now() - graceMs);

    const postingPosts = await this.prisma.post.findMany({
      where: { status: PostStatus.POSTING, approvedAt: { lt: cutoff } },
      take: 500, // MEM: safety cap — orphaned POSTING posts should be rare (<10),
      // but without a limit a pathological state could load thousands into memory.
    });
    if (postingPosts.length === 0) return { reaped: 0, skipped: 0 };

    let reaped = 0;
    let skipped = 0;

    for (const post of postingPosts) {
      let errorMessage =
        'Stuck in POSTING with no active job (likely crash mid-post). Marked FAILED by reaper — ' +
        'VERIFY the account timeline before re-approving: the post MAY already be live.';
      let isNetworkDisabled = false;

      if (!isNetworkEnabled(post.network as SocialNetwork)) {
        isNetworkDisabled = true;
        errorMessage = `Network ${post.network} is disabled — post cannot be processed`;
      } else {
        // If BullMQ still has an in-flight/pending job, the post is genuinely being processed.
        try {
          const queue = this.queueFactory.getQueue(post.network, 'posting');
          const job = await queue.getJob(post.id);
          if (job) {
            const state = await job.getState();
            if (isJobInFlight(state)) {
              skipped++;
              continue;
            }
          }
        } catch (queueErr) {
          // Can't determine job state — be conservative and skip (never reap blindly).
          this.logger.debug(
            `Reaper: cannot check queue state for post ${post.id}: ${(queueErr as Error).message}`,
          );
          skipped++;
          continue;
        }
      }

      try {
        await this.prisma.post.update({
          where: { id: post.id },
          data: { status: PostStatus.FAILED, errorMessage },
        });
      } catch (updateErr) {
        this.logger.error(
          `Reaper: failed to mark post ${post.id} FAILED: ${(updateErr as Error).message}`,
        );
        skipped++;
        continue;
      }

      await this.sseService.publish({
        type: 'post_status',
        postId: post.id,
        status: 'FAILED',
        network: post.network,
        error: errorMessage,
      });
      await this.discord
        .warning(
          isNetworkDisabled ? 'Disabled network post reaped' : 'Stuck POSTING reaped',
          `Post **${post.id}** (${post.network}): ${errorMessage}`,
        )
        .catch(() => void 0);
      this.logger.warn(`Reaper: post ${post.id} (${post.network}) reaped (POSTING → FAILED)`);
      reaped++;
    }

    if (reaped > 0 || skipped > 0) {
      this.logger.log(`Reaper: ${reaped} stuck POSTING reaped, ${skipped} skipped (in-flight)`);
    }
    return { reaped, skipped };
  }

  /**
   * Reap browsing sessions that are stuck ACTIVE after a crash or browser hang.
   *
   * A browsing session in ACTIVE should finish within its planned duration plus the hard
   * timeout buffer. If it remains ACTIVE past that, the worker/container that owned it is
   * gone and the row is orphaned. Leaving it ACTIVE blocks the engagement scheduler,
   * which sees `lastSessionStatus === ACTIVE` and refuses to enqueue a new session.
   *
   * Uses startedAt (not endedAt) because stuck sessions have no endedAt. The grace is the
   * session duration + hard-timeout buffer + a small safety margin so a just-started
   * session is never reaped.
   */
  async reapStuckBrowsingSessions(): Promise<{ reaped: number }> {
    const browsingMinutes = Number(this.configService.get<number>('F1_BROWSING_SESSION_MINUTES', 15));
    const graceMs = browsingMinutes * 60 * 1000 + 180_000 + 5 * 60 * 1000;
    const cutoff = new Date(Date.now() - graceMs);

    const stuck = await this.prisma.browsingSession.findMany({
      where: { status: BrowsingSessionStatus.ACTIVE, startedAt: { lt: cutoff } },
      take: 500, // safety cap
    });

    if (stuck.length === 0) return { reaped: 0 };

    let reaped = 0;
    for (const session of stuck) {
      try {
        await this.prisma.browsingSession.update({
          where: { id: session.id },
          data: {
            status: BrowsingSessionStatus.FAILED,
            endedAt: new Date(),
            errorMessage: `Reaped: stuck ACTIVE for >${Math.round((Date.now() - session.startedAt.getTime()) / 1000 / 60)}min (session duration ${browsingMinutes}min + buffer)`,
          },
        });
        reaped++;
      } catch (updateErr) {
        this.logger.warn(
          `Reaper: failed to mark browsing session ${session.id} FAILED: ${(updateErr as Error).message}`,
        );
      }
    }

    // If any session was stuck, the distributed engagement lock may be held by
    // the dead/crashed worker that owned it. Force-release it so the next job
    // can acquire it and resume engagement.
    if (reaped > 0) {
      try {
        await this.redis.del(this.engagementLockKey);
        this.logger.warn(`Reaper: forced release of engagement lock ${this.engagementLockKey}`);
      } catch (lockErr) {
        this.logger.warn(
          `Reaper: failed to force-release engagement lock ${this.engagementLockKey}: ${(lockErr as Error).message}`,
        );
      }
    }

    this.logger.warn(
      `Reaper: ${reaped} stuck ACTIVE browsing session(s) reaped to FAILED (cutoff ${cutoff.toISOString()})`,
    );
    return { reaped };
  }

  /**
   * Run a full health check — called by cron and manually via API.
   */
  async runHealthCheck(opts: { emitAlerts?: boolean } = { emitAlerts: true }): Promise<HealthReport> {
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

    // Emit SSE alerts + Discord notifications (unless called from getDashboard)
    if (opts.emitAlerts) {
      for (const alert of report.alerts) {
        await this.sseService.publish({
          type: 'health_alert',
          severity: alert.severity, // P1-6: use dedicated severity field, not postId
          error: alert.message,
        });

        // Send critical/warning alerts to Discord
        if (alert.severity === 'critical') {
          await this.discord.critical('Health Alert', alert.message);
        } else if (alert.severity === 'warning') {
          await this.discord.warning('Health Alert', alert.message);
        }
      }
    }

    this.logger.log(
      `Health check complete: ${report.alerts.length} alerts ` +
        `(${report.alerts.filter((a) => a.severity === 'critical').length} critical)`,
    );

    this.lastReport = report;
    this.lastReportAt = Date.now();
    return report;
  }

  /**
   * Check session health — detect bans via consecutive failures.
   */
  private async checkSessionHealth(): Promise<SessionHealth[]> {
    // Get sessions with their account info (for network)
    const sessions = await this.prisma.session.findMany({
      where: {
        status: { in: [SessionStatus.ACTIVE, SessionStatus.EXPIRED] },
        account: { network: { in: getEnabledNetworks() } },
      },
      include: { account: { select: { network: true } } },
      orderBy: { createdAt: 'desc' },
    });

    if (sessions.length === 0) return [];

    // NQ-1 fix: Batch-query recent posts for ALL accounts in a single DB call
    // instead of N queries (one per session). Group by accountId in memory.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const accountIds = sessions.map((s) => s.accountId);
    const allRecentPosts = await this.prisma.post.findMany({
      where: {
        accountId: { in: accountIds },
        createdAt: { gte: twentyFourHoursAgo },
      },
      select: { accountId: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    // Group posts by accountId
    const postsByAccount = new Map<string, typeof allRecentPosts>();
    for (const post of allRecentPosts) {
      const list = postsByAccount.get(post.accountId);
      if (list) {
        list.push(post);
      } else {
        postsByAccount.set(post.accountId, [post]);
      }
    }

    const results: SessionHealth[] = [];

    for (const session of sessions) {
      // P1-4 fix: Count CONSECUTIVE failures (not total failures in 24h).
      // Use the batch-loaded posts, limited to recent 50 for streak analysis.
      const recentPosts = (postsByAccount.get(session.accountId) ?? []).slice(0, 50);

      // Count consecutive FAILED posts from the most recent
      let consecutiveFailures = 0;
      for (const p of recentPosts) {
        if (p.status === PostStatus.FAILED) {
          consecutiveFailures++;
        } else {
          break; // streak broken by a non-FAILED post
        }
      }

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

    // P1-5 fix: Detect stuck POSTING posts using approvedAt (when post entered APPROVED→POSTING flow),
    // not createdAt (which is when the DRAFT was first created).
    // A post approved 1 min ago but stuck in POSTING for 1 min should NOT be flagged (false positive).
    // A post approved 35 min ago stuck in POSTING SHOULD be flagged.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const stuckPosting = await this.prisma.post.count({
      where: {
        status: PostStatus.POSTING,
        approvedAt: { lt: thirtyMinAgo },
        network: { in: getEnabledNetworks() },
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
   * Check queue health — DLQ depth and active queue status.
   * Queries BullMQ failed jobs per network to detect dead-letter queue depth.
   */
  private async checkQueueHealth(): Promise<QueueHealth> {
    let dlqDepth = 0;
    const activeQueues: string[] = [];

    for (const network of getEnabledNetworks()) {
      try {
        const counts = await this.queueService.getJobCounts(network);
        const failed = counts.failed ?? 0;
        const active = counts.active ?? 0;
        const waiting = counts.waiting ?? 0;
        if (failed > 0) {
          dlqDepth += failed;
        }
        if (active > 0 || waiting > 0) {
          activeQueues.push(`${network} (${active} active, ${waiting} waiting)`);
        }
      } catch {
        // Queue not available — skip
      }
    }

    return { dlqDepth, activeQueues };
  }

  /**
   * Get dashboard data — combines health report with current state.
   * Caches the last report for 5 minutes so SSE metrics collection doesn't
   * run the expensive full health check every 5 seconds.
   */
  async getDashboard(force = false): Promise<HealthReport & { summary: HealthSummary }> {
    const cacheMaxAgeMs = 300_000; // 5 minutes
    if (!force && this.lastReport && Date.now() - this.lastReportAt < cacheMaxAgeMs) {
      const report = this.lastReport;
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

    const report = await this.runHealthCheck({ emitAlerts: false });

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

  /**
   * Sprint K: Ban Recovery — checks if a BANNED session can be reactivated.
   * Called manually or via cron. Navigates to the network's profile page;
   * if accessible without ban/suspension page, marks session as ACTIVE.
   *
   * @returns true if ban was lifted, false if still banned
   */
  async checkBanRecovery(accountId: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { accountId, status: SessionStatus.BANNED },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) return false;

    // For now, we do a time-based recovery check:
    // If the ban was more than 24h ago and no recent failures, try reactivation.
    // Use updatedAt (when the session was last marked BANNED) instead of createdAt
    // so a recently-banned old session is not reactivated prematurely.
    const banAgeMs = Date.now() - session.updatedAt.getTime();
    const RECOVERY_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

    if (banAgeMs < RECOVERY_THRESHOLD_MS) {
      this.logger.debug(`Ban recovery: session ${session.id} banned ${Math.round(banAgeMs / 3600000)}h ago — waiting for 24h threshold`);
      return false;
    }

    // Check for recent failed posts for this account
    const recentFailures = await this.prisma.post.count({
      where: {
        accountId,
        status: PostStatus.FAILED,
        createdAt: { gt: new Date(Date.now() - RECOVERY_THRESHOLD_MS) },
      },
    });

    if (recentFailures > 0) {
      this.logger.debug(`Ban recovery: session ${session.id} has ${recentFailures} recent failures — not recovering`);
      return false;
    }

    // Reactivate session
    await this.prisma.session.update({
      where: { id: session.id },
      data: { status: SessionStatus.ACTIVE },
    });

    this.sseService.publish({
      type: 'health_alert',
      severity: 'info',
      error: `Ban lifted for account ${accountId} — session reactivated`,
    });
    this.logger.log(`Ban recovery: session ${session.id} reactivated for account ${accountId}`);
    return true;
  }

  /**
   * Sprint K: Run ban recovery check for all banned sessions.
   */
  async recoverBannedSessions(): Promise<{ checked: number; recovered: number }> {
    const bannedSessions = await this.prisma.session.findMany({
      where: { status: SessionStatus.BANNED },
      include: { account: true },
    });

    let recovered = 0;
    for (const session of bannedSessions) {
      const wasRecovered = await this.checkBanRecovery(session.accountId);
      if (wasRecovered) recovered += 1;
    }

    this.logger.log(`Ban recovery: checked ${bannedSessions.length}, recovered ${recovered}`);
    return { checked: bannedSessions.length, recovered };
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
