import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import type IORedis from "ioredis";
import {
  TelegramAdapter,
  type TelegramUpdate,
} from "../../infrastructure/telegram/telegram.adapter.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { QueueFactory } from "../../infrastructure/queue/queue.factory.js";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";
import { getEnabledNetworks } from "../../domain/enabled-networks.js";
import { PostEvents, SessionEvents } from "../../events/enums/post-events.enum.js";
import { PostsService } from "../posts/posts.service.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import type { PostFailedEvent, SessionBannedEvent } from "@spa/shared";
import {
  formatPending,
  formatStatus,
  helpText,
  parseCommand,
  parseFlowArg,
  type FlowArg,
} from "./control-bot.commands.js";

const LONG_POLL_TIMEOUT_SEC = 25;

/**
 * TGBOT-101 / CONTROL-001: operator control bot over Telegram long-polling.
 *
 * Transport only (GRASP: information expert stays in the existing services) —
 * every command delegates to the same service the dashboard uses. No inbound
 * HTTP port; the bot token is separate from the notification channel token.
 * Messages from chats outside TELEGRAM_CONTROL_CHAT_IDS are ignored and logged.
 */
@Injectable()
export class ControlBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlBotService.name);
  private readonly allowedChats: Set<string>;
  private running = false;
  private offset = 0;
  private loop: Promise<void> | null = null;
  private readonly failedStreaks = new Map<string, number>();
  private readonly alertedFailedStreaks = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly telegram: TelegramAdapter,
    private readonly postsService: PostsService,
    private readonly flowControl: FlowControlService,
    @Optional() private readonly queueFactory?: QueueFactory,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() @Inject(SHARED_REDIS) private readonly redis?: IORedis,
  ) {
    const raw = this.configService.get<string>("TELEGRAM_CONTROL_CHAT_IDS", "");
    this.allowedChats = new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }

  onModuleInit(): void {
    if (!this.enabled()) return;
    if (this.allowedChats.size === 0) {
      this.logger.warn("Control bot enabled but TELEGRAM_CONTROL_CHAT_IDS empty — not starting");
      return;
    }
    this.running = true;
    this.loop = this.pollLoop().catch((err) => {
      this.running = false;
      this.logger.error(`Control bot poll loop crashed: ${(err as Error).message}`);
    });
    this.logger.log(`Telegram control bot started (${this.allowedChats.size} allowed chat(s))`);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
  }

  enabled(): boolean {
    return (
      this.configService.get<string>("CONTROL_BOT_ENABLED", "false") === "true" &&
      Boolean(this.configService.get<string>("TELEGRAM_CONTROL_BOT_TOKEN", ""))
    );
  }

  /** Whether updates from this chat id may be executed (allowlist). */
  isChatAllowed(chatId: string | number): boolean {
    return this.allowedChats.has(String(chatId));
  }

  // ── Long-poll loop ────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.telegram.getUpdates(this.offset, LONG_POLL_TIMEOUT_SEC);
        if (!res.ok || !res.updates) {
          this.logger.debug(`getUpdates failed: ${res.error} — retrying`);
          await this.sleep(5_000);
          continue;
        }
        for (const update of res.updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (err) {
        this.logger.warn(`Poll iteration error: ${(err as Error).message}`);
        await this.sleep(5_000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text || !msg.chat) return;
    const chatId = String(msg.chat.id);
    if (!this.isChatAllowed(chatId)) {
      this.logger.warn(
        `Ignoring message from non-allowlisted chat ${chatId}${msg.from ? ` (@${msg.from.username ?? msg.from.id})` : ""}`,
      );
      return;
    }
    const reply = await this.execute(msg.text);
    if (reply) {
      await this.telegram.sendMessageToChat(chatId, reply);
    }
  }

  // ── Command router ───────────────────────────────────────────────────────

  /**
   * Execute one command line and return the reply text (null → no reply).
   * Public for tests; every branch mirrors a dashboard code path.
   */
  async execute(text: string): Promise<string | null> {
    const cmd = parseCommand(text);
    if (!cmd) return null;

    switch (cmd.name) {
      case "help":
      case "start":
        return helpText();

      case "status":
        return this.cmdStatus();

      case "pending":
        return this.cmdPending();

      case "approve":
        return this.cmdApprove(cmd.args[0]);

      case "reject":
        return this.cmdReject(cmd.args[0], cmd.args.slice(1).join(" ") || undefined);

      case "pause":
        return this.cmdFlow(cmd.args[0], "pause");

      case "resume":
        return this.cmdFlow(cmd.args[0], "resume");

      default:
        return `Unknown command "/${cmd.name}".\n\n${helpText()}`;
    }
  }

  private async cmdStatus(): Promise<string> {
    const [{ total }, { flows }, queue, orchestrator, todayCostUsd] = await Promise.all([
      this.postsService.findMany({
        status: "DRAFT",
        limit: 1,
        offset: 0,
      } as Parameters<PostsService["findMany"]>[0]),
      this.flowControl.getStatus(),
      this.getQueueSnapshot(),
      this.getOrchestratorSnapshot(),
      this.getTodayCostUsd(),
    ]);
    return formatStatus({
      draftsPending: total ?? 0,
      flows,
      queue,
      orchestrator,
      todayCostUsd,
    });
  }

  private async getQueueSnapshot(): Promise<
    { waiting: number; active: number; delayed: number; failed: number } | undefined
  > {
    if (!this.queueFactory) return undefined;
    try {
      const counts = await Promise.all(
        getEnabledNetworks().map((network) => this.queueFactory!.getJobCounts(network)),
      );
      const snapshot = { waiting: 0, active: 0, delayed: 0, failed: 0 };
      for (const count of counts) {
        snapshot.waiting += Number(count.waiting ?? 0);
        snapshot.active += Number(count.active ?? 0);
        snapshot.delayed += Number(count.delayed ?? 0);
        snapshot.failed += Number(count.failed ?? 0);
      }
      return snapshot;
    } catch (err) {
      this.logger.warn(`Control bot queue status unavailable: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async getOrchestratorSnapshot(): Promise<
    | {
        enabled: boolean;
        running: boolean | null;
        cycle: number | null;
        heartbeatAgeMs: number | null;
      }
    | undefined
  > {
    const enabled = this.configService.get<string>("ORCHESTRATOR_ENABLED", "false") === "true";
    if (!enabled) return { enabled: false, running: false, cycle: null, heartbeatAgeMs: null };
    if (!this.redis) return { enabled: true, running: null, cycle: null, heartbeatAgeMs: null };

    const heartbeatKey = this.configService.get<string>(
      "ORCHESTRATOR_HEARTBEAT_KEY",
      "spa:orchestrator:heartbeat",
    );
    const heartbeatTtlMs = Number(
      this.configService.get<string>("ORCHESTRATOR_HEARTBEAT_TTL_MS", "1800000"),
    );
    try {
      const rawHeartbeat = await this.redis.get(heartbeatKey);
      const heartbeat = rawHeartbeat ? Number(rawHeartbeat) : NaN;
      const heartbeatAgeMs = Number.isFinite(heartbeat) ? Date.now() - heartbeat : null;
      return {
        enabled: true,
        running:
          heartbeatAgeMs !== null &&
          Number.isFinite(heartbeatTtlMs) &&
          heartbeatAgeMs <= heartbeatTtlMs,
        cycle: null,
        heartbeatAgeMs,
      };
    } catch (err) {
      this.logger.warn(`Control bot orchestrator status unavailable: ${(err as Error).message}`);
      return { enabled: true, running: null, cycle: null, heartbeatAgeMs: null };
    }
  }

  private async getTodayCostUsd(): Promise<number | undefined> {
    if (!this.prisma) return undefined;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    try {
      const aggregate = await this.prisma.llmUsageEvent.aggregate({
        where: { createdAt: { gte: startOfDay } },
        _sum: { costUsd: true },
      });
      return Number(aggregate._sum.costUsd ?? 0);
    } catch (err) {
      this.logger.warn(`Control bot cost status unavailable: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async cmdPending(): Promise<string> {
    const limit = 10;
    const { posts } = await this.postsService.findMany({
      status: "DRAFT",
      limit,
      offset: 0,
    } as Parameters<PostsService["findMany"]>[0]);
    return formatPending(
      posts.map((p) => ({ id: p.id, network: String(p.network), content: p.content })),
    );
  }

  private async cmdApprove(id: string | undefined): Promise<string> {
    if (!id) return "Usage: /approve <postId>";
    try {
      await this.postsService.approve(id, undefined, undefined, "telegram-control-bot");
      return `✅ Approved \`${id}\``;
    } catch (err) {
      return `⚠️ Approve failed: ${(err as Error).message}`;
    }
  }

  private async cmdReject(id: string | undefined, reason?: string): Promise<string> {
    if (!id) return "Usage: /reject <postId> [reason]";
    try {
      await this.postsService.reject(
        id,
        reason ? { comment: reason } : undefined,
        "telegram-control-bot",
      );
      return `⛔️ Rejected \`${id}\`${reason ? ` — ${reason}` : ""}`;
    } catch (err) {
      return `⚠️ Reject failed: ${(err as Error).message}`;
    }
  }

  private async cmdFlow(arg: string | undefined, action: "pause" | "resume"): Promise<string> {
    const flow = parseFlowArg(arg);
    if (!flow) {
      return `Usage: /${action} <posting|generation|engagement|replies|all>`;
    }
    try {
      if (flow === "all") {
        if (action === "pause") await this.flowControl.pauseAll("control-bot");
        else await this.flowControl.resumeAll();
      } else if (action === "pause") {
        await this.flowControl.pause(flow as Exclude<FlowArg, "all">, "control-bot");
      } else {
        await this.flowControl.resume(flow as Exclude<FlowArg, "all">);
      }
      return `${action === "pause" ? "⏸ Paused" : "▶ Resumed"}: ${flow}`;
    } catch (err) {
      return `⚠️ ${action} failed: ${(err as Error).message}`;
    }
  }

  // ── Push alerts (same triggers as the Discord notifier) ─────────────────

  /** Push failed-post alerts to all allowlisted chats. */
  async pushAlert(text: string): Promise<void> {
    for (const chatId of this.allowedChats) {
      await this.telegram
        .sendMessageToChat(chatId, `🚨 ${text}`)
        .catch((err) =>
          this.logger.warn(`Alert delivery to ${chatId} failed: ${(err as Error).message}`),
        );
    }
  }

  @OnEvent(PostEvents.FAILED)
  onPostFailed(payload: PostFailedEvent): void {
    if (!this.enabled()) return;
    const network = payload.network || "unknown";
    const streak = (this.failedStreaks.get(network) ?? 0) + 1;
    this.failedStreaks.set(network, streak);
    void this.pushAlert(
      `Post failed [${payload.network}] \`${payload.postId}\`: ${payload.error ?? "unknown"}` +
        (payload.retryable ? " (will retry)" : ""),
    );
    if (streak >= 3 && !this.alertedFailedStreaks.has(network)) {
      this.alertedFailedStreaks.add(network);
      void this.pushAlert(`Failed-post streak on ${network}: ${streak} consecutive failures.`);
    }
  }

  @OnEvent(PostEvents.POSTED)
  onPostRecovered(payload: { network: string }): void {
    this.failedStreaks.delete(payload.network);
    this.alertedFailedStreaks.delete(payload.network);
  }

  @OnEvent(SessionEvents.SESSION_BANNED)
  onSessionBanned(payload: SessionBannedEvent): void {
    if (!this.enabled()) return;
    void this.pushAlert(
      `Session banned [${payload.network}]${payload.accountId ? ` account ${payload.accountId}` : ""}: ${payload.reason ?? "manual intervention needed"}`,
    );
  }

  @OnEvent("queue.dlq_entered")
  onDlqEntered(payload: {
    jobId?: string;
    queue?: string;
    attempts?: number;
    maxAttempts?: number;
    error?: string;
  }): void {
    if (!this.enabled()) return;
    void this.pushAlert(
      `Job entered DLQ${payload.queue ? ` [${payload.queue}]` : ""}: ${payload.jobId ?? "unknown"} ` +
        `(${payload.attempts ?? "?"}/${payload.maxAttempts ?? "?"} attempts) — ${payload.error ?? "manual intervention needed"}`,
    );
  }

  @OnEvent("circuit.open")
  onCircuitOpen(payload: { name?: string; message?: string }): void {
    if (!this.enabled()) return;
    void this.pushAlert(
      `Circuit opened${payload.name ? ` [${payload.name}]` : ""}: ${payload.message ?? "manual intervention needed"}`,
    );
  }
}
