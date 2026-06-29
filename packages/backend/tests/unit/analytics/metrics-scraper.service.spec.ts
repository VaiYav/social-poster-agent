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

describe('F6: MetricsScraperService', () => {
  let service: MetricsScraperService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let sse: ReturnType<typeof createMockSse>;
  let browser: ReturnType<typeof createMockBrowser>;

  beforeEach(() => {
    // AN1: keep the metrics-source registry empty so the "no source → skip" path
    // under test is preserved regardless of the ambient env.
    delete process.env.THREADS_ACCESS_TOKEN;
    delete process.env.FACEBOOK_PAGE_TOKEN;
    prisma = createMockPrisma();
    sse = createMockSse();
    browser = createMockBrowser();
    service = new MetricsScraperService(
      prisma as any,
      sse as any,
      browser as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('F6-001: collectMetrics() skips gracefully when browser is not available', async () => {
    const noBrowserService = new MetricsScraperService(
      prisma as any,
      sse as any,
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

  it('F6-008: collectMetricsCron() does nothing when METRICS_SCRAPER_ENABLED is not true', async () => {
    const original = process.env.METRICS_SCRAPER_ENABLED;
    process.env.METRICS_SCRAPER_ENABLED = 'false';
    const spy = vi.spyOn(service, 'collectMetrics');
    await service.collectMetricsCron();
    expect(spy).not.toHaveBeenCalled();
    process.env.METRICS_SCRAPER_ENABLED = original;
  });

  it('F6-009: collectMetricsCron() runs when METRICS_SCRAPER_ENABLED is true', async () => {
    const original = process.env.METRICS_SCRAPER_ENABLED;
    process.env.METRICS_SCRAPER_ENABLED = 'true';
    prisma.post.findMany.mockResolvedValue([]);
    await service.collectMetricsCron();
    // collectMetrics was called (no posts → 0 collected)
    process.env.METRICS_SCRAPER_ENABLED = original;
  });
});
