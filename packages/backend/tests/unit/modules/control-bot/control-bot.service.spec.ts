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
});
