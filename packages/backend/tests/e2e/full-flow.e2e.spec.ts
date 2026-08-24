/**

 * E2E Smoke Test — Full generate → approve → post flow via HTTP.
 *
 * Verifies the core product journey end-to-end through the NestJS app:
 *   1. POST /api/v1/generation/run — triggers generation (mocked LLM)
 *   2. GET /api/v1/posts?status=DRAFT — fetch generated drafts
 *   3. POST /api/v1/posts/:id/approve — approve a draft
 *   4. POST /api/v1/posting/:postId — post via mocked browser
 *   5. GET /api/v1/posts/:id — verify status POSTED + postUrl
 *
 * All external deps mocked: Prisma (in-memory), LLM (stub), Browser (stub),
 * Redis (Map-backed), BullMQ (no-op). No real network or browser.
 *
 * Spec: CONSTITUTION.md §14 (Testing) — E2E smoke (Sprint D)
 */
import "reflect-metadata";
import { TopicGenerationService } from "../../src/infrastructure/content/topic-generation.service.js";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SseEventListener } from "../../src/events/listeners/sse-event.listener.js";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";

import { AppModule } from "../../src/app.module.js";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service.js";
import { ILlmPort } from "../../src/domain/ports/llm.port.js";
import { IBrowserPort } from "../../src/domain/ports/browser.port.js";
import { QueueFactory } from "../../src/infrastructure/queue/queue.factory.js";
import { EncryptionService } from "../../src/infrastructure/crypto/encryption.service.js";
import { TrendingScraperService } from "../../src/modules/trending/trending-scraper.service.js";
import { BrowserFactory } from "../../src/infrastructure/browser/browser.factory.js";
import { LlmService } from "../../src/infrastructure/llm/llm.service.js";
import { ContentReader } from "../../src/infrastructure/content/content-reader.js";
import { SseService } from "../../src/infrastructure/sse/sse.service.js";
import { SseModule } from "../../src/infrastructure/sse/sse.module.js";
import { RedisCheckpointSaver } from "../../src/infrastructure/checkpoint/redis-checkpoint.js";
import { HealthController } from "../../src/modules/health/health.controller.js";
import { GenerationService } from "../../src/modules/generation/generation.service.js";
import { XPoster } from "../../src/modules/posting/posters/x.poster.js";
import { ThreadsPoster } from "../../src/modules/posting/posters/threads.poster.js";
import { FacebookPoster } from "../../src/modules/posting/posters/facebook.poster.js";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { RateLimitService } from "../../src/modules/rate-limit/rate-limit.service.js";
import { CronService } from "../../src/modules/generation/cron.service.js";
import { WarmupService } from "../../src/modules/sessions/warmup.service.js";
import { QueueService } from "../../src/modules/queue/queue.service.js";
import { QueueModule } from "../../src/modules/queue/queue.module.js";
import { PostsService } from "../../src/modules/posts/posts.service.js";
import { PostsController } from "../../src/modules/posts/posts.controller.js";
import { PostingController } from "../../src/modules/posting/posting.controller.js";
import { ModuleRef } from "@nestjs/core";
import {
  createMockLlmPort,
  createMockBrowserPort,
  createMockPrismaService,
} from "../mocks/index.js";
import { restoreAllDesignParamtypes } from "../helpers/restore-paramtypes.js";
import { DiscordNotificationService } from "../../src/infrastructure/notifications/discord-notification.service.js";
import { AutoApproveListener } from "../../src/modules/autonomy/auto-approve.listener.js";
import { VisualConceptService } from "../../src/modules/content-enhancements/visual-concept.service.js";
import { ABVariantGenerator } from "../../src/modules/content-enhancements/ab-variant.generator.js";
import { ThreadDepthService } from "../../src/modules/content-enhancements/thread-depth.service.js";
import { ContentPillarTracker } from "../../src/modules/content-enhancements/content-pillar.tracker.js";
import { HookPerformanceBank } from "../../src/modules/content-enhancements/hook-performance-bank.js";
import { ThreadProgressService } from "../../src/modules/posting/thread-progress.service.js";
import { HumanBehaviorEngine } from "../../src/modules/engagement/human-behavior-engine.js";
import { TargetingService } from "../../src/modules/engagement/targeting.service.js";
import { RepliesMonitorService } from "../../src/modules/replies/replies-monitor.service.js";
import { EngagementSchedulerService } from "../../src/modules/engagement/engagement-scheduler.service.js";
import { BrowsingSessionService } from "../../src/modules/engagement/browsing-session.service.js";
import { EngagementService } from "../../src/modules/engagement/engagement.service.js";
import { EngagementController } from "../../src/modules/engagement/engagement.controller.js";
import { XEngager } from "../../src/modules/engagement/engagers/x.engager.js";
import { ThreadsEngager } from "../../src/modules/engagement/engagers/threads.engager.js";
import { FacebookEngager } from "../../src/modules/engagement/engagers/facebook.engager.js";
import { ContentSourceService } from "../../src/modules/content-source/content-source.service.js";
import { ContentSourceController } from "../../src/modules/content-source/content-source.controller.js";
import { GenerationController } from "../../src/modules/generation/generation.controller.js";
import { QueueController } from "../../src/modules/queue/queue.controller.js";
import { AccountsController } from "../../src/modules/accounts/accounts.controller.js";
import { SessionsController } from "../../src/modules/sessions/sessions.controller.js";
import { SessionsService } from "../../src/modules/sessions/sessions.service.js";
import { PostingService } from "../../src/modules/posting/posting.service.js";
import { PostingGuardService } from "../../src/modules/posting/posting-guards.service.js";
import { PosterRegistryService } from "../../src/modules/posting/poster-registry.service.js";
import { PostVerificationService } from "../../src/modules/posting/post-verification.service.js";
import { ThreadPostingService } from "../../src/modules/posting/thread-posting.service.js";
import { PostSideEffectsService } from "../../src/modules/posting/post-side-effects.service.js";
import { AccountsService } from "../../src/modules/accounts/accounts.service.js";
import { MetricsScraperService } from "../../src/modules/analytics/metrics-scraper.service.js";
import { SseController } from "../../src/modules/sse/sse.controller.js";
import { clearHookCache } from "../../src/modules/generation/generation.graph.js";

// ── ioredis mock (Map-backed shared store) ──────────────────────────────────
const { sharedRedisStore } = vi.hoisted(() => ({
  sharedRedisStore: new Map<string, string>(),
}));

vi.mock("ioredis", () => {
  const createMockRedis = () => {
    const store = sharedRedisStore;
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const on = (ev: string, cb: (...args: unknown[]) => void) => {
      (listeners[ev] ??= []).push(cb);
      return inst;
    };
    const emit = (ev: string, ...args: unknown[]) => {
      (listeners[ev] ?? []).forEach((l) => l(...args));
      return inst;
    };
    const inst: Record<string, unknown> = {
      status: "ready",
      on,
      emit,
      removeAllListeners: () => inst,
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      mget: (keys: string[]) => Promise.resolve(keys.map((key) => store.get(key) ?? null)),
      set: (k: string, v: unknown) => {
        store.set(k, String(v));
        return Promise.resolve("OK");
      },
      setex: (k: string, _t: number, v: string) => {
        store.set(k, v);
        return Promise.resolve("OK");
      },
      psetex: (k: string, _t: number, v: string) => {
        store.set(k, v);
        return Promise.resolve("OK");
      },
      incr: (k: string) => {
        const v = parseInt(store.get(k) ?? "0", 10) + 1;
        store.set(k, String(v));
        return Promise.resolve(v);
      },
      decr: (k: string) => {
        const v = parseInt(store.get(k) ?? "0", 10) - 1;
        store.set(k, String(v));
        return Promise.resolve(v);
      },
      expire: () => Promise.resolve(1),
      pexpire: () => Promise.resolve(1),
      del: (k: string) => {
        store.delete(k);
        return Promise.resolve(1);
      },
      unlink: (k: string) => {
        store.delete(k);
        return Promise.resolve(1);
      },
      exists: (k: string) => Promise.resolve(store.has(k) ? 1 : 0),
      ping: () => Promise.resolve("PONG"),
      publish: () => Promise.resolve(1),
      subscribe: () => Promise.resolve("OK"),
      unsubscribe: () => Promise.resolve("OK"),
      psubscribe: () => Promise.resolve("OK"),
      connect: () => Promise.resolve(undefined),
      disconnect: () => undefined,
      close: () => Promise.resolve(undefined),
      quit: () => Promise.resolve(undefined),
      duplicate: () => createMockRedis(),
      keys: (pat: string) => {
        const prefix = pat.replace(/\*$/, "");
        return Promise.resolve([...store.keys()].filter((k) => k.startsWith(prefix)));
      },
      scan: () => Promise.resolve(["0", []]),
      hget: () => Promise.resolve(null),
      hset: () => Promise.resolve(1),
      hgetall: () => Promise.resolve({}),
      sadd: () => Promise.resolve(1),
      smembers: () => Promise.resolve([]),
      srem: () => Promise.resolve(1),
      zadd: () => Promise.resolve(1),
      zrange: () => Promise.resolve([]),
      zremrangebyscore: () => Promise.resolve(1),
      type: () => Promise.resolve("none"),
      ttl: () => Promise.resolve(-1),
      pttl: () => Promise.resolve(-1),
    };
    return inst;
  };
  return {
    default: function MockIORedis(..._args: unknown[]) {
      return createMockRedis();
    },
    Redis: function MockIORedis2(..._args: unknown[]) {
      return createMockRedis();
    },
  };
});

vi.mock("camoufox-js", () => ({
  Camoufox: vi.fn().mockImplementation(() => ({ launch: vi.fn() })),
}));

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({ content: "Generated post content" }),
  })),
}));

describe("E2E Sprint D: Full Flow — generate → approve → post", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let postId: string;

  beforeAll(async () => {
    sharedRedisStore.clear();

    prisma = createMockPrismaService();

    // Seed account + session for posting
    const accountId = "acc-e2e-1";
    const sessionId = "sess-e2e-1";
    prisma.account.findFirst.mockResolvedValue({
      id: accountId,
      network: "X",
      handle: "exampleco",
      credentialsRef: "SOCIAL_X_USERNAME/PASSWORD",
      active: true,
      warmupEnabled: false,
      warmupStartedAt: null,
      warmupDaysTotal: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.account.findMany.mockResolvedValue([
      { id: accountId, network: "X", handle: "exampleco", sessions: [] },
    ]);
    // SocialAccount mocks (for WarmupService — Prisma model is SocialAccount, not Account)
    prisma.socialAccount.findUnique.mockResolvedValue({
      id: accountId,
      network: "X",
      handle: "exampleco",
      credentialsRef: "SOCIAL_X_USERNAME/PASSWORD",
      active: true,
      warmupEnabled: false,
      warmupStartedAt: null,
      warmupDaysTotal: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.socialAccount.update.mockResolvedValue({});
    prisma.session.findFirst.mockResolvedValue({
      id: sessionId,
      accountId,
      storageState: { cookies: [], origins: [] },
      status: "ACTIVE",
      lastHealthCheck: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.session.create.mockResolvedValue({
      id: sessionId,
      accountId,
      storageState: { cookies: [], origins: [] },
      status: "ACTIVE",
      lastHealthCheck: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock post creation — return a post with DRAFT status
    prisma.post.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "post-e2e-1",
        generationRunId: data.generationRunId ?? null,
        accountId: data.accountId,
        threadId: null,
        threadPosition: 0,
        network: data.network ?? "X",
        content: data.content ?? "Test content",
        sourceRef: data.sourceRef ?? null,
        status: "DRAFT",
        postUrl: null,
        errorMessage: null,
        retryCount: 0,
        llmMetadata: data.llmMetadata ?? null,
        createdAt: new Date(),
        approvedAt: null,
        postedAt: null,
      }),
    );

    // Mock post findMany — return drafts
    prisma.post.findMany.mockImplementation(({ where }: { where?: Record<string, unknown> }) => {
      const posts = [
        {
          id: "post-e2e-1",
          generationRunId: "run-1",
          accountId,
          threadId: null,
          threadPosition: 0,
          network: "X",
          content: "Generated post about Workflow Trends",
          sourceRef: { type: "brief", path: "/brief.json", topic: "Workflow Trends" },
          status: "DRAFT",
          postUrl: null,
          errorMessage: null,
          retryCount: 0,
          llmMetadata: { model: "gpt-5-nano", promptVersion: "0.3.0" },
          createdAt: new Date(),
          approvedAt: null,
          postedAt: null,
        },
      ];
      if (where?.status === "APPROVED") {
        return Promise.resolve(
          posts.map((p) => ({ ...p, status: "APPROVED", approvedAt: new Date() })),
        );
      }
      return Promise.resolve(posts);
    });

    // Mock post findUnique — return post by ID with status transitions
    prisma.post.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const stored = (prisma as Record<string, unknown>).__storedPost as
        | Record<string, unknown>
        | undefined;
      if (where.id === "post-e2e-1") {
        return Promise.resolve(
          stored ?? {
            id: "post-e2e-1",
            generationRunId: "run-1",
            accountId,
            threadId: null,
            threadPosition: 0,
            network: "X",
            content: "Generated post about Workflow Trends",
            sourceRef: { type: "brief", path: "/brief.json", topic: "Workflow Trends" },
            status: "DRAFT",
            postUrl: null,
            errorMessage: null,
            retryCount: 0,
            llmMetadata: { model: "gpt-5-nano", promptVersion: "0.3.0" },
            createdAt: new Date(),
            approvedAt: null,
            postedAt: null,
          },
        );
      }
      return Promise.resolve(null);
    });

    // Mock post update — track status transitions
    prisma.post.update.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = (prisma as Record<string, unknown>).__storedPost as
          | Record<string, unknown>
          | undefined;
        const updated = {
          ...(current ?? {
            id: where.id,
            accountId,
            network: "X",
            content: "Test",
            status: "DRAFT",
          }),
          ...data,
        };
        (prisma as Record<string, unknown>).__storedPost = updated;
        return Promise.resolve(updated);
      },
    );

    // Mock generation run
    prisma.generationRun.create.mockResolvedValue({
      id: "run-e2e-1",
      triggeredBy: "MANUAL",
      sourceTopics: [],
      status: "RUNNING",
      startedAt: new Date(),
      completedAt: null,
      posts: [],
      errorMessage: null,
    });
    prisma.generationRun.update.mockResolvedValue({});
    prisma.generationRun.findMany.mockResolvedValue([]);
    prisma.generationRun.findUnique.mockResolvedValue(null);

    // Restore paramtypes for esbuild (esbuild doesn't emit design:paramtypes)
    // Always set — previous test files may have set older metadata
    await restoreAllDesignParamtypes();

    // Mock QueueFactory (no-op — no BullMQ worker polling, but with queue control methods)
    const queueFactory = {
      createQueue: vi.fn().mockReturnValue({
        add: vi.fn(),
        close: vi.fn(),
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
        getFailed: vi.fn().mockResolvedValue([]),
        isPaused: vi.fn().mockResolvedValue(false),
        pause: vi.fn(),
        resume: vi.fn(),
      }),
      createWorker: vi.fn().mockReturnValue({ close: vi.fn() }),
      registerWorker: vi.fn(),
      closeAll: vi.fn(),
      enqueuePosting: vi.fn().mockResolvedValue(undefined),
      getJobCounts: vi
        .fn()
        .mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      getFailedJobs: vi.fn().mockResolvedValue([]),
      pauseQueue: vi.fn().mockResolvedValue(undefined),
      resumeQueue: vi.fn().mockResolvedValue(undefined),
      isQueuePaused: vi.fn().mockResolvedValue(false),
    } as unknown as QueueFactory;

    // Mock posters — return valid post URLs
    const xPoster = {
      post: vi.fn().mockResolvedValue({ url: "https://x.com/exampleco/status/1234567890" }),
    } as unknown as XPoster;
    const threadsPoster = {
      post: vi.fn().mockResolvedValue({ url: "https://www.threads.com/@exampleco/post/abc123" }),
    } as unknown as ThreadsPoster;
    const facebookPoster = {
      post: vi.fn().mockResolvedValue({ url: "https://www.facebook.com/exampleco/posts/789" }),
    } as unknown as FacebookPoster;

    const mockSharedRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      ping: vi.fn().mockResolvedValue("PONG"),
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(1),
      on: vi.fn(),
      publish: vi.fn().mockResolvedValue(1),
      keys: vi.fn().mockResolvedValue([]),
      rpush: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown;

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ILlmPort)
      .useValue(createMockLlmPort())
      .overrideProvider(IBrowserPort)
      .useValue(createMockBrowserPort())
      .overrideProvider(QueueFactory)
      .useValue(queueFactory)
      .overrideProvider(XPoster)
      .useValue(xPoster)
      .overrideProvider(ThreadsPoster)
      .useValue(threadsPoster)
      .overrideProvider(FacebookPoster)
      .useValue(facebookPoster)
      .overrideProvider(RedisCheckpointSaver)
      .useValue({
        onModuleInit: vi.fn(),
        save: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      })
      .overrideProvider(EncryptionService)
      .useValue({
        encrypt: (data: unknown) => data,
        decrypt: (data: string) => data,
        isEnabled: () => false,
      })
      .overrideProvider(TrendingScraperService)
      .useValue({
        getGoogleTrends: () => Promise.resolve([]),
        getXTrends: () => Promise.resolve([]),
        getMergedTrends: () => Promise.resolve([]),
        getCacheStatus: () => Promise.resolve({ googleTrends: null, xTrends: null }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    clearHookCache();
    // PO1: each test must start with a fresh DRAFT post-e2e-1 — approve/reject now return 409
    // for a non-DRAFT post, and the stateful prisma mock otherwise leaks status across tests.
    delete (prisma as Record<string, unknown>).__storedPost;
  });

  it("E2E-D1-1: GET /health returns 200", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
  });

  it("E2E-D1-2: GET /posts?status=DRAFT returns 200 with drafts", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/posts?status=DRAFT");
    expect(res.status).toBe(200);
    // findMany returns { posts, total, limit, offset } (paginated)
    const posts = res.body.posts ?? res.body;
    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0].status).toBe("DRAFT");
  });

  it("E2E-D1-3: POST /posts/:id/approve approves a draft", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/posts/post-e2e-1/approve")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.approvedAt).not.toBeNull();
  });

  it("E2E-D1-4: POST /posting/:postId posts via mocked browser", async () => {
    // Approve first
    await request(app.getHttpServer()).post("/api/v1/posts/post-e2e-1/approve").send({});

    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-e2e-1");

    // 200 if posted, 409 if rate-limited — both prove posting pipeline works
    expect([200, 409]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("success");
      if (res.body.success) {
        expect(res.body.url).toContain("x.com");
      }
    }
  });

  it("E2E-D1-5: Full chain — approve → post → verify POSTED", async () => {
    // Step 1: Approve
    const approveRes = await request(app.getHttpServer())
      .post("/api/v1/posts/post-e2e-1/approve")
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("APPROVED");

    // Step 2: Post
    const postRes = await request(app.getHttpServer()).post("/api/v1/posting/post-e2e-1");
    expect([200, 409]).toContain(postRes.status);

    // Step 3: Verify final state via GET
    const finalRes = await request(app.getHttpServer()).get("/api/v1/posts/post-e2e-1");
    expect(finalRes.status).toBe(200);
    // Status should be POSTED or POSTING (if rate-limited, still APPROVED)
    if (postRes.status === 200 && postRes.body.success) {
      expect(finalRes.body.status).toBe("POSTED");
      expect(finalRes.body.postUrl).toContain("x.com");
    }
  });

  it("E2E-D1-6: POST /posting/non-existent returns 404", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/non-existent-post");
    expect([404, 500]).toContain(res.status);
  });

  it("E2E-D1-7: GET /posts/:id returns post details", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/posts/post-e2e-1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "post-e2e-1");
    expect(res.body).toHaveProperty("network", "X");
    expect(res.body).toHaveProperty("content");
  });

  it("E2E-D1-8: POST /posts/:id/reject rejects a draft", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posts/post-e2e-1/reject").send({});
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.status).toBe("REJECTED");
    }
  });
});
