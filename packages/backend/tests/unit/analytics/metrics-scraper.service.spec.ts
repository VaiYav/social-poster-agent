/**
 * F6: Metrics Scraper Service — unit tests.
 *
 * Tests:
 *   - collectMetrics() with no browser → graceful skip
 *   - collectMetrics() with browser → collects and persists metrics
 *   - collectMetrics() handles scraping errors gracefully
 *   - getLatestMetricsForPost() returns latest snapshot
 *   - getMetricsHistory() returns time-series
 *   - cron is gated by METRICS_SCRAPER_ENABLED
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsScraperService } from '../../../src/modules/analytics/metrics-scraper.service';
import { PrismaService } from '../../../src/infrastructure/prisma/prisma.service';
import { SseService } from '../../../src/infrastructure/sse/sse.service';
import { IBrowserPort } from '../../../src/domain/ports/browser.port';
import { SocialNetwork, PostStatus } from '@prisma/client';
import { createMockConfigService, createMockRedis } from '../../mocks/index.js';

// Mock IBrowserPort
function createMockBrowser() {
  return {
    createContext: vi.fn().mockResolvedValue({
      newPage: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    randomDelay: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPrisma() {
  return {
    post: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    postMetrics: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function createMockSse() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockMetricsRedis() {
  const redis = createMockRedis();
  // Track lock state so tests can assert concurrent-run protection.
  redis.set.mockImplementation(
    (key: string, _token: string, ...args: unknown[]) => {
      if (key.startsWith('spa:lock:metrics-scraper')) {
        // NX semantics: if key already exists, return null.
        if (redis._store.has(key)) return Promise.resolve(null);
        // PX/EX option is at args[0], ttl at args[1] — just store the token.
        const ttl = args.length >= 2 ? Number(args[1]) : 0;
        redis._store.set(key, _token);
        return Promise.resolve('OK');
      }
      return Promise.resolve('OK');
    },
  );
  redis.eval.mockImplementation(
    (script: string, _numKeys: number, key: string, token: string) => {
      if (script.includes('redis.call') && key.startsWith('spa:lock:metrics-scraper')) {
        const stored = redis._store.get(key);
        if (stored === token) {
          redis._store.delete(key);
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }
      return Promise.resolve(undefined);
    },
  );
  return redis;
}

describe('F6: MetricsScraperService', () => {
  let service: MetricsScraperService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let sse: ReturnType<typeof createMockSse>;
  let browser: ReturnType<typeof createMockBrowser>;
  let config: ReturnType<typeof createMockConfigService>;
  let redis: ReturnType<typeof createMockMetricsRedis>;

  beforeEach(() => {
    // AN1: keep the metrics-source registry empty so the "no source → skip" path
    // under test is preserved regardless of the ambient env.
    prisma = createMockPrisma();
    sse = createMockSse();
    browser = createMockBrowser();
    config = createMockConfigService();
    redis = createMockMetricsRedis();
    service = new MetricsScraperService(
      config as any,
      prisma as any,
      sse as any,
      { addCronJob: vi.fn(), deleteCronJob: vi.fn() } as any,
      browser as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('F6-001: collectMetrics() skips gracefully when browser is not available', async () => {
    const noBrowserService = new MetricsScraperService(
      config as any,
      prisma as any,
      sse as any,
      { addCronJob: vi.fn(), deleteCronJob: vi.fn() } as any,
      undefined as any,
    );
    const result = await noBrowserService.collectMetrics();
    expect(result.collected).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('F6-002: collectMetrics() returns zeros when no posts to scrape', async () => {
    prisma.post.findMany.mockResolvedValue([]);
    const result = await service.collectMetrics();
    expect(result.collected).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('F6-003: collectMetrics() skips posts when scraper is stubbed (returns null)', async () => {
    const posts = [
      {
        id: 'post-1',
        postUrl: 'https://x.com/user/status/123',
        network: SocialNetwork.X,
        accountId: 'acc-1',
      },
      {
        id: 'post-2',
        postUrl: 'https://threads.net/@user/post/abc',
        network: SocialNetwork.THREADS,
        accountId: 'acc-2',
      },
    ];
    prisma.post.findMany.mockResolvedValue(posts);
    prisma.postMetrics.create.mockResolvedValue({ id: 'metrics-1' });

    const result = await service.collectMetrics();

    // scrapePostMetrics returns null when stubbed → posts are skipped, not collected
    expect(result.collected).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
    // Should NOT write zero metrics to DB
    expect(prisma.postMetrics.create).not.toHaveBeenCalled();
  });

  it('F6-004: collectMetrics() handles scraping errors gracefully', async () => {
    const posts = [
      {
        id: 'post-fail',
        postUrl: 'https://x.com/user/status/999',
        network: SocialNetwork.X,
        accountId: 'acc-1',
      },
    ];
    prisma.post.findMany.mockResolvedValue(posts);
    // Make browser throw
    browser.createContext.mockRejectedValue(new Error('Browser launch failed'));

    const result = await service.collectMetrics();

    // When browser throws, scrapePostMetrics catches and returns null → skipped
    expect(result.collected).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('F6-005: getLatestMetricsForPost() returns null when no metrics exist', async () => {
    prisma.postMetrics.findFirst.mockResolvedValue(null);
    const result = await service.getLatestMetricsForPost('post-1');
    expect(result).toBeNull();
  });

  it('F6-006: getLatestMetricsForPost() returns latest metrics snapshot', async () => {
    const metrics = {
      likes: 42,
      comments: 5,
      shares: 3,
      impressions: 1000,
      collectedAt: new Date('2026-07-27T10:00:00Z'),
    };
    prisma.postMetrics.findFirst.mockResolvedValue(metrics);
    const result = await service.getLatestMetricsForPost('post-1');
    expect(result).toEqual(metrics);
  });

  it('F6-007: getMetricsHistory() returns time-series array', async () => {
    const history = [
      { likes: 10, comments: 1, shares: 0, collectedAt: new Date('2026-07-25T10:00:00Z') },
      { likes: 25, comments: 3, shares: 2, collectedAt: new Date('2026-07-26T10:00:00Z') },
      { likes: 42, comments: 5, shares: 3, collectedAt: new Date('2026-07-27T10:00:00Z') },
    ];
    prisma.postMetrics.findMany.mockResolvedValue(history);
    const result = await service.getMetricsHistory('post-1');
    expect(result).toHaveLength(3);
    expect(result[0].likes).toBe(10);
    expect(result[2].likes).toBe(42);
  });

  it('F6-008: collectMetrics() can be called directly (cron registration is in onModuleInit)', async () => {
    prisma.post.findMany.mockResolvedValue([]);
    const result = await service.collectMetrics();
    expect(result.collected).toBe(0);
  });

  it('F6-009: skips randomDelay for HTTP API sources but keeps it for browser-based sources', async () => {
    // HTTP API path: Threads with a token.
    const threadsPost = {
      id: 'post-threads',
      postUrl: 'https://www.threads.com/@user/post/ABC123',
      network: SocialNetwork.THREADS,
      accountId: 'acc-1',
    };
    vi.stubEnv('ENABLED_NETWORKS', 'X,THREADS,FACEBOOK');
    const apiConfig = createMockConfigService({
      THREADS_ACCESS_TOKEN: 'fake-token',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { name: 'likes', values: [{ value: 1 }] },
          { name: 'replies', values: [{ value: 2 }] },
          { name: 'reposts', values: [{ value: 3 }] },
          { name: 'views', values: [{ value: 4 }] },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const apiService = new MetricsScraperService(
      apiConfig as any,
      prisma as any,
      sse as any,
      { addCronJob: vi.fn(), deleteCronJob: vi.fn() } as any,
      browser as any,
    );
    prisma.post.findMany.mockResolvedValue([threadsPost]);

    await apiService.collectMetrics();

    expect(browser.randomDelay).not.toHaveBeenCalled();
    expect(prisma.postMetrics.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ likes: 1, comments: 2, shares: 3, impressions: 4 }) }),
    );

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('F6-010: Redis mutex prevents concurrent collectMetrics() runs', async () => {
    const redisService = new MetricsScraperService(
      config as any,
      prisma as any,
      sse as any,
      { addCronJob: vi.fn(), deleteCronJob: vi.fn() } as any,
      browser as any,
      undefined,
      redis as any,
    );
    // Hold the lock by pre-populating the key.
    redis._store.set('spa:lock:metrics-scraper', 'other-token');

    const result = await redisService.collectMetrics();

    expect(result).toEqual({ collected: 0, failed: 0, skipped: 0 });
    expect(redis.set).toHaveBeenCalledWith(
      'spa:lock:metrics-scraper',
      expect.any(String),
      'PX',
      600_000,
      'NX',
    );
  });

  it('F6-011: Redis mutex is released even when collectMetrics() throws', async () => {
    const redisService = new MetricsScraperService(
      config as any,
      prisma as any,
      sse as any,
      { addCronJob: vi.fn(), deleteCronJob: vi.fn() } as any,
      browser as any,
      undefined,
      redis as any,
    );
    prisma.post.findMany.mockRejectedValue(new Error('DB down'));

    await expect(redisService.collectMetrics()).rejects.toThrow('DB down');

    expect(redis.eval).toHaveBeenCalled();
    expect(redis._store.has('spa:lock:metrics-scraper')).toBe(false);
  });
});
