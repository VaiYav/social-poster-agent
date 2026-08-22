/**
 * E2E: Phase 2 social posting flow — Bluesky, Mastodon, Telegram, LinkedIn.
 *
 * Verifies the complete posting pipeline for the new Phase 2 networks using
 * the real NestJS app (AppModule) with mocked external dependencies:
 *   - Prisma: in-memory mock
 *   - Browser posters: mocked Bluesky/Mastodon/LinkedIn posters
 *   - Telegram: mocked TelegramAdapter
 *   - Redis, LLM, Queue, etc.: no-op or stub
 *
 * Covers CONSTITUTION §14 "Posting E2E" for Phase 2 social syndication (#45).
 */
import "reflect-metadata";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service";
import { ILlmPort } from "../../src/domain/ports/llm.port.js";
import { IBrowserPort } from "../../src/domain/ports/browser.port.js";
import { QueueFactory } from "../../src/infrastructure/queue/queue.factory";
import { BrowserFactory } from "../../src/infrastructure/browser/browser.factory";
import { LlmService } from "../../src/infrastructure/llm/llm.service";
import { ContentReader } from "../../src/infrastructure/content/content-reader.js";
import { RedisCheckpointSaver } from "../../src/infrastructure/checkpoint/redis-checkpoint.js";
import { HealthController } from "../../src/modules/health/health.controller";
import { EncryptionService } from "../../src/infrastructure/crypto/encryption.service";
import { TrendingScraperService } from "../../src/modules/trending/trending-scraper.service";
import { ConfigService } from "@nestjs/config";
import { GenerationService } from "../../src/modules/generation/generation.service";
import { SchedulerRegistry } from "@nestjs/schedule";
import { RateLimitService } from "../../src/modules/rate-limit/rate-limit.service";
import { CronService } from "../../src/modules/generation/cron.service";
import { MetricsScraperService } from "../../src/modules/analytics/metrics-scraper.service";
import { WarmupService } from "../../src/modules/sessions/warmup.service";
import { HealthMonitorService } from "../../src/modules/health-monitor/health-monitor.service";

import { BlueskyPoster } from "../../src/modules/posting/posters/bluesky.poster.js";
import { MastodonPoster } from "../../src/modules/posting/posters/mastodon.poster.js";
import { LinkedinSocialPoster } from "../../src/modules/posting/posters/linkedin-social.poster.js";
import { TelegramAdapter } from "../../src/infrastructure/telegram/telegram.adapter.js";

import {
  createMockLlmPort,
  createMockBrowserPort,
  createMockPrismaService,
} from "../mocks/index.js";
import { restoreAllDesignParamtypes } from "../helpers/restore-paramtypes.js";
import { SocialNetwork, PostStatus, ContentType } from "../../src/generated/prisma/client";
import { clearHookCache } from "../../src/modules/generation/generation.graph";

const { sharedRedisStore } = vi.hoisted(() => ({
  sharedRedisStore: new Map<string, string>(),
}));

vi.mock("ioredis", () => {
  const createMockRedis = () => {
    const store = sharedRedisStore;
    return {
      status: "ready",
      on: vi.fn(),
      removeAllListeners: () => ({}),
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
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
      keys: (pat: string) =>
        Promise.resolve([...store.keys()].filter((k) => k.startsWith(pat.replace(/\*$/, "")))),
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
      rpush: () => Promise.resolve(1),
      lrange: () => Promise.resolve([]),
      eval: () => Promise.resolve([1, 0, 0]),
    };
  };
  return {
    default: function MockIORedis() {
      return createMockRedis();
    },
    Redis: function MockIORedis2() {
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

const idToNetwork: Record<string, SocialNetwork> = {
  "acc-bluesky": SocialNetwork.BLUESKY,
  "acc-mastodon": SocialNetwork.MASTODON,
  "acc-telegram": SocialNetwork.TELEGRAM,
  "acc-linkedin": SocialNetwork.LINKEDIN,
  "acc-x": SocialNetwork.X,
};

describe("E2E: Phase 2 social posting (Bluesky, Mastodon, Telegram, LinkedIn)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let originalEnabledNetworks: string | undefined;

  beforeAll(async () => {
    sharedRedisStore.clear();
    originalEnabledNetworks = process.env.ENABLED_NETWORKS;
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK,BLUESKY,MASTODON,TELEGRAM,LINKEDIN";

    prisma = createMockPrismaService();

    const postStore = new Map<string, Record<string, unknown>>();
    for (const id of ["post-bluesky-1", "post-mastodon-1", "post-telegram-1", "post-linkedin-1"]) {
      const post = createPostById(id);
      if (post) postStore.set(id, post);
    }

    // Account lookup: return an active account matching the requested accountId.
    prisma.socialAccount.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const id = where.id;
      const network = idToNetwork[id] ?? SocialNetwork.X;
      return Promise.resolve({
        id,
        network,
        handle: `test_${id}`,
        credentialsRef: `SOCIAL_${network}_USERNAME`,
        active: true,
        warmupEnabled: false,
        warmupStartedAt: null,
        warmupDaysTotal: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    // Return an active session for any queried account.
    prisma.session.findFirst.mockImplementation(({ where }: { where: { accountId?: string } }) => {
      const accountId = where?.accountId ?? "acc-x";
      return Promise.resolve({
        id: `sess-${accountId}`,
        accountId,
        storageState: { cookies: [], origins: [] },
        status: "ACTIVE",
        lastHealthCheck: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    prisma.session.upsert.mockImplementation(({ create }: { create: { accountId?: string } }) =>
      Promise.resolve({
        id: `sess-${create.accountId ?? "x"}`,
        accountId: create.accountId ?? "acc-x",
        storageState: { cookies: [], origins: [] },
        status: "ACTIVE",
        lastHealthCheck: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    // Post lookup by ID.
    prisma.post.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      return Promise.resolve(postStore.get(where.id) ?? null);
    });

    prisma.post.update.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = postStore.get(where.id);
        if (!existing) return Promise.resolve(null);
        const updated = { ...existing, ...data };
        postStore.set(where.id, updated);
        return Promise.resolve(updated);
      },
    );

    prisma.post.findMany.mockResolvedValue([]);

    await restoreAllDesignParamtypes();

    const queueFactory = {
      createQueue: vi.fn().mockReturnValue({ add: vi.fn(), close: vi.fn() }),
      createWorker: vi.fn().mockReturnValue({ close: vi.fn() }),
      registerWorker: vi.fn(),
      closeAll: vi.fn(),
    } as unknown as QueueFactory;

    const blueskyPoster = {
      post: vi
        .fn()
        .mockResolvedValue({ url: "https://bsky.app/profile/test.bsky.social/post/3k2" }),
    } as unknown as BlueskyPoster;

    const mastodonPoster = {
      post: vi.fn().mockResolvedValue({ url: "https://mastodon.social/@test/123456" }),
    } as unknown as MastodonPoster;

    const linkedinSocialPoster = {
      post: vi
        .fn()
        .mockResolvedValue({ url: "https://www.linkedin.com/feed/update/urn:li:activity:123456" }),
    } as unknown as LinkedinSocialPoster;

    const telegramAdapter = {
      postMessage: vi.fn().mockResolvedValue({ url: "https://t.me/testchannel/123" }),
    } as unknown as TelegramAdapter;

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
      .overrideProvider(BlueskyPoster)
      .useValue(blueskyPoster)
      .overrideProvider(MastodonPoster)
      .useValue(mastodonPoster)
      .overrideProvider(LinkedinSocialPoster)
      .useValue(linkedinSocialPoster)
      .overrideProvider(TelegramAdapter)
      .useValue(telegramAdapter)
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
        getMergedTrending: () => Promise.resolve([]),
        getCacheStatus: () => Promise.resolve({ googleTrends: null, xTrends: null }),
      })
      .overrideProvider(BrowserFactory)
      .useValue({})
      .overrideProvider(LlmService)
      .useValue({ onModuleInit: vi.fn(), generate: vi.fn() })
      .overrideProvider(GenerationService)
      .useValue({
        generate: vi.fn().mockResolvedValue("run-1"),
        generateSocialPromo: vi.fn().mockResolvedValue(null),
      })
      .overrideProvider(HealthController)
      .useValue({ check: vi.fn() })
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
      .overrideProvider(RateLimitService)
      .useValue({
        onModuleInit: vi.fn(),
        onModuleDestroy: vi.fn(),
        checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
        recordPost: vi.fn().mockResolvedValue({ allowed: true, dailyCount: 0, weeklyCount: 0 }),
      })
      .overrideProvider(HealthMonitorService)
      .useValue({ checkHealth: vi.fn(), reconcile: vi.fn() })
      .overrideProvider(CronService)
      .useValue({ onModuleInit: vi.fn() })
      .overrideProvider(WarmupService)
      .useValue({
        isWarmupAccount: vi.fn().mockResolvedValue(false),
        canPost: vi.fn().mockResolvedValue(true),
        recordPost: vi.fn(),
      })
      .overrideProvider(MetricsScraperService)
      .useValue({
        collectMetrics: vi.fn().mockResolvedValue({ collected: 0, failed: 0, skipped: 0 }),
      })
      .overrideProvider(ContentReader)
      .useValue({
        getTopics: vi.fn().mockResolvedValue([]),
        readBriefs: vi.fn().mockResolvedValue([]),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (originalEnabledNetworks !== undefined) {
      process.env.ENABLED_NETWORKS = originalEnabledNetworks;
    } else {
      delete process.env.ENABLED_NETWORKS;
    }
  });

  beforeEach(() => {
    clearHookCache();
  });

  it("E2E-PHASE2-01: POST /posting/:postId posts to Bluesky and returns a postUrl", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-bluesky-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toMatch(/bsky\.app/);
  });

  it("E2E-PHASE2-02: POST /posting/:postId posts to Mastodon and returns a postUrl", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-mastodon-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toMatch(/mastodon/);
  });

  it("E2E-PHASE2-03: POST /posting/:postId posts to Telegram and returns a postUrl", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-telegram-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toMatch(/t\.me/);
  });

  it("E2E-PHASE2-04: POST /posting/:postId posts to LinkedIn social and returns a postUrl", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/posting/post-linkedin-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toMatch(/linkedin\.com/);
  });
});

function createPostById(id: string): Record<string, unknown> | undefined {
  if (id === "post-bluesky-1") {
    return postFixture("post-bluesky-1", SocialNetwork.BLUESKY, "acc-bluesky", "Bluesky test post");
  }
  if (id === "post-mastodon-1") {
    return postFixture(
      "post-mastodon-1",
      SocialNetwork.MASTODON,
      "acc-mastodon",
      "Mastodon test post",
    );
  }
  if (id === "post-telegram-1") {
    return postFixture(
      "post-telegram-1",
      SocialNetwork.TELEGRAM,
      "acc-telegram",
      "Telegram test post",
    );
  }
  if (id === "post-linkedin-1") {
    return postFixture(
      "post-linkedin-1",
      SocialNetwork.LINKEDIN,
      "acc-linkedin",
      "LinkedIn social test post",
    );
  }
  return undefined;
}

function postFixture(
  id: string,
  network: SocialNetwork,
  accountId: string,
  content: string,
): Record<string, unknown> {
  return {
    id,
    accountId,
    network,
    content,
    contentType: ContentType.SOCIAL_POST,
    status: PostStatus.APPROVED,
    postUrl: null,
    errorMessage: null,
    retryCount: 0,
    threadId: null,
    threadPosition: 0,
    createdAt: new Date(),
    approvedAt: new Date(),
    postedAt: null,
  };
}
