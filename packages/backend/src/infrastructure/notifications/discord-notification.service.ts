/**
 * Discord Notification Service — sends alerts to a Discord channel via webhook.
 *
 * Used for:
 * - DLQ alerts (jobs that exhausted all retries)
 * - Critical health alerts (BANNED accounts, expired sessions)
 * - Captcha detection during auto-login
 * - Generation failures
 *
 * Config:
 *   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 *   DISCORD_ALERTS_ENABLED=true/false (default: false)
 *
 * If webhook URL is not set or alerts disabled, all calls are no-ops (graceful degradation).
 */
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CircuitBreaker, CircuitOpenError } from "../../domain/circuit-breaker.js";

export type AlertSeverity = "info" | "warning" | "critical";

export interface DiscordAlert {
  severity: AlertSeverity;
  title: string;
  message: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
}

const SEVERITY_COLORS: Record<AlertSeverity, number> = {
  info: 0x3498db, // blue
  warning: 0xf39c12, // orange
  critical: 0xe74c3c, // red
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

const DISCORD_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
} as const;

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

function truncate(str: string, limit: number): string {
  if (str.length <= limit) return str;
  return `${str.slice(0, limit - 1)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class DiscordNotificationService implements OnModuleInit {
  private readonly logger = new Logger(DiscordNotificationService.name);
  private readonly webhookUrl: string | null;
  private readonly enabled: boolean;
  private readonly circuitBreaker = new CircuitBreaker("discord-webhook", {
    failureThreshold: 3,
    resetTimeoutMs: 5 * 60 * 1000, // 5 minutes
  });

  constructor(private readonly configService: ConfigService) {
    const rawUrl = this.configService.get<string>("DISCORD_WEBHOOK_URL");
    // Treat empty string, whitespace-only, and undefined as "not configured"
    this.webhookUrl = rawUrl && rawUrl.trim().length > 0 ? rawUrl.trim() : null;
    this.enabled = this.configService.get<string>("DISCORD_ALERTS_ENABLED", "false") === "true";
  }

  onModuleInit(): void {
    if (this.enabled && this.webhookUrl) {
      this.logger.log("Discord alerts enabled — webhook configured");
    } else if (this.enabled && !this.webhookUrl) {
      this.logger.warn(
        "DISCORD_ALERTS_ENABLED=true but DISCORD_WEBHOOK_URL not set — alerts will be no-ops",
      );
    }
  }

  /**
   * Send an alert to Discord. Non-blocking — errors are logged but never thrown.
   *
   * Retries transient failures up to 3 attempts with exponential backoff and
   * uses a circuit breaker to stop sending after 3 consecutive failures.
   */
  async sendAlert(alert: DiscordAlert): Promise<void> {
    if (!this.enabled || !this.webhookUrl) return;

    try {
      await this.circuitBreaker.execute(async () => {
        const payload = {
          embeds: [
            {
              title: truncate(
                `${SEVERITY_EMOJI[alert.severity]} ${alert.title}`,
                DISCORD_LIMITS.title,
              ),
              description: truncate(alert.message, DISCORD_LIMITS.description),
              color: SEVERITY_COLORS[alert.severity],
              fields: alert.fields?.map((field) => ({
                name: truncate(field.name, DISCORD_LIMITS.fieldName),
                value: truncate(field.value, DISCORD_LIMITS.fieldValue),
                inline: field.inline,
              })),
              footer: alert.footer
                ? { text: truncate(alert.footer, DISCORD_LIMITS.footerText) }
                : undefined,
              timestamp: new Date().toISOString(),
            },
          ],
        };

        let lastError: Error | undefined;
        for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(this.webhookUrl!, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.ok) return response;

            const body = await response.text().catch(() => "unknown");
            lastError = new Error(`Discord webhook returned ${response.status}: ${body}`);
          } catch (err) {
            lastError = err as Error;
          }

          if (attempt < RETRY_ATTEMPTS - 1) {
            const backoff = RETRY_BASE_MS * 2 ** attempt;
            this.logger.warn(
              `Discord alert attempt ${attempt + 1} failed, retrying in ${backoff}ms: ${lastError.message}`,
            );
            await sleep(backoff);
          }
        }

        throw lastError ?? new Error("Discord webhook failed after all retries");
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        this.logger.warn(`Discord alert skipped: ${err.message}`);
        return;
      }
      this.logger.warn(`Failed to send Discord alert: ${(err as Error).message}`);
    }
  }

  /**
   * Convenience: send a critical alert.
   */
  async critical(
    title: string,
    message: string,
    fields?: { name: string; value: string; inline?: boolean }[],
  ): Promise<void> {
    await this.sendAlert({ severity: "critical", title, message, fields });
  }

  /**
   * Convenience: send a warning alert.
   */
  async warning(
    title: string,
    message: string,
    fields?: { name: string; value: string; inline?: boolean }[],
  ): Promise<void> {
    await this.sendAlert({ severity: "warning", title, message, fields });
  }

  /**
   * Convenience: send an info alert.
   */
  async info(
    title: string,
    message: string,
    fields?: { name: string; value: string; inline?: boolean }[],
  ): Promise<void> {
    await this.sendAlert({ severity: "info", title, message, fields });
  }

  isEnabled(): boolean {
    return this.enabled && !!this.webhookUrl;
  }
}
