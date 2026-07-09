/**
 * Top-Down Integration Tests — Social Poster Agent (SPA)
 *
 * Technique: Top-Down (ISO/IEC/IEEE 29119:2021)
 * Tests high-level modules first, stubbing lower-level external ports.
 *
 * Coverage (11 ITCs):
 *   ITC-001: Generation → LLM Port (ILlmPort.generateChat called 4× per post)
 *   ITC-002: Generation → Content Source (IContentPort.getTopics called, posts created)
 *   ITC-003: Generation → Posts (dedup check via findBySourceAndNetwork)
 *   ITC-004: Generation → Checkpoint (RedisCheckpointSaver.put called during graph invoke)
 *   ITC-005: Generation → Posts (markRunCompleted updates DB)
 *   ITC-015: Queue → QueueInfra (QueueFactory creates per-network queues)
 *   ITC-016: Queue → Posting (enqueuePosting adds job with postId)
 *   ITC-026: Generation → Posts (multi-network: 3 topics × 3 networks = 9 posts)
 *   ITC-027: Generation → Content Source (readBriefs + readArticles fallback)
 *   ITC-032: Queue → Posting (job data contains postId, network)
 *   ITC-033: Generation → Checkpoint (resume from checkpoint after simulated crash)
 *
 * Strategy:
 *   - REAL NestJS module wiring via Test.createTestingModule (no direct instantiation)
 *   - Mock only external ports: ILlmPort, IContentPort (ContentReader), IBrowserPort
 *   - vi.mock('ioredis') → in-memory Map store (no real Redis)
 *   - vi.mock('bullmq') → captured Queue/Worker constructors (no real BullMQ)
 *   - vi.mock('node:fs/promises') → controlled filesystem for ContentReader fallback (ITC-027)
 *   - createMockPrismaService() from '../mocks/index' → override PrismaService via a
 *     global dynamic module (PrismaModule is not @Global, so we provide it globally)
 *
 * Source: CONSTITUTION.md §14 (Testing) — test case IDs are inline
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { restoreAllDesignParamtypes } from '../helpers/restore-paramtypes';
import { TopicGenerationService } from '../../src/infrastructure/content/topic-generation.service';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import type { ContentTopic } from '@spa/shared';

// ── Hoisted mocks: ioredis, bullmq, node:fs/promises ─────────────────────────
// vi.hoisted() ensures the mock objects exist before vi.mock factories run.

const ioredisMocks = vi.hoisted(() => ({
  factory: vi.fn(),
  instances: [] as Array<Record<string, unknown>>,
}));

// Each `new IORedis(url, opts)` returns an independent in-memory Redis mock.
vi.mock('ioredis', () => ({
  default: ioredisMocks.factory.mockImplementation((_url: string, _opts?: unknown) => {
    const store = new Map<string, string | string[]>();
    const inst = {
      get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      set: vi.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      setex: vi.fn((k: string, _ttl: number, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      keys: vi.fn((pat: string) => {
        const prefix = pat.replace(/\*$/, '');
        return Promise.resolve(
          [...store.keys()].filter((k) => k.startsWith(prefix)),
        );
      }),
      rpush: vi.fn((k: string, v: string) => {
        const arr = (store.get(k) as string[] | undefined) ?? [];
        arr.push(v);
        store.set(k, arr);
        return Promise.resolve(arr.length);
      }),
      lrange: vi.fn((k: string) => Promise.resolve((store.get(k) as string[] | undefined) ?? [])),
      incr: vi.fn((k: string) => {
        const v = parseInt((store.get(k) as string) ?? '0', 10) + 1;
        store.set(k, String(v));
        return Promise.resolve(v);
      }),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn((k: string) => {
        store.delete(k);
        return Promise.resolve(1);
      }),
      exists: vi.fn((k: string) => Promise.resolve(store.has(k) ? 1 : 0)),
      ping: vi.fn().mockResolvedValue('PONG'),
      quit: vi.fn().mockResolvedValue('OK'),
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockResolvedValue('OK'),
      unsubscribe: vi.fn().mockResolvedValue('OK'),
      on: vi.fn(),
      off: vi.fn(),
      disconnect: vi.fn(),
      duplicate: vi.fn().mockReturnThis(),
      _store: store,
    };
    ioredisMocks.instances.push(inst);
    return inst;
  }),
}));

const bullmqMocks = vi.hoisted(() => ({
  queueAdd: vi.fn().mockResolvedValue({ id: 'job-1' }),
  queueGetFailed: vi.fn().mockResolvedValue([]),
  queueGetJobCounts: vi.fn().mockResolvedValue({
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
  }),
  queueClose: vi.fn().mockResolvedValue(undefined),
  workerClose: vi.fn().mockResolvedValue(undefined),
  workerOn: vi.fn(),
  QueueCtor: vi.fn(),
  WorkerCtor: vi.fn(),
  // queueName → handler, captured when Worker is constructed
  workerHandlers: new Map<string, (job: unknown) => Promise<void>>(),
  // queueName → queue instance, captured when Queue is constructed
  queues: new Map<string, Record<string, unknown>>(),
}));

vi.mock('bullmq', () => ({
  Queue: bullmqMocks.QueueCtor.mockImplementation((name: string, _opts?: unknown) => {
    const q = {
      name,
      add: bullmqMocks.queueAdd,
      getFailed: bullmqMocks.queueGetFailed,
      getJobCounts: bullmqMocks.queueGetJobCounts,
      close: bullmqMocks.queueClose,
    };
    bullmqMocks.queues.set(name, q);
    return q;
  }),
  Worker: bullmqMocks.WorkerCtor.mockImplementation(
    (name: string, handler: (job: unknown) => Promise<void>, _opts?: unknown) => {
      bullmqMocks.workerHandlers.set(name, handler);
      return { name, close: bullmqMocks.workerClose, on: bullmqMocks.workerOn };
    },
  ),
}));

// node:fs/promises — used by GenerationService.loadBrandVoice (readFile) and by
// the real ContentReader (access/readdir/readFile) for ITC-027 fallback.
const fsMocks = vi.hoisted(() => ({
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

vi.mock('node:fs/promises', () => ({
  access: fsMocks.access,
  readdir: fsMocks.readdir,
  readFile: fsMocks.readFile,
}));

// node:fs — ContentModule uses existsSync to choose between filesystem (ContentReader)
// and DB-backed (DbContentReader) IContentPort implementations. ITC-027 needs the
// fs path so the real ContentReader runs against the mocked node:fs/promises.
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

// ── Real source imports (after vi.mock is hoisted) ───────────────────────────
import 'reflect-metadata';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RedisCheckpointSaver } from '../../src/infrastructure/checkpoint/redis-checkpoint';
import { HealthController } from '../../src/modules/health/health.controller';
import { ContentReader } from '../../src/infrastructure/content/content-reader';
import { ILlmPort, type ILlmPort as ILlmPortType, type LlmResponse } from '../../src/domain/ports/llm.port';
import { IBrowserPort } from '../../src/domain/ports/browser.port';
import { GenerationModule } from '../../src/modules/generation/generation.module';
import { GenerationService } from '../../src/modules/generation/generation.service';
import { GenerationController } from '../../src/modules/generation/generation.controller';
import { CronService } from '../../src/modules/generation/cron.service';
import { buildGenerationGraph, createInitialState, clearHookCache } from '../../src/modules/generation/generation.graph';
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsController } from '../../src/modules/posts/posts.controller';
import { QueueModule } from '../../src/modules/queue/queue.module';
import { QueueService } from '../../src/modules/queue/queue.service';
import { QueueController } from '../../src/modules/queue/queue.controller';
import { QueueFactory } from '../../src/infrastructure/queue/queue.factory';
import { PostingService } from '../../src/modules/posting/posting.service';
import { PostingController } from '../../src/modules/posting/posting.controller';
import { XPoster } from '../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../src/modules/posting/posters/facebook.poster';
import { ContentSourceService } from '../../src/modules/content-source/content-source.service';
import { ContentSourceController } from '../../src/modules/content-source/content-source.controller';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { AccountsController } from '../../src/modules/accounts/accounts.controller';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { SessionsController } from '../../src/modules/sessions/sessions.controller';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service.js';
import { TrendingScraperService } from '../../src/modules/trending/trending-scraper.service';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service.js';
import { NotificationsModule } from '../../src/infrastructure/notifications/notifications.module.js';
import { VisualConceptService } from '../../src/modules/content-enhancements/visual-concept.service.js';
import { ABVariantGenerator } from '../../src/modules/content-enhancements/ab-variant.generator.js';
import { ThreadDepthController } from '../../src/modules/content-enhancements/thread-depth.controller.js';
import { ContentPillarTracker } from '../../src/modules/content-enhancements/content-pillar.tracker.js';
import { HookPerformanceBank } from '../../src/modules/content-enhancements/hook-performance-bank.js';
import { SseModule } from '../../src/infrastructure/sse/sse.module';
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';
import { BrowserFactory } from '../../src/infrastructure/browser/browser.factory';
import { LlmService } from '../../src/infrastructure/llm/llm.service';
import { ConfigService } from '@nestjs/config';
import { createMockPrismaService, createMockBrowserPort } from '../mocks/index';
import { SHARED_REDIS, SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER, RedisModule } from '../../src/infrastructure/redis/redis.module';

restoreAllDesignParamtypes();


// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock PrismaService. Extends createMockPrismaService() with the
 * `socialAccount` model (used by AccountsService) which the base mock lacks.
 */
function createTestPrisma() {
  const base = createMockPrismaService();
  return {
    ...base,
    socialAccount: {
      create: vi.fn().mockResolvedValue(undefined),
      findFirst: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteMany: vi.fn().mockResolvedValue(0),
    },
  };
}

/**
 * PrismaModule is not @Global in this codebase, yet PostsService / AccountsService
 * inject PrismaService without importing PrismaModule. To make the mock available
 * to every module in the TestingModule we register it via a global dynamic module.
 */
function createMockPrismaModule(mockPrisma: ReturnType<typeof createTestPrisma>) {
  return {
    module: class MockPrismaModule {},
    global: true,
    providers: [{ provide: PrismaService, useValue: mockPrisma }],
    exports: [PrismaService],
  };
}

/** Canned LLM responses — critique deliberately avoids "GOOD"/"no changes" so refine runs.
 * Network-specific content avoids B5 SimHash dedup (Hamming distance ≤ 3) when
 * generating posts for multiple networks within the same topic.
 */
function createIntegrationLlmPort(): ILlmPortType {
  const responses: LlmResponse = {
    content: 'Mercury retrograde is coming! Reflect, not react. #astrology',
    model: 'gpt-4o-mini',
    tokens: 120,
    cost: 0.001,
  };
  const critiqueResponse: LlmResponse = {
    content: 'The draft is a bit long — consider shortening the hook.',
    model: 'gpt-4o-mini',
    tokens: 40,
    cost: 0.0005,
  };
  let draftCounter = 0;
  return {
    generate: vi.fn().mockResolvedValue(responses),
    generateChat: vi.fn().mockImplementation((sys: string, userPrompt: string) => {
      // self_critique node sends a critique prompt
      if (userPrompt.startsWith('Critique this')) return Promise.resolve(critiqueResponse);
      // Draft/refine nodes — the system prompt contains "Generate a X post" etc.
      // Return network-specific content so SimHash hashes differ sufficiently
      // (Hamming distance > 3) to avoid B5 dedup removing cross-network posts.
      const prompt = `${sys} ${userPrompt}`;
      if (prompt.includes('X post')) {
        draftCounter++;
        return Promise.resolve({
          content: `Mercury retrograde is coming! Reflect, not react. Short punchy take for X. #astrology #X${draftCounter}`,
          model: 'gpt-4o-mini',
          tokens: 120,
          cost: 0.001,
        });
      }
      if (prompt.includes('THREADS post')) {
        draftCounter++;
        return Promise.resolve({
          content: `Mercury retrograde is here. Let me tell you a story about cosmic timing and why slowing down matters now. A narrative thread for you. #astrology #THREADS${draftCounter}`,
          model: 'gpt-4o-mini',
          tokens: 120,
          cost: 0.001,
        });
      }
      if (prompt.includes('FACEBOOK post')) {
        draftCounter++;
        return Promise.resolve({
          content: `Mercury retrograde is approaching! How are you preparing for this cosmic shift? Share your thoughts below and let us navigate this together as a community. #astrology #FACEBOOK${draftCounter}`,
          model: 'gpt-4o-mini',
          tokens: 120,
          cost: 0.001,
        });
      }
      return Promise.resolve(responses);
    }),
  };
}

function makeTopic(
  path: string,
  topic: string,
  sourceType: ContentTopic['sourceType'] = 'brief',
): ContentTopic {
  return {
    sourceType,
    path,
    topic,
    keywords: ['astrology', topic.split(' ')[0]!.toLowerCase()],
    facts: ['Key fact about ' + topic],
  };
}

const ACCOUNTS: Record<string, { id: string; network: SocialNetwork; active: boolean }> = {
  X: { id: 'acc-x', network: SocialNetwork.X, active: true },
  THREADS: { id: 'acc-t', network: SocialNetwork.THREADS, active: true },
  FACEBOOK: { id: 'acc-f', network: SocialNetwork.FACEBOOK, active: true },
};

/**
 * Build a TestingModule with REAL GenerationModule wiring.
 * Mocks only ILlmPort (external LLM) and ContentReader (external filesystem adapter
 * that implements IContentPort). PrismaService is mocked via overrideProvider — the
 * recommended NestJS testing pattern that registers the override across the whole
 * TestingModule (PrismaModule is not @Global in this codebase).
 */
async function buildGenerationModule(opts: {
  llm: ILlmPortType;
  contentReader?: Partial<ContentReader>; // omit to use real ContentReader (ITC-027)
  prisma: ReturnType<typeof createTestPrisma>;
}): Promise<TestingModule> {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      createMockPrismaModule(opts.prisma),
      RedisModule, // Sprint L: Global module — provides SHARED_REDIS via mocked ioredis factory
      NotificationsModule, // Global — provides DiscordNotificationService
      EventEmitterModule.forRoot(),
      ScheduleModule.forRoot(), // provides SchedulerRegistry for SessionsService
      GenerationModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(opts.prisma)
    .overrideProvider(ILlmPort)
    .useValue(opts.llm)
    // Sprint I: Mock SseService — GenerationService now publishes progress events
    .overrideProvider(SseService)
    .useValue({ publish: vi.fn().mockResolvedValue(undefined), init: vi.fn().mockResolvedValue(undefined) })
    // CronService.onModuleInit calls accountsService.seedFromEnv() which would
    // invoke prisma.socialAccount during bootstrap — override to a no-op so it
    // doesn't pollute per-test prisma mock assertions.
    .overrideProvider(CronService)
    .useValue({})
    .overrideProvider(TrendingScraperService)
    .useValue({
      getGoogleTrends: () => Promise.resolve([]),
      getXTrends: () => Promise.resolve([]),
      getMergedTrending: () => Promise.resolve([]),
      getCacheStatus: () => ({ googleTrends: { cached: false, topics: 0 }, xTrends: { cached: false, topics: 0 } }),
    })
    // TopicGenerationService needs SchedulerRegistry (global ScheduleModule.forRoot()
    // in prod) — irrelevant to these integration cases, so mock it out.
    .overrideProvider(TopicGenerationService)
    .useValue({})

  if (opts.contentReader) {
    builder.overrideProvider(ContentReader).useValue(opts.contentReader);
  }

  const ref = await builder.compile();
  // Trigger OnModuleInit lifecycle hooks (RedisCheckpointSaver connects to the
  // mocked ioredis here; without it, put/getTuple would no-op).
  await ref.init();
  return ref;
}

/**
 * Build a TestingModule with REAL QueueModule wiring.
 * PostingService is mocked (per ITC-015 preconditions: "PostingModule mocked");
 * IBrowserPort is mocked; PrismaService is mocked globally. ioredis + bullmq are
 * mocked at the file level so no real Redis/BullMQ connections are made.
 */
async function buildQueueModule(opts: {
  postingService: Partial<PostingService>;
  prisma: ReturnType<typeof createTestPrisma>;
}): Promise<TestingModule> {
  const ref = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      createMockPrismaModule(opts.prisma),
      RedisModule, // Sprint L: Global module — provides SHARED_REDIS via mocked ioredis factory
      NotificationsModule, // Global — provides DiscordNotificationService
      EventEmitterModule.forRoot(),
      ScheduleModule.forRoot(), // provides SchedulerRegistry for SessionsService
      QueueModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(opts.prisma)
    .overrideProvider(PostingService)
    .useValue(opts.postingService)
    .overrideProvider(IBrowserPort)
    .useValue(createMockBrowserPort())
    .overrideProvider(SseService)
    .useValue({ publish: vi.fn().mockResolvedValue(undefined), init: vi.fn().mockResolvedValue(undefined) })
    .compile();

  // Trigger OnModuleInit — QueueModule.onModuleInit registers a BullMQ worker
  // per network here.
  await ref.init();
  return ref;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Top-Down Integration — Social Poster Agent (ITC-001..005, 015..016, 026..027, 032..033)', () => {
  let moduleRef: TestingModule | null = null;

  beforeAll(() => {
    // Ensure env vars used by ConfigService-dependent services exist.
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.REDIS_URL = 'redis://localhost:6381';
    process.env.SOCIAL_X_USERNAME = 'test_x_user';
    process.env.SOCIAL_THREADS_USERNAME = 'test_threads_user';
    process.env.SOCIAL_FACEBOOK_EMAIL = 'test_fb@facebook.com';
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs mocks to defaults: everything "not found" so loadBrandVoice falls back.
    fsMocks.access.mockRejectedValue(new Error('ENOENT'));
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
    // Reset captured bullmq handlers/queues between queue tests.
    bullmqMocks.workerHandlers.clear();
    bullmqMocks.queues.clear();
    bullmqMocks.queueAdd.mockResolvedValue({ id: 'job-1' });
    bullmqMocks.queueGetFailed.mockResolvedValue([]);
    bullmqMocks.queueGetJobCounts.mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });
  });

  afterEach(async () => {
    // Close the TestingModule after each test to trigger OnModuleDestroy hooks
    // (disconnects mock ioredis, closes BullMQ workers) and free DI references.
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = null;
    }
  });

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  // ── ITC-001: Generation → LLM Port ───────────────────────────────────────
  it('ITC-001: Generation → LLM Port integration (generateChat called 4× per post)', async () => {
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-001' });
    prisma.socialAccount.findFirst.mockImplementation(({ where }: { where: { network: SocialNetwork } }) =>
      Promise.resolve(ACCOUNTS[where.network] ?? null),
    );
    prisma.post.findMany.mockResolvedValue([]); // no dedup hits
    let created = 0;
    prisma.post.create.mockImplementation(() => Promise.resolve({ id: `post-${++created}` }));

    const contentReader = {
      getTopics: vi.fn().mockResolvedValue([makeTopic('/blog/venus.md', 'Venus transit 2026')]),
      readBriefs: vi.fn().mockResolvedValue([]),
      readArticles: vi.fn().mockResolvedValue([]),
    };

    moduleRef = await buildGenerationModule({ llm, contentReader, prisma });
    const gen = moduleRef.get(GenerationService);

    const runId = await gen.generate(1, [SocialNetwork.X]);

    expect(runId).toBe('run-001');
    // 1 topic × 1 network = 1 post → 5 LLM calls (hook, draft, critique, refine, judge)
    expect(llm.generateChat).toHaveBeenCalledTimes(5);
    // A DRAFT post was created via the real PostsService → PrismaService
    expect(prisma.post.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.post.create.mock.calls[0]![0];
    expect(createArg.data.network).toBe(SocialNetwork.X);
    // status is not set explicitly by PostsService.create — it relies on the
    // Prisma schema default (DRAFT). We assert the content is populated from
    // the mock LLM and sourceRef carries the topic path.
    expect(createArg.data.status).toBeUndefined();
    expect(createArg.data.content).toBeTruthy();
    expect(createArg.data.sourceRef.path).toBe('/blog/venus.md');
  });

  // ── ITC-002: Generation → Content Source ─────────────────────────────────
  it('ITC-002: Generation → Content Source integration (IContentPort.getTopics called, posts created)', async () => {
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-002' });
    prisma.socialAccount.findFirst.mockImplementation(({ where }: { where: { network: SocialNetwork } }) =>
      Promise.resolve(ACCOUNTS[where.network] ?? null),
    );
    prisma.post.findMany.mockResolvedValue([]);
    let created = 0;
    prisma.post.create.mockImplementation(() => Promise.resolve({ id: `post-${++created}` }));

    const topics = [makeTopic('/blog/mercury.md', 'Mercury retrograde 2026')];
    const contentReader = {
      getTopics: vi.fn().mockResolvedValue(topics),
      readBriefs: vi.fn().mockResolvedValue([]),
      readArticles: vi.fn().mockResolvedValue([]),
    };

    moduleRef = await buildGenerationModule({ llm, contentReader, prisma });
    const gen = moduleRef.get(GenerationService);
    const cs = moduleRef.get(ContentSourceService);

    // Verify the real ContentSourceService delegates to ContentReader (IContentPort impl)
    const fetched = await cs.getTopics(1);
    expect(fetched).toEqual(topics);
    expect(contentReader.getTopics).toHaveBeenCalledWith(1);

    const runId = await gen.generate(1, [SocialNetwork.X]);

    expect(runId).toBe('run-002');
    expect(contentReader.getTopics).toHaveBeenCalledWith(1);
    expect(prisma.post.create).toHaveBeenCalledTimes(1);
    expect(prisma.post.create.mock.calls[0]![0].data.sourceRef.path).toBe('/blog/mercury.md');
  });

  // ── ITC-003: Generation → Posts (dedup) ──────────────────────────────────
  it('ITC-003: Generation → Posts dedup integration (findBySourceAndNetwork skips duplicates)', async () => {
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-003' });
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNTS.X);
    // Simulate an existing post for this source+network → dedup hit
    prisma.post.findMany.mockResolvedValue([
      { id: 'existing-1', network: SocialNetwork.X, sourceRef: { path: '/blog/venus.md' } },
    ]);
    prisma.post.create.mockResolvedValue({ id: 'should-not-be-called' });

    const contentReader = {
      getTopics: vi.fn().mockResolvedValue([makeTopic('/blog/venus.md', 'Venus transit 2026')]),
      readBriefs: vi.fn().mockResolvedValue([]),
      readArticles: vi.fn().mockResolvedValue([]),
    };

    moduleRef = await buildGenerationModule({ llm, contentReader, prisma });
    const gen = moduleRef.get(GenerationService);
    const posts = moduleRef.get(PostsService);

    const spy = vi.spyOn(posts, 'findBySourceAndNetwork');

    await gen.generate(1, [SocialNetwork.X]);

    // Dedup check was invoked through the real PostsService
    expect(spy).toHaveBeenCalledWith('/blog/venus.md', SocialNetwork.X, 14);
    // No new post created because a duplicate already exists for X
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  // ── ITC-004: Generation → Checkpoint ─────────────────────────────────────
  it('ITC-004: Generation → Checkpoint integration (RedisCheckpointSaver.put called during invoke)', async () => {
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-004' });
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNTS.X);
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.create.mockResolvedValue({ id: 'post-004' });

    const contentReader = {
      getTopics: vi.fn().mockResolvedValue([makeTopic('/blog/mars.md', 'Mars in Aries 2026')]),
      readBriefs: vi.fn().mockResolvedValue([]),
      readArticles: vi.fn().mockResolvedValue([]),
    };

    moduleRef = await buildGenerationModule({ llm, contentReader, prisma });
    const gen = moduleRef.get(GenerationService);
    const saver = moduleRef.get(RedisCheckpointSaver);

    // Spy on the real saver's put() — called by LangGraph after each node
    const putSpy = vi.spyOn(saver, 'put');

    await gen.generate(1, [SocialNetwork.X]);

    // LangGraph persists a checkpoint after each node (5 nodes: research, hook,
    // draft, critique, refine) → put called multiple times.
    expect(putSpy).toHaveBeenCalled();
    expect(putSpy.mock.calls.length).toBeGreaterThanOrEqual(5);

    // Verify the thread_id pattern matches {runId}:{topic}
    const firstCall = putSpy.mock.calls[0]!;
    const config = firstCall[0] as { configurable: { thread_id: string } };
    expect(config.configurable.thread_id).toContain('run-004');
  });

  // ── ITC-005: Generation → Posts (markRunCompleted) ───────────────────────
  it('ITC-005: Generation → Posts integration (markRunCompleted updates DB to COMPLETED)', async () => {
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-005' });
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNTS.X);
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.create.mockResolvedValue({ id: 'post-005' });
    prisma.generationRun.update.mockResolvedValue({ id: 'run-005' });

    const contentReader = {
      getTopics: vi.fn().mockResolvedValue([makeTopic('/blog/saturn.md', 'Saturn return 2026')]),
      readBriefs: vi.fn().mockResolvedValue([]),
      readArticles: vi.fn().mockResolvedValue([]),
    };

    moduleRef = await buildGenerationModule({ llm, contentReader, prisma });
    const gen = moduleRef.get(GenerationService);

    await gen.generate(1, [SocialNetwork.X]);

    // markRunCompleted → prisma.generationRun.update with COMPLETED status
    expect(prisma.generationRun.update).toHaveBeenCalled();
    const updateCall = prisma.generationRun.update.mock.calls.find(
      (c) => (c[0] as { data: { status: string } }).data.status === 'COMPLETED',
    );
    expect(updateCall).toBeDefined();
    const updateArg = updateCall![0] as {
      where: { id: string };
      data: { status: string; completedAt: Date; sourceTopics: string[]; errorMessage?: string };
    };
    expect(updateArg.where.id).toBe('run-005');
    expect(updateArg.data.status).toBe('COMPLETED');
    expect(updateArg.data.completedAt).toBeInstanceOf(Date);
    expect(updateArg.data.sourceTopics).toEqual(['Saturn return 2026']);
    expect(updateArg.data.errorMessage).toBeUndefined();
  });

  // ── ITC-015: Queue → QueueInfra ──────────────────────────────────────────
  it('ITC-015: Queue → QueueInfra integration (QueueFactory creates per-network queues + workers)', async () => {
    const postingService = { postById: vi.fn().mockResolvedValue({ success: true, url: 'https://x.com/1' }) };
    const prisma = createTestPrisma();

    moduleRef = await buildQueueModule({ postingService, prisma });
    const factory = moduleRef.get(QueueFactory);

    // QueueModule.onModuleInit registers workers per network:
    // 3 posting workers (X, THREADS, FACEBOOK) + 3 engagement workers = 6 total
    expect(bullmqMocks.WorkerCtor).toHaveBeenCalledTimes(6);
    const workerQueueNames = bullmqMocks.WorkerCtor.mock.calls.map((c) => c[0] as string);
    expect(workerQueueNames).toContain('spa-posting-x');
    expect(workerQueueNames).toContain('spa-posting-threads');
    expect(workerQueueNames).toContain('spa-posting-facebook');

    // QueueFactory.getQueue creates a per-network queue (lazy, cached)
    const qX = factory.getQueue('X');
    const qX2 = factory.getQueue('X');
    expect(qX).toBe(qX2); // cached
    const qT = factory.getQueue('THREADS');
    expect(qX).not.toBe(qT); // distinct per network

    // The registered worker handler delegates to PostingService.postById
    const handler = bullmqMocks.workerHandlers.get('spa-posting-x');
    expect(handler).toBeDefined();
    await handler!({ data: { postId: 'p-015' } });

    expect(postingService.postById).toHaveBeenCalledWith('p-015');
  });

  // ── ITC-016: Queue → Posting (enqueuePosting adds job) ───────────────────
  it('ITC-016: Queue → Posting integration (enqueuePosting adds job with postId)', async () => {
    const postingService = { postById: vi.fn().mockResolvedValue({ success: true }) };
    const prisma = createTestPrisma();

    moduleRef = await buildQueueModule({ postingService, prisma });
    const queueService = moduleRef.get(QueueService);

    await queueService.enqueuePosting('post-016', SocialNetwork.X);

    // queue.add called with job name 'post' and data { postId, network }
    expect(bullmqMocks.queueAdd).toHaveBeenCalledTimes(1);
    const addArgs = bullmqMocks.queueAdd.mock.calls[0]!;
    expect(addArgs[0]).toBe('post');
    expect(addArgs[1]).toEqual({ postId: 'post-016', network: SocialNetwork.X });

    // Job options: jobId = postId (idempotency), attempts = 8 (BULLMQ_POSTING_MAX_RETRIES default), exponential backoff
    const opts = addArgs[2] as { jobId: string; attempts: number; backoff: { type: string; delay: number } };
    expect(opts.jobId).toBe('post-016');
    expect(opts.attempts).toBe(8);
    expect(opts.backoff.type).toBe('exponential');
  });

  // ── ITC-026: Generation → Posts (multi-network 3×3=9) ────────────────────
  it('ITC-026: Generation → Posts multi-network integration (3 topics × 3 networks = 9 posts)', async () => {
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-026' });
    prisma.socialAccount.findFirst.mockImplementation(({ where }: { where: { network: SocialNetwork } }) =>
      Promise.resolve(ACCOUNTS[where.network] ?? null),
    );
    prisma.post.findMany.mockResolvedValue([]); // no dedup
    let created = 0;
    prisma.post.create.mockImplementation(() => Promise.resolve({ id: `post-${++created}` }));

    const topics = [
      makeTopic('/blog/t1.md', 'Solar eclipse 2026'),
      makeTopic('/blog/t2.md', 'Lunar eclipse 2026'),
      makeTopic('/blog/t3.md', 'Jupiter transit 2026'),
    ];
    const contentReader = {
      getTopics: vi.fn().mockResolvedValue(topics),
      readBriefs: vi.fn().mockResolvedValue([]),
      readArticles: vi.fn().mockResolvedValue([]),
    };

    moduleRef = await buildGenerationModule({ llm, contentReader, prisma });
    const gen = moduleRef.get(GenerationService);

    const runId = await gen.generate(3, [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK]);

    expect(runId).toBe('run-026');
    // 3 topics × 3 networks = 9 DRAFT posts
    expect(prisma.post.create).toHaveBeenCalledTimes(9);
    // 3 topics × 13 LLM calls = 39 generateChat calls
    // (per topic: 1 hook + 3 drafts + 3 critiques + 3 refines + 3 judges)
    expect(llm.generateChat).toHaveBeenCalledTimes(39);

    // Verify all three networks are represented in created posts
    const networks = prisma.post.create.mock.calls.map(
      (c) => (c[0] as { data: { network: SocialNetwork } }).data.network,
    );
    expect(networks.filter((n) => n === SocialNetwork.X)).toHaveLength(3);
    expect(networks.filter((n) => n === SocialNetwork.THREADS)).toHaveLength(3);
    expect(networks.filter((n) => n === SocialNetwork.FACEBOOK)).toHaveLength(3);

    // Run marked COMPLETED once
    const completedUpdate = prisma.generationRun.update.mock.calls.find(
      (c) => (c[0] as { data: { status: string } }).data.status === 'COMPLETED',
    );
    expect(completedUpdate).toBeDefined();
  });

  // ── ITC-027: Generation → Content Source (readBriefs + readArticles fallback) ──
  it('ITC-027: Generation → Content Source fallback integration (readBriefs empty → readArticles fallback)', async () => {
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-027' });
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNTS.X);
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.create.mockResolvedValue({ id: 'post-027' });

    // Use REAL ContentReader with a mocked filesystem:
    //   - CAP runs dir not found → readBriefs returns []
    //   - blog dir has 1 article → readArticles returns 1 topic (fallback)
    process.env.CONTENT_AGENT_PLATFORM_PATH = '/test/cap';
    process.env.SITE_BLOG_PATH = '/test/blog';

    fsMocks.access.mockImplementation(async (p: string) => {
      // CAP runs dir does not exist → readBriefs returns []
      if (p === '/test/cap/runs') throw new Error('ENOENT');
      // blog dir exists
      if (p === '/test/blog') return;
      throw new Error('ENOENT');
    });
    fsMocks.readdir.mockImplementation(async (p: string) => {
      if (p === '/test/blog') return [{ name: 'mercury-retro-2026.md', isDirectory: () => false, isFile: () => true }] as never;
      return [];
    });
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === '/test/blog/mercury-retro-2026.md') {
        // Minimal frontmatter — the ContentReader YAML parser only handles
        // scalar keys and `- item` arrays, so we omit tags (Zod default []).
        return ['---', 'title: Mercury Retrograde July 2026', 'description: Mercury retrograde guide', '---', 'Body content.'].join('\n');
      }
      // brand-voice.md → throw so GenerationService uses its fallback voice
      throw new Error('ENOENT');
    });

    // No contentReader override → real ContentReader is used
    moduleRef = await buildGenerationModule({ llm, prisma });
    const gen = moduleRef.get(GenerationService);
    const cs = moduleRef.get(ContentSourceService);

    // Verify the real fallback path: readBriefs empty → readArticles supplies topics
    const topics = await cs.getTopics(1);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.sourceType).toBe('article');
    expect(topics[0]!.topic).toBe('Mercury Retrograde July 2026');

    // GenerationService consumes the fallback topic and creates a DRAFT post
    const runId = await gen.generate(1, [SocialNetwork.X]);
    expect(runId).toBe('run-027');
    expect(prisma.post.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.post.create.mock.calls[0]![0];
    expect(createArg.data.sourceRef.type).toBe('article');
    expect(createArg.data.sourceRef.topic).toBe('Mercury Retrograde July 2026');
  });

  // ── ITC-032: Queue → Posting (job data + failed-job inspection) ──────────
  it('ITC-032: Queue → Posting integration (job data contains postId + network; failed jobs inspectable)', async () => {
    const postingService = { postById: vi.fn().mockResolvedValue({ success: true }) };
    const prisma = createTestPrisma();

    // Pre-seed BullMQ mock state: 2 failed jobs in the X queue
    const failedJobs = [
      { id: 'fj-1', data: { postId: 'p-fail-1', network: SocialNetwork.X }, failedReason: 'Navigation timeout', attemptsMade: 3, timestamp: Date.now() },
      { id: 'fj-2', data: { postId: 'p-fail-2', network: SocialNetwork.X }, failedReason: 'Session expired', attemptsMade: 3, timestamp: Date.now() },
    ];
    bullmqMocks.queueGetFailed.mockResolvedValue(failedJobs);
    bullmqMocks.queueGetJobCounts.mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 5,
      failed: 2,
      delayed: 0,
    });

    moduleRef = await buildQueueModule({ postingService, prisma });
    const queueService = moduleRef.get(QueueService);

    // Enqueue a job and verify its data payload contains postId + network.
    // NOTE: the current QueueFactory.enqueuePosting stores { postId, network } only
    // (accountId is not part of the job payload — it is resolved by PostingService
    // from the Post record at processing time).
    await queueService.enqueuePosting('post-032', SocialNetwork.X);
    const addArgs = bullmqMocks.queueAdd.mock.calls[0]!;
    const jobData = addArgs[1] as { postId: string; network: SocialNetwork };
    expect(jobData.postId).toBe('post-032');
    expect(jobData.network).toBe(SocialNetwork.X);

    // getJobCounts delegates through real QueueService → QueueFactory → BullMQ Queue
    const counts = await queueService.getJobCounts(SocialNetwork.X);
    expect(counts.failed).toBe(2);
    expect(counts.completed).toBe(5);

    // getFailedJobs returns failed jobs with id, data, failedReason
    const failed = await queueService.getFailedJobs(SocialNetwork.X);
    expect(failed).toHaveLength(2);
    expect((failed[0] as { data: { postId: string } }).data.postId).toBe('p-fail-1');
    expect((failed[1] as { failedReason: string }).failedReason).toBe('Session expired');
  });

  // ── ITC-033: Generation → Checkpoint (resume after simulated crash) ──────
  it('ITC-033: Generation → Checkpoint resume integration (resumes from checkpoint, skipping completed nodes)', async () => {
    // Clear hook cache — previous tests may have cached hooks for this topic
    clearHookCache();
    const llm = createIntegrationLlmPort();
    const prisma = createTestPrisma();
    prisma.generationRun.create.mockResolvedValue({ id: 'run-033' });
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNTS.X);
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.create.mockResolvedValue({ id: 'post-033' });

    const contentReader = {
      getTopics: vi.fn().mockResolvedValue([makeTopic('/blog/jupiter.md', 'Jupiter transit 2026')]),
      readBriefs: vi.fn().mockResolvedValue([]),
      readArticles: vi.fn().mockResolvedValue([]),
    };

    moduleRef = await buildGenerationModule({ llm, contentReader, prisma });
    const saver = moduleRef.get(RedisCheckpointSaver);

    // Use the real generation graph builder + real checkpoint saver (from DI).
    const threadId = 'run-033:X:Jupiter transit 2026';
    const initialState = createInitialState(
      makeTopic('/blog/jupiter.md', 'Jupiter transit 2026'),
      SocialNetwork.X,
      'Mystical-but-grounded, accessible, empowering.',
    );

    // Step 1: compile with interruptBefore critique_x → simulates a crash
    // after draft_x completes. Checkpoint is persisted to mock Redis.
    const interruptedGraph = buildGenerationGraph(llm).compile({
      checkpointer: saver,
      interruptBefore: ['critique_x'],
    });

    await interruptedGraph.invoke(initialState, {
      configurable: { thread_id: threadId },
      recursionLimit: 10,
    });

    // After interruption: research (no LLM) + hook + draft = 2 LLM calls
    const callsBeforeResume = (llm.generateChat as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsBeforeResume).toBe(2);

    // Step 2: re-invoke with the SAME thread_id but no interrupt and `null` input.
    // Passing `null` tells LangGraph to resume from the checkpoint (loading it via
    // RedisCheckpointSaver.getTuple) instead of re-running from START. Only
    // self_critique + refine execute.
    const resumeGraph = buildGenerationGraph(llm).compile({ checkpointer: saver });

    const finalState = (await resumeGraph.invoke(null, {
      configurable: { thread_id: threadId },
      recursionLimit: 10,
    })) as { posts?: Array<{ content?: string }>; results?: Record<string, { refined?: string; critique?: string }> };

    const callsAfterResume = (llm.generateChat as ReturnType<typeof vi.fn>).mock.calls.length;
    // 3 NEW LLM calls (critique + refine + judge) — completed nodes were skipped
    expect(callsAfterResume - callsBeforeResume).toBe(3);

    // Final state has posts produced by the resumed nodes
    expect(finalState.posts).toBeDefined();
    expect(finalState.posts!.length).toBeGreaterThan(0);
    expect(finalState.posts![0]!.content).toBeTruthy();
  });
});
