// EngagementScheduler — schedules browsing sessions via BullMQ delayed jobs.
//
// Schedules 2-3 browsing sessions per day per network at randomized times
// (jitter window) to simulate organic human activity patterns.
//
// Sessions are enqueued as BullMQ delayed jobs (not setTimeout) so they:
// - Survive process restarts (jobs persist in Redis)
// - Run in parallel across networks (each network has its own engagement queue)
// - Get auto-retried on failure (BullMQ exponential backoff)
// - Don't block the event loop (worker concurrency=1 per network)
//
// Configurable via env:
//   ENGAGEMENT_SCHEDULER_ENABLED=true/false
//   ENGAGEMENT_SESSIONS_PER_DAY=3
//   ENGAGEMENT_SESSION_WINDOWS=09:00,13:00,18:00  (base times, jitter applied)

import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import { QueueFactory } from '../../infrastructure/queue/queue.factory.js';
import { parseBool } from '../../infrastructure/config/parse-bool';
import { isOrchestratorEnabled } from '../orchestrator/feature-flag.js';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import type { WorldState } from '../orchestrator/types.js';

@Injectable()
export class EngagementSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngagementSchedulerService.name);
  private readonly enabled: boolean;
  private readonly sessionsPerDay: number;
  private readonly sessionWindows: string[]; // ['09:00', '13:00', '18:00']
  private readonly jitterMinutes: number;
  private readonly networks: SocialNetwork[];

  private scheduledTimeouts: NodeJS.Timeout[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly queueFactory: QueueFactory,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.enabled = parseBool(this.configService.get<string>('ENGAGEMENT_SCHEDULER_ENABLED', 'false'));
    this.sessionsPerDay = Number(this.configService.get<string>('ENGAGEMENT_SESSIONS_PER_DAY', '3'));
    this.sessionWindows = this.parseWindows(
      this.configService.get<string>('ENGAGEMENT_SESSION_WINDOWS', '09:00,13:00,18:00'),
    );
    this.jitterMinutes = Number(this.configService.get<string>('ENGAGEMENT_JITTER_MINUTES', '30'));
    this.networks = this.parseNetworks(
      this.configService.get<string>('ENGAGEMENT_NETWORKS', getEnabledNetworks().join(',')),
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Engagement scheduler disabled (ENGAGEMENT_SCHEDULER_ENABLED=false)');
      return;
    }

    if (this.networks.length === 0) {
      this.logger.warn('Engagement scheduler enabled but no networks configured');
      return;
    }

    // When orchestrator is enabled, engagement runs in PARALLEL via
    // checkStaleAndEnqueue() called from the orchestrator observeNode.
    // The daily cron + scheduleDailySessions are NOT needed.
    if (isOrchestratorEnabled()) {
      this.logger.log(
        'Engagement scheduler: orchestrator is enabled — stale-check runs in parallel, daily cron skipped',
      );
      return;
    }

    // Legacy mode: schedule today's sessions + register daily midnight cron
    this.scheduleDailySessions();
    this.registerDailyCron();
    this.logger.log(
      `Engagement scheduler started: ${this.sessionsPerDay} sessions/day across ${this.networks.length} networks (via BullMQ)`,
    );
  }

  /**
   * BUG-2: re-schedule browsing sessions every day at midnight. Without this, sessions were
   * scheduled exactly once (onModuleInit, today only) and engagement stopped forever after the
   * start day — the browsing-session worker doesn't enqueue the next one. Guards are re-applied
   * here (they lived only in onModuleInit); BullMQ dedups by jobId so a re-run is safe.
   *
   * Dynamically registered (not @Cron) so it is NOT created when orchestrator is enabled.
   */
  private registerDailyCron(): void {
    const cronExpr = process.env.ENGAGEMENT_SCHEDULE_CRON ?? '0 0 * * *';
    const job = new CronJob(cronExpr, () => this.scheduleDailySessions());
    try {
      this.schedulerRegistry.addCronJob('engagement-daily', job);
      job.start();
      this.logger.debug(`Engagement daily cron registered: ${cronExpr}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — engagement daily cron will not run');
    }
  }

  onModuleDestroy(): void {
    for (const timeout of this.scheduledTimeouts) {
      clearTimeout(timeout);
    }
    this.scheduledTimeouts = [];
  }

  /**
   * Schedule today's browsing sessions for all networks.
   * Each session is enqueued as a BullMQ delayed job with randomized jitter.
   * All networks are scheduled in parallel — each has its own engagement queue.
   *
   * No-op when disabled or no networks configured (guards that used to live in
   * the old scheduleDailySessionsCron wrapper).
   */
  scheduleDailySessions(): void {
    if (!this.enabled || this.networks.length === 0) return;

    const today = new Date();

    for (const network of this.networks) {
      const windows = this.pickWindowsForToday();

      for (const windowTime of windows) {
        const scheduledTime = this.applyJitter(windowTime, today);
        const delayMs = scheduledTime.getTime() - Date.now();

        // BUG-10 defense-in-depth: a malformed window yields an Invalid Date → NaN delay.
        // `NaN <= 0` is false, so the past-time guard alone would let it through and the later
        // `.toISOString()` would throw and kill the whole tick. Reject non-finite delays.
        if (!Number.isFinite(delayMs) || delayMs <= 0) {
          this.logger.debug(`Skipping past/invalid session window for ${network} (${windowTime})`);
          continue;
        }

        // Enqueue as BullMQ delayed job — runs in engagement queue for this network
        const jobId = `browsing-${network}-${scheduledTime.toISOString()}`;
        this.queueFactory
          .enqueueEngagement(
            jobId,
            network,
            'browsing-session',
            {
              network,
              scheduledAt: scheduledTime.toISOString(),
              durationSec: this.configService.get<number>('F1_BROWSING_SESSION_MINUTES', 10) * 60,
            },
            { delay: delayMs },
          )
          .then(() => {
            this.logger.debug(
              `Enqueued browsing session for ${network} at ${scheduledTime.toISOString()} (in ${Math.round(delayMs / 1000 / 60)}min)`,
            );
          })
          .catch((err: Error) => {
            this.logger.error(
              `Failed to enqueue browsing session for ${network}: ${err.message}`,
            );
          });
      }
    }
  }

  /**
   * Pick which time windows to use today (rotates to add variety).
   * If sessionsPerDay < sessionWindows.length, picks a random subset.
   */
  private pickWindowsForToday(): string[] {
    const windows = [...this.sessionWindows];
    // Shuffle for variety
    for (let i = windows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [windows[i], windows[j]] = [windows[j]!, windows[i]!];
    }
    return windows.slice(0, this.sessionsPerDay);
  }

  /**
   * Apply random jitter (±jitterMinutes) to a base time.
   */
  private applyJitter(baseTime: string, date: Date): Date {
    const [hours, minutes] = baseTime.split(':').map(Number);
    const base = new Date(date);
    // BUG-10: `?? default` does NOT catch NaN (a non-numeric window segment), so guard with
    // Number.isFinite — otherwise setHours(NaN, …) yields an Invalid Date.
    base.setHours(Number.isFinite(hours) ? hours! : 9, Number.isFinite(minutes) ? minutes! : 0, 0, 0);

    // Apply jitter: -jitterMinutes to +jitterMinutes
    const jitterMs = (Math.random() * 2 - 1) * this.jitterMinutes * 60 * 1000;
    return new Date(base.getTime() + jitterMs);
  }

  private parseWindows(value: string): string[] {
    // BUG-10: validate HH:MM at the source and drop malformed windows (e.g. 'foo' or '25:99'),
    // so a bad env value can't reach applyJitter and produce an Invalid Date.
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((w) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(w);
        if (!m) {
          this.logger.warn(`Ignoring invalid ENGAGEMENT_SESSION_WINDOWS entry "${w}" (expected HH:MM)`);
          return false;
        }
        const h = Number(m[1]);
        const min = Number(m[2]);
        const ok = h >= 0 && h <= 23 && min >= 0 && min <= 59;
        if (!ok) this.logger.warn(`Ignoring out-of-range ENGAGEMENT_SESSION_WINDOWS entry "${w}"`);
        return ok;
      });
  }

  private parseNetworks(value: string): SocialNetwork[] {
    return value
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s === 'X' || s === 'THREADS' || s === 'FACEBOOK')
      .map((s) => SocialNetwork[s as keyof typeof SocialNetwork]);
  }

  /**
   * Check for stale browsing sessions and enqueue them as fire-and-forget BullMQ jobs.
   * Called by the orchestrator on every observe cycle — runs in PARALLEL with the
   * main decision (GENERATE_POSTS, POST, etc.) so engagement never blocks content pipeline.
   *
   * BullMQ dedups by jobId, so calling this every cycle is safe — only the first
   * enqueue per network-per-stale-window actually creates a job.
   *
   * Conditions for enqueue:
   *   - Engagement is enabled and orchestrator is running (this method is only called then)
   *   - Flow control is not pausing engagement
   *   - Session for the network is ACTIVE
   *   - Last browse was > 4h ago (stale)
   *   - Not in night mode (01:00-07:00 UTC) — let the account rest
   */
  async checkStaleAndEnqueue(world: WorldState): Promise<void> {
    if (!this.enabled || this.networks.length === 0) return;
    if (world.flowControl.pauseAll || world.flowControl.pauseEngagement) return;

    // Night mode — skip engagement to let accounts rest
    if (world.utcHour >= 1 && world.utcHour < 7) return;

    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    const durationSec = this.configService.get<number>('F1_BROWSING_SESSION_MINUTES', 10) * 60;

    for (const network of this.networks) {
      const netKey = network as string;
      const lastBrowse = world.engagement.lastBrowseMs[netKey] ?? 0;
      const session = world.sessions[netKey];

      if (lastBrowse >= fourHoursAgo) continue; // not stale
      if (!session || session.status !== 'ACTIVE') continue; // no active session

      // Dedup key — one browsing session per network per 4h window
      const windowStart = new Date(fourHoursAgo).toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const jobId = `browsing-stale-${netKey}-${windowStart}`;

      try {
        await this.queueFactory.enqueueEngagement(
          jobId,
          netKey,
          'browsing-session',
          {
            network: netKey,
            scheduledAt: new Date().toISOString(),
            durationSec,
            source: 'orchestrator-stale-check',
          },
          { delay: 0 }, // run immediately — it's already stale
        );
        this.logger.debug(
          `Orchestrator: enqueued stale browsing session for ${netKey} (last browse ${Math.round((Date.now() - lastBrowse) / 1000 / 60)}min ago)`,
        );
      } catch (err) {
        // Non-critical — likely a duplicate jobId (already enqueued this window)
        this.logger.debug(
          `Orchestrator: skipping browsing session for ${netKey}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Get the current scheduler status (for monitoring/debugging).
   */
  getStatus(): {
    enabled: boolean;
    sessionsPerDay: number;
    windows: string[];
    networks: string[];
    jitterMinutes: number;
    pendingSessions: number;
  } {
    return {
      enabled: this.enabled,
      sessionsPerDay: this.sessionsPerDay,
      windows: this.sessionWindows,
      networks: this.networks.map((n) => n as string),
      jitterMinutes: this.jitterMinutes,
      pendingSessions: this.scheduledTimeouts.length,
    };
  }
}
