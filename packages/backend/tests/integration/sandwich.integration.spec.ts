/**
 * Sandwich Integration Tests — Posting ↔ Sessions ↔ Browser
 *
 * Technique: Sandwich (top-down + bottom-up combined)
 * Interfaces: INT-05 (Posting→Browser), INT-06 (Posting→Sessions),
 *             INT-07 (Posting→Posts), INT-08 (Posting→RateLimit),
 *             INT-09 (Posting→SSE), INT-10 (Sessions→Browser)
 *
 * Test cases: ITC-010..014, ITC-023..025, ITC-034 (9 cases)
 * Spec: CONSTITUTION.md §14 (Testing) — test case IDs are inline
 *
 * Real NestJS DI wiring with mocked infrastructure:
 *   - IBrowserPort: mocked (no real Camoufox browser)
 *   - PrismaService: overridden with createMockPrismaService()
 *   - ioredis: vi.mock (no real Redis — RateLimit + SSE use mock store)
 *   - ConfigService: mocked with test env values
 *
 * All service classes (PostingService, SessionsService, PostsService,
 * RateLimitService, SseService, AccountsService, XPoster, ThreadsPoster,
 * FacebookPoster) are REAL — only infrastructure is mocked.
 *
 * NOTE: Vitest transforms with esbuild, which does NOT emit
 * `design:paramtypes` decorator metadata. Nest DI relies on that metadata
 * to resolve type-injected constructor params. The `@Inject(IBrowserPort)`
 * token survives (separate metadata key), but class-typed params come back
 * as `undefined`. We restore the metadata explicitly via
 * `Reflect.defineMetadata` so @nestjs/testing DI works as intended.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PostStatus, SessionStatus, SocialNetwork } from '@prisma/client';

import { PostingService } from '../../src/modules/posting/posting.service';
import { ThreadProgressService } from '../../src/modules/posting/thread-progress.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { WarmupService } from '../../src/modules/sessions/warmup.service';
import { PostsService } from '../../src/modules/posts/posts.service';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { XPoster } from '../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../src/modules/posting/posters/facebook.poster';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service.js';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service.js';
import { IBrowserPort } from '../../src/domain/ports/browser.port.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createMockPrismaService, createMockEncryptionService } from '../mocks/index';
import { SHARED_REDIS, SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER } from '../../src/infrastructure/redis/redis.module';

// ── ioredis mock (hoisted) ───────────────────────────────────────────────────
// A real Map-backed store so RateLimitService.checkRateLimit / recordPost
// and SseService.publish exercise their real logic against mocked Redis.

const { redisStore, sseMessageHandlers } = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  sseMessageHandlers: [] as Array<(channel: string, msg: string) => void>,
}));

vi.mock('ioredis', () => {
  return {
    default: vi.fn(() => ({
      get: (key: string) => Promise.resolve(redisStore.get(key) ?? null),
      set: (key: string, val: string) => {
        redisStore.set(key, String(val));
        return Promise.resolve('OK');
      },
      incr: (key: string) => {
        const v = parseInt(redisStore.get(key) ?? '0', 10) + 1;
        redisStore.set(key, String(v));
        return Promise.resolve(v);
      },
      expire: () => Promise.resolve(1),
      publish: vi.fn().mockResolvedValue(1),
      subscribe: () => Promise.resolve('OK'),
      on: () => {},
      disconnect: () => {},
    })),
  };
});

// ── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock Playwright Page compatible with both XPoster (compose flow)
 * and SessionsService.autoLogin (login form flow).
 */
function createMockPage(opts: { url?: string; successVisible?: boolean } = {}) {
  const url = opts.url ?? 'https://x.com/status/123456789';
  const locatorFirst = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(opts.successVisible ?? true),
    isEnabled: vi.fn().mockResolvedValue(true),
    isDisabled: vi.fn().mockResolvedValue(false),
    isHidden: vi.fn().mockResolvedValue(false),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    inputValue: vi.fn().mockResolvedValue('testuser'),
    textContent: vi.fn().mockResolvedValue(''),
    innerText: vi.fn().mockResolvedValue(''),
    getAttribute: vi.fn().mockResolvedValue(null),
    or: vi.fn().mockImplementation(() => locatorFirst),
  };
  // Separate locatorFirst for 2FA/verification selectors — isVisible returns false
  // so autoLogin doesn't enter the 2FA/verification challenge branch.
  const hiddenLocatorFirst = {
    ...locatorFirst,
    isVisible: vi.fn().mockResolvedValue(false),
  };
  const locatorResult = {
    first: () => locatorFirst,
    allTextContents: vi.fn().mockResolvedValue([]),
    innerText: vi.fn().mockResolvedValue(''),
    evaluateAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    all: vi.fn().mockResolvedValue([]),
    or: vi.fn().mockImplementation(() => locatorResult),
  };
  const hiddenLocatorResult = {
    ...locatorResult,
    first: () => hiddenLocatorFirst,
  };
  // Selectors that should appear hidden (2FA input, identity verification)
  const HIDDEN_SELECTOR_PATTERN = /ocfEnterTextTextInput|name="text"/;
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(url),
    locator: vi.fn().mockImplementation((selector: string) =>
      HIDDEN_SELECTOR_PATTERN.test(selector) ? hiddenLocatorResult : locatorResult,
    ),
    getByLabel: vi.fn().mockReturnValue(locatorResult),
    getByRole: vi.fn().mockReturnValue(locatorResult),
    getByText: vi.fn().mockReturnValue(locatorResult),
    close: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html></html>'),
    textContent: vi.fn().mockResolvedValue(''),
    innerText: vi.fn().mockResolvedValue(''),
    screenshot: vi.fn().mockResolvedValue('/tmp/mock.png'),
    evaluate: vi.fn().mockResolvedValue(undefined),
    evaluateAll: vi.fn().mockResolvedValue([]),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnValue(undefined),
    keyboard: { type: vi.fn().mockResolvedValue(undefined), press: vi.fn().mockResolvedValue(undefined) },
    _locatorFirst: locatorFirst,
  };
}

/** Build a mock BrowserContext whose newPage() resolves to the supplied page. */
function createMockContext(page: ReturnType<typeof createMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    pages: vi.fn().mockReturnValue([page]),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

/** Mock IBrowserPort backed by the supplied mock context. */
function createIntegrationBrowserPort(context: ReturnType<typeof createMockContext>) {
  return {
    createContext: vi.fn().mockResolvedValue(context),
    acquireContext: vi.fn().mockResolvedValue(context),
    releaseContext: vi.fn(),
    saveStorageState: vi.fn().mockResolvedValue(
      JSON.stringify({ cookies: [{ name: 'sess', value: 'abc' }], origins: [] }),
    ),
    randomDelay: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(undefined),
    humanType: vi.fn().mockResolvedValue(undefined),
    typeHuman: vi.fn().mockResolvedValue(undefined),
    humanClick: vi.fn().mockResolvedValue(undefined),
    scrollPage: vi.fn().mockResolvedValue(undefined),
    extractText: vi.fn().mockResolvedValue(''),
    dismissDialogs: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    waitForStable: vi.fn().mockResolvedValue(undefined),
    suppressPageErrors: vi.fn().mockResolvedValue(undefined),
  };
}

/** ConfigService mock with test env defaults + overrides. */
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
  return {
    get: vi.fn((key: string, def?: unknown) => (key in values ? values[key] : def)),
  } as unknown as ConfigService;
}

/**
 * Extend createMockPrismaService() with the `socialAccount` model
 * (AccountsService uses prisma.socialAccount, not prisma.account).
 */
function createIntegrationPrismaService() {
  const prisma = createMockPrismaService();
  (prisma as unknown).socialAccount = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
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

// ── Metadata restoration (esbuild compatibility) ────────────────────────────

function restoreDesignParamtypes(): void {
  // PostingService: (@Inject(IBrowserPort), AccountsService, SessionsService,
  //   WarmupService, PostsService, RateLimitService, SseService,
  //   ThreadProgressService, XPoster, ThreadsPoster, FacebookPoster, @Optional() QueueFactory)
    Reflect.defineMetadata(
      'design:paramtypes',
      [Object, AccountsService, SessionsService, WarmupService, PostsService, RateLimitService, SseService, ThreadProgressService, XPoster, ThreadsPoster, FacebookPoster, Object],
      PostingService,
    );
  // SessionsService: (PrismaService, AccountsService, @Inject(IBrowserPort), ConfigService, EncryptionService, DiscordNotificationService)
    Reflect.defineMetadata(
      'design:paramtypes',
      [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService],
      SessionsService,
    );
  // WarmupService: (PrismaService, ConfigService)
    Reflect.defineMetadata(
      'design:paramtypes',
      [PrismaService, ConfigService],
      WarmupService,
    );
  // AccountsService: (PrismaService, ConfigService, @Optional() WarmupService)
    Reflect.defineMetadata('design:paramtypes', [PrismaService, ConfigService, WarmupService], AccountsService);
  // PostsService: (PrismaService, EventEmitter2)
    Reflect.defineMetadata('design:paramtypes', [PrismaService, EventEmitter2], PostsService);
  // RateLimitService: (ConfigService, @Inject(SHARED_REDIS) IORedis)
    Reflect.defineMetadata('design:paramtypes', [ConfigService, Object], RateLimitService);
  // SseService: (ConfigService, @Inject(SHARED_REDIS_SUBSCRIBER), @Inject(SHARED_REDIS_PUBLISHER))
    Reflect.defineMetadata('design:paramtypes', [ConfigService, Object, Object], SseService);
  // FacebookPoster: (IBrowserPort, ConfigService)
    Reflect.defineMetadata('design:paramtypes', [IBrowserPort, ConfigService], FacebookPoster);
  // XPoster: (IBrowserPort)
    Reflect.defineMetadata('design:paramtypes', [IBrowserPort], XPoster);
  // ThreadsPoster: (IBrowserPort)
    Reflect.defineMetadata('design:paramtypes', [IBrowserPort], ThreadsPoster);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_X = {
  id: 'acc-001',
  network: SocialNetwork.X,
  handle: 'myzodiacai',
  credentialsRef: 'SOCIAL_X_USERNAME/PASSWORD',
  active: true,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

const ACTIVE_SESSION = {
  id: 'sess-001',
  accountId: 'acc-001',
  storageState: { cookies: [{ name: 'auth', value: 'token' }], origins: [] },
  status: SessionStatus.ACTIVE,
  lastHealthCheck: new Date('2026-07-15T10:00:00Z'),
  createdAt: new Date('2026-07-10T00:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
};

const NEW_SESSION = {
  id: 'sess-auto-001',
  accountId: 'acc-001',
  storageState: { cookies: [{ name: 'sess', value: 'abc' }], origins: [] },
  status: SessionStatus.ACTIVE,
  lastHealthCheck: new Date('2026-07-16T10:00:00Z'),
  createdAt: new Date('2026-07-16T10:00:00Z'),
  updatedAt: new Date('2026-07-16T10:00:00Z'),
};

const APPROVED_POST_X = {
  id: 'post-001',
  network: SocialNetwork.X,
  content: 'Mercury retrograde is coming! Time to reflect, not react.',
  status: PostStatus.APPROVED,
  postUrl: null,
  errorMessage: null,
  accountId: 'acc-001',
  threadId: null,
  threadPosition: 0,
  generationRunId: null,
  sourceRef: null,
  llmMetadata: null,
  createdAt: new Date('2026-07-15T10:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
  approvedAt: new Date('2026-07-15T10:00:00Z'),
  postedAt: null,
  account: ACCOUNT_X,
  thread: null,
  generationRun: null,
};

const POSTED_POST_X = {
  ...APPROVED_POST_X,
  status: PostStatus.POSTED,
  postUrl: 'https://x.com/myzodiacai/status/123456789',
  postedAt: new Date('2026-07-15T12:00:00Z'),
};

const DEFAULT_STORAGE_STATE = JSON.stringify({
  cookies: [{ name: 'sess', value: 'abc' }],
  origins: [],
});

// ── Test module builder ──────────────────────────────────────────────────────

interface TestContext {
  moduleRef: TestingModule;
  postingService: PostingService;
  sessionsService: SessionsService;
  postsService: PostsService;
  rateLimitService: RateLimitService;
  sseService: SseService;
  accountsService: AccountsService;
  browserPort: ReturnType<typeof createIntegrationBrowserPort>;
  prisma: ReturnType<typeof createIntegrationPrismaService>;
  mockPage: ReturnType<typeof createMockPage>;
  mockContext: ReturnType<typeof createMockContext>;
  configService: ConfigService;
}

async function buildTestingModule(
  opts: {
    pageOpts?: { url?: string; successVisible?: boolean };
    configOverrides?: Record<string, unknown>;
  } = {},
): Promise<TestContext> {
  restoreDesignParamtypes();

  const mockPage = createMockPage(opts.pageOpts);
  const mockContext = createMockContext(mockPage);
  const browserPort = createIntegrationBrowserPort(mockContext);
  const prisma = createIntegrationPrismaService();
  const configService = createMockConfigService(opts.configOverrides);

  // Sprint L: Use redisStore-backed mock so RateLimitService reads/writes
  // against the same Map that tests seed via redisStore.set().
  // Note: plain functions (not vi.fn) so vi.clearAllMocks() doesn't reset them.
  const mockSharedRedis = {
    get: (key: string) => Promise.resolve(redisStore.get(key) ?? null),
    set: (key: string, val: unknown) => { redisStore.set(key, String(val)); return Promise.resolve('OK'); },
    setex: (key: string, _ttl: number, val: string) => { redisStore.set(key, val); return Promise.resolve('OK'); },
    psetex: (key: string, _ttl: number, val: string) => { redisStore.set(key, val); return Promise.resolve('OK'); },
    del: (key: string) => { redisStore.delete(key); return Promise.resolve(1); },
    ping: () => Promise.resolve('PONG'),
    subscribe: () => Promise.resolve('OK'),
    unsubscribe: () => Promise.resolve('OK'),
    on: (event: string, cb: (channel: string, msg: string) => void) => {
      if (event === 'message') sseMessageHandlers.push(cb);
    },
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

  const moduleRef = await Test.createTestingModule({
    providers: [
      // Real service classes — real DI wiring
      PostingService,
      SessionsService,
      WarmupService,
      PostsService,
      AccountsService,
      RateLimitService,
      SseService,
      ThreadProgressService,
      XPoster,
      ThreadsPoster,
      FacebookPoster,
      // Mocked infrastructure
      { provide: IBrowserPort, useValue: browserPort },
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: configService },
      // P0-H3: Mock EncryptionService (passthrough mode)
      { provide: EncryptionService, useValue: createMockEncryptionService() },
      // DiscordNotificationService: mock (SessionsService now depends on it)
      { provide: DiscordNotificationService, useValue: { critical: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined), info: vi.fn().mockResolvedValue(undefined), sendAlert: vi.fn().mockResolvedValue(undefined) } },
      // EDA: Mock EventEmitter2 (no real event bus needed in tests)
      { provide: EventEmitter2, useValue: { emit: vi.fn() } },
      // Sprint L: Provide SHARED_REDIS tokens directly (RedisModule not imported)
      { provide: SHARED_REDIS, useValue: mockSharedRedis },
      { provide: SHARED_REDIS_SUBSCRIBER, useValue: mockSharedRedis },
      { provide: SHARED_REDIS_PUBLISHER, useValue: mockSharedRedis },
    ],
  }).compile();

  // Trigger OnModuleInit lifecycle hooks (compile() alone does not call them).
  // RateLimitService.onModuleInit creates the Redis connection (mocked ioredis).
  await moduleRef.init();

  const sseService = moduleRef.get(SseService);
  // SseModule normally calls init() in its onModuleInit; we call it manually
  // since we provide SseService directly (not via SseModule import).
  await sseService.init();

  return {
    moduleRef,
    postingService: moduleRef.get(PostingService),
    sessionsService: moduleRef.get(SessionsService),
    postsService: moduleRef.get(PostsService),
    rateLimitService: moduleRef.get(RateLimitService),
    sseService,
    accountsService: moduleRef.get(AccountsService),
    browserPort,
    prisma,
    mockPage,
    mockContext,
    configService,
  };
}

/** Reset all Prisma/browser mocks to default return values. */
function resetDefaultMocks(ctx: TestContext) {
  const { prisma, browserPort, mockPage } = ctx;

  // Prisma — post
  prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X });
  prisma.post.update.mockResolvedValue({ ...APPROVED_POST_X });
  prisma.post.findMany.mockResolvedValue([]);
  prisma.post.count.mockResolvedValue(0);

  // Prisma — session
  prisma.session.findFirst.mockResolvedValue({ ...ACTIVE_SESSION });
  prisma.session.create.mockResolvedValue({ ...NEW_SESSION });
  prisma.session.update.mockResolvedValue({});
  prisma.session.findMany.mockResolvedValue([]);

  // Prisma — socialAccount
  prisma.socialAccount.findFirst.mockResolvedValue({ ...ACCOUNT_X });
  prisma.socialAccount.findMany.mockResolvedValue([{ ...ACCOUNT_X }]);
  prisma.socialAccount.create.mockResolvedValue({ ...ACCOUNT_X });

  // Browser port
  browserPort.createContext.mockResolvedValue(ctx.mockContext);
  browserPort.acquireContext.mockResolvedValue(ctx.mockContext);
  browserPort.releaseContext.mockReturnValue(undefined);
  browserPort.saveStorageState.mockResolvedValue(DEFAULT_STORAGE_STATE);
  browserPort.randomDelay.mockResolvedValue(undefined);

  // Mock page
  mockPage.goto.mockResolvedValue(undefined);
  mockPage.url.mockReturnValue('https://x.com/status/123456789');
  mockPage._locatorFirst.waitFor.mockResolvedValue(undefined);
  mockPage._locatorFirst.click.mockResolvedValue(undefined);
  mockPage._locatorFirst.fill.mockResolvedValue(undefined);
  mockPage._locatorFirst.isVisible.mockResolvedValue(true);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Sandwich Integration: Posting ↔ Sessions ↔ Browser (ITC-010..014, ITC-023..025, ITC-034)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await buildTestingModule();
  });

  afterAll(async () => {
    await ctx.moduleRef.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();
    resetDefaultMocks(ctx);
  });

  // ── ITC-010: Posting → Browser Port Integration ───────────────────────────

  it('ITC-010: PostingService calls IBrowserPort.createContext(network, storageState) and saveStorageState() — post marked POSTED', async () => {
    // Arrange: APPROVED post + ACTIVE session (defaults already set)
    ctx.prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X, id: 'post-010' });

    // Act
    const result = await ctx.postingService.postById('post-010');

    // Assert: acquireContext called with network + storageState from session
    expect(ctx.browserPort.acquireContext).toHaveBeenCalledTimes(1);
    const [networkArg, storageStateArg] = ctx.browserPort.acquireContext.mock.calls[0];
    expect(networkArg).toBe(SocialNetwork.X);
    expect(storageStateArg).toBe(JSON.stringify(ACTIVE_SESSION.storageState));

    // Assert: saveStorageState called with the context after posting
    expect(ctx.browserPort.saveStorageState).toHaveBeenCalledTimes(1);
    expect(ctx.browserPort.saveStorageState.mock.calls[0][0]).toBe(ctx.mockContext);

    // Assert: post status updated to POSTED in DB
    const postedUpdate = ctx.prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTED,
    );
    expect(postedUpdate).toBeDefined();
    expect(postedUpdate[0].where.id).toBe('post-010');
    expect(postedUpdate[0].data.postUrl).toBeTruthy();

    // Assert: success returned
    expect(result.success).toBe(true);
    expect(result.url).toBeTruthy();
  });

  // ── ITC-011: Posting → Sessions Integration ───────────────────────────────

  it('ITC-011: PostingService calls SessionsService.getOrCreateSession(network) before posting — storageState flows to createContext', async () => {
    ctx.prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X, id: 'post-011' });

    // Spy on the real getOrCreateSession — calls through to original
    const getOrCreateSpy = vi.spyOn(ctx.sessionsService, 'getOrCreateSession');

    // Act
    await ctx.postingService.postById('post-011');

    // Assert: getOrCreateSession called with the post's network
    expect(getOrCreateSpy).toHaveBeenCalledTimes(1);
    expect(getOrCreateSpy).toHaveBeenCalledWith(SocialNetwork.X, { deferFormLogin: true });

    // Assert: session.storageState was passed to browser.acquireContext
    expect(ctx.browserPort.acquireContext).toHaveBeenCalledTimes(1);
    const [, storageStateArg] = ctx.browserPort.acquireContext.mock.calls[0];
    expect(storageStateArg).toBe(JSON.stringify(ACTIVE_SESSION.storageState));

    // Assert: session.updateStorageState called after posting (session state saved)
    const updateCall = ctx.prisma.session.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === SessionStatus.ACTIVE,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0].where.id).toBe(ACTIVE_SESSION.id);
  });

  // ── ITC-012: Sessions → Browser Port Integration (Auto-Login) ─────────────

  it('ITC-012: SessionsService.autoLogin() uses IBrowserPort — createContext(X) without storageState, page.goto(loginUrl), saveStorageState, session created ACTIVE', async () => {
    // Arrange: no active session → triggers autoLogin
    ctx.prisma.session.findFirst.mockResolvedValue(null);
    ctx.prisma.session.create.mockResolvedValue({ ...NEW_SESSION });
    ctx.prisma.socialAccount.findFirst.mockResolvedValue({ ...ACCOUNT_X });
    // Mock page with success indicator visible (login succeeds)
    ctx.mockPage._locatorFirst.isVisible.mockResolvedValue(true);
    ctx.mockPage.url.mockReturnValue('https://x.com/home');

    // Act
    const session = await ctx.sessionsService.getOrCreateSession(SocialNetwork.X);

    // Assert: createContext called with network only (no storageState)
    expect(ctx.browserPort.createContext).toHaveBeenCalledTimes(1);
    const [networkArg, storageStateArg] = ctx.browserPort.createContext.mock.calls[0];
    expect(networkArg).toBe(SocialNetwork.X);
    expect(storageStateArg).toBeUndefined();

    // Assert: page.goto called with the X login URL
    expect(ctx.mockPage.goto).toHaveBeenCalledWith(
      'https://x.com/i/flow/login',
      { waitUntil: 'domcontentloaded', timeout: 30000 },
    );

    // Assert: saveStorageState called (to capture session state)
    expect(ctx.browserPort.saveStorageState).toHaveBeenCalledTimes(1);

    // Assert: session created in DB with status=ACTIVE
    expect(ctx.prisma.session.create).toHaveBeenCalledTimes(1);
    const createArg = ctx.prisma.session.create.mock.calls[0][0];
    expect(createArg.data.accountId).toBe(ACCOUNT_X.id);
    expect(createArg.data.status).toBe(SessionStatus.ACTIVE);
    // P0-H3: storageState is now encrypted (stringified in passthrough mode)
    expect(createArg.data.storageState).toEqual(DEFAULT_STORAGE_STATE);
    expect(createArg.data.lastHealthCheck).toBeInstanceOf(Date);

    // Assert: returned session is the new ACTIVE session
    expect(session).toEqual(expect.objectContaining({ id: NEW_SESSION.id, status: SessionStatus.ACTIVE }));
  });

  // ── ITC-013: Posting → RateLimit + SSE Integration (Full Posting Flow) ────

  it('ITC-013: Full posting flow — rate check → SSE POSTING → post → SSE POSTED → recordPost (correct sequence)', async () => {
    ctx.prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X, id: 'post-013' });

    // Spy on real service methods (call through to original)
    const checkRateSpy = vi.spyOn(ctx.rateLimitService, 'checkRateLimit');
    const recordPostSpy = vi.spyOn(ctx.rateLimitService, 'recordPost');
    const publishSpy = vi.spyOn(ctx.sseService, 'publish');

    // Act
    const result = await ctx.postingService.postById('post-013');

    // Assert: rate limit checked before posting
    expect(checkRateSpy).toHaveBeenCalledTimes(1);
    expect(checkRateSpy).toHaveBeenCalledWith('X');
    const rateCheckCallOrder = checkRateSpy.mock.invocationCallOrder[0];

    // Assert: SSE POSTING event published
    const postingEvent = publishSpy.mock.calls.find((c: unknown[]) => c[0]?.status === 'POSTING');
    expect(postingEvent).toBeDefined();
    expect(postingEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-013',
      status: 'POSTING',
      network: 'X',
    });
    const postingEventOrder = publishSpy.mock.invocationCallOrder[
      publishSpy.mock.calls.findIndex((c: unknown[]) => c[0]?.status === 'POSTING')
    ];

    // Assert: SSE POSTED event published with url
    const postedEvent = publishSpy.mock.calls.find((c: unknown[]) => c[0]?.status === 'POSTED');
    expect(postedEvent).toBeDefined();
    expect(postedEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-013',
      status: 'POSTED',
      network: 'X',
    });
    expect(postedEvent[0].url).toBeTruthy();
    const postedEventOrder = publishSpy.mock.invocationCallOrder[
      publishSpy.mock.calls.findIndex((c: unknown[]) => c[0]?.status === 'POSTED')
    ];

    // Assert: recordPost called after success
    expect(recordPostSpy).toHaveBeenCalledTimes(1);
    expect(recordPostSpy).toHaveBeenCalledWith('X');
    const recordPostOrder = recordPostSpy.mock.invocationCallOrder[0];

    // Assert: correct sequence — rate check < POSTING event < POSTED event
    // NOTE: In source code, recordPost is called BEFORE the POSTED SSE event:
    //   updateStatus(POSTED) → recordPost → publish(POSTED)
    expect(rateCheckCallOrder).toBeLessThan(postingEventOrder);
    expect(postingEventOrder).toBeLessThan(postedEventOrder);
    // recordPost happens between updateStatus(POSTED) and publish(POSTED)
    expect(recordPostOrder).toBeGreaterThan(postingEventOrder);
    expect(recordPostOrder).toBeLessThan(postedEventOrder);

    // Assert: post status = POSTED in DB
    const postedUpdate = ctx.prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTED,
    );
    expect(postedUpdate).toBeDefined();

    // Assert: success returned with url
    expect(result.success).toBe(true);
    expect(result.url).toBeTruthy();
  });

  // ── ITC-014: Posting → RateLimit (Rate Limited → Throw → Retry) ───────────

  it('ITC-014: PostingService throws Error("Rate limited") when rate limit exceeded — post status remains APPROVED (not POSTING)', async () => {
    // Arrange: seed Redis interval key to now (just posted → rate limited)
    const intervalKey = 'spa:ratelimit:X:interval';
    redisStore.set(intervalKey, Date.now().toString());

    ctx.prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X, id: 'post-014' });

    // Spy on SSE publish BEFORE the call to verify no events are emitted
    const publishSpy = vi.spyOn(ctx.sseService, 'publish');

    // Act + Assert: throws Error with "Rate limited" message
    await expect(ctx.postingService.postById('post-014')).rejects.toThrow('Rate limited');

    // Assert: post status NOT changed to POSTING (updateStatus not called)
    const postingUpdate = ctx.prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTING,
    );
    expect(postingUpdate).toBeUndefined();

    // Assert: no post.update at all — status remains APPROVED
    expect(ctx.prisma.post.update).not.toHaveBeenCalled();

    // Assert: browser NOT touched (posting deferred)
    expect(ctx.browserPort.createContext).not.toHaveBeenCalled();

    // Assert: no SSE events published (rate limit throws before any posting logic)
    expect(publishSpy).not.toHaveBeenCalled();
  });

  // ── ITC-023: Posting → SSE (FAILED Event on Poster Error) ─────────────────

  it('ITC-023: SSE FAILED event published when poster returns error — post marked FAILED with errorMessage', async () => {
    // Arrange: make XPoster fail by having page.goto throw "Navigation timeout"
    ctx.mockPage.goto.mockRejectedValue(new Error('Navigation timeout'));
    ctx.prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X, id: 'post-023' });

    // Spy on SSE publish BEFORE the call to capture all events
    const publishSpy = vi.spyOn(ctx.sseService, 'publish');

    // Act
    const result = await ctx.postingService.postById('post-023');

    // Assert: SSE POSTING event published (before the error)
    const postingEvent = publishSpy.mock.calls.find((c: unknown[]) => c[0]?.status === 'POSTING');
    expect(postingEvent).toBeDefined();
    expect(postingEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-023',
      status: 'POSTING',
      network: 'X',
    });

    // Assert: SSE FAILED event published with error message
    const failedEvent = publishSpy.mock.calls.find((c: unknown[]) => c[0]?.status === 'FAILED');
    expect(failedEvent).toBeDefined();
    expect(failedEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-023',
      status: 'FAILED',
      network: 'X',
    });
    expect(failedEvent[0].error).toContain('Navigation timeout');

    // Assert: result is failure with error
    expect(result.success).toBe(false);
    expect(result.error).toContain('Navigation timeout');

    // Assert: post status = FAILED in DB with errorMessage
    const failedUpdate = ctx.prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.FAILED,
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate[0].where.id).toBe('post-023');
    expect(failedUpdate[0].data.errorMessage).toContain('Navigation timeout');

    // Assert: recordPost NOT called (only on success) — no interval key in Redis
    expect(redisStore.has('spa:ratelimit:X:interval')).toBe(false);
  });

  // ── ITC-024: Posting → SSE (FAILED Event on Exception) ────────────────────

  it('ITC-024: SSE FAILED event published when posting throws exception (no session) — post marked FAILED with "No active session"', async () => {
    // Arrange: no account → getOrCreateSession returns null → throws
    ctx.prisma.socialAccount.findFirst.mockResolvedValue(null);
    ctx.prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X, id: 'post-024' });

    // Spy on SSE publish BEFORE the call to capture all events
    const publishSpy = vi.spyOn(ctx.sseService, 'publish');

    // Act
    const result = await ctx.postingService.postById('post-024');

    // Assert: exception caught, returns failure
    expect(result.success).toBe(false);
    expect(result.error).toContain('No active session');

    // Assert: SSE POSTING event was published (before the exception in try block)
    const postingEvent = publishSpy.mock.calls.find((c: unknown[]) => c[0]?.status === 'POSTING');
    expect(postingEvent).toBeDefined();
    expect(postingEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-024',
      status: 'POSTING',
      network: 'X',
    });

    // Assert: SSE FAILED event published with "No active session" error
    const failedEvent = publishSpy.mock.calls.find((c: unknown[]) => c[0]?.status === 'FAILED');
    expect(failedEvent).toBeDefined();
    expect(failedEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-024',
      status: 'FAILED',
      network: 'X',
    });
    expect(failedEvent[0].error).toContain('No active session');

    // Assert: post status = FAILED with "No active session" error
    const failedUpdate = ctx.prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.FAILED,
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate[0].where.id).toBe('post-024');
    expect(failedUpdate[0].data.errorMessage).toContain('No active session');

    // Assert: POSTING status was set before the exception
    const postingUpdate = ctx.prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTING,
    );
    expect(postingUpdate).toBeDefined();

    // Assert: recordPost NOT called — no interval key in Redis
    expect(redisStore.has('spa:ratelimit:X:interval')).toBe(false);

    // Assert: browser NOT called (session was null, threw before createContext)
    expect(ctx.browserPort.createContext).not.toHaveBeenCalled();
  });

  // ── ITC-025: Posting Idempotency (Already POSTED) ─────────────────────────

  it('ITC-025: postById returns success with existing url when post already POSTED — no browser, no SSE, no side effects', async () => {
    // Arrange: post already POSTED with postUrl
    ctx.prisma.post.findUnique.mockResolvedValue({
      ...POSTED_POST_X,
      id: 'post-025',
    });

    // Act
    const result = await ctx.postingService.postById('post-025');

    // Assert: returns success with existing url
    expect(result).toEqual({
      success: true,
      url: 'https://x.com/myzodiacai/status/123456789',
    });

    // Assert: IBrowserPort.createContext NOT called
    expect(ctx.browserPort.createContext).not.toHaveBeenCalled();

    // Assert: no SSE events published (check via Redis publish not called)
    // Since SseService.publish calls redis.publish, and no posting flow ran,
    // the mock Redis publish should not have been called.
    // We verify by checking no post.update calls were made.
    expect(ctx.prisma.post.update).not.toHaveBeenCalled();

    // Assert: no rate limit check (checkRateLimit not called — no Redis incr)
    // The daily key would be set if checkRateLimit ran
    const today = new Date().toISOString().slice(0, 10);
    expect(redisStore.has(`spa:ratelimit:X:daily:${today}`)).toBe(false);
  });

  // ── ITC-034: Posting → Sessions (Auto-Login on Expired Session) ───────────

  it('ITC-034: Posting triggers autoLogin when session is EXPIRED — new ACTIVE session created, storageState saved, post POSTED', async () => {
    // Arrange: no ACTIVE session (expired) → autoLogin triggered
    ctx.prisma.session.findFirst.mockResolvedValue(null); // no active session
    ctx.prisma.session.create.mockResolvedValue({ ...NEW_SESSION });
    ctx.prisma.socialAccount.findFirst.mockResolvedValue({ ...ACCOUNT_X });
    ctx.prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X, id: 'post-034' });

    // Mock page: login succeeds (success indicator visible).
    // URL 'https://x.com/status/123456789' works for BOTH:
    //   - autoLogin: no 'challenge'/'checkpoint' in URL → login succeeds
    //   - XPoster: matches /\/status\/(\d+)$/ → postUrl captured
    // (Default URL from resetDefaultMocks is already correct — no override needed.)
    ctx.mockPage._locatorFirst.isVisible.mockResolvedValue(true);

    // Spy on getOrCreateSession to verify it's called
    const getOrCreateSpy = vi.spyOn(ctx.sessionsService, 'getOrCreateSession');

    // Act
    const result = await ctx.postingService.postById('post-034');

    // Assert: getOrCreateSession called with X
    expect(getOrCreateSpy).toHaveBeenCalledWith(SocialNetwork.X, { deferFormLogin: true });

    // Assert: autoLogin triggered — browser.createContext called for login (no storageState)
    // autoLogin uses createContext (SessionsService), posting uses acquireContext (PostingService)
    expect(ctx.browserPort.createContext).toHaveBeenCalledTimes(1);
    const [autoLoginNetwork, autoLoginStorageState] = ctx.browserPort.createContext.mock.calls[0];
    expect(autoLoginNetwork).toBe(SocialNetwork.X);
    expect(autoLoginStorageState).toBeUndefined(); // autoLogin: no saved state

    // Assert: new ACTIVE session created in DB
    expect(ctx.prisma.session.create).toHaveBeenCalledTimes(1);
    const createArg = ctx.prisma.session.create.mock.calls[0][0];
    expect(createArg.data.accountId).toBe(ACCOUNT_X.id);
    expect(createArg.data.status).toBe(SessionStatus.ACTIVE);

    // Assert: acquireContext call uses storageState from the new session
    expect(ctx.browserPort.acquireContext).toHaveBeenCalledTimes(1);
    const [, postingStorageState] = ctx.browserPort.acquireContext.mock.calls[0];
    expect(postingStorageState).toBe(JSON.stringify(NEW_SESSION.storageState));

    // Assert: session storageState updated after posting (updateStorageState called)
    const sessionUpdateCalls = ctx.prisma.session.update.mock.calls.filter(
      (c: unknown[]) => c[0]?.data?.status === SessionStatus.ACTIVE && c[0]?.data?.storageState !== undefined,
    );
    expect(sessionUpdateCalls.length).toBeGreaterThanOrEqual(1);
    // The update should target the new session
    const updateForNewSession = sessionUpdateCalls.find((c: unknown[]) => c[0]?.where?.id === NEW_SESSION.id);
    expect(updateForNewSession).toBeDefined();

    // Assert: post status = POSTED
    const postedUpdate = ctx.prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTED,
    );
    expect(postedUpdate).toBeDefined();
    expect(postedUpdate[0].where.id).toBe('post-034');

    // Assert: success
    expect(result.success).toBe(true);
    expect(result.url).toBeTruthy();
  });
});
