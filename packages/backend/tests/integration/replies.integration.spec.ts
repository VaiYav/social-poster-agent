/**
 * F4 Integration Tests — RepliesModule end-to-end wiring.
 *
 * Technique: Top-Down / Big-Bang hybrid. Loads the real RepliesModule with
 * all F4 services (RepliesMonitorService, DialogueService, QuestionClassifierService,
 * CommentSafetyClassifierService, ToneAnalyzerService) and stubs only external
 * ports (LLM, Browser, Prisma, Redis, Engagement, Queue, SSE, Accounts, Sessions).
 */
import "reflect-metadata";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { NotificationsModule } from "../../src/infrastructure/notifications/notifications.module.js";
import { CommentStatus, SocialNetwork } from "../../src/generated/prisma/client.js";

import { restoreAllDesignParamtypes } from "../helpers/restore-paramtypes.js";
import { RepliesModule } from "../../src/modules/replies/replies.module.js";
import { RepliesMonitorService } from "../../src/modules/replies/replies-monitor.service.js";
import { DialogueService } from "../../src/modules/replies/dialogue.service.js";
import { QuestionClassifierService } from "../../src/modules/replies/question-classifier.service.js";
import { CommentSafetyClassifierService } from "../../src/modules/replies/comment-safety-classifier.service.js";
import { ToneAnalyzerService } from "../../src/modules/replies/tone-analyzer.service.js";

import { ILlmPort, type LlmResponse } from "../../src/domain/ports/llm.port.js";
import { IBrowserPort } from "../../src/domain/ports/browser.port.js";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service.js";
import {
  SHARED_REDIS,
  SHARED_REDIS_SUBSCRIBER,
  SHARED_REDIS_PUBLISHER,
} from "../../src/infrastructure/redis/redis.module.js";
import { QueueFactory } from "../../src/infrastructure/queue/queue.factory.js";
import { SseService } from "../../src/infrastructure/sse/sse.service.js";
import { DiscordNotificationService } from "../../src/infrastructure/notifications/discord-notification.service.js";
import { AccountsService } from "../../src/modules/accounts/accounts.service.js";
import { SessionsService } from "../../src/modules/sessions/sessions.service.js";
import { EngagementService } from "../../src/modules/engagement/engagement.service.js";
import { FlowControlService } from "../../src/modules/flow-control/flow-control.service.js";
import { LlmService } from "../../src/infrastructure/llm/llm.service.js";
import { BrowserFactory } from "../../src/infrastructure/browser/browser.factory.js";

import {
  createMockPrismaService,
  createMockBrowserPort,
  createMockQueueFactory,
  createMockSseService,
} from "../mocks/index.js";

restoreAllDesignParamtypes();

const QUESTION_JSON = JSON.stringify({
  isQuestion: true,
  confidence: 0.95,
  questionType: "personal",
  reason: "Asks about their own chart placement",
});

const SAFETY_NONE_JSON = JSON.stringify({
  risk: "none",
  confidence: 0.95,
  reason: "Safe, on-topic productivity question",
});

const SAFETY_TOXIC_JSON = JSON.stringify({
  risk: "toxic",
  confidence: 0.9,
  reason: "Hate speech and slurs detected",
});

const REPLY_DECISION_JSON = JSON.stringify({
  action: "auto_reply",
  reason: "Genuine personal productivity question",
  replyText: "Customer Feedback feels deeply — trust your intuition.",
  detectedLanguage: "en",
});

function makeMockRedis() {
  const store = new Map<string, string>();
  return {
    status: "ready",
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn((k: string, v: unknown) => {
      store.set(k, String(v));
      return Promise.resolve("OK");
    }),
    setex: vi.fn((k: string, _t: number, v: string) => {
      store.set(k, v);
      return Promise.resolve("OK");
    }),
    del: vi.fn((...keys: unknown[]) => {
      const flat = keys.flat(Number.POSITIVE_INFINITY) as string[];
      let count = 0;
      for (const k of flat) if (store.delete(k)) count += 1;
      return Promise.resolve(count);
    }),
    expire: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue("PONG"),
    quit: vi.fn().mockResolvedValue("OK"),
    duplicate: vi.fn().mockReturnThis(),
    // F4 reserve/release Lua scripts
    eval: vi.fn((_script: unknown, _numKeys: number, ...rest: unknown[]) => {
      const key = rest[0] as string;
      const current = Number(store.get(key)) || 0;
      if (rest.length === 3) {
        const limit = Number(rest[1]);
        if (limit > 0 && current >= limit) return Promise.resolve([0, current]);
        const next = current + 1;
        store.set(key, String(next));
        return Promise.resolve([1, next]);
      }
      if (current > 0) store.set(key, String(current - 1));
      return Promise.resolve(current);
    }),
    _store: store,
  };
}

function makeMockLlm(): ILlmPort {
  return {
    generate: vi.fn().mockResolvedValue({
      content: "mock",
      model: "mock",
      tokens: 1,
      cost: 0,
    } satisfies LlmResponse),
    generateChat: vi.fn().mockImplementation((systemPrompt: string) => {
      if (systemPrompt.includes("intent classifier")) {
        return Promise.resolve({ content: QUESTION_JSON, model: "mock", tokens: 10, cost: 0 });
      }
      if (systemPrompt.includes("brand-safety filter")) {
        return Promise.resolve({ content: SAFETY_NONE_JSON, model: "mock", tokens: 10, cost: 0 });
      }
      if (systemPrompt.includes("Decide whether to reply")) {
        return Promise.resolve({
          content: REPLY_DECISION_JSON,
          model: "mock",
          tokens: 20,
          cost: 0,
        });
      }
      return Promise.resolve({ content: "{}", model: "mock", tokens: 1, cost: 0 });
    }),
  } as unknown as ILlmPort;
}

function makeMockToxicLlm(): ILlmPort {
  return {
    generate: vi.fn().mockResolvedValue({
      content: "mock",
      model: "mock",
      tokens: 1,
      cost: 0,
    } satisfies LlmResponse),
    generateChat: vi.fn().mockImplementation((systemPrompt: string) => {
      if (systemPrompt.includes("brand-safety filter")) {
        return Promise.resolve({ content: SAFETY_TOXIC_JSON, model: "mock", tokens: 10, cost: 0 });
      }
      return Promise.resolve({ content: "{}", model: "mock", tokens: 1, cost: 0 });
    }),
  } as unknown as ILlmPort;
}

// Shared engagement stub so postScheduledReply / manualReply can exercise real wiring.
const mockEngagement = {
  reply: vi.fn().mockResolvedValue({ success: true, postUrl: "https://x.com/u/status/2" }),
};

@Module({
  providers: [{ provide: EngagementService, useValue: mockEngagement }],
  exports: [EngagementService],
})
class TestEngagementModule {}

describe("F4 RepliesModule integration", () => {
  let module: TestingModule;
  let repliesMonitor: RepliesMonitorService;
  let dialogue: DialogueService;
  let safety: CommentSafetyClassifierService;
  let tone: ToneAnalyzerService;
  let question: QuestionClassifierService;
  let mockPrisma: ReturnType<typeof createMockPrismaService>;

  beforeAll(async () => {
    process.env.REPLIES_ENABLED = "false"; // avoid cron registration
    process.env.REPLIES_MAX_PER_POST = "3";
    process.env.REPLIES_MAX_PER_DAY = "10";
    process.env.REPLIES_AUTO_REPLY_COMPLEXITY = "medium";
    process.env.REPLIES_MAX_CONVERSATION_DEPTH = "3";
    process.env.REPLIES_TEMPERATURE = "0.6";
    process.env.REPLIES_QUESTION_TEMPERATURE = "0.3";
    process.env.REPLIES_SAFETY_TEMPERATURE = "0.2";
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK";
    process.env.RATE_LIMIT_FAIL_CLOSED = "false";

    mockPrisma = createMockPrismaService();
    mockPrisma.incomingComment.count = vi.fn().mockResolvedValue(0);
    mockPrisma.incomingComment.update = vi.fn().mockResolvedValue({});
    mockPrisma.incomingComment.findMany = vi.fn().mockResolvedValue([]);

    mockEngagement.reply.mockResolvedValue({ success: true, postUrl: "https://x.com/u/status/2" });

    const mockLlm = makeMockLlm();
    const mockRedis = makeMockRedis();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ScheduleModule.forRoot(),
        NotificationsModule,
        RepliesModule.withEngagement(TestEngagementModule),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(ILlmPort)
      .useValue(mockLlm)
      .overrideProvider(LlmService)
      .useValue({})
      .overrideProvider(IBrowserPort)
      .useValue(createMockBrowserPort())
      .overrideProvider(BrowserFactory)
      .useValue({})
      .overrideProvider(SHARED_REDIS)
      .useValue(mockRedis)
      .overrideProvider(SHARED_REDIS_SUBSCRIBER)
      .useValue(mockRedis)
      .overrideProvider(SHARED_REDIS_PUBLISHER)
      .useValue(mockRedis)
      .overrideProvider(QueueFactory)
      .useValue(createMockQueueFactory())
      .overrideProvider(SseService)
      .useValue(createMockSseService())
      .overrideProvider(DiscordNotificationService)
      .useValue({ warning: vi.fn(), critical: vi.fn() })
      .overrideProvider(AccountsService)
      .useValue({ findFirstActiveByNetwork: vi.fn().mockResolvedValue(null) })
      .overrideProvider(SessionsService)
      .useValue({})
      .overrideProvider(FlowControlService)
      .useValue({})
      .compile();

    repliesMonitor = module.get(RepliesMonitorService);
    dialogue = module.get(DialogueService);
    safety = module.get(CommentSafetyClassifierService);
    tone = module.get(ToneAnalyzerService);
    question = module.get(QuestionClassifierService);
  });

  afterAll(async () => {
    await module?.close();
  });

  it("resolves all F4 services from the module", () => {
    expect(repliesMonitor).toBeDefined();
    expect(dialogue).toBeDefined();
    expect(safety).toBeDefined();
    expect(tone).toBeDefined();
    expect(question).toBeDefined();
  });

  it("decides auto_reply for a safe personal productivity question", async () => {
    const post = {
      id: "p1",
      network: "X",
      content: "Workflow enters learning today — stay curious.",
    };
    const comment = {
      id: "c1",
      postId: "p1",
      network: SocialNetwork.X,
      commentId: "cid-1",
      author: "stargazer",
      text: "What does this mean for my Customer Feedback?",
      commentUrl: null,
      status: CommentStatus.NEW,
    };

    const decision = await repliesMonitor.decideReply(post, comment);

    expect(decision.action).toBe("auto_reply");
    expect(decision.replyText).toBeDefined();
    expect(decision.detectedLanguage).toBe("en");
  });

  it("escalates a toxic comment to human_review at the safety gate", async () => {
    const post = { id: "p1", network: "X", content: "Workflow enters learning today." };
    const comment = {
      id: "c2",
      postId: "p1",
      network: SocialNetwork.X,
      commentId: "cid-2",
      author: "troll",
      text: "You are a pathetic loser and nobody cares about your nonsense",
      commentUrl: null,
      status: CommentStatus.NEW,
    };

    // Re-create module with the toxic-safety mock LLM so the safety gate triggers.
    const toxicLlm = makeMockToxicLlm();
    const fresh = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ScheduleModule.forRoot(),
        NotificationsModule,
        RepliesModule.withEngagement(TestEngagementModule),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(ILlmPort)
      .useValue(toxicLlm)
      .overrideProvider(LlmService)
      .useValue({})
      .overrideProvider(IBrowserPort)
      .useValue(createMockBrowserPort())
      .overrideProvider(BrowserFactory)
      .useValue({})
      .overrideProvider(SHARED_REDIS)
      .useValue(makeMockRedis())
      .overrideProvider(SHARED_REDIS_SUBSCRIBER)
      .useValue(makeMockRedis())
      .overrideProvider(SHARED_REDIS_PUBLISHER)
      .useValue(makeMockRedis())
      .overrideProvider(QueueFactory)
      .useValue(createMockQueueFactory())
      .overrideProvider(SseService)
      .useValue(createMockSseService())
      .overrideProvider(DiscordNotificationService)
      .useValue({ warning: vi.fn(), critical: vi.fn() })
      .overrideProvider(AccountsService)
      .useValue({ findFirstActiveByNetwork: vi.fn().mockResolvedValue(null) })
      .overrideProvider(SessionsService)
      .useValue({})
      .overrideProvider(FlowControlService)
      .useValue({})
      .compile();

    const svc = fresh.get(RepliesMonitorService);
    const decision = await svc.decideReply(post, comment);
    await fresh.close();

    expect(decision.action).toBe("human_review");
    expect(decision.reviewReason).toMatch(/hate speech|slurs|toxic/i);
  });

  it("posts a scheduled auto-reply through the engagement service", async () => {
    await repliesMonitor.postScheduledReply({
      commentDbId: "c1",
      commentId: "cid-1",
      postId: "p1",
      network: "X",
      postUrl: "https://x.com/u/status/1",
      targetCommentUrl: "https://x.com/u/status/1#cid-1",
      replyText: "Thanks for the question!",
    });

    expect(mockEngagement.reply).toHaveBeenCalledWith(
      SocialNetwork.X,
      "https://x.com/u/status/1#cid-1",
      "Thanks for the question!",
    );
    expect(mockPrisma.incomingComment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: expect.objectContaining({ status: CommentStatus.REPLIED }),
      }),
    );
  });
});
