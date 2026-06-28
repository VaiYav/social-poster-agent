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
import { ConfigService } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import { QueueFactory } from '../../infrastructure/queue/queue.factory.js';
import { parseBool } from '../../infrastructure/config/parse-bool';

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
  ) {
    this.enabled = parseBool(this.configService.get<string>('ENGAGEMENT_SCHEDULER_ENABLED', 'false'));
    this.sessionsPerDay = Number(this.configService.get<string>('ENGAGEMENT_SESSIONS_PER_DAY', '3'));
    this.sessionWindows = this.parseWindows(
      this.configService.get<string>('ENGAGEMENT_SESSION_WINDOWS', '09:00,13:00,18:00'),
    );
    this.jitterMinutes = Number(this.configService.get<string>('ENGAGEMENT_JITTER_MINUTES', '30'));
    this.networks = this.parseNetworks(
      this.configService.get<string>('ENGAGEMENT_NETWORKS', 'X,THREADS,FACEBOOK'),
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

    this.scheduleDailySessions();
    this.logger.log(
      `Engagement scheduler started: ${this.sessionsPerDay} sessions/day across ${this.networks.length} networks (via BullMQ)`,
    );
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
   */
  scheduleDailySessions(): void {
    const today = new Date();

    for (const network of this.networks) {
      const windows = this.pickWindowsForToday();

      for (const windowTime of windows) {
        const scheduledTime = this.applyJitter(windowTime, today);
        const delayMs = scheduledTime.getTime() - Date.now();

        // Only schedule if the time hasn't passed yet
        if (delayMs <= 0) {
          this.logger.debug(`Skipping past session for ${network} at ${scheduledTime.toISOString()}`);
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
    base.setHours(hours ?? 9, minutes ?? 0, 0, 0);

    // Apply jitter: -jitterMinutes to +jitterMinutes
    const jitterMs = (Math.random() * 2 - 1) * this.jitterMinutes * 60 * 1000;
    return new Date(base.getTime() + jitterMs);
  }

  private parseWindows(value: string): string[] {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  private parseNetworks(value: string): SocialNetwork[] {
    return value
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s === 'X' || s === 'THREADS' || s === 'FACEBOOK')
      .map((s) => SocialNetwork[s as keyof typeof SocialNetwork]);
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
