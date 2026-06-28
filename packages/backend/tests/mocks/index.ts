/**
 * Mock factories for unit tests.
 *
 * Each factory returns a typed mock object that satisfies a domain port
 * or service interface. Tests can override individual methods as needed.
 *
 * Pattern: const mock = createMockLlmPort();
 *          mock.generateChat = vi.fn().mockResolvedValue({ content: '...' });
 */

import { vi } from 'vitest';
import type { ILlmPort, LlmResponse, GenerateOptions } from '../../src/domain/ports/llm.port';
import type { IContentPort } from '../../src/domain/ports/content.port';
import type { IBrowserPort } from '../../src/domain/ports/browser.port';
import type { ContentTopic } from '@spa/shared';

// ── LLM Port Mock ──

export function createMockLlmPort(): ILlmPort {
  return {
    generate: vi.fn().mockResolvedValue({
      content: 'Mock LLM generated content',
      model: 'gpt-4o-mini',
      tokens: 100,
      cost: 0.001,
    } satisfies LlmResponse),
    generateChat: vi.fn().mockResolvedValue({
      content: 'Mock LLM chat content',
      model: 'gpt-4o-mini',
      tokens: 150,
      cost: 0.001,
    } satisfies LlmResponse),
  };
}

// ── Content Port Mock ──

export function createMockContentPort(topics?: ContentTopic[]): IContentPort {
  const defaultTopics: ContentTopic[] = [
    {
      id: 'topic-1',
      title: 'Mercury Retrograde 2026',
      type: 'brief',
      facts: ['Mercury retrograde starts July 14', 'Ends August 7'],
      sourceRef: { type: 'brief', path: 'briefs/mercury-retro-2026.json' },
    },
    {
      id: 'topic-2',
      title: 'Full Moon in Capricorn',
      type: 'article',
      facts: ['Full moon on July 21', 'Capricorn energy: discipline'],
      sourceRef: { type: 'article', path: 'blog/en/full-moon-capricorn.md' },
    },
  ];
  const data = topics ?? defaultTopics;
  return {
    getTopics: vi.fn().mockResolvedValue(data),
    readBriefs: vi.fn().mockResolvedValue(data.filter((t) => t.type === 'brief')),
    readArticles: vi.fn().mockResolvedValue(data.filter((t) => t.type === 'article')),
  };
}

// ── Browser Port Mock ──

/**
 * Create a mock locator that supports the chainable Playwright locator API.
 * Returns a locator-like object with waitFor, click, fill, isVisible, etc.
 */
export function createMockLocator() {
  const locator: Record<string, ReturnType<typeof vi.fn>> = {};
  locator.waitFor = vi.fn().mockResolvedValue(undefined);
  locator.click = vi.fn().mockResolvedValue(undefined);
  locator.fill = vi.fn().mockResolvedValue(undefined);
  locator.focus = vi.fn().mockResolvedValue(undefined);
  locator.isVisible = vi.fn().mockResolvedValue(true);
  locator.isEnabled = vi.fn().mockResolvedValue(true);
  locator.isDisabled = vi.fn().mockResolvedValue(false);
  locator.isHidden = vi.fn().mockResolvedValue(false);
  locator.count = vi.fn().mockResolvedValue(0);
  locator.first = vi.fn().mockReturnValue(locator);
  locator.last = vi.fn().mockReturnValue(locator);
  locator.nth = vi.fn().mockReturnValue(locator);
  locator.or = vi.fn().mockReturnValue(locator);
  locator.all = vi.fn().mockResolvedValue([locator]);
  locator.allInnerTexts = vi.fn().mockResolvedValue([]);
  locator.evaluate = vi.fn().mockResolvedValue(undefined);
  locator.evaluateAll = vi.fn().mockResolvedValue([]);
  locator.getAttribute = vi.fn().mockResolvedValue(null);
  locator.textContent = vi.fn().mockResolvedValue('');
  locator.innerText = vi.fn().mockResolvedValue('');
  locator.scrollIntoViewIfNeeded = vi.fn().mockResolvedValue(undefined);
  locator.pressSequentially = vi.fn().mockResolvedValue(undefined);
  locator.press = vi.fn().mockResolvedValue(undefined);
  locator.type = vi.fn().mockResolvedValue(undefined);
  return locator as unknown;
}

/**
 * Create a mock Playwright Page that supports the methods used by BasePoster.
 * Includes: goto, locator, getByRole, getByLabel, getByText, url, close, keyboard, etc.
 */
export function createMockPage(opts: {
  url?: string;
  urlSequence?: string[];
  bodyText?: string;
} = {}) {
  const mockLocator = createMockLocator();

  let urlCallIndex = 0;
  const urlFn = vi.fn(() => {
    if (opts.urlSequence && urlCallIndex < opts.urlSequence.length) {
      return opts.urlSequence[urlCallIndex++];
    }
    return opts.url ?? 'https://x.com/user/status/1234567890';
  });

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: urlFn,
    close: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(mockLocator),
    getByRole: vi.fn().mockReturnValue(mockLocator),
    getByLabel: vi.fn().mockReturnValue(mockLocator),
    getByText: vi.fn().mockReturnValue(mockLocator),
    getByPlaceholder: vi.fn().mockReturnValue(mockLocator),
    getByTestId: vi.fn().mockReturnValue(mockLocator),
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
    },
    textContent: vi.fn().mockResolvedValue(opts.bodyText ?? ''),
    innerText: vi.fn().mockResolvedValue(opts.bodyText ?? ''),
    screenshot: vi.fn().mockResolvedValue('/tmp/mock-screenshot.png'),
    evaluate: vi.fn().mockResolvedValue(undefined),
    evaluateAll: vi.fn().mockResolvedValue([]),
    content: vi.fn().mockResolvedValue('<html></html>'),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(true),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    _locator: mockLocator,
  };
  return page;
}

/** Build a mock BrowserContext whose newPage() resolves to the supplied page. */
export function createMockContext(
  page: ReturnType<typeof createMockPage>,
  opts?: { cookies?: Array<{ name: string; value: string; domain: string; expires?: number }> },
) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockReturnValue([page]),
    storageState: vi.fn().mockResolvedValue({}),
    cookies: vi.fn().mockResolvedValue(opts?.cookies ?? []),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

export function createMockBrowserPort(): IBrowserPort {
  const mockContext = {
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn(),
      click: vi.fn(),
      fill: vi.fn(),
      waitForSelector: vi.fn(),
      screenshot: vi.fn(),
      close: vi.fn(),
    }),
    close: vi.fn(),
    storageState: vi.fn().mockResolvedValue({}),
  } as unknown;
  return {
    createContext: vi.fn().mockResolvedValue(mockContext),
    acquireContext: vi.fn().mockResolvedValue(mockContext),
    releaseContext: vi.fn(),
    saveStorageState: vi.fn().mockResolvedValue(
      JSON.stringify({ cookies: [], origins: [] }),
    ),
    randomDelay: vi.fn().mockResolvedValue(undefined),
    // New methods added in Phase 1.1
    humanType: vi.fn().mockResolvedValue(undefined),
    // Stealth human-like typing (stealth-x approach) — used for X login
    typeHuman: vi.fn().mockResolvedValue(undefined),
    humanClick: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    scrollPage: vi.fn().mockResolvedValue(undefined),
    scrollToElement: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue('/tmp/mock-screenshot.png'),
    extractText: vi.fn().mockResolvedValue(''),
    waitForStable: vi.fn().mockResolvedValue(undefined),
    dismissDialogs: vi.fn().mockResolvedValue(undefined),
  } as unknown as IBrowserPort;
}

// ── Prisma Service Mock ──

/**
 * Creates a mock PrismaService with chained mock methods.
 * Each model gets a set of standard CRUD mocks.
 */
export function createMockPrismaService() {
  const createModelMock = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  });

  return {
    generationRun: {
      ...createModelMock(),
      _count: { posts: vi.fn() },
    },
    post: {
      ...createModelMock(),
    },
    postThread: {
      ...createModelMock(),
    },
    session: {
      ...createModelMock(),
    },
    account: {
      ...createModelMock(),
    },
    socialAccount: {
      ...createModelMock(),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $transaction: vi.fn((cb) => cb({})),
    $queryRaw: vi.fn(),
  };
}

// ── Redis Mock ──

export function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, val: string) => {
      store.set(key, val);
      return Promise.resolve('OK');
    }),
    setex: vi.fn((key: string, _ttl: number, val: string) => {
      store.set(key, val);
      return Promise.resolve('OK');
    }),
    incr: vi.fn((key: string) => {
      const val = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(val));
      return Promise.resolve(val);
    }),
    expire: vi.fn().mockResolvedValue(1),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    exists: vi.fn((key: string) => Promise.resolve(store.has(key) ? 1 : 0)),
    ping: vi.fn().mockResolvedValue('PONG'),
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue('OK'),
    unsubscribe: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
    duplicate: vi.fn().mockReturnThis(),
    _store: store, // exposed for test assertions
  };
}

// ── SSE Service Mock ──

export function createMockSseService() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    addClient: vi.fn(),
    removeClient: vi.fn(),
    broadcast: vi.fn(),
    getActiveClientCount: vi.fn().mockReturnValue(0),
  };
}

// ── Encryption Service Mock ──

/**
 * P0-H3: Mock EncryptionService — passthrough mode (no encryption).
 * encrypt() returns JSON.stringify(data), decrypt() returns JSON.parse(data).
 * This matches the behavior when SESSION_ENCRYPTION_KEY is not set.
 */
export function createMockEncryptionService() {
  return {
    encrypt: vi.fn((data: unknown) => JSON.stringify(data)),
    decrypt: vi.fn((s: string) => JSON.parse(s)),
    isEnabled: vi.fn().mockReturnValue(false),
    isEncrypted: vi.fn((s: string) => s.startsWith('v1:')),
  };
}

// ── Rate Limit Service Mock ──

export function createMockRateLimitService() {
  return {
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    recordPost: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({
      dailyCount: 0,
      dailyLimit: 50,
      lastPostAt: null,
      minIntervalMs: 120000,
    }),
  };
}

// ── Thread Progress Service Mock ──

/**
 * P0-H2: Mock ThreadProgressService — all methods resolve successfully.
 * Used by PostingService tests to verify per-reply persistence calls.
 */
export function createMockThreadProgressService() {
  return {
    initThread: vi.fn().mockResolvedValue(undefined),
    markReplyPosted: vi.fn().mockResolvedValue(undefined),
    markReplyFailed: vi.fn().mockResolvedValue(undefined),
    getPendingReplies: vi.fn().mockResolvedValue([]),
    getThreadProgress: vi.fn().mockResolvedValue([]),
    isThreadComplete: vi.fn().mockResolvedValue(true),
    getThreadStats: vi.fn().mockResolvedValue({ total: 0, posted: 0, failed: 0, pending: 0 }),
  };
}

// ── Queue Service Mock ──

export function createMockQueueService() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
    addBulk: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }),
    getFailedJobs: vi.fn().mockResolvedValue([]),
    retryJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Checkpoint Saver Mock ──

export function createMockCheckpointSaver() {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  };
}

// ── Fixture Data ──

export const fixtureTopics: ContentTopic[] = [
  {
    id: 'topic-1',
    title: 'Mercury Retrograde July 2026',
    type: 'brief',
    facts: ['Mercury retrograde: July 14 – August 7, 2026', 'Zodiac signs affected: Leo, Virgo'],
    sourceRef: { type: 'brief', path: 'briefs/mercury-retro-2026.json' },
  },
  {
    id: 'topic-2',
    title: 'Full Moon in Capricorn',
    type: 'article',
    facts: ['Full moon on July 21, 2026', 'Capricorn energy: discipline, ambition'],
    sourceRef: { type: 'article', path: 'blog/en/full-moon-capricorn.md' },
  },
  {
    id: 'topic-3',
    title: 'Cosmic Weather Weekly',
    type: 'topic',
    facts: ['Week of July 15: Venus trine Jupiter', 'Favorable for relationships'],
    sourceRef: { type: 'topic', path: 'topics/cosmic-weather-w28.json' },
  },
];

export const fixturePost = {
  id: 'post-001',
  network: 'X' as const,
  content: 'Mercury retrograde is coming! Time to reflect, not react. ♋',
  status: 'DRAFT' as const,
  generationRunId: 'run-001',
  sourceRef: { type: 'brief', path: 'briefs/mercury-retro-2026.json' },
  llmMetadata: { model: 'gpt-4o-mini', tokens: 120, cost: 0.001 },
  createdAt: new Date('2026-07-15T10:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
  approvedAt: null,
  postedAt: null,
  postUrl: null,
  errorMessage: null,
  threadId: null,
  threadPosition: null,
  accountId: 'acc-001',
};

export const fixtureGenerationRun = {
  id: 'run-001',
  status: 'COMPLETED' as const,
  triggeredBy: 'MANUAL' as const,
  sourceTopics: ['topic-1', 'topic-2'],
  startedAt: new Date('2026-07-15T10:00:00Z'),
  completedAt: new Date('2026-07-15T10:05:00Z'),
  errorMessage: null,
  posts: [],
};

export const fixtureSession = {
  id: 'session-001',
  network: 'X' as const,
  status: 'ACTIVE' as const,
  storageState: JSON.stringify({ cookies: [], origins: [] }),
  lastHealthCheck: new Date('2026-07-15T10:00:00Z'),
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
};
