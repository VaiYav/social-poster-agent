import { describe, it, expect, vi, beforeEach } from "vitest";
import { ControlBotService } from "../../../../src/modules/control-bot/control-bot.service.js";
import {
  formatPending,
  formatStatus,
  helpText,
  parseCommand,
  parseFlowArg,
} from "../../../../src/modules/control-bot/control-bot.commands.js";

// ── Pure command helpers ─────────────────────────────────────────────────────

describe("control-bot commands (pure helpers)", () => {
  it("parses /command with args", () => {
    expect(parseCommand("/approve post-1 typo")).toEqual({
      name: "approve",
      args: ["post-1", "typo"],
    });
  });

  it("strips bot username from /cmd@bot", () => {
    expect(parseCommand("/status@spa_admin_bot")).toEqual({ name: "status", args: [] });
  });

  it("returns null for non-commands and empty text", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });

  it("parseFlowArg accepts known flows + all", () => {
    expect(parseFlowArg("posting")).toBe("posting");
    expect(parseFlowArg("ALL")).toBe("all");
    expect(parseFlowArg("banana")).toBeNull();
    expect(parseFlowArg(undefined)).toBeNull();
  });

  it("formatPending truncates long hooks", () => {
    const out = formatPending([{ id: "p1", network: "X", content: "x".repeat(120) }]);
    expect(out).toContain("`p1`");
    expect(out).toContain("…");
  });

  it("formatStatus marks paused flows", () => {
    const out = formatStatus({ draftsPending: 4, flows: { posting: true } });
    expect(out).toContain("drafts pending review: 4");
    expect(out).toContain("PAUSED");
  });

  it("helpText lists all commands", () => {
    expect(helpText()).toContain("/approve <postId>");
  });
});

// ── Service router ───────────────────────────────────────────────────────────

function buildService(overrides: Record<string, unknown> = {}) {
  const config = { get: vi.fn() };
  config.get.mockImplementation((key: string, def?: unknown) => {
    if (key === "TELEGRAM_CONTROL_CHAT_IDS") return "111,222";
    if (overrides[key] !== undefined) return overrides[key];
    return def;
  });
  const telegram = { sendMessageToChat: vi.fn().mockResolvedValue({ success: true }) };
  const postsService = {
    findMany: vi
      .fn()
      .mockResolvedValue({ posts: [], total: 2, hasMore: false }),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
  };
  const flowControl = {
    getStatus: vi
      .fn()
      .mockResolvedValue({ pauseAll: false, flows: { posting: false, generation: true } }),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    pauseAll: vi.fn().mockResolvedValue(undefined),
    resumeAll: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ControlBotService(
    config as never,
    telegram as never,
    postsService as never,
    flowControl as never,
  );
  return { service, config, telegram, postsService, flowControl };
}

describe("ControlBotService", () => {
  let ctx: ReturnType<typeof buildService>;
  beforeEach(() => {
    vi.clearAllMocks();
    ctx = buildService();
  });

  it("allowlists chats exactly", () => {
    expect(ctx.service.isChatAllowed("111")).toBe(true);
    expect(ctx.service.isChatAllowed(222)).toBe(true);
    expect(ctx.service.isChatAllowed("999")).toBe(false);
  });

  it("disabled by default without env", () => {
    expect(ctx.service.enabled()).toBe(false);
  });

  it("enabled with flag+token", () => {
    const enabled = buildService({
      CONTROL_BOT_ENABLED: "true",
      TELEGRAM_CONTROL_BOT_TOKEN: "tok",
    });
    expect(enabled.service.enabled()).toBe(true);
  });

  it("execute(/help) returns help text", async () => {
    expect(await ctx.service.execute("/help")).toBe(helpText());
  });

  it("unknown command returns hint", async () => {
    const reply = await ctx.service.execute("/banana");
    expect(reply).toContain('Unknown command "/banana"');
  });

  it("execute(/status) aggregates drafts total + flow state", async () => {
    const reply = await ctx.service.execute("/status");
    expect(ctx.postsService.findMany).toHaveBeenCalled();
    expect(reply).toContain("drafts pending review: 2");
    expect(reply).toContain("generation: PAUSED");
    expect(reply).toContain("posting: running");
  });

  it("execute(/status) includes queue, orchestrator and daily cost snapshots", async () => {
    const config = {
      get: vi.fn((key: string, def?: unknown) => {
        const values: Record<string, unknown> = {
          TELEGRAM_CONTROL_CHAT_IDS: "111",
          ORCHESTRATOR_ENABLED: "true",
          ORCHESTRATOR_HEARTBEAT_KEY: "heartbeat",
          ORCHESTRATOR_HEARTBEAT_TTL_MS: "1800000",
        };
        return key in values ? values[key] : def;
      }),
    };
    const telegram = { sendMessageToChat: vi.fn().mockResolvedValue({ success: true }) };
    const postsService = {
      findMany: vi.fn().mockResolvedValue({ posts: [], total: 2, hasMore: false }),
      approve: vi.fn(),
      reject: vi.fn(),
    };
    const flowControl = {
      getStatus: vi.fn().mockResolvedValue({
        pauseAll: false,
        flows: { posting: false, generation: true },
      }),
    };
    const queueFactory = {
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 2, active: 1, delayed: 3, failed: 4 }),
    };
    const prisma = {
      llmUsageEvent: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0.123456 } }),
      },
    };
    const redis = { get: vi.fn().mockResolvedValue(String(Date.now())) };
    const service = new ControlBotService(
      config as never,
      telegram as never,
      postsService as never,
      flowControl as never,
      queueFactory as never,
      prisma as never,
      redis as never,
    );

    const reply = await service.execute("/status");

    expect(reply).toContain("orchestrator: RUNNING");
    expect(reply).toContain("queue: 6 waiting, 3 active, 9 delayed, 12 failed");
    expect(reply).toContain("today's LLM cost: $0.123456");
  });

  it("execute(/pending) formats drafts", async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [{ id: "p9", network: "THREADS", content: "Hook line" }],
      total: 1,
      hasMore: false,
    });
    const reply = await ctx.service.execute("/pending");
    expect(reply).toContain("`p9` [THREADS] Hook line");
  });

  it("execute(/approve) delegates to PostsService with bot actor", async () => {
    const reply = await ctx.service.execute("/approve post-7");
    expect(ctx.postsService.approve).toHaveBeenCalledWith(
      "post-7",
      undefined,
      undefined,
      "telegram-control-bot",
    );
    expect(reply).toContain("Approved `post-7`");
  });

  it("execute(/reject) passes reason", async () => {
    await ctx.service.execute("/reject post-8 too spammy");
    expect(ctx.postsService.reject).toHaveBeenCalledWith(
      "post-8",
      { comment: "too spammy" },
      "telegram-control-bot",
    );
  });

  it("execute(/pause posting) delegates to FlowControl", async () => {
    const reply = await ctx.service.execute("/pause posting");
    expect(ctx.flowControl.pause).toHaveBeenCalledWith("posting", "control-bot");
    expect(reply).toContain("Paused: posting");
  });

  it("execute(/resume all) delegates to resumeAll", async () => {
    await ctx.service.execute("/resume all");
    expect(ctx.flowControl.resumeAll).toHaveBeenCalled();
  });

  it("invalid flow arg returns usage", async () => {
    const reply = await ctx.service.execute("/pause banana");
    expect(reply).toContain("Usage:");
  });

  it("handleUpdate ignores non-allowlisted chat without executing", async () => {
    await ctx.service.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 999, type: "private" }, text: "/approve x" },
    });
    expect(ctx.postsService.approve).not.toHaveBeenCalled();
    expect(ctx.telegram.sendMessageToChat).not.toHaveBeenCalled();
  });

  it("handleUpdate executes allowlisted command and replies in-chat", async () => {
    await ctx.service.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: 111, type: "private" }, text: "/help" },
    });
    expect(ctx.telegram.sendMessageToChat).toHaveBeenCalledWith("111", expect.any(String));
  });

  it("pushes a failed-post streak alert after three failures and resets after recovery", async () => {
    const enabled = buildService({
      CONTROL_BOT_ENABLED: "true",
      TELEGRAM_CONTROL_BOT_TOKEN: "token",
    });

    enabled.service.onPostFailed({ postId: "p1", network: "X", error: "one" });
    enabled.service.onPostFailed({ postId: "p2", network: "X", error: "two" });
    enabled.service.onPostFailed({ postId: "p3", network: "X", error: "three" });
    await new Promise(resolve => setTimeout(resolve, 0));

    const messages = enabled.telegram.sendMessageToChat.mock.calls.map(call => String(call[1]));
    expect(messages.filter(message => message.includes("Failed-post streak")).length).toBe(2);

    enabled.telegram.sendMessageToChat.mockClear();
    enabled.service.onPostRecovered({ network: "X" });
    enabled.service.onPostFailed({ postId: "p4", network: "X", error: "after recovery" });
    enabled.service.onPostFailed({ postId: "p5", network: "X", error: "after recovery" });
    enabled.service.onPostFailed({ postId: "p6", network: "X", error: "after recovery" });
    await new Promise(resolve => setTimeout(resolve, 0));

    const nextMessages = enabled.telegram.sendMessageToChat.mock.calls.map(call => String(call[1]));
    expect(nextMessages.filter(message => message.includes("Failed-post streak")).length).toBe(2);
  });

  it("routes ban, DLQ and circuit-open events to the allowlisted chats", async () => {
    const enabled = buildService({
      CONTROL_BOT_ENABLED: "true",
      TELEGRAM_CONTROL_BOT_TOKEN: "token",
    });

    enabled.service.onSessionBanned({ accountId: "acc-1", network: "X", reason: "challenge" });
    enabled.service.onDlqEntered({
      jobId: "job-1",
      queue: "spa-posting-x",
      attempts: 8,
      maxAttempts: 8,
      error: "provider down",
    });
    enabled.service.onCircuitOpen({ name: "posting:X", message: "cooldown" });
    await Promise.resolve();

    const messages = enabled.telegram.sendMessageToChat.mock.calls.map(call => String(call[1]));
    expect(messages.some(message => message.includes("Session banned"))).toBe(true);
    expect(messages.some(message => message.includes("entered DLQ"))).toBe(true);
    expect(messages.some(message => message.includes("Circuit opened"))).toBe(true);
  });
});
