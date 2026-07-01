/**
 * Watchdog — safety net cron that monitors the orchestrator heartbeat.
 *
 * Runs every 5 minutes. If the orchestrator heartbeat is stale (> 10 min),
 * it attempts to restart the orchestrator and sends a Discord alert.
 *
 * This is the ONLY @Cron that remains permanently — it ensures the
 * orchestrator (which replaces all other crons) is always alive.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Inject, Optional } from '@nestjs/common';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { DiscordNotificationService } from '../../infrastructure/notifications/discord-notification.service.js';
import { OrchestratorService } from './orchestrator.service.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';

@Injectable()
export class WatchdogCron implements OnModuleInit {
  private readonly logger = new Logger(WatchdogCron.name);
  private readonly heartbeatKey: string;
  private readonly heartbeatTtlMs: number;
  private readonly enabled: boolean;

  constructor(
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    @Optional() private readonly discord: DiscordNotificationService,
    @Optional() private readonly orchestratorService: OrchestratorService,
  ) {
    this.heartbeatKey = process.env.ORCHESTRATOR_HEARTBEAT_KEY ?? 'spa:orchestrator:heartbeat';
    this.heartbeatTtlMs = Number(process.env.ORCHESTRATOR_HEARTBEAT_TTL_MS ?? '600000');
    this.enabled = parseBool(process.env.ORCHESTRATOR_ENABLED ?? 'false');
  }

  onModuleInit() {
    if (this.enabled) {
      this.logger.log('Watchdog enabled — monitoring orchestrator heartbeat every 5 min');
    }
  }

  /**
   * Check orchestrator heartbeat every 5 minutes.
   * If stale → restart orchestrator + Discord alert.
   */
  @Cron('*/5 * * * *')
  async checkHeartbeat() {
    if (!this.enabled) return;

    try {
      const heartbeat = await this.redis.get(this.heartbeatKey);
      if (!heartbeat) {
        await this.handleStaleHeartbeat(null);
        return;
      }

      const heartbeatAge = Date.now() - Number(heartbeat);
      if (heartbeatAge > this.heartbeatTtlMs) {
        await this.handleStaleHeartbeat(heartbeatAge);
      } else {
        this.logger.debug(`Orchestrator heartbeat OK (${Math.round(heartbeatAge / 1000)}s old)`);
      }
    } catch (err) {
      this.logger.warn(`Watchdog heartbeat check failed: ${(err as Error).message}`);
    }
  }

  private async handleStaleHeartbeat(ageMs: number | null): Promise<void> {
    const ageStr = ageMs ? `${Math.round(ageMs / 1000)}s` : 'missing';
    this.logger.warn(`Orchestrator heartbeat stale (${ageStr}) — attempting restart`);

    // Attempt restart
    if (this.orchestratorService) {
      try {
        await this.orchestratorService.stop();
        await new Promise((r) => setTimeout(r, 5000)); // graceful shutdown window
        await this.orchestratorService.start();
        this.logger.log('Orchestrator restarted by watchdog');
      } catch (err) {
        this.logger.error(`Watchdog restart failed: ${(err as Error).message}`);
      }
    }

    // Discord alert
    if (this.discord) {
      void this.discord
        .warning(
          'Orchestrator Restarted by Watchdog',
          `The orchestrator heartbeat was stale (${ageStr}). The watchdog attempted a restart.\n` +
            `If this recurs, investigate the orchestrator logs for hangs or crashes.`,
        )
        .catch(() => void 0);
    }
  }
}
