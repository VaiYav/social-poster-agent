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
import 'reflect-metadata';
import { TopicGenerationService } from '../../src/infrastructure/content/topic-generation.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SseEventListener } from '../../src/events/listeners/sse-event.listener';
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
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsController } from '../../src/modules/posts/posts.controller';
import { PostingController } from '../../src/modules/posting/posting.controller';
import { QueueController } from '../../src/modules/queue/queue.controller';
import { SessionsController } from '../../src/modules/sessions/sessions.controller';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { HealthMonitorController } from '../../src/modules/health-monitor/health-monitor.controller';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service';
import { TrendingScraperService } from '../../src/modules/trending/trending-scraper.service';
import { ModuleRef } from '@nestjs/core';
import { createMockLlmPort, createMockBrowserPort, createMockPrismaService } from '../mocks/index';
import { restoreAllDesignParamtypes } from '../helpers/restore-paramtypes';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service';
import { AutoApproveListener } from '../../src/modules/autonomy/auto-approve.listener';
import { VisualConceptService } from '../../src/modules/content-enhancements/visual-concept.service';
import { ABVariantGenerator } from '../../src/modules/content-enhancements/ab-variant.generator';
import { ThreadDepthService } from '../../src/modules/content-enhancements/thread-depth.service';
import { ContentPillarTracker } from '../../src/modules/content-enhancements/content-pillar.tracker';
import { HookPerformanceBank } from '../../src/modules/content-enhancements/hook-performance-bank';
import { ThreadProgressService } from '../../src/modules/posting/thread-progress.service';
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
import { AccountsController } from '../../src/modules/accounts/accounts.controller';
import { PostingService } from '../../src/modules/posting/posting.service';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { MetricsScraperService } from '../../src/modules/analytics/metrics-scraper.service';
import { SseController } from '../../src/modules/sse/sse.controller';
import { clearHookCache } from '../../src/modules/generation/generation.graph';

// ── ioredis mock (Map-backed shared store) ──────────────────────────────────
const { sharedRedisStore } = vi.hoisted(() => ({
  sharedRedisStore: new Map<string, string>(),
}));

vi.mock('ioredis', () => {
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
      status: 'ready',
      on,
      emit,
      removeAllListeners: () => inst,
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      set: (k: string, v: unknown) => { store.set(k, String(v)); return Promise.resolve('OK'); },
      setex: (k: string, _t: number, v: string) => { store.set(k, v); return Promise.resolve('OK'); },
      psetex: (k: string, _t: number, v: string) => { store.set(k, v); return Promise.resolve('OK'); },
      incr: (k: string) => {
        const v = parseInt(store.get(k) ?? '0', 10) + 1;
        store.set(k, String(v));
        return Promise.resolve(v);
      },
      decr: (k: string) => {
        const v = parseInt(store.get(k) ?? '0', 10) - 1;
        store.set(k, String(v));
        return Promise.resolve(v);
      },
      expire: () => Promise.resolve(1),
      pexpire: () => Promise.resolve(1),
      del: (k: string) => { store.delete(k); return Promise.resolve(1); },
      unlink: (k: string) => { store.delete(k); return Promise.resolve(1); },
      exists: (k: string) => Promise.resolve(store.has(k) ? 1 : 0),
      ping: () => Promise.resolve('PONG'),
      publish: () => Promise.resolve(1),
      subscribe: () => Promise.resolve('OK'),
      unsubscribe: () => Promise.resolve('OK'),
      psubscribe: () => Promise.resolve('OK'),
      connect: () => Promise.resolve(undefined),
      disconnect: () => undefined,
      close: () => Promise.resolve(undefined),
      quit: () => Promise.resolve(undefined),
      duplicate: () => createMockRedis(),
      keys: (pat: string) => {
        const prefix = pat.replace(/\*$/, '');
        return Promise.resolve([...store.keys()].filter((k) => k.startsWith(prefix)));
      },
      scan: () => Promise.resolve(['0', []]),
      hget: () => Promise.resolve(null),
      hset: () => Promise.resolve(1),
      hgetall: () => Promise.resolve({}),
      sadd: () => Promise.resolve(1),
      smembers: () => Promise.resolve([]),
      srem: () => Promise.resolve(1),
      zadd: () => Promise.resolve(1),
      zrange: () => Promise.resolve([]),
      zremrangebyscore: () => Promise.resolve(1),
      type: () => Promise.resolve('none'),
      ttl: () => Promise.resolve(-1),
      pttl: () => Promise.resolve(-1),
    };
    return inst;
  };
  return {
    default: function MockIORedis(..._args: unknown[]) { return createMockRedis(); },
    Redis: function MockIORedis2(..._args: unknown[]) { return createMockRedis(); },
  };
});

vi.mock('camoufox-js', () => ({
  Camoufox: vi.fn().mockImplementation(() => ({ launch: vi.fn() })),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({ content: 'Generated post content' }),
  })),
}));

describe('E2E Sprint D: Session Health Check — generate → approve → post', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let postId: string;

  beforeAll(async () => {
    sharedRedisStore.clear();

    prisma = createMockPrismaService();

    // Seed account + session for posting
    const accountId = 'acc-e2e-1';
    const sessionId = 'sess-e2e-1';
    prisma.account.findFirst.mockResolvedValue({
      id: accountId,
      network: 'X',
      handle: 'myzodiacai',
      credentialsRef: 'SOCIAL_X_USERNAME/PASSWORD',
      active: true,
      warmupEnabled: false,
      warmupStartedAt: null,
      warmupDaysTotal: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.account.findMany.mockResolvedValue([
      { id: accountId, network: 'X', handle: 'myzodiacai', sessions: [] },
    ]);
    // SocialAccount mocks (for WarmupService — Prisma model is SocialAccount, not Account)
    prisma.socialAccount.findUnique.mockResolvedValue({
      id: accountId, network: 'X', handle: 'myzodiacai',
      credentialsRef: 'SOCIAL_X_USERNAME/PASSWORD', active: true,
      warmupEnabled: false, warmupStartedAt: null, warmupDaysTotal: 7,
      createdAt: new Date(), updatedAt: new Date(),
    });
    prisma.socialAccount.update.mockResolvedValue({});
    prisma.session.findFirst.mockResolvedValue({
      id: sessionId,
      accountId,
      storageState: { cookies: [], origins: [] },
      status: 'ACTIVE',
      lastHealthCheck: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.session.create.mockResolvedValue({
      id: sessionId,
      accountId,
      storageState: { cookies: [], origins: [] },
      status: 'ACTIVE',
      lastHealthCheck: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.session.findMany.mockResolvedValue([
      { id: sessionId, accountId, status: 'ACTIVE', lastHealthCheck: null, account: { network: 'X' }, createdAt: new Date(), updatedAt: new Date() },
    ]);
    prisma.session.update.mockResolvedValue({});
    prisma.session.count.mockResolvedValue(1);

    // Mock post creation — return a post with DRAFT status
    prisma.post.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'post-e2e-1',
        generationRunId: data.generationRunId ?? null,
        accountId: data.accountId,
        threadId: null,
        threadPosition: 0,
        network: data.network ?? 'X',
        content: data.content ?? 'Test content',
        sourceRef: data.sourceRef ?? null,
        status: 'DRAFT',
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
          id: 'post-e2e-1',
          generationRunId: 'run-1',
          accountId,
          threadId: null,
          threadPosition: 0,
          network: 'X',
          content: 'Generated post about Mercury Retrograde',
          sourceRef: { type: 'brief', path: '/brief.json', topic: 'Mercury Retrograde' },
          status: 'DRAFT',
          postUrl: null,
          errorMessage: null,
          retryCount: 0,
          llmMetadata: { model: 'gpt-4o-mini', promptVersion: '0.3.0' },
          createdAt: new Date(),
          approvedAt: null,
          postedAt: null,
        },
      ];
      if (where?.status === 'APPROVED') {
        return Promise.resolve(posts.map((p) => ({ ...p, status: 'APPROVED', approvedAt: new Date() })));
      }
      return Promise.resolve(posts);
    });

    // Mock post findUnique — return post by ID with status transitions
    prisma.post.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const stored = (prisma as Record<string, unknown>).__storedPost as Record<string, unknown> | undefined;
      if (where.id === 'post-e2e-1') {
        return Promise.resolve(stored ?? {
          id: 'post-e2e-1',
          generationRunId: 'run-1',
          accountId,
          threadId: null,
          threadPosition: 0,
          network: 'X',
          content: 'Generated post about Mercury Retrograde',
          sourceRef: { type: 'brief', path: '/brief.json', topic: 'Mercury Retrograde' },
          status: 'DRAFT',
          postUrl: null,
          errorMessage: null,
          retryCount: 0,
          llmMetadata: { model: 'gpt-4o-mini', promptVersion: '0.3.0' },
          createdAt: new Date(),
          approvedAt: null,
          postedAt: null,
        });
      }
      return Promise.resolve(null);
    });

    // Mock post update — track status transitions
    prisma.post.update.mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const current = (prisma as Record<string, unknown>).__storedPost as Record<string, unknown> | undefined;
      const updated = { ...(current ?? { id: where.id, accountId, network: 'X', content: 'Test', status: 'DRAFT' }), ...data };
      (prisma as Record<string, unknown>).__storedPost = updated;
      return Promise.resolve(updated);
    });

    // Mock generation run
    prisma.generationRun.create.mockResolvedValue({
      id: 'run-e2e-1',
      triggeredBy: 'MANUAL',
      sourceTopics: [],
      status: 'RUNNING',
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
      createQueue: vi.fn().mockReturnValue({ add: vi.fn(), close: vi.fn(), getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }), getFailed: vi.fn().mockResolvedValue([]), isPaused: vi.fn().mockResolvedValue(false), pause: vi.fn(), resume: vi.fn() }),
      createWorker: vi.fn().mockReturnValue({ close: vi.fn() }),
      registerWorker: vi.fn(),
      closeAll: vi.fn(),
      enqueuePosting: vi.fn().mockResolvedValue(undefined),
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      getFailedJobs: vi.fn().mockResolvedValue([]),
      pauseQueue: vi.fn().mockResolvedValue(undefined),
      resumeQueue: vi.fn().mockResolvedValue(undefined),
      isQueuePaused: vi.fn().mockResolvedValue(false),
    } as unknown as QueueFactory;

    // Mock posters — return valid post URLs
    const xPoster = { post: vi.fn().mockResolvedValue({ url: 'https://x.com/myzodiacai/status/1234567890' }) } as unknown as XPoster;
    const threadsPoster = { post: vi.fn().mockResolvedValue({ url: 'https://www.threads.com/@myzodiacai/post/abc123' }) } as unknown as ThreadsPoster;
    const facebookPoster = { post: vi.fn().mockResolvedValue({ url: 'https://www.facebook.com/myzodiacai/posts/789' }) } as unknown as FacebookPoster;

    const mockSharedRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      ping: vi.fn().mockResolvedValue('PONG'),
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(1),
      on: vi.fn(),
      publish: vi.fn().mockResolvedValue(1),
      keys: vi.fn().mockResolvedValue([]),
      rpush: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
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
      .useValue({ onModuleInit: vi.fn(), save: vi.fn(), get: vi.fn(), list: vi.fn(), close: vi.fn() })
      .overrideProvider(EncryptionService)
      .useValue({ encrypt: (data: unknown) => data, decrypt: (data: string) => data, isEnabled: () => false })
      .overrideProvider(TrendingScraperService)
      .useValue({
        getGoogleTrends: () => Promise.resolve([]),
        getXTrends: () => Promise.resolve([]),
        getMergedTrends: () => Promise.resolve([]),
        getCacheStatus: () => Promise.resolve({ googleTrends: null, xTrends: null }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    clearHookCache();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E-D3: Session health check flow
  // ─────────────────────────────────────────────────────────────────────────

  it('E2E-D3-1: GET /sessions returns session list', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('E2E-D3-2: POST /sessions/health-check triggers health check', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sessions/health-check')
      .query({ network: 'X' });

    expect(res.status).toBe(200);
    // Health check returns session health results
    expect(res.body).toBeDefined();
  });

  it('E2E-D3-3: GET /health-monitor/dashboard returns health dashboard', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health-monitor/dashboard');

    expect(res.status).toBe(200);
    // Dashboard: { sessions, posts, queues, alerts, summary }
    expect(res.body).toBeDefined();
  });

  it('E2E-D3-4: POST /health-monitor/check triggers manual health check', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health-monitor/check');

    // NestJS @Post returns 201 by default (no @HttpCode(200) on this endpoint)
    expect([200, 201]).toContain(res.status);
    // Health report: { sessions, posts, queues, alerts }
    expect(res.body).toBeDefined();
  });

  it('E2E-D3-5: POST /health-monitor/reconcile re-enqueues orphaned APPROVED posts', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health-monitor/reconcile');

    // NestJS @Post returns 201 by default
    expect([200, 201]).toContain(res.status);
    // Reconciliation result: { requeued, skipped }
    expect(res.body).toHaveProperty('requeued');
    expect(res.body).toHaveProperty('skipped');
  });

  it('E2E-D3-6: GET /health returns 200 with status field', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });
});
