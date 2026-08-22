/**
 * Watchdog — safety net cron that monitors the orchestrator heartbeat.
 *
 * Runs every 5 minutes. If the orchestrator heartbeat is stale (> 10 min),
 * it attempts to restart the orchestrator and sends a Discord alert.
 *
 * This is the ONLY @Cron that remains permanently — it ensures the
 * orchestrator (which replaces all other crons) is always alive.
 */

import { Injectable, Logger, OnModuleInit, Inject, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";
import { DiscordNotificationService } from "../../infrastructure/notifications/discord-notification.service.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { parseBool } from "../../infrastructure/config/parse-bool.js";

const HEARTBEAT_KEY_DEFAULT = "spa:orchestrator:heartbeat";
const HEARTBEAT_TTL_MS_DEFAULT = 1_800_000;

@Injectable()
export class WatchdogCron implements OnModuleInit {
  private readonly logger = new Logger(WatchdogCron.name);
  private readonly heartbeatKey: string;
  private readonly heartbeatTtlMs: number;
  private readonly restartDelayMs: number;
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import("ioredis").default>,
    @Optional() private readonly discord: DiscordNotificationService,
    @Optional() private readonly orchestratorService: OrchestratorService,
  ) {
    this.heartbeatKey =
      this.configService.get<string>("ORCHESTRATOR_HEARTBEAT_KEY") ?? HEARTBEAT_KEY_DEFAULT;
    this.heartbeatTtlMs = Number(
      this.configService.get<string>("ORCHESTRATOR_HEARTBEAT_TTL_MS") ?? HEARTBEAT_TTL_MS_DEFAULT,
    );
    this.restartDelayMs = Number(
      this.configService.get<string>("ORCHESTRATOR_WATCHDOG_RESTART_DELAY_MS") ?? "5000",
    );
    this.enabled = parseBool(this.configService.get<string>("ORCHESTRATOR_ENABLED") ?? "false");
  }

  onModuleInit() {
    if (this.enabled) {
      this.logger.log("Watchdog enabled — monitoring orchestrator heartbeat every 5 min");
    }
  }

  /**
   * Check orchestrator heartbeat every 5 minutes.
   * If stale → restart orchestrator + Discord alert.
   */
  @Cron("*/5 * * * *")
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
    const ageStr = ageMs ? `${Math.round(ageMs / 1000)}s` : "missing";
    this.logger.warn(`Orchestrator heartbeat stale (${ageStr}) — attempting restart`);

    // Attempt restart (OrchestratorService has its own lifecycle mutex)
    if (this.orchestratorService) {
      try {
        await this.orchestratorService.stop();
        await new Promise((r) => setTimeout(r, this.restartDelayMs)); // graceful shutdown window
        await this.orchestratorService.start();
        this.logger.log("Orchestrator restarted by watchdog");
      } catch (err) {
        this.logger.error(`Watchdog restart failed: ${(err as Error).message}`);
      }
    }

    // Discord alert
    if (this.discord) {
      void this.discord
        .warning(
          "Orchestrator Restarted by Watchdog",
          `The orchestrator heartbeat was stale (${ageStr}). The watchdog attempted a restart.\n` +
            `If this recurs, investigate the orchestrator logs for hangs or crashes.`,
        )
        .catch(() => void 0);
    }
  }
}
