/**
 * Bottom-Up Integration Tests — Social Poster Agent (SPA)
 *
 * Technique: Test low-level modules first, verify they work correctly
 * with their infrastructure before testing higher-level consumers.
 *
 * 10 test cases: ITC-006..009, ITC-021..022, ITC-028..031
 * Interfaces: INT-08, INT-09+14, INT-15, INT-16, INT-11, INT-14, ContentSource, Accounts
 *
 * ISO/IEC/IEEE 29119:2021 — Integration Test Technique: Bottom-Up
 *
 * Real service classes with mocked infrastructure (ioredis, Prisma, IBrowserPort).
 * Direct provider registration (not module imports) to avoid pulling in
 * BrowserModule/BrowserFactory which needs Camoufox native binary.
 */

import 'reflect-metadata';
import { restoreAllDesignParamtypes } from '../helpers/restore-paramtypes';
import { SchedulerRegistry } from '@nestjs/schedule';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PostStatus, SessionStatus, SocialNetwork } from '@prisma/client';

// ── Source imports ──
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { PostsService } from '../../src/modules/posts/posts.service';
import { HealthController } from '../../src/modules/health/health.controller';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service.js';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { EventsController } from '../../src/modules/events/events.controller';
import { ContentSourceService } from '../../src/modules/content-source/content-source.service';
import { ContentReader } from '../../src/infrastructure/content/content-reader';
import { ILlmPort } from '../../src/domain/ports/llm.port';
import { IBrowserPort } from '../../src/domain/ports/browser.port';
import { IContentPort } from '../../src/domain/ports/content.port';
import { createMockPrismaService, createMockBrowserPort, createMockContentPort } from '../mocks/index';
import { SHARED_REDIS, SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER } from '../../src/infrastructure/redis/redis.module';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service';
import { EmailReaderService } from '../../src/infrastructure/email/email-reader.service';

// ── ioredis mock (hoisted) ──
const { redisStore, sseMessageHandlers } = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  sseMessageHandlers: [] as Array<(channel: string, msg: string) => void>,
}));

vi.mock('ioredis', () => {
  const messageHandlers = sseMessageHandlers;
  return {
    default: vi.fn(() => ({
      store: redisStore,
      get: (key: string) => Promise.resolve(redisStore.get(key) ?? null),
      set: (key: string, val: string) => { redisStore.set(key, String(val)); return Promise.resolve('OK'); },
      setex: (key: string, _ttl: number, val: string) => { redisStore.set(key, String(val)); return Promise.resolve('OK'); },
      incr: (key: string) => {
        const v = parseInt(redisStore.get(key) ?? '0', 10) + 1;
        redisStore.set(key, String(v));
        return Promise.resolve(v);
      },
      expire: () => Promise.resolve(1),
      pexpire: () => Promise.resolve(1),
      del: (key: string) => { redisStore.delete(key); return Promise.resolve(1); },
      exists: (key: string) => Promise.resolve(redisStore.has(key) ? 1 : 0),
      ping: () => Promise.resolve('PONG'),
      publish: (ch: string, msg: string) => {
        // In real Redis, publish triggers 'message' event on all subscribers
        messageHandlers.forEach((h) => h(ch, msg));
        return Promise.resolve(1);
      },
      subscribe: () => Promise.resolve('OK'),
      unsubscribe: () => Promise.resolve('OK'),
      on: (event: string, cb: (channel: string, msg: string) => void) => {
        if (event === 'message') messageHandlers.push(cb);
      },
      disconnect: () => {},
      duplicate() { return (this as unknown); },
    })),
  };
});

// ── esbuild decorator metadata restoration ──
/*
function restoreParamtypes(cls: unknown, types: unknown[]) {
  if (Reflect.getMetadata('design:paramtypes', cls) == null) {
    Reflect.defineMetadata('design:paramtypes', types, cls);
  }
}

restoreParamtypes(PostsService, [PrismaService, EventEmitter2]);
// Quality pass: SessionsService grew Discord/SHARED_REDIS/EmailReader/SchedulerRegistry
// params — the stale 5-entry restore left `discord` undefined at boot.
restoreParamtypes(SessionsService, [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService, Object, EmailReaderService, SchedulerRegistry]);
restoreParamtypes(EncryptionService, [ConfigService]);
restoreParamtypes(RateLimitService, [ConfigService]);
restoreParamtypes(SseService, [ConfigService]);
restoreParamtypes(AccountsService, [PrismaService, ConfigService]);
// ContentSourceService injects @Inject(IContentPort) — token decorator wins, slot is Object
restoreParamtypes(ContentSourceService, [Object]);
restoreParamtypes(HealthController, [PrismaService, ConfigService]);
restoreParamtypes(EventsController, [SseService]);
// Quality pass: TopicGenerationService was added to AppModule without a restore
// entry — esbuild-stripped paramtypes made configService undefined at boot.
restoreParamtypes(TopicGenerationService, [PrismaService, ConfigService, SchedulerRegistry, LlmService]);*/
restoreAllDesignParamtypes();

// ── Mock ConfigService ──
function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    REDIS_URL: 'redis://localhost:6381',
    SSE_CHANNEL: 'spa:sse',
    RATE_LIMIT_PREFIX: 'spa:ratelimit',
    RATE_LIMIT_X_MAX_PER_DAY: 50,
    RATE_LIMIT_X_MAX_PER_WEEK: 10,
    RATE_LIMIT_THREADS_MAX_PER_DAY: 75,
    RATE_LIMIT_THREADS_MAX_PER_WEEK: 15,
    RATE_LIMIT_FACEBOOK_MAX_PER_DAY: 25,
    RATE_LIMIT_FACEBOOK_MAX_PER_WEEK: 5,
    RATE_LIMIT_MIN_DELAY_MS: 300_000,
    SOCIAL_X_USERNAME: 'testuser',
    SOCIAL_X_PASSWORD: 'testpass',
    SOCIAL_THREADS_USERNAME: 'testuser',
    SOCIAL_THREADS_PASSWORD: 'testpass',
    SOCIAL_FACEBOOK_EMAIL: 'test@fb.com',
    SOCIAL_FACEBOOK_PASSWORD: 'testpass',
    SOCIAL_FACEBOOK_PAGE_SLUG: 'myzodiacai',
  };
  const values = { ...defaults, ...overrides };
  return { get: vi.fn((key: string, def?: unknown) => (key in values ? values[key] : def)) } as unknown as ConfigService;
}

// ── Extend Prisma mock with socialAccount ──
function createIntegrationPrismaService() {
  const prisma = createMockPrismaService();
  (prisma as unknown).socialAccount = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  };
  return prisma;
}

// ── Mock SSE Response ──
function createMockSseResponse() {
  const written: string[] = [];
  return {
    write: vi.fn((data: string) => { written.push(data); return true; }),
    end: vi.fn(),
    on: vi.fn(),
    headersSent: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    _written: written,
  } as unknown;
}

// ── Shared Redis mock (uses same redisStore as ioredis mock) ──
const mockSharedRedis = {
  get: (key: string) => Promise.resolve(redisStore.get(key) ?? null),
  set: (key: string, val: unknown) => { redisStore.set(key, String(val)); return Promise.resolve('OK'); },
  setex: (key: string, _ttl: number, val: string) => { redisStore.set(key, val); return Promise.resolve('OK'); },
  psetex: (key: string, _ttl: number, val: string) => { redisStore.set(key, val); return Promise.resolve('OK'); },
  del: (key: string) => { redisStore.delete(key); return Promise.resolve(1); },
  ping: () => Promise.resolve('PONG'),
  subscribe: () => Promise.resolve('OK'),
  unsubscribe: () => Promise.resolve('OK'),
  on: vi.fn((ev: string, cb: (channel: string, msg: string) => void) => {
    if (ev === 'message') sseMessageHandlers.push(cb);
  }),
  off: vi.fn((ev: string, cb: (channel: string, msg: string) => void) => {
    if (ev === 'message') {
      const idx = sseMessageHandlers.indexOf(cb);
      if (idx >= 0) sseMessageHandlers.splice(idx, 1);
    }
  }),
  publish: (ch: string, msg: string) => { sseMessageHandlers.forEach((h) => h(ch, msg)); return Promise.resolve(1); },
  keys: (pat: string) => {
    const prefix = pat.replace(/\*$/, '');
    return Promise.resolve([...redisStore.keys()].filter((k) => k.startsWith(prefix)));
  },
  rpush: () => Promise.resolve(1),
  expire: () => Promise.resolve(1),
  pexpire: () => Promise.resolve(1),
  incr: (key: string) => {
    const v = parseInt(redisStore.get(key) ?? '0', 10) + 1;
    redisStore.set(key, String(v));
    return Promise.resolve(v);
  },
  decr: (key: string) => {
    const v = parseInt(redisStore.get(key) ?? '0', 10) - 1;
    redisStore.set(key, String(v));
    return Promise.resolve(v);
  },
  quit: () => Promise.resolve('OK'),
  disconnect: () => undefined,
  connect: () => Promise.resolve(undefined),
  duplicate() { return this; },
} as unknown;

// ═══════════════════════════════════════════════════════════════
// BOTTOM-UP INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════

describe('Bottom-Up Integration Tests', () => {

  // ── ITC-006..009: Infrastructure → Service Integration ──
  describe('ITC-006..009: Infrastructure → Service Integration', () => {
    let moduleRef: TestingModule;
    let rateLimitService: RateLimitService;
    let sseService: SseService;
    let postsService: PostsService;
    let healthController: HealthController;
    let prisma: unknown;
    let configService: ConfigService;

    beforeAll(async () => {
      prisma = createIntegrationPrismaService();
      configService = createMockConfigService();

      moduleRef = await Test.createTestingModule({
        providers: [
          RateLimitService,
          SseService,
          PostsService,
          HealthController,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: configService },
          { provide: ILlmPort, useValue: { generate: vi.fn(), generateChat: vi.fn() } },
          { provide: EventEmitter2, useValue: { emit: vi.fn() } },
          { provide: SHARED_REDIS, useValue: mockSharedRedis },
          { provide: SHARED_REDIS_SUBSCRIBER, useValue: mockSharedRedis },
          { provide: SHARED_REDIS_PUBLISHER, useValue: mockSharedRedis },
        ],
      }).compile();

      rateLimitService = moduleRef.get(RateLimitService);
      sseService = moduleRef.get(SseService);
      postsService = moduleRef.get(PostsService);
      healthController = moduleRef.get(HealthController);

      await (rateLimitService as unknown).onModuleInit();
      await (sseService as unknown).init();
    });

    afterAll(async () => { await moduleRef.close(); });

    beforeEach(() => {
      redisStore.clear();
      vi.clearAllMocks();
    });

    it('ITC-006: RateLimit → Redis (INCR + EXPIRE for daily counter, SET for interval)', async () => {
      // Step 1: checkRateLimit when no prior posts → allowed
      const result1 = await rateLimitService.checkRateLimit('X' as unknown);
      expect(result1.allowed).toBe(true);

      // Step 2: recordPost sets interval key
      await rateLimitService.recordPost('X' as unknown);

      // Step 3: checkRateLimit immediately → blocked by interval
      const result2 = await rateLimitService.checkRateLimit('X' as unknown);
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toMatch(/wait|interval/i);

      // Step 4: daily limit — set daily counter to 50, clear interval
      const dateKey = new Date().toISOString().slice(0, 10);
      const dailyKey = `spa:ratelimit:X:daily:${dateKey}`;
      redisStore.set(dailyKey, '50');
      for (const key of redisStore.keys()) {
        if (key.includes('interval')) redisStore.delete(key);
      }
      const result3 = await rateLimitService.checkRateLimit('X' as unknown);
      expect(result3.allowed).toBe(false);
      expect(result3.reason).toMatch(/daily|limit/i);
    });

    it('ITC-007: SSE → Redis Pub/Sub (publish delivers to connected clients)', async () => {
      const mockRes = createMockSseResponse();
      sseService.addClient(mockRes);

      // Verify connected event sent
      expect(mockRes.write).toHaveBeenCalled();
      const connectedData = mockRes._written[0];
      expect(connectedData).toContain('connected');

      // Publish an event
      await sseService.publish({ type: 'post_status', postId: 'p1', status: 'POSTING' });

      // Verify event data was written to client
      const lastWrite = mockRes._written[mockRes._written.length - 1];
      expect(lastWrite).toContain('POSTING');
      expect(lastWrite).toContain('p1');
    });

    it('ITC-008: Posts → Prisma (CRUD: create, findDrafts, updateStatus)', async () => {
      // Create
      prisma.post.create.mockResolvedValue({
        id: 'post-crud-1', network: 'X', content: 'test post',
        status: 'DRAFT', createdAt: new Date(),
      });
      const created = await postsService.create({
        accountId: 'acc-1', network: 'X' as unknown, content: 'test post',
      } as unknown);
      expect(created).toBeDefined();
      expect(prisma.post.create).toHaveBeenCalled();

      // findDrafts
      prisma.post.findMany.mockResolvedValue([
        { id: 'post-crud-1', status: 'DRAFT', network: 'X' },
      ]);
      const drafts = await postsService.findDrafts();
      expect(drafts).toHaveLength(1);

      // updateStatus → APPROVED (takes DTO object, not string)
      prisma.post.findUnique.mockResolvedValue({
        id: 'post-crud-1', status: 'DRAFT', network: 'X',
      });
      prisma.post.update.mockResolvedValue({
        id: 'post-crud-1', status: 'APPROVED', approvedAt: new Date(),
      });
      const updated = await postsService.updateStatus('post-crud-1', { status: 'APPROVED' } as unknown);
      expect(updated.status).toBe('APPROVED');
      expect(prisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'APPROVED' }),
        }),
      );
    });

    it('ITC-009: Health → Prisma + Redis (ok when both up, degraded when Redis down)', async () => {
      // Both up
      prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      const result1 = await healthController.check();
      expect(result1.status).toBe('ok');

      // Redis down — simulate by making ping fail
      const redisInstance = (healthController as unknown).redis;
      if (redisInstance) {
        vi.spyOn(redisInstance, 'ping').mockRejectedValueOnce(new Error('Connection refused'));
      }
      const result2 = await healthController.check();
      expect(result2.status).toBe('degraded');
    });
  });

  // ── ITC-021..022: Sessions → Prisma Integration ──
  describe('ITC-021..022: Sessions → Prisma Integration', () => {
    let moduleRef: TestingModule;
    let sessionsService: SessionsService;
    let prisma: unknown;
    let browserPort: unknown;

    beforeAll(async () => {
      prisma = createIntegrationPrismaService();
      browserPort = createMockBrowserPort();
      const configService = createMockConfigService();

      moduleRef = await Test.createTestingModule({
        providers: [
          SessionsService,
          AccountsService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: configService },
          { provide: IBrowserPort, useValue: browserPort },
          { provide: EncryptionService, useValue: { encrypt: (data: unknown) => JSON.stringify(data), decrypt: (data: string) => JSON.parse(data), isEnabled: () => false, isEncrypted: (s: string) => s.startsWith('v1:') } },
          { provide: SHARED_REDIS, useValue: mockSharedRedis },
          { provide: SHARED_REDIS_SUBSCRIBER, useValue: mockSharedRedis },
          { provide: SHARED_REDIS_PUBLISHER, useValue: mockSharedRedis },
          // Quality pass: new SessionsService deps (see restoreParamtypes above)
          { provide: DiscordNotificationService, useValue: { notify: vi.fn().mockResolvedValue(undefined), notifyDlq: vi.fn().mockResolvedValue(undefined) } },
          { provide: EmailReaderService, useValue: { isEnabled: () => false } },
          { provide: SchedulerRegistry, useValue: { addTimeout: vi.fn(), deleteTimeout: vi.fn(), doesExist: vi.fn(() => false) } },
        ],
      }).compile();

      sessionsService = moduleRef.get(SessionsService);
    });

    afterAll(async () => { await moduleRef.close(); });

    beforeEach(() => { vi.clearAllMocks(); });

    it('ITC-021: Sessions → Prisma (create → find → update storageState → mark expired)', async () => {
      // getOrCreateSession first calls accountsService.findByNetwork → needs account
      prisma.socialAccount.findFirst.mockResolvedValue({
        id: 'acc-1', network: 'X', handle: 'testuser', active: true,
      });
      // Then finds existing ACTIVE session
      prisma.session.findFirst.mockResolvedValue({
        id: 'sess-1', network: 'X', status: 'ACTIVE',
        storageState: '{}', accountId: 'acc-1',
      });
      const session = await sessionsService.getOrCreateSession('X' as unknown);
      expect(session).toBeDefined();
      expect(session.id).toBe('sess-1');

      // updateStorageState
      prisma.session.update.mockResolvedValue({
        id: 'sess-1', status: 'ACTIVE', storageState: '{"cookies":[]}',
      });
      await (sessionsService as unknown).updateStorageState('sess-1', '{"cookies":[]}');
      expect(prisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            // P0-H3: storageState is now encrypted (stringified in passthrough mode)
            storageState: '{"cookies":[]}',
            status: SessionStatus.ACTIVE,
          }),
        }),
      );

      // healthCheck → EXPIRED (mock browser returns login redirect)
      prisma.socialAccount.findFirst.mockResolvedValue({
        id: 'acc-1', network: 'X', handle: 'testuser', active: true,
      });
      prisma.session.findFirst.mockResolvedValue({
        id: 'sess-1', network: 'X', status: 'ACTIVE',
        storageState: '{}', accountId: 'acc-1',
      });
      prisma.session.update.mockResolvedValue({
        id: 'sess-1', status: 'EXPIRED',
      });
      // Mock browser to simulate expired session
      const mockPage = {
        goto: vi.fn(),
        url: vi.fn().mockReturnValue('https://x.com/login'),
        close: vi.fn(),
      };
      (browserPort.createContext as unknown).mockResolvedValue({
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn(),
      });

      const result = await sessionsService.healthCheck('X' as unknown);
      expect(result.healthy).toBe(false);
    });

    it('ITC-022: Sessions → Prisma (findAll returns sessions with account relation)', async () => {
      const sessions = [
        { id: 's1', network: 'X', status: 'ACTIVE', createdAt: new Date('2026-07-15'), account: { network: 'X', handle: 'test_x' } },
        { id: 's2', network: 'THREADS', status: 'ACTIVE', createdAt: new Date('2026-07-14'), account: { network: 'THREADS', handle: 'test_t' } },
        { id: 's3', network: 'FACEBOOK', status: 'EXPIRED', createdAt: new Date('2026-07-13'), account: { network: 'FACEBOOK', handle: 'test_f' } },
      ];
      prisma.session.findMany.mockResolvedValue(sessions);

      const result = await sessionsService.findAll();

      expect(result).toHaveLength(3);
      expect(result[0].account).toBeDefined();
      expect(result[0].account.handle).toBe('test_x');
      // Verify ordering: createdAt DESC
      expect(result[0].createdAt.getTime()).toBeGreaterThan(result[1].createdAt.getTime());
    });
  });

  // ── ITC-028..029: Events → SSE Integration ──
  describe('ITC-028..029: Events → SSE Integration', () => {
    let moduleRef: TestingModule;
    let sseService: SseService;

    beforeAll(async () => {
      const configService = createMockConfigService();

      moduleRef = await Test.createTestingModule({
        providers: [
          SseService,
          EventsController,
          { provide: ConfigService, useValue: configService },
          { provide: SHARED_REDIS, useValue: mockSharedRedis },
          { provide: SHARED_REDIS_SUBSCRIBER, useValue: mockSharedRedis },
          { provide: SHARED_REDIS_PUBLISHER, useValue: mockSharedRedis },
        ],
      }).compile();

      sseService = moduleRef.get(SseService);
      await (sseService as unknown).init();
    });

    afterAll(async () => { await moduleRef.close(); });

    beforeEach(() => {
      const clients = (sseService as unknown).clients;
      if (clients) clients.clear();
      vi.clearAllMocks();
    });

    it('ITC-028: Events → SSE (client connect → connected event → disconnect → cleanup)', async () => {
      const mockRes = createMockSseResponse();

      // Add client
      sseService.addClient(mockRes);

      // Verify connected event
      expect(mockRes.write).toHaveBeenCalled();
      const connectedData = mockRes._written[0];
      expect(connectedData).toContain('connected');

      // Verify client count = 1
      expect(sseService.getConnectedCount()).toBe(1);

      // Simulate disconnect
      const clients = (sseService as unknown).clients;
      const clientId = clients.keys().next().value;
      sseService.removeClient(clientId);

      // Verify client count = 0
      expect(sseService.getConnectedCount()).toBe(0);
    });

    it('ITC-029: Events → SSE (broadcast delivers to all 3 connected clients)', async () => {
      const responses = [createMockSseResponse(), createMockSseResponse(), createMockSseResponse()];

      for (const res of responses) {
        sseService.addClient(res);
      }

      expect(sseService.getConnectedCount()).toBe(3);

      // Publish event
      await sseService.publish({ type: 'post_status', status: 'POSTED', postId: 'p1' });

      // All 3 clients should have received the event (at least 2 writes: connected + event)
      for (const res of responses) {
        expect(res.write).toHaveBeenCalled();
        const lastWrite = res._written[res._written.length - 1];
        expect(lastWrite).toContain('POSTED');
      }
    });
  });

  // ── ITC-030: ContentSource → ContentPort ──
  describe('ITC-030: ContentSource → Content Port Integration', () => {
    let moduleRef: TestingModule;
    let contentSourceService: ContentSourceService;
    let mockContentPort: unknown;

    beforeAll(async () => {
      mockContentPort = createMockContentPort();

      moduleRef = await Test.createTestingModule({
        providers: [
          ContentSourceService,
          { provide: ContentReader, useValue: mockContentPort },
          // Quality pass: ContentSourceService now injects @Inject(IContentPort)
          { provide: IContentPort, useValue: mockContentPort },
        ],
      })
        .overrideProvider(SHARED_REDIS)
        .useValue(mockSharedRedis)
        .overrideProvider(SHARED_REDIS_SUBSCRIBER)
        .useValue(mockSharedRedis)
        .overrideProvider(SHARED_REDIS_PUBLISHER)
        .useValue(mockSharedRedis)
        .compile();

      contentSourceService = moduleRef.get(ContentSourceService);
    });

    afterAll(async () => { await moduleRef.close(); });

    beforeEach(() => { vi.clearAllMocks(); });

    it('ITC-030: ContentSource → IContentPort (getTopics, getBriefs, getArticles delegate to port)', async () => {
      // getTopics
      await contentSourceService.getTopics(5);
      expect(mockContentPort.getTopics).toHaveBeenCalledWith(5);

      // getBriefs
      await contentSourceService.getBriefs(5);
      expect(mockContentPort.readBriefs).toHaveBeenCalledWith(5);

      // getArticles
      await contentSourceService.getArticles(5);
      expect(mockContentPort.readArticles).toHaveBeenCalledWith(5);
    });
  });

  // ── ITC-031: Accounts → Config ──
  describe('ITC-031: Accounts → Env Config Integration', () => {
    let moduleRef: TestingModule;
    let accountsService: AccountsService;
    let prisma: unknown;

    beforeAll(async () => {
      prisma = createIntegrationPrismaService();
      const configService = createMockConfigService({
        SOCIAL_X_USERNAME: 'test_x_user',
        SOCIAL_THREADS_USERNAME: 'test_threads_user',
        SOCIAL_FACEBOOK_EMAIL: 'test_fb_user',
      });

      moduleRef = await Test.createTestingModule({
        providers: [
          AccountsService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: configService },
        ],
      })
        .overrideProvider(SHARED_REDIS)
        .useValue(mockSharedRedis)
        .overrideProvider(SHARED_REDIS_SUBSCRIBER)
        .useValue(mockSharedRedis)
        .overrideProvider(SHARED_REDIS_PUBLISHER)
        .useValue(mockSharedRedis)
        .compile();

      accountsService = moduleRef.get(AccountsService);
    });

    afterAll(async () => { await moduleRef.close(); });

    beforeEach(() => { vi.clearAllMocks(); });

    it('ITC-031: Accounts → Config (findByNetwork returns account from env config)', async () => {
      // findByNetwork uses prisma.socialAccount.findFirst (not findUnique)
      prisma.socialAccount.findFirst.mockResolvedValue({
        id: 'acc-x', network: 'X', handle: 'test_x_user', active: true,
      });

      const account = await accountsService.findByNetwork('X' as unknown);
      expect(account).toBeDefined();
      expect(account.handle).toBe('test_x_user');
      expect(prisma.socialAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { network: 'X', active: true } }),
      );
    });
  });
});
