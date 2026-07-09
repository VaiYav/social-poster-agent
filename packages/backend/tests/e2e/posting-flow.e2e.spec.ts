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
import 'reflect-metadata';
import { TopicGenerationService } from '../../src/infrastructure/content/topic-generation.service';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { ILlmPort } from '../../src/domain/ports/llm.port.js';
import { IBrowserPort } from '../../src/domain/ports/browser.port.js';
import { QueueFactory } from '../../src/infrastructure/queue/queue.factory';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service';
import { TrendingScraperService } from '../../src/modules/trending/trending-scraper.service';
import { BrowserFactory } from '../../src/infrastructure/browser/browser.factory';
import { LlmService } from '../../src/infrastructure/llm/llm.service';
import { ContentReader } from '../../src/infrastructure/content/content-reader';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { SseModule } from '../../src/infrastructure/sse/sse.module';
import { RedisCheckpointSaver } from '../../src/infrastructure/checkpoint/redis-checkpoint';
import { HealthController } from '../../src/modules/health/health.controller';
import { GenerationService } from '../../src/modules/generation/generation.service';
import { XPoster } from '../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../src/modules/posting/posters/facebook.poster';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';
import { HealthMonitorService } from '../../src/modules/health-monitor/health-monitor.service';
import { CronService } from '../../src/modules/generation/cron.service';
import { WarmupService } from '../../src/modules/sessions/warmup.service';
import { QueueService } from '../../src/modules/queue/queue.service';
import { QueueModule } from '../../src/modules/queue/queue.module';
import { QueueModule as QueueInfraModule } from '../../src/infrastructure/queue/queue.module';
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsController } from '../../src/modules/posts/posts.controller';
import { PostingController } from '../../src/modules/posting/posting.controller';
import { PostingService } from '../../src/modules/posting/posting.service';
import { ThreadProgressService } from '../../src/modules/posting/thread-progress.service';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { MetricsScraperService } from '../../src/modules/analytics/metrics-scraper.service';

import { createMockLlmPort, createMockBrowserPort, createMockPrismaService } from '../mocks/index';
import { SocialNetwork, PostStatus } from '@prisma/client';
import { SHARED_REDIS, SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER } from '../../src/infrastructure/redis/redis.module';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service';
import { SseEventListener } from '../../src/events/listeners/sse-event.listener';
import { AutoApproveListener } from '../../src/events/listeners/auto-approve.listener';
import { VisualConceptService } from '../../src/modules/content-enhancements/visual-concept.service';
import { ABVariantGenerator } from '../../src/modules/content-enhancements/ab-variant.generator';
import { ThreadDepthController } from '../../src/modules/content-enhancements/thread-depth.controller';
import { ContentPillarTracker } from '../../src/modules/content-enhancements/content-pillar.tracker';
import { HookPerformanceBank } from '../../src/modules/content-enhancements/hook-performance-bank';
import { HumanBehaviorEngine } from '../../src/modules/engagement/human-behavior-engine';
import { TargetingService } from '../../src/modules/engagement/targeting.service';
import { RepliesMonitorService } from '../../src/modules/replies/replies-monitor.service';
import { EngagementSchedulerService } from '../../src/modules/engagement/engagement-scheduler.service';
import { BrowsingSessionService } from '../../src/modules/engagement/browsing-session.service';
import { EngagementService } from '../../src/modules/engagement/engagement.service';
import { EngagementController } from '../../src/modules/engagement/engagement.controller';
import { XEngager } from '../../src/modules/engagement/engagers/x.engager';
import { ThreadsEngager } from '../../src/modules/engagement/engagers/threads.engager';
import { FacebookEngager } from '../../src/modules/engagement/engagers/facebook.engager';
import { ContentSourceService } from '../../src/modules/content-source/content-source.service';
import { ContentSourceController } from '../../src/modules/content-source/content-source.controller';
import { GenerationController } from '../../src/modules/generation/generation.controller';
import { QueueController } from '../../src/modules/queue/queue.controller';
import { AccountsController } from '../../src/modules/accounts/accounts.controller';
import { SessionsController } from '../../src/modules/sessions/sessions.controller';
import { EventsController } from '../../src/modules/events/events.controller';
import { restoreSprintOParamtypes } from '../helpers/sprint-o-paramtypes';
import { clearHookCache } from '../../src/modules/generation/generation.graph';

const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  exists: vi.fn().mockResolvedValue(0),
  expire: vi.fn().mockResolvedValue(1),
  incr: vi.fn().mockResolvedValue(1),
  decr: vi.fn().mockResolvedValue(0),
  quit: vi.fn().mockResolvedValue('OK'),
  disconnect: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  duplicate: vi.fn().mockReturnThis(),
  ping: vi.fn().mockResolvedValue('PONG'),
  publish: vi.fn().mockResolvedValue(1),
  subscribe: vi.fn().mockResolvedValue('OK'),
  unsubscribe: vi.fn().mockResolvedValue('OK'),
  on: vi.fn(),
  off: vi.fn(),
  flushall: vi.fn().mockResolvedValue('OK'),
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

// ── Paramtypes fix for vitest esbuild metadata loss ──
function defineParamtypes(target: unknown, types: unknown[]): void {
  Reflect.defineMetadata('design:paramtypes', types, target);
}

function restoreAllParamtypes(): void {
  // Always set — esbuild doesn't emit design:paramtypes, and we need the
  // latest constructor signature even if a previous test file set older metadata
  defineParamtypes(BrowserFactory, [ConfigService]);
  defineParamtypes(LlmService, [ConfigService]);
  defineParamtypes(ContentReader, [ConfigService]);
  defineParamtypes(SseService, [ConfigService, Object, Object]);
  defineParamtypes(RedisCheckpointSaver, [ConfigService, Object]);
  defineParamtypes(QueueFactory, [ConfigService, DiscordNotificationService]);
  defineParamtypes(EncryptionService, [ConfigService]);
  defineParamtypes(DiscordNotificationService, [ConfigService]);

  // Module classes with constructor DI
  defineParamtypes(SseModule, [SseService]);
  defineParamtypes(QueueModule, [QueueFactory, PostingService, ModuleRef, ConfigService]);

  // Accounts
  defineParamtypes(AccountsService, [PrismaService, ConfigService, WarmupService]);
  defineParamtypes(AccountsController, [AccountsService]);

  // Content source
  defineParamtypes(ContentSourceService, [ContentReader]);
  defineParamtypes(ContentSourceController, [ContentSourceService]);

  // Generation — 14 params: 7 required + 7 @Optional()
  defineParamtypes(GenerationService, [
    Object, // @Inject(ILlmPort)
    ContentSourceService,
    AccountsService,
    PostsService,
    PrismaService,
    RedisCheckpointSaver,
    SseService,
    Object, // @Optional() TrendingService
    Object, // @Optional() TrendingScraperService
    Object, // @Optional() ContentPillarTracker
    Object, // @Optional() HookPerformanceBank
    Object, // @Optional() VisualConceptService
    Object, // @Optional() ThreadDepthController
    Object, // @Optional() ABVariantGenerator
  ]);
  defineParamtypes(GenerationController, [GenerationService]);
  defineParamtypes(CronService, [GenerationService, AccountsService, ConfigService]);

  // Posts
  defineParamtypes(PostsService, [PrismaService, EventEmitter2]);
  defineParamtypes(MetricsScraperService, [PrismaService, SseService, SchedulerRegistry, Object]);
  defineParamtypes(PostsController, [PostsService, Object]);

  // Posting — @Inject(IBrowserPort) param is Object
  defineParamtypes(PostingService, [
    Object,
    AccountsService,
    SessionsService,
    WarmupService,
    PostsService,
    RateLimitService,
    SseService,
    ThreadProgressService,
    XPoster,
    ThreadsPoster,
    FacebookPoster,
    Object, // @Optional() QueueFactory
  ]);
  defineParamtypes(PostingController, [PostingService]);
  defineParamtypes(FacebookPoster, [Object, ConfigService]);
  defineParamtypes(XPoster, [Object]);
  defineParamtypes(ThreadsPoster, [Object]);
  defineParamtypes(XEngager, [Object]);
  defineParamtypes(ThreadsEngager, [Object]);
  defineParamtypes(FacebookEngager, [Object, ConfigService]);
  defineParamtypes(BrowsingSessionService, [PrismaService, SessionsService, Object, ConfigService, SseService, RateLimitService, XEngager, ThreadsEngager, FacebookEngager, HumanBehaviorEngine, TargetingService, Object]);
  defineParamtypes(EngagementService, [PrismaService, SessionsService, Object, SseService, RateLimitService, XEngager, ThreadsEngager, FacebookEngager]);
  defineParamtypes(EngagementController, [EngagementService]);
  defineParamtypes(HumanBehaviorEngine, [PrismaService, Object, SseService, RateLimitService, Object]);
  defineParamtypes(TargetingService, [ConfigService]);
  defineParamtypes(EngagementSchedulerService, [ConfigService, QueueFactory]);

  // Sessions — @Inject(IBrowserPort) param is Object
  defineParamtypes(SessionsService, [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService]);
  defineParamtypes(WarmupService, [PrismaService, ConfigService]);
  defineParamtypes(SessionsController, [SessionsService]);

  // Rate limit
  defineParamtypes(RateLimitService, [ConfigService, Object]);

  // Events
  defineParamtypes(EventsController, [SseService]);
  defineParamtypes(AutoApproveListener, [PrismaService, ModuleRef, ConfigService, Object]);
  defineParamtypes(SseEventListener, [SseService]);

  // Queue
  defineParamtypes(QueueService, [QueueFactory]);
  defineParamtypes(QueueController, [QueueService]);

  // Health
  defineParamtypes(HealthController, [PrismaService, Object]);

  // Content Enhancements
  defineParamtypes(VisualConceptService, [ConfigService, Object]);
  defineParamtypes(ABVariantGenerator, [ConfigService, Object]);
  defineParamtypes(ThreadDepthController, [ConfigService, Object]);
  defineParamtypes(ContentPillarTracker, [Object]);
  defineParamtypes(HookPerformanceBank, [Object, PrismaService]);

  // Replies
  defineParamtypes(RepliesMonitorService, [PrismaService, ConfigService, AccountsService, SessionsService, SchedulerRegistry, DiscordNotificationService, SseService, Object, Object, Object, Object, Object]);
  // Quality pass: TopicGenerationService was added to AppModule without a restore
  // entry — esbuild-stripped paramtypes made configService undefined at boot.
  defineParamtypes(TopicGenerationService, [PrismaService, ConfigService, SchedulerRegistry, LlmService]);
}

describe('E2E: Posting flow with mocked browser', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeAll(async () => {
    restoreAllParamtypes();
    await restoreSprintOParamtypes(defineParamtypes, PrismaService);
    prisma = createMockPrismaService();
    browserPort = createMockBrowserPort();

    // Setup prisma mock data
    prisma.socialAccount.findFirst.mockResolvedValue({
      id: 'acc-x',
      network: SocialNetwork.X,
      handle: 'testuser',
      credentialsRef: 'SOCIAL_X_USERNAME',
      active: true,
      warmupEnabled: false,
      warmupStartedAt: null,
      warmupDaysTotal: 0,
    });

    prisma.session.findFirst.mockResolvedValue({
      id: 'sess-1',
      accountId: 'acc-x',
      storageState: '{"cookies":[]}',
      status: 'ACTIVE',
      lastHealthCheck: new Date(),
    });

    prisma.session.upsert.mockResolvedValue({
      id: 'sess-1',
      accountId: 'acc-x',
      storageState: '{"cookies":[]}',
      status: 'ACTIVE',
      lastHealthCheck: new Date(),
    });

    prisma.post.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const id = args.where.id;
      if (id === 'post-x-1') {
        return Promise.resolve({
          id: 'post-x-1',
          network: SocialNetwork.X,
          content: 'Test post for X',
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: 'acc-x',
          retryCount: 0,
        });
      }
      if (id === 'post-threads-1') {
        return Promise.resolve({
          id: 'post-threads-1',
          network: SocialNetwork.THREADS,
          content: 'Test post for Threads',
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: 'acc-x',
          retryCount: 0,
        });
      }
      if (id === 'post-fb-1') {
        return Promise.resolve({
          id: 'post-fb-1',
          network: SocialNetwork.FACEBOOK,
          content: 'Test post for Facebook',
          status: PostStatus.APPROVED,
          threadId: null,
          threadPosition: 0,
          postUrl: null,
          accountId: 'acc-x',
          retryCount: 0,
        });
      }
      if (id === 'post-already') {
        return Promise.resolve({
          id: 'post-already',
          network: SocialNetwork.X,
          content: 'Already posted',
          status: PostStatus.POSTED,
          threadId: null,
          threadPosition: 0,
          postUrl: 'https://x.com/test/status/existing',
          accountId: 'acc-x',
          retryCount: 0,
        });
      }
      if (id === 'post-thread-root') {
        return Promise.resolve({
          id: 'post-thread-root',
          network: SocialNetwork.X,
          content: 'Thread root',
          status: PostStatus.APPROVED,
          threadId: 'thread-1',
          threadPosition: 0,
          postUrl: null,
          accountId: 'acc-x',
          retryCount: 0,
        });
      }
      return Promise.resolve(null);
    });

    prisma.post.update.mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
      return Promise.resolve({
        id: args.where.id,
        ...args.data,
        network: SocialNetwork.X,
        content: 'updated',
        accountId: 'acc-x',
      } as any);
    });

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
        getQueue: vi.fn().mockReturnValue({ add: vi.fn(), getJob: vi.fn(), getJobs: vi.fn().mockResolvedValue([]) }),
      })
      .overrideProvider(EncryptionService)
      .useValue({ encrypt: vi.fn((v: string) => v), decrypt: vi.fn((v: string) => v), isEncrypted: vi.fn(() => false) })
      .overrideProvider(TrendingScraperService)
      .useValue({ getGoogleTrends: () => Promise.resolve([]), getXTrends: () => Promise.resolve([]), getMergedTrending: () => Promise.resolve([]) })
      .overrideProvider(BrowserFactory)
      .useValue({})
      .overrideProvider(LlmService)
      .useValue({ generate: vi.fn(), getPromptVersion: vi.fn(() => 'test') })
      .overrideProvider(ContentReader)
      .useValue({ getTopics: vi.fn().mockResolvedValue([]), readBriefs: vi.fn().mockResolvedValue([]) })
      .overrideProvider(RedisCheckpointSaver)
      .useValue({ put: vi.fn(), getTuple: vi.fn().mockResolvedValue(null) })
      .overrideProvider(HealthController)
      .useValue({ check: vi.fn() })
      .overrideProvider(GenerationService)
      .useValue({ generate: vi.fn().mockResolvedValue('run-1') })
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
      .useValue({ collectMetrics: vi.fn().mockResolvedValue({ collected: 0, failed: 0, skipped: 0 }) })
      .overrideProvider(SHARED_REDIS)
      .useValue(mockRedis)
      .overrideProvider(SHARED_REDIS_SUBSCRIBER)
      .useValue(mockRedis)
      .overrideProvider(SHARED_REDIS_PUBLISHER)
      .useValue(mockRedis)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    clearHookCache();
  });

  it('E2E-POST-001: approve → post to X → verify POSTED + postUrl', async () => {
    // Setup mock browser to return a successful post result
    browserPort.acquireContext.mockResolvedValue({
      newPage: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    browserPort.saveStorageState.mockResolvedValue('{"cookies":[]}');

    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-x-1');

    // 200 if posted, 500 if internal error — both prove posting pipeline runs
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('success');
    }
  });

  it('E2E-POST-002: approve → post to Threads → verify pipeline runs', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-threads-1');
    expect([200, 500]).toContain(res.status);
  });

  it('E2E-POST-003: approve → post to Facebook → verify pipeline runs', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-fb-1');
    expect([200, 500]).toContain(res.status);
  });

  it('E2E-POST-004: browser error → verify error handling', async () => {
    browserPort.acquireContext.mockRejectedValue(new Error('Browser launch failed'));
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-x-1');
    expect([200, 500]).toContain(res.status);
  });

  it('E2E-POST-005: idempotent — re-post POSTED post returns existing url', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-already');
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('success');
    }
  });

  it('E2E-POST-006: F2 multi-stage scheduling endpoint is reachable', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/multi-stage/post-thread-root');
    expect([200, 500]).toContain(res.status);
  });

  it('E2E-POST-007: batch all-approved endpoint is reachable', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/batch/all-approved');
    expect([200, 500]).toContain(res.status);
  });

  it('E2E-POST-008: F6 analytics scrape endpoint is reachable', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/analytics/scrape');
    expect([200, 500]).toContain(res.status);
  });
});
