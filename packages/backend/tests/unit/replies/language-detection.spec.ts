/**
 * Replies monitor service unit tests.
 *
 * After RP5: ALL reply content is LLM-generated — no template fallback.
 * These tests cover the deterministic pre-LLM checks (troll, self-reply,
 * sensitive topic, max replies) that run before the LLM is called.
 *
 * Source: packages/backend/src/modules/replies/replies-monitor.service.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { RepliesMonitorService } from "../../../src/modules/replies/replies-monitor.service";
import { ToneAnalyzerService } from "../../../src/modules/replies/tone-analyzer.service";
import { DialogueService } from "../../../src/modules/replies/dialogue.service";
import { createMockPrismaService } from "../../mocks/index.js";

// ── Mock dependencies ──

function createMockConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string, def?: unknown) => {
      if (key in values) return values[key];
      return def;
    }),
  } as unknown as ConfigService;
}

function createMockSchedulerRegistry() {
  return {
    addCronJob: vi.fn(),
    deleteCronJob: vi.fn(),
    getCronJobs: vi.fn().mockReturnValue(new Map()),
  };
}

function createMockDiscord() {
  return {
    notifyCritical: vi.fn().mockResolvedValue(undefined),
    notifyWarning: vi.fn().mockResolvedValue(undefined),
    notifyInfo: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSseService() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAccountsService(handle?: string) {
  return {
    findByNetwork: vi.fn().mockResolvedValue(handle ? [{ handle }] : []),
    findFirstActiveByNetwork: vi.fn().mockResolvedValue(handle ? { handle } : null),
    getAccount: vi.fn().mockResolvedValue(null),
  };
}

function createMockSessionsService() {
  return {
    getSession: vi.fn().mockResolvedValue(null),
  };
}

// ── RepliesMonitorService — deterministic pre-LLM checks ──

describe("RepliesMonitorService — Pre-LLM Decision Logic", () => {
  let service: RepliesMonitorService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;
  let prisma: any;

  beforeEach(() => {
    prisma = createMockPrismaService();
    // Add incomingComment model mock (not in the default mock factory)
    prisma.incomingComment = {
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    };

    service = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: "true" }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      undefined, // llmService — not wired, tests pre-LLM logic
      undefined, // browser
      undefined, // engagementService
    );
    svc = service;
  });

  // ── Troll/spam detection ──

  it("PRE-001: skips troll/spam comments", async () => {
    const result = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "This is spam, buy my product" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("troll");
  });

  it('PRE-002: does NOT flag innocent words containing "bot" (about)', async () => {
    const result = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Tell me about this post" },
    );
    // "about" contains "bot" but should not be flagged as troll.
    // Without LLM wired, action will be 'skip' (LLM not available) — but the
    // reason should NOT mention troll/spam.
    expect(result.reason).not.toContain("troll");
    expect(result.reason).not.toContain("spam");
  });

  // ── Self-reply detection ──

  it("PRE-003: skips self-reply when comment author matches account handle", async () => {
    const svcWithHandle = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: "true" }),
      createMockAccountsService("exampleco") as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      undefined,
      undefined,
      undefined,
    );
    const result = await (svcWithHandle as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "@exampleco", text: "Great post" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Self-reply");
  });

  // ── Max replies per post ──

  it("PRE-004: skips when max replies per post is reached", async () => {
    prisma.incomingComment.count = vi.fn().mockResolvedValue(3); // maxRepliesPerPost=3
    const result = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Great post about productivity" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Max replies");
  });

  // ── Sensitive topic detection (runs BEFORE LLM) ──

  it("PRE-005: flags depression mentions for human review", async () => {
    const result = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "I feel depressed and anxious about this" },
    );
    expect(result.action).toBe("human_review");
  });

  it("PRE-006: flags crisis mentions for human review", async () => {
    const result = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "I am having a crisis because of this" },
    );
    expect(result.action).toBe("human_review");
  });

  it("PRE-007: flags complaints for human review", async () => {
    const result = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "This is wrong, you are misleading" },
    );
    expect(result.action).toBe("human_review");
  });

  it("PRE-008: does NOT flag innocent words containing crisis roots", async () => {
    const result1 = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "I love this product, great job" },
    );
    expect(result1.action).not.toBe("human_review");

    const result2 = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "This is a big milestone, hard to reach" },
    );
    expect(result2.action).not.toBe("human_review");
  });

  // ── LLM-only behavior ──

  it('PRE-010: skips with "LLM not available" when llmService is not wired', async () => {
    const result = await svc.decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Great post about productivity" },
    );
    // No LLM service → skip (no template fallback)
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("LLM");
  });

  it("PRE-011: calls LLM when service is wired", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","replyText":"Thanks! ✨"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Love this post!" },
    );
    expect(result.action).toBe("auto_reply");
    expect(result.replyText).toContain("Thanks");
    expect(mockLlm.generateChat).toHaveBeenCalledOnce();
  });

  it("PRE-012: skips when LLM throws (all providers failed)", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockRejectedValue(new Error("All LLM providers failed")),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Love this post!" },
    );
    // LLM failed → skip (no template fallback, will retry next cycle)
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("LLM reply decision failed");
  });

  it("PRE-013: skips when LLM returns no JSON", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: "Sorry, I cannot help with that.",
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Love this post!" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("no valid JSON");
  });

  it("PRE-014: defaults to human_review when LLM returns invalid action", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"maybe","reason":"unsure"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Love this post!" },
    );
    expect(result.action).toBe("human_review");
  });

  it("PRE-015: defaults to human_review when auto_reply has no replyText", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Love this post!" },
    );
    expect(result.action).toBe("human_review");
  });

  // ── Config ──

  it("PRE-016: isEnabled returns true when REPLIES_ENABLED=true", () => {
    expect(service.isEnabled()).toBe(true);
  });

  it("PRE-017: isEnabled returns false when REPLIES_ENABLED=false", () => {
    const disabled = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: "false" }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      undefined,
      undefined,
      undefined,
    );
    expect(disabled.isEnabled()).toBe(false);
  });

  // ── Language matching (post-validation) ──
  // The LLM must always reply in English, regardless of the original comment language.
  // We post-validate: any non-English reply is downgraded to human_review.

  function createMockQuestionClassifier() {
    return {
      classify: vi.fn().mockResolvedValue({
        isQuestion: false,
        confidence: 0,
        questionType: null,
        reason: "test",
      }),
    };
  }

  function createServiceWithLlm(mockLlm: any) {
    const config = createMockConfigService({ REPLIES_ENABLED: "true" });
    const questionClassifier = createMockQuestionClassifier();
    const toneAnalyzer = new ToneAnalyzerService();
    const dialogueService = new DialogueService(
      mockLlm as any,
      questionClassifier as any,
      toneAnalyzer,
      prisma as any,
      config as any,
    );
    return new RepliesMonitorService(
      prisma as any,
      config,
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      dialogueService as any,
      mockLlm as any,
      undefined,
      undefined,
      undefined,
    );
  }

  it("LANG-004: accepts auto_reply when English comment gets English reply", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content:
          '{"action":"auto_reply","reason":"Positive","detectedLanguage":"en","replyText":"Thanks for the insight!"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Love this post about productivity" },
    );
    expect(result.action).toBe("auto_reply");
    expect(result.detectedLanguage).toBe("en");
  });

  it("LANG-005: downgrades Spanish reply to human_review under English-only mode", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content:
          '{"action":"auto_reply","reason":"Positive","detectedLanguage":"es","replyText":"¡Gracias! El ciclo de producto es real."}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "¡Me encanta este post!" },
    );
    expect(result.action).toBe("human_review");
    expect(result.reviewReason).toMatch(/not in English|non-English/i);
    expect(result.replyText).toBeUndefined();
  });

  it("LANG-006: downgrades Italian reply to human_review under English-only mode", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content:
          '{"action":"auto_reply","reason":"Positive","detectedLanguage":"it","replyText":"Grazie! Il ciclo di prodotto è reale."}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Mi piace questo post!" },
    );
    expect(result.action).toBe("human_review");
    expect(result.reviewReason).toMatch(/not in English|non-English/i);
    expect(result.replyText).toBeUndefined();
  });

  it("LANG-008: accepts auto_reply when detectedLanguage is missing (no validation)", async () => {
    // Backward compat: if LLM doesn't return detectedLanguage, skip validation
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","replyText":"Thanks!"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Love this post" },
    );
    expect(result.action).toBe("auto_reply");
    expect(result.replyText).toBe("Thanks!");
  });

  it("LANG-009: system prompt includes detectedLanguage in JSON schema", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content:
          '{"action":"auto_reply","reason":"ok","detectedLanguage":"en","replyText":"Thanks!"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post" },
      { id: "2", commentId: "c1", author: "user", text: "Nice post" },
    );
    const [systemPrompt] = mockLlm.generateChat.mock.calls[0];
    expect(systemPrompt).toContain("detectedLanguage");
    expect(systemPrompt).toContain('"en"');
    expect(systemPrompt).toContain("English only");
    expect(systemPrompt).toContain("REPLY LANGUAGE");
  });

  // ── LLM skip action ──

  it("SKIP-001: accepts LLM skip action for low-value comment", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content:
          '{"action":"skip","reason":"Generic reaction, nothing to reply to","detectedLanguage":"en"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "Who else is here from TikTok?" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Generic");
  });

  it("SKIP-002: deterministic low-value filter skips before LLM is called", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"skip","reason":"should not reach LLM"}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    // "nice" is a generic reaction — deterministic filter catches it, no LLM call
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "nice" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Generic reaction");
    expect(mockLlm.generateChat).not.toHaveBeenCalled();
  });

  it("SKIP-003: emoji-only comment is skipped by deterministic filter (no LLM call)", async () => {
    const mockLlm = {
      generateChat: vi.fn(),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "🔥🔥🔥" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Emoji-only");
    expect(mockLlm.generateChat).not.toHaveBeenCalled();
  });

  it("SKIP-004: follow bait is skipped by deterministic filter (no LLM call)", async () => {
    const mockLlm = {
      generateChat: vi.fn(),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "follow me for daily newsletters" },
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Follow/subscribe bait");
    expect(mockLlm.generateChat).not.toHaveBeenCalled();
  });

  it("SKIP-005: genuine question still goes to LLM (not caught by low-value filter)", async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content:
          '{"action":"auto_reply","reason":"genuine question","detectedLanguage":"en","replyText":"Great question! Remote work is..."}',
        model: "test",
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: "1", network: "X", content: "Post about Workflow" },
      { id: "2", commentId: "c1", author: "user", text: "What does remote work mean for me?" },
    );
    expect(result.action).toBe("auto_reply");
    expect(mockLlm.generateChat).toHaveBeenCalledOnce();
  });
});
