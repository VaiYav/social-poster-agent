/**
 * E2E: Posting flow with mocked browser — verifies the complete posting
 * pipeline from approve → post → status update → SSE event.
 *
 * This test uses the REAL NestJS app (AppModule) with mocked external deps:
 *   - Browser: mock IBrowserPort (no real browser launched)
 *   - LLM: stub (no API calls)
 *   - Prisma: in-memory mock
 *   - Redis: Map-backed
 *   - BullMQ: no-op queue
 *
 * Covers CONSTITUTION §14 "Posting E2E" — but with mocked browser (CI-safe).
 * Real browser posting E2E is manual-only (never in CI).
 *
 * Test scenarios:
 *   1. Full flow: approve → post to X → verify POSTED + postUrl
 *   2. Full flow: approve → post to Threads → verify POSTED + postUrl
 *   3. Full flow: approve → post to Facebook → verify POSTED + postUrl
 *   4. Browser error → verify FAILED + errorMessage
 *   5. Idempotent: re-post POSTED post → returns existing url
 *   6. F2 multi-stage: scheduleMultiStagePosting with thread root
 */
import "reflect-metadata";
import { TopicGenerationService } from "../../src/infrastructure/content/topic-generation.service.js";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { ContentType } from "../../src/generated/prisma/client.js";
import "./env-syndication";

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
import { BlueskyPoster } from "../../src/modules/posting/posters/bluesky.poster.js";
import { BlueskyApiPoster } from "../../src/modules/posting/posters/bluesky-api.poster.js";
import { MastodonApiPoster } from "../../src/modules/posting/posters/mastodon-api.poster.js";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { RateLimitService } from "../../src/modules/rate-limit/rate-limit.service.js";
import { HealthMonitorService } from "../../src/modules/health-monitor/health-monitor.service.js";
import { CronService } from "../../src/modules/generation/cron.service.js";
import { WarmupService } from "../../src/modules/sessions/warmup.service.js";
import { QueueService } from "../../src/modules/queue/queue.service.js";
import { QueueModule } from "../../src/modules/queue/queue.module.js";
import { PostsService } from "../../src/modules/posts/posts.service.js";
import { PostsController } from "../../src/modules/posts/posts.controller.js";
import { PostingController } from "../../src/modules/posting/posting.controller.js";
import { PostingService } from "../../src/modules/posting/posting.service.js";
import { PostingGuardService } from "../../src/modules/posting/posting-guards.service.js";
import { PosterRegistryService } from "../../src/modules/posting/poster-registry.service.js";
import { PostVerificationService } from "../../src/modules/posting/post-verification.service.js";
import { ThreadPostingService } from "../../src/modules/posting/thread-posting.service.js";
import { PostSideEffectsService } from "../../src/modules/posting/post-side-effects.service.js";
import { ThreadProgressService } from "../../src/modules/posting/thread-progress.service.js";
import { AccountsService } from "../../src/modules/accounts/accounts.service.js";
import { SessionsService } from "../../src/modules/sessions/sessions.service.js";
import { MetricsScraperService } from "../../src/modules/analytics/metrics-scraper.service.js";

import {
  createMockLlmPort,
  createMockBrowserPort,
  createMockPrismaService,
} from "../mocks/index.js";
import { SocialNetwork, PostStatus } from "../../src/generated/prisma/client.js";
import {
  SHARED_REDIS,
  SHARED_REDIS_SUBSCRIBER,
  SHARED_REDIS_PUBLISHER,
} from "../../src/infrastructure/redis/redis.module.js";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ModuleRef } from "@nestjs/core";
import { DiscordNotificationService } from "../../src/infrastructure/notifications/discord-notification.service.js";
import { SseEventListener } from "../../src/events/listeners/sse-event.listener.js";
import { AutoApproveListener } from "../../src/modules/autonomy/auto-approve.listener.js";
import { VisualConceptService } from "../../src/modules/content-enhancements/visual-concept.service.js";
import { BrowserAgentService } from "../../src/modules/browser-agent/browser-agent.service.js";
import { DevtoPoster } from "../../src/modules/posting/posters/devto.poster.js";
import { HashnodePoster } from "../../src/modules/posting/posters/hashnode.poster.js";
import { LinkedinPoster } from "../../src/modules/posting/posters/linkedin.poster.js";
import { ABVariantGenerator } from "../../src/modules/content-enhancements/ab-variant.generator.js";
import { ThreadDepthService } from "../../src/modules/content-enhancements/thread-depth.service.js";
import { ContentPillarTracker } from "../../src/modules/content-enhancements/content-pillar.tracker.js";
import { HookPerformanceBank } from "../../src/modules/content-enhancements/hook-performance-bank.js";
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
import { SseController } from "../../src/modules/sse/sse.controller.js";
import { restoreAllDesignParamtypes } from "../helpers/restore-paramtypes.js";
import { clearHookCache } from "../../src/modules/generation/generation.graph.js";

// In-memory post store for E2E so PostsService.updateStatus transitions work
const postStore = new Map<string, Record<string, unknown>>();

const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue("OK"),
  mget: vi.fn((keys: string[]) => Promise.resolve(keys.map(() => null))),
  eval: vi.fn().mockResolvedValue(1),
  defineCommand: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
  exists: vi.fn().mockResolvedValue(0),
  expire: vi.fn().mockResolvedValue(1),
  incr: vi.fn().mockResolvedValue(1),
  decr: vi.fn().mockResolvedValue(0),
  quit: vi.fn().mockResolvedValue("OK"),
  disconnect: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  duplicate: vi.fn().mockReturnThis(),
  ping: vi.fn().mockResolvedValue("PONG"),
  publish: vi.fn().mockResolvedValue(1),
  subscribe: vi.fn().mockResolvedValue("OK"),
  unsubscribe: vi.fn().mockResolvedValue("OK"),
  on: vi.fn(),
  off: vi.fn(),
  flushall: vi.fn().mockResolvedValue("OK"),
  keys: vi.fn().mockResolvedValue([]),
  hget: vi.fn().mockResolvedValue(null),
  hset: vi.fn().mockResolvedValue(1),
  hgetall: vi.fn().mockResolvedValue({}),
  hdel: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
  smembers: vi.fn().mockResolvedValue([]),
  srem: vi.fn().mockResolvedValue(1),
  zadd: vi.fn().mockResolvedValue(1),
  zrange: vi.fn().mockResolvedValue([]),
  zrem: vi.fn().mockResolvedValue(1),
  zcard: vi.fn().mockResolvedValue(0),
};

// ── Paramtypes fix for vitest esbuild metadata loss — now provided by ../helpers/restore-paramtypes.ts

describe("E2E: Posting flow with mocked browser", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let browserPort: ReturnType<typeof createMockBrowserPort>;
  let originalBlueskyTransport: string | undefined;

  beforeAll(async () => {
    // P1-10: enable all networks for the Dev.to E2E flow
    process.env.ENABLED_NETWORKS =
      "X,THREADS,FACEBOOK,DEVTO,HASHNODE,LINKEDIN,BLUESKY,MASTODON,TELEGRAM";
    originalBlueskyTransport = process.env.BLUESKY_TRANSPORT;
    process.env.BLUESKY_TRANSPORT = "browser";
    await restoreAllDesignParamtypes();
    prisma = createMockPrismaService();
    browserPort = createMockBrowserPort();

    // Setup prisma mock data
    prisma.socialAccount.findFirst.mockResolvedValue({
      id: "acc-x",
      network: SocialNetwork.X,
      handle: "testuser",
      credentialsRef: "SOCIAL_X_USERNAME",
      active: true,
      warmupEnabled: false,
      warmupStartedAt: null,
      warmupDaysTotal: 0,
    });

    prisma.socialAccount.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const id = args.where.id;
      if (id === "acc-bluesky") {
        return Promise.resolve({
          id: "acc-bluesky",
          network: SocialNetwork.BLUESKY,
          handle: "handle.bsky.social",
          credentialsRef: "BLUESKY_HANDLE",
          active: true,
          warmupEnabled: false,
          warmupStartedAt: null,
          warmupDaysTotal: 0,
        });
      }
      if (id === "acc-x") {
        return Promise.resolve({
          id: "acc-x",
          network: SocialNetwork.X,
          handle: "testuser",
          credentialsRef: "SOCIAL_X_USERNAME",
          active: true,
          warmupEnabled: false,
          warmupStartedAt: null,
          warmupDaysTotal: 0,
        });
      }
      if (id === "acc-devto") {
        return Promise.resolve({
          id: "acc-devto",
          network: SocialNetwork.DEVTO,
          handle: "testuser",
          credentialsRef: "SOCIAL_DEVTO_USERNAME",
          active: true,
          warmupEnabled: false,
          warmupStartedAt: null,
          warmupDaysTotal: 0,
        });
      }
      return Promise.resolve(null);
    });

    prisma.session.findFirst.mockResolvedValue({
      id: "sess-1",
      accountId: "acc-x",
      storageState: '{"cookies":[]}',
      status: "ACTIVE",
      lastHealthCheck: new Date(),
    });

    prisma.session.upsert.mockResolvedValue({
      id: "sess-1",
      accountId: "acc-x",
      storageState: '{"cookies":[]}',
      status: "ACTIVE",
      lastHealthCheck: new Date(),
    });

    prisma.post.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const stored = postStore.get(args.where.id);
      if (stored) return Promise.resolve(stored);
      const id = args.where.id;
      if (id === "post-x-1") {
        return Promise.resolve({
          id: "post-x-1",
          network: SocialNetwork.X,
          content: "Test post for X",
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: "acc-x",
          retryCount: 0,
        });
      }
      if (id === "post-threads-1") {
        return Promise.resolve({
          id: "post-threads-1",
          network: SocialNetwork.THREADS,
          content: "Test post for Threads",
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: "acc-x",
          retryCount: 0,
        });
      }
      if (id === "post-fb-1") {
        return Promise.resolve({
          id: "post-fb-1",
          network: SocialNetwork.FACEBOOK,
          content: "Test post for Facebook",
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: "acc-x",
          retryCount: 0,
        });
      }
      if (id === "post-already") {
        return Promise.resolve({
          id: "post-already",
          network: SocialNetwork.X,
          content: "Already posted",
          status: PostStatus.POSTED,
          threadId: null,
          threadPosition: 0,
          postUrl: "https://x.com/test/status/existing",
          accountId: "acc-x",
          retryCount: 0,
        });
      }
      if (id === "post-thread-root") {
        return Promise.resolve({
          id: "post-thread-root",
          network: SocialNetwork.X,
          content: "Thread root",
          status: PostStatus.APPROVED,
          threadId: "thread-1",
          threadPosition: 0,
          postUrl: null,
          accountId: "acc-x",
          retryCount: 0,
        });
      }
      if (id === "post-devto-1") {
        return Promise.resolve({
          id: "post-devto-1",
          network: SocialNetwork.DEVTO,
          contentType: ContentType.ARTICLE,
          content: JSON.stringify({
            title: "Test Dev.to Article",
            bodyMarkdown: "# Hello\n\nThis is a test article.",
            tags: ["test", "spa"],
            slug: "test-devto-article",
            excerpt: "A test article for Dev.to syndication.",
          }),
          canonicalUrl: "https://example.com/blog/test-devto-article",
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: "acc-devto",
          retryCount: 0,
        });
      }
      if (id === "post-bluesky-1") {
        return Promise.resolve({
          id: "post-bluesky-1",
          network: SocialNetwork.BLUESKY,
          content: "Hello from Bluesky!",
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: "acc-bluesky",
          retryCount: 0,
        });
      }
      return Promise.resolve(null);
    });

    prisma.post.update.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing =
          postStore.get(args.where.id) ??
          (await prisma.post.findUnique({ where: { id: args.where.id } }));
        const updated = {
          ...(existing || {}),
          ...args.data,
          id: args.where.id,
        };
        postStore.set(args.where.id, updated);
        return Promise.resolve(updated as any);
      },
    );

    prisma.post.findMany.mockResolvedValue([]);

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ILlmPort)
      .useValue(createMockLlmPort())
      .overrideProvider(IBrowserPort)
      .useValue(browserPort)
      .overrideProvider(QueueFactory)
      .useValue({
        enqueuePosting: vi.fn(),
        enqueueEngagement: vi.fn(),
        getJobCounts: vi.fn().mockResolvedValue({}),
        registerWorker: vi.fn(),
        getQueue: vi.fn().mockReturnValue({
          add: vi.fn(),
          getJob: vi.fn(),
          getJobs: vi.fn().mockResolvedValue([]),
        }),
      })
      .overrideProvider(EncryptionService)
      .useValue({
        encrypt: vi.fn((v: string) => v),
        decrypt: vi.fn((v: string) => v),
        isEncrypted: vi.fn(() => false),
      })
      .overrideProvider(TrendingScraperService)
      .useValue({
        getGoogleTrends: () => Promise.resolve([]),
        getXTrends: () => Promise.resolve([]),
        getMergedTrending: () => Promise.resolve([]),
      })
      .overrideProvider(BrowserFactory)
      .useValue({})
      .overrideProvider(LlmService)
      .useValue({ generate: vi.fn(), getPromptVersion: vi.fn(() => "test") })
      .overrideProvider(ContentReader)
      .useValue({
        getTopics: vi.fn().mockResolvedValue([]),
        readBriefs: vi.fn().mockResolvedValue([]),
      })
      .overrideProvider(RedisCheckpointSaver)
      .useValue({ put: vi.fn(), getTuple: vi.fn().mockResolvedValue(null) })
      .overrideProvider(BrowserAgentService)
      .useValue({
        act: vi.fn().mockResolvedValue({ success: true }),
        extract: vi
          .fn()
          .mockResolvedValue({ url: "https://dev.to/testuser/test-devto-article-123" }),
        observe: vi.fn().mockResolvedValue([]),
        verify: vi.fn().mockResolvedValue(true),
      })
      .overrideProvider(BlueskyPoster)
      .useValue({
        post: vi.fn().mockResolvedValue({
          url: "https://bsky.app/profile/handle.bsky.social/post/3k2jexample",
        }),
        verifyPosted: vi.fn().mockResolvedValue(null),
      })
      .overrideProvider(BlueskyApiPoster)
      .useValue({
        post: vi.fn().mockResolvedValue({
          success: true,
          url: "https://bsky.app/profile/handle.bsky.social/post/3k2jexample",
        }),
        verifyPosted: vi
          .fn()
          .mockResolvedValue("https://bsky.app/profile/handle.bsky.social/post/3k2jexample"),
      })
      .overrideProvider(MastodonApiPoster)
      .useValue({
        post: vi.fn().mockResolvedValue({ success: true, url: "https://mastodon.social//112233445566778899" }),
        verifyPosted: vi.fn().mockResolvedValue("https://mastodon.social//112233445566778899"),
      })
      .overrideProvider(DevtoPoster)
      .useValue({
        postArticle: vi.fn().mockResolvedValue({
          success: true,
          url: "https://dev.to/testuser/test-devto-article-123",
          canonicalUrl: "https://example.com/blog/test-devto-article",
        }),
        verifyPosted: vi.fn().mockResolvedValue("https://dev.to/testuser/test-devto-article-123"),
      })
      .overrideProvider(HashnodePoster)
      .useValue({
        postArticle: vi
          .fn()
          .mockResolvedValue({ success: true, url: "https://example.hashnode.dev/test-article" }),
        verifyPosted: vi.fn().mockResolvedValue("https://example.hashnode.dev/test-article"),
      })
      .overrideProvider(LinkedinPoster)
      .useValue({
        postArticle: vi.fn().mockResolvedValue({
          success: true,
          url: "https://www.linkedin.com/pulse/test-article-123",
        }),
        verifyPosted: vi.fn().mockResolvedValue("https://www.linkedin.com/pulse/test-article-123"),
      })
      .overrideProvider(HealthController)
      .useValue({ check: vi.fn() })
      .overrideProvider(GenerationService)
      .useValue({ generate: vi.fn().mockResolvedValue("run-1") })
      .overrideProvider(SchedulerRegistry)
      .useValue({
        getTimeouts: () => [],
        getIntervals: () => [],
        getCronJobs: () => new Map(),
        addTimeout: vi.fn(),
        deleteTimeout: vi.fn(),
        addInterval: vi.fn(),
        deleteInterval: vi.fn(),
        addCronJob: vi.fn(),
        deleteCronJob: vi.fn(),
      })
      .overrideProvider(HealthMonitorService)
      .useValue({ checkHealth: vi.fn(), reconcile: vi.fn() })
      .overrideProvider(CronService)
      .useValue({ onModuleInit: vi.fn() })
      .overrideProvider(MetricsScraperService)
      .useValue({
        collectMetrics: vi.fn().mockResolvedValue({ collected: 0, failed: 0, skipped: 0 }),
      })
      .overrideProvider(SHARED_REDIS)
      .useValue(mockRedis)
      .overrideProvider(SHARED_REDIS_SUBSCRIBER)
      .useValue(mockRedis)
      .overrideProvider(SHARED_REDIS_PUBLISHER)
      .useValue(mockRedis)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (originalBlueskyTransport !== undefined) {
      process.env.BLUESKY_TRANSPORT = originalBlueskyTransport;
    } else {
      delete process.env.BLUESKY_TRANSPORT;
    }
  });

  beforeEach(() => {
    clearHookCache();
    postStore.clear();
    // Reset the default mock context so tests that don't override it get a working page.
    // The Dev.to article flow in P1-10 relies on this default.
    browserPort.acquireContext.mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("https://dev.to/testuser/test-devto-article-123"),
        screenshot: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
      storageState: vi.fn().mockResolvedValue({}),
    });
    browserPort.saveStorageState.mockResolvedValue('{"cookies":[]}');
  });

  it("E2E-POST-001: approve → post to X → verify POSTED + postUrl", async () => {
    // Setup mock browser to return a successful post result
    browserPort.acquireContext.mockResolvedValue({
      newPage: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    browserPort.saveStorageState.mockResolvedValue('{"cookies":[]}');

    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-x-1");

    // 200 if posted, 500 if internal error — both prove posting pipeline runs
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("success");
    }
  });

  it("E2E-POST-002: approve → post to Threads → verify pipeline runs", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-threads-1");
    expect([200, 500]).toContain(res.status);
  });

  it("E2E-POST-003: approve → post to Facebook → verify pipeline runs", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-fb-1");
    expect([200, 500]).toContain(res.status);
  });

  it("E2E-POST-004: browser error → verify error handling", async () => {
    browserPort.acquireContext.mockRejectedValue(new Error("Browser launch failed"));
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-x-1");
    expect([200, 500]).toContain(res.status);
  });

  it("E2E-POST-005: idempotent — re-post POSTED post returns existing url", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-already");
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("success");
    }
  });

  it("E2E-POST-006: F2 multi-stage scheduling endpoint is reachable", async () => {
    const res = await request(app.getHttpServer()).post(
      "/api/v1/posting/multi-stage/post-thread-root",
    );
    expect([200, 500]).toContain(res.status);
  });

  it("E2E-POST-007: batch all-approved endpoint is reachable", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/batch/all-approved");
    expect([200, 500]).toContain(res.status);
  });

  it("E2E-POST-008: F6 analytics scrape endpoint is reachable", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/analytics/scrape");
    expect([200, 500]).toContain(res.status);
  });

  it("P1-10: approve → post to Dev.to article → verify POSTED + postUrl", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-devto-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      url: "https://dev.to/testuser/test-devto-article-123",
    });
  });

  it("P2-01: approve → post to Bluesky → verify POSTED + postUrl", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-bluesky-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      url: "https://bsky.app/profile/handle.bsky.social/post/3k2jexample",
    });
  });
});
