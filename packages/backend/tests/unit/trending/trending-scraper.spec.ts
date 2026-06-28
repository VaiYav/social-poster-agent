/**
 * Item 38: TrendingScraperService tests — Google Trends RSS + X scraping.
 *
 * Tests:
 *   - Google Trends RSS parsing (XML → ScrapedTrendingTopic[])
 *   - Cache behavior (TTL, invalidation)
 *   - X trends scraping (mocked browser port)
 *   - Merged trending (astro + Google + X deduplication and priority)
 *   - Graceful degradation (network failures, missing browser)
 *   - Feature flags (TRENDING_SCRAPING_ENABLED, X_TRENDS_SCRAPING_ENABLED)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TrendingScraperService } from '../../../src/modules/trending/trending-scraper.service';

// ── Sample Google Trends RSS XML ──
const SAMPLE_RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss">
  <channel>
    <title>Google Trends</title>
    <item>
      <title><![CDATA[OpenAI GPT-5]]></title>
      <link>https://trends.google.com/trends/explore?q=openai+gpt5</link>
      <ht:approx_traffic>500K+</ht:approx_traffic>
    </item>
    <item>
      <title><![CDATA[Mercury Retrograde]]></title>
      <link>https://trends.google.com/trends/explore?q=mercury+retrograde</link>
      <ht:approx_traffic>200K+</ht:approx_traffic>
    </item>
    <item>
      <title>Climate Summit 2026</title>
      <link>https://trends.google.com/trends/explore?q=climate+summit</link>
      <ht:approx_traffic>100K+</ht:approx_traffic>
    </item>
  </channel>
</rss>`;

// ── Mock browser port for X scraping ──
function createMockBrowserPort() {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue([
      { topic: 'OpenAI GPT-5', rank: 1 },
      { topic: '#MercuryRetrograde', rank: 2 },
      { topic: 'World Cup 2026', rank: 3 },
    ]),
    close: vi.fn(),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn(),
  };
  return {
    acquireContext: vi.fn().mockResolvedValue(mockContext),
    releaseContext: vi.fn(),
    _mockPage: mockPage,
    _mockContext: mockContext,
  };
}

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    TRENDING_CACHE_TTL_MS: 60000,
    TRENDING_SCRAPING_ENABLED: 'true',
    X_TRENDS_SCRAPING_ENABLED: 'true',
    TRENDING_LLM_FILTER_ENABLED: 'true', // Enable LLM niche filter (mock LLM returns YES)
  };
  const merged = { ...defaults, ...overrides };
  return {
    get: vi.fn((key: string, defaultVal?: unknown) => merged[key] ?? defaultVal),
  } as unknown as ConfigService;
}

// Direct instantiation (avoids NestJS DI paramtype issues with Symbol tokens)
function createService(configOverrides: Record<string, unknown> = {}, browser?: any): TrendingScraperService {
  const configService = createMockConfigService(configOverrides);
  // Constructor: (ConfigService, SchedulerRegistry, @Optional() LlmService, @Optional() IBrowserPort)
  // Pass a mock LLM that always returns YES for niche relevance checks
  const mockLlm = {
    generateChat: vi.fn().mockResolvedValue({ content: 'YES' }),
  };
  // @ts-expect-error — constructor is private due to DI decorators, but we can call it directly
  return new TrendingScraperService(configService, undefined, mockLlm, browser);
}

describe('TrendingScraperService (Item 38 — F22 Google Trends + X scraping)', () => {
  let service: TrendingScraperService;
  let mockBrowser: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockBrowser = createMockBrowserPort();
    service = createService({}, mockBrowser);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Google Trends RSS parsing ──

  it('UTC-GT-001: parses Google Trends RSS XML correctly', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    const topics = await service.getGoogleTrends(10);

    expect(topics).toHaveLength(3);
    expect(topics[0].topic).toBe('OpenAI GPT-5');
    expect(topics[0].source).toBe('google_trends');
    expect(topics[0].rank).toBe(1);
    expect(topics[0].traffic).toBe('500K+');
    expect(topics[0].url).toContain('openai+gpt5');
    expect(topics[0].scrapedAt).toBeInstanceOf(Date);

    fetchSpy.mockRestore();
  });

  it('UTC-GT-002: respects limit parameter', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    const topics = await service.getGoogleTrends(2);
    expect(topics).toHaveLength(2);

    fetchSpy.mockRestore();
  });

  it('UTC-GT-003: caches Google Trends results within TTL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    // First call — fetches
    await service.getGoogleTrends(10);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call — uses cache (no fetch)
    await service.getGoogleTrends(10);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past TTL
    vi.advanceTimersByTime(70000);

    // Third call — fetches again
    await service.getGoogleTrends(10);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
  });

  it('UTC-GT-004: returns empty array on fetch failure (graceful degradation)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    const topics = await service.getGoogleTrends(10);
    expect(topics).toEqual([]);

    fetchSpy.mockRestore();
  });

  it('UTC-GT-005: returns empty array when RSS returns non-200', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    } as Response);

    const topics = await service.getGoogleTrends(10);
    expect(topics).toEqual([]);

    fetchSpy.mockRestore();
  });

  it('UTC-GT-006: returns cached results on fetch failure after first success', async () => {
    let callCount = 0;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          text: async () => SAMPLE_RSS_XML,
        } as Response);
      }
      return Promise.reject(new Error('Network error'));
    });

    // First call succeeds
    const first = await service.getGoogleTrends(10);
    expect(first).toHaveLength(3);

    // Advance past TTL
    vi.advanceTimersByTime(70000);

    // Second call fails — should return cached results
    const second = await service.getGoogleTrends(10);
    expect(second).toHaveLength(3); // cached results

    fetchSpy.mockRestore();
  });

  // ── X Trends scraping ──

  it('UTC-XT-001: scrapes X trending topics via browser port', async () => {
    const topics = await service.getXTrends(10);

    expect(topics).toHaveLength(3);
    expect(topics[0].topic).toBe('OpenAI GPT-5');
    expect(topics[0].source).toBe('x_trends');
    expect(topics[0].rank).toBe(1);
    expect(topics[0].scrapedAt).toBeInstanceOf(Date);

    // Verify browser was used
    expect(mockBrowser.acquireContext).toHaveBeenCalledWith('X');
    expect(mockBrowser.releaseContext).toHaveBeenCalled();
  });

  it('UTC-XT-002: caches X trends results within TTL', async () => {
    // First call
    await service.getXTrends(10);
    expect(mockBrowser.acquireContext).toHaveBeenCalledTimes(1);

    // Second call — uses cache
    await service.getXTrends(10);
    expect(mockBrowser.acquireContext).toHaveBeenCalledTimes(1);

    // Advance past TTL
    vi.advanceTimersByTime(70000);

    // Third call — fetches again
    await service.getXTrends(10);
    expect(mockBrowser.acquireContext).toHaveBeenCalledTimes(2);
  });

  it('UTC-XT-003: returns empty array when browser port is not available', async () => {
    const serviceNoBrowser = createService({}, undefined);
    const topics = await serviceNoBrowser.getXTrends(10);
    expect(topics).toEqual([]);
  });

  it('UTC-XT-004: handles browser scraping failure gracefully', async () => {
    mockBrowser.acquireContext.mockRejectedValue(new Error('Browser not available'));

    const topics = await service.getXTrends(10);
    expect(topics).toEqual([]);
  });

  it('UTC-XT-005: releases context even on error', async () => {
    mockBrowser._mockPage.evaluate.mockRejectedValue(new Error('Selector timeout'));

    await service.getXTrends(10);

    expect(mockBrowser.releaseContext).toHaveBeenCalled();
  });

  // ── Feature flags ──

  it('UTC-FF-001: TRENDING_SCRAPING_ENABLED=false disables Google Trends', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    const disabledService = createService({ TRENDING_SCRAPING_ENABLED: 'false' }, mockBrowser);
    const topics = await disabledService.getGoogleTrends(10);

    expect(topics).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('UTC-FF-002: X_TRENDS_SCRAPING_ENABLED=false disables X scraping', async () => {
    const disabledService = createService({ X_TRENDS_SCRAPING_ENABLED: 'false' }, mockBrowser);
    const topics = await disabledService.getXTrends(10);

    expect(topics).toEqual([]);
    expect(mockBrowser.acquireContext).not.toHaveBeenCalled();
  });

  // ── Merged trending ──

  it('UTC-MT-001: merges astro + Google + X trends with correct priorities', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    const astroTopics = [
      { topic: 'Mercury Retrograde', networks: ['X', 'THREADS'] },
    ];

    const merged = await service.getMergedTrending(astroTopics);

    // Should have topics from all sources
    const sources = merged.flatMap((m) => m.sources);
    expect(sources).toContain('astro');
    expect(sources).toContain('google_trends');
    expect(sources).toContain('x_trends');

    // "Mercury Retrograde" appears in astro + Google Trends → higher priority
    const mercury = merged.find((m) => m.topic.toLowerCase().includes('mercury'));
    expect(mercury).toBeDefined();
    expect(mercury!.sources).toContain('astro');
    expect(mercury!.sources).toContain('google_trends');
    expect(mercury!.priority).toBeGreaterThan(3); // 3 (astro) + 2 (google) = 5

    fetchSpy.mockRestore();
  });

  it('UTC-MT-002: deduplicates topics that appear in multiple sources', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    // "OpenAI GPT-5" appears in both Google Trends and X Trends
    const merged = await service.getMergedTrending([]);

    const openai = merged.filter((m) => m.topic.toLowerCase().includes('openai'));
    expect(openai).toHaveLength(1); // deduplicated
    expect(openai[0].sources).toContain('google_trends');
    expect(openai[0].sources).toContain('x_trends');
    expect(openai[0].priority).toBe(4); // 2 (google) + 2 (x) = 4

    fetchSpy.mockRestore();
  });

  it('UTC-MT-003: sorts merged topics by priority (highest first)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    const astroTopics = [
      { topic: 'Mercury Retrograde', networks: ['X', 'THREADS'] }, // in Google Trends too → priority 5
    ];

    const merged = await service.getMergedTrending(astroTopics);

    // Verify sorted by priority descending
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i - 1].priority).toBeGreaterThanOrEqual(merged[i].priority);
    }

    fetchSpy.mockRestore();
  });

  it('UTC-MT-004: assigns correct networks for X-only trends', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    const merged = await service.getMergedTrending([]);

    // "World Cup 2026" only appears in X trends
    const worldCup = merged.find((m) => m.topic.toLowerCase().includes('world cup'));
    expect(worldCup).toBeDefined();
    expect(worldCup!.sources).toEqual(['x_trends']);
    expect(worldCup!.networks).toContain('X');
    expect(worldCup!.networks).toContain('THREADS');

    fetchSpy.mockRestore();
  });

  // ── Cache management ──

  it('UTC-CM-001: invalidateCache clears both caches', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    // Populate caches
    await service.getGoogleTrends(10);
    await service.getXTrends(10);

    // Invalidate
    service.invalidateCache();

    // Next calls should fetch again
    await service.getGoogleTrends(10);
    await service.getXTrends(10);

    expect(fetchSpy).toHaveBeenCalledTimes(2); // 2 Google fetches (initial + after invalidate)
    expect(mockBrowser.acquireContext).toHaveBeenCalledTimes(2); // 2 X scrapes

    fetchSpy.mockRestore();
  });

  it('UTC-CM-002: getCacheStatus returns correct cache state', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_XML,
    } as Response);

    // Before caching
    let status = service.getCacheStatus();
    expect(status.googleTrends.cached).toBe(false);
    expect(status.xTrends.cached).toBe(false);

    // Populate caches
    await service.getGoogleTrends(10);
    await service.getXTrends(10);

    // After caching
    status = service.getCacheStatus();
    expect(status.googleTrends.cached).toBe(true);
    expect(status.googleTrends.topics).toBe(3);
    expect(status.googleTrends.expiresAt).toBeInstanceOf(Date);
    expect(status.xTrends.cached).toBe(true);
    expect(status.xTrends.topics).toBe(3);

    fetchSpy.mockRestore();
  });
});
