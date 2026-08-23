import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import { TelegramAdapter, type TelegramUpdate } from "../../infrastructure/telegram/telegram.adapter.js";
import { PostsService } from "../posts/posts.service.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import type { PostFailedEvent } from "@spa/shared";
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

  constructor(
    private readonly configService: ConfigService,
    private readonly telegram: TelegramAdapter,
    private readonly postsService: PostsService,
    private readonly flowControl: FlowControlService,
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
    const { total } = await this.postsService.findMany({
      status: "DRAFT",
      limit: 1,
      offset: 0,
    } as Parameters<PostsService["findMany"]>[0]);
    const { flows } = await this.flowControl.getStatus();
    return formatStatus({
      draftsPending: total ?? 0,
      flows,
    });
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

  @OnEvent("post.failed")
  onPostFailed(payload: PostFailedEvent): void {
    if (!this.enabled()) return;
    void this.pushAlert(
      `Post failed [${payload.network}] \`${payload.postId}\`: ${payload.error ?? "unknown"}` +
        (payload.retryable ? " (will retry)" : ""),
    );
  }
}
