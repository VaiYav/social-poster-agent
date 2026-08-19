/**
 * F22 / Item 38: TrendingScraperService — Google Trends + X trending scraping.
 *
 * Adds real-time trend sources on top of the configured event calendar:
 *   1. Google Trends RSS feed (no API key required, public data)
 *   2. X (Twitter) trending topics tab (scraped via browser port)
 *
 * Design:
 *   - Google Trends: fetches daily trending searches via the public RSS feed
 *     (https://trends.google.com/trending/rss). No auth, no API key.
 *   - X Trends: uses IBrowserPort to navigate to the Explore/Trending tab
 *     and extract trending topic text. Reuses existing Camoufox session pool.
 *   - Results are merged with configured events (TrendingService) and
 *     deduplicated.
 *   - Cached for 15 minutes (TRENDING_CACHE_TTL_MS) to avoid scraping on
 *     every generation run.
 *
 * Safety:
 *   - X scraping reuses the existing session pool (no extra login)
 *   - Respects robots.txt (Google Trends RSS is public)
 *   - Rate-limited by cache TTL (15 min default)
 *   - Failures are logged but don't block generation (graceful degradation)
 */

import { Injectable, Logger, Optional, Inject, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { IPromptPort, type CompiledChatPrompt } from '../../domain/ports/prompt.port.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import type { BrowserContext, Page } from '../../domain/ports/browser-primitives.js';
import { SocialNetwork } from '@prisma/client';
import { isNetworkEnabled } from '../../domain/enabled-networks.js';
import { parseGoogleTrendsRss as parseGoogleTrendsRssPure } from './google-trends-rss.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { sanitizeUntrustedInput } from '../../infrastructure/llm/sanitize-untrusted-input.js';
import { interpolate } from '../../domain/prompt-interpolation.js';
import { isOrchestratorEnabled } from '../orchestrator/feature-flag.js';
import { TRENDING_RELEVANCE_PROMPT } from './prompts/trending-relevance-prompt.js';

// ── Types ──

export interface ScrapedTrendingTopic {
  source: 'google_trends' | 'x_trends';
  topic: string;
  rank?: number; // 1 = top trend
  url?: string;
  traffic?: string; // e.g. "500K+ searches" (Google Trends)
  scrapedAt: Date;
}

export interface MergedTrendingTopic {
  topic: string;
  sources: ('events' | 'google_trends' | 'x_trends')[];
  networks: string[]; // recommended networks
  priority: number; // 1 = highest (multiple sources agree)
  scrapedAt?: Date;
}

// ── Constants ──

const GOOGLE_TRENDS_RSS_URL = 'https://trends.google.com/trending/rss?geo=US';
// X has changed the explore URL multiple times. Try the canonical explore page first,
// then fall back to the home page sidebar ("What's happening" section).
const X_TRENDS_URLS = [
  'https://x.com/explore/tabs/trending',
  'https://x.com/explore',
  'https://x.com/home',
];
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const X_SCRAPE_TIMEOUT_MS = 30_000; // 30s timeout for X scraping
// Multi-fallback selectors for X trending topics — X changes DOM structure frequently.
// Try data-testid first (most stable), then aria-label, then CSS, then text-based.
const X_TREND_SELECTORS: readonly string[] = [
  '[data-testid="trend"]',                    // Original — may still work on some layouts
  'aside[aria-label="Trending"] [data-testid="trend"]',  // Sidebar with aria-label
  'section[aria-label="Trending"] [data-testid="trend"]', // Section wrapper
  '[data-testid="trend"] > div > div > span',  // Deeper nesting
  'div[role="link"] span',                      // Text-based fallback (was :has-text, invalid in browser)
  'aside a[href*="/explore/tabs/trending"]',   // Link to trending tab
];

/**
 * Niche keyword whitelist — empty by default. Configure for the brand's topic area.
 * Google/X trends must contain at least one keyword (case-insensitive substring match)
 * to pass the fast keyword filter. Topics that don't match go to the LLM relevance
 * filter as a second-chance borderline check.
 */
const NICHE_KEYWORDS: readonly string[] = [];

@Injectable()
export class TrendingScraperService implements OnModuleInit {
  private readonly logger = new Logger(TrendingScraperService.name);
  private readonly cacheTtlMs: number;
  private readonly enabled: boolean;
  private readonly xScrapeEnabled: boolean;
  private readonly llmFilterEnabled: boolean;

  // Cache: { topics, expiresAt }
  private googleTrendsCache: { topics: ScrapedTrendingTopic[]; expiresAt: number } | null = null;
  private xTrendsCache: { topics: ScrapedTrendingTopic[]; expiresAt: number } | null = null;

  // 2.9.5: Cache for the merged result (events + Google Trends + X) to avoid
  // repeated niche filtering and merging within the TTL window.
  private mergedCache: {
    key: string;
    topics: MergedTrendingTopic[];
    expiresAt: number;
  } | null = null;

  /**
   * LLM relevance cache — avoids re-calling the LLM for the same topic across runs.
   * Key = lowercased topic, value = boolean (relevant to niche).
   * MEM: bounded to llmCacheMaxSize entries with llmCacheTtlMs TTL to prevent
   * unbounded growth over the service lifetime. Eviction is FIFO (oldest first).
   */
  private readonly llmRelevanceCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly llmCacheMaxSize = 1000;
  private readonly llmCacheTtlMs = 6 * 60 * 60 * 1000; // 6 hours — trends rotate, stale relevance is wrong
  private readonly llmConcurrency: number;
  private readonly googleApiUrl: string;
  private readonly googleApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Optional() @Inject(ILlmPort) private readonly llmService?: ILlmPort,
    @Optional() @Inject(IBrowserPort) private readonly browser?: IBrowserPort,
    @Optional() private readonly sessionsService?: SessionsService,
    @Optional() private readonly accountsService?: AccountsService,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
  ) {
    this.cacheTtlMs = this.configService.get<number>('TRENDING_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS);
    this.enabled = parseBool(this.configService.get<string>('TRENDING_SCRAPING_ENABLED', 'true'));
    this.xScrapeEnabled =
      parseBool(this.configService.get<string>('X_TRENDS_SCRAPING_ENABLED', 'true')) &&
      isNetworkEnabled(SocialNetwork.X);
    this.llmFilterEnabled = parseBool(this.configService.get<string>('TRENDING_LLM_FILTER_ENABLED', 'true'));
    const rawConcurrency = Number(this.configService.get<string>('TRENDING_LLM_CONCURRENCY', '3'));
    this.llmConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : 3;
    this.googleApiUrl = this.configService.get<string>('TRENDING_GOOGLE_API_URL', '');
    this.googleApiKey = this.configService.get<string>('TRENDING_GOOGLE_API_KEY', '');
  }

  /**
   * Sprint Q: Register a cron job to proactively refresh the trending cache.
   * Default: every 2 hours (TRENDING_SCRAPER_SCHEDULE).
   * This ensures generation runs always have fresh cached trends without
   * waiting for inline scraping (which blocks generation for ~20-30s).
   */
  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Trending scraper disabled (TRENDING_SCRAPING_ENABLED=false)');
      return;
    }

    // SPA_DRY_RUN: skip cron registration in dry-run mode
    const isDryRun = parseBool(this.configService.get<string>('SPA_DRY_RUN', 'false'));
    if (isDryRun) {
      this.logger.warn('SPA_DRY_RUN=true — trending scraper cron NOT registered');
      return;
    }

    // Orchestrator mode: REFRESH_TRENDS is handled by the orchestrator decision loop.
    // Still do initial cache warm-up so the first cycle has data.
    if (isOrchestratorEnabled()) {
      this.logger.log('Orchestrator is enabled — trending scraper cron NOT registered (initial warm-up still runs)');
      void this.refreshCache();
      return;
    }

    const cronExpr = this.configService.get<string>(
      'TRENDING_SCRAPER_SCHEDULE',
      '0 */2 * * *',
    ) ?? '0 */2 * * *';

    const job = new CronJob(cronExpr, async () => {
      await this.refreshCache();
    });

    try {
      this.schedulerRegistry?.addCronJob('trending-scraper', job);
      job.start();
      this.logger.log(`Trending scraper cron registered: ${cronExpr}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — trending scraper cron will not run');
    }

    // Initial cache warm-up on startup (non-blocking)
    void this.refreshCache();
  }

  /**
   * Proactively refresh both Google Trends and X Trends caches.
   * Called by cron and on startup. Errors are logged but never thrown.
   */
  private async refreshCache(): Promise<void> {
    try {
      this.logger.log('Refreshing trending cache (cron)...');
      const [google, x] = await Promise.allSettled([
        this.getGoogleTrends(20),
        this.xScrapeEnabled ? this.getXTrends(20) : Promise.resolve([]),
      ]);

      const googleCount = google.status === 'fulfilled' ? google.value.length : 0;
      const xCount = x.status === 'fulfilled' ? x.value.length : 0;
      this.logger.log(`Trending cache refreshed: Google=${googleCount}, X=${xCount}`);

      if (google.status === 'rejected') {
        this.logger.warn(`Google Trends refresh failed: ${google.reason?.message ?? 'unknown'}`);
      }
      if (x.status === 'rejected') {
        this.logger.warn(`X Trends refresh failed: ${x.reason?.message ?? 'unknown'}`);
      }
    } catch (err) {
      this.logger.warn(`Trending cache refresh failed: ${(err as Error).message}`);
    }
  }

  // ── Google Trends (RSS feed — no auth) ──

  /**
   * Fetch Google Trends daily trending searches.
   *
   * F22: If TRENDING_GOOGLE_API_URL and TRENDING_GOOGLE_API_KEY are configured,
   * use the programmatic proxy endpoint first. On any failure, fall back to the
   * public RSS feed. If only one of the two is set, log a warning and use RSS.
   * Cached for TRENDING_CACHE_TTL_MS (default 15 min).
   */
  async getGoogleTrends(limit = 20): Promise<ScrapedTrendingTopic[]> {
    if (!this.enabled) return [];

    // Check cache
    if (this.googleTrendsCache && Date.now() < this.googleTrendsCache.expiresAt) {
      this.logger.debug(`Google Trends cache hit (${this.googleTrendsCache.topics.length} topics)`);
      return this.googleTrendsCache.topics.slice(0, limit);
    }

    const useApi = this.googleApiUrl.length > 0 && this.googleApiKey.length > 0;
    if (this.googleApiUrl.length > 0 && this.googleApiKey.length === 0) {
      this.logger.warn('TRENDING_GOOGLE_API_URL is set but TRENDING_GOOGLE_API_KEY is missing — using RSS fallback');
    } else if (this.googleApiKey.length > 0 && this.googleApiUrl.length === 0) {
      this.logger.warn('TRENDING_GOOGLE_API_KEY is set but TRENDING_GOOGLE_API_URL is missing — using RSS fallback');
    }

    try {
      const topics = useApi
        ? await this.fetchGoogleTrendsApi(limit)
        : await this.fetchGoogleTrendsRss(limit);
      this.googleTrendsCache = { topics, expiresAt: Date.now() + this.cacheTtlMs };
      this.logger.log(`Fetched ${topics.length} Google Trends topics (${useApi ? 'API' : 'RSS'})`);
      return topics.slice(0, limit);
    } catch (err) {
      this.logger.warn(`Failed to fetch Google Trends (${useApi ? 'API' : 'RSS'}): ${(err as Error).message}`);

      // F22: programmatic API failed — fall back to public RSS
      if (useApi) {
        try {
          const topics = await this.fetchGoogleTrendsRss(limit);
          this.googleTrendsCache = { topics, expiresAt: Date.now() + this.cacheTtlMs };
          this.logger.log(`Fell back to RSS and fetched ${topics.length} Google Trends topics`);
          return topics.slice(0, limit);
        } catch (rssErr) {
          this.logger.warn(`Google Trends RSS fallback also failed: ${(rssErr as Error).message}`);
        }
      }

      return this.googleTrendsCache?.topics ?? [];
    }
  }

  /**
   * Parse Google Trends RSS feed.
   * The RSS feed contains <item> elements with <title> (topic) and <ht:approx_traffic> (traffic).
   */
  private async fetchGoogleTrendsRss(limit: number): Promise<ScrapedTrendingTopic[]> {
    // Use global fetch (Node 18+)
    const response = await fetch(GOOGLE_TRENDS_RSS_URL, {
      headers: { 'User-Agent': 'SocialPosterAgent/1.0 (trending detection)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Google Trends RSS returned ${response.status}`);
    }

    const xml = await response.text();
    return this.parseGoogleTrendsRss(xml, limit);
  }

  /**
   * Parse RSS XML to extract trending topics.
   * Uses regex-based parsing (no XML dependency needed for simple RSS).
   */
  private parseGoogleTrendsRss(xml: string, limit: number): ScrapedTrendingTopic[] {
    // TR1: delegate to the hardened pure parser (CDATA + multiline titles + entity decoding).
    const now = new Date();
    return parseGoogleTrendsRssPure(xml, limit).map((t): ScrapedTrendingTopic => ({
      source: 'google_trends',
      topic: t.topic,
      rank: t.rank,
      url: t.url,
      traffic: t.traffic,
      scrapedAt: now,
    }));
  }

  // ── Google Trends (programmatic API — optional proxy) ──

  /**
   * F22: Fetch Google Trends via a configured programmatic API / proxy.
   * Expects a JSON array of objects like { topic, rank?, url?, traffic? }.
   * Sends the configured key in the Authorization: Bearer header.
   */
  private async fetchGoogleTrendsApi(limit: number): Promise<ScrapedTrendingTopic[]> {
    if (!this.googleApiUrl || !this.googleApiKey) {
      throw new Error('TRENDING_GOOGLE_API_URL and TRENDING_GOOGLE_API_KEY must both be set');
    }

    const response = await fetch(this.googleApiUrl, {
      headers: {
        'User-Agent': 'SocialPosterAgent/1.0 (trending detection)',
        Accept: 'application/json',
        Authorization: `Bearer ${this.googleApiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Google Trends API returned ${response.status}`);
    }

    const json = (await response.json()) as unknown;
    return this.parseGoogleTrendsApi(json, limit);
  }

  /**
   * Parse a programmatic Google Trends JSON response.
   * Accepts an array of topic objects and normalizes them to ScrapedTrendingTopic.
   */
  private parseGoogleTrendsApi(json: unknown, limit: number): ScrapedTrendingTopic[] {
    if (!Array.isArray(json)) {
      throw new Error('Google Trends API did not return a JSON array');
    }

    const now = new Date();
    const topics: ScrapedTrendingTopic[] = [];
    for (let i = 0; i < Math.min(json.length, limit); i++) {
      const raw = json[i];
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const topicText = typeof item.topic === 'string' ? sanitizeUntrustedInput(item.topic, 200) : '';
      if (!topicText) continue;

      topics.push({
        source: 'google_trends',
        topic: topicText,
        rank: typeof item.rank === 'number' ? item.rank : i + 1,
        url: typeof item.url === 'string' ? item.url : undefined,
        traffic: typeof item.traffic === 'string' ? item.traffic : undefined,
        scrapedAt: now,
      });
    }
    return topics;
  }

  // ── X Trends (browser scraping) ──

  /**
   * Scrape X (Twitter) trending topics via browser.
   * Reuses the existing Camoufox session pool — no extra login needed.
   * Cached for TRENDING_CACHE_TTL_MS (default 15 min).
   */
  async getXTrends(limit = 20): Promise<ScrapedTrendingTopic[]> {
    if (!this.enabled || !this.xScrapeEnabled || !this.browser) {
      return [];
    }

    // Check cache
    if (this.xTrendsCache && Date.now() < this.xTrendsCache.expiresAt) {
      this.logger.debug(`X Trends cache hit (${this.xTrendsCache.topics.length} topics)`);
      return this.xTrendsCache.topics.slice(0, limit);
    }

    let context: BrowserContext | null = null;
    let page: Awaited<ReturnType<BrowserContext['newPage']>> | undefined;
    let accountId: string | undefined;
    try {
      // Use authenticated session if available — X may require login to view trends
      let storageState: string | undefined;
      if (this.sessionsService) {
        try {
          if (this.accountsService) {
            const account = await this.accountsService.getNextAccountForNetwork(SocialNetwork.X);
            accountId = account?.id;
          }
          const session = accountId
            ? await this.sessionsService.getOrCreateSession(accountId, SocialNetwork.X)
            : await this.sessionsService.getOrCreateSession(SocialNetwork.X);
          if (session?.storageState) {
            storageState = this.sessionsService.decryptStorageState(session);
          }
        } catch (err) {
          this.logger.debug(`Could not get X session for trending scrape: ${(err as Error).message}`);
        }
      }
      context = await this.browser.acquireContext('X' as SocialNetwork, storageState, accountId);
      page = await context.newPage();

      // Suppress uncaught page-side JS errors (X React app throws many) that can
      // crash the Playwright/Camoufox Firefox driver (see browser.factory.ts doc).
      await this.browser.suppressPageErrors(page);
      // MEM: block images/media/fonts — trending scrape only needs the text of
      // trend labels. Media-heavy X pages accumulate renderer memory during the
      // 5s hydration wait; blocking images prevents OOM on constrained hosts.
      await this.browser.applyResourceBlocking(page, { blockImages: true });

      // Try multiple URLs — X has changed the explore page structure multiple times.
      // The trends may be on /explore/tabs/trending, /explore, or the home page sidebar.
      let topics: ScrapedTrendingTopic[] = [];
      for (const url of X_TRENDS_URLS) {
        this.logger.debug(`X trends: trying ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: X_SCRAPE_TIMEOUT_MS });
        await page.waitForTimeout(5000); // let trends load (X React app is slow to hydrate)

        topics = await this.extractXTrends(page, limit);
        if (topics.length > 0) {
          this.logger.debug(`X trends: found ${topics.length} topics at ${url}`);
          break;
        }
      }

      this.xTrendsCache = { topics, expiresAt: Date.now() + this.cacheTtlMs };
      this.logger.log(`Scraped ${topics.length} X trending topics`);
      return topics.slice(0, limit);
    } catch (err) {
      this.logger.warn(`Failed to scrape X trends: ${(err as Error).message}`);
      return this.xTrendsCache?.topics ?? [];
    } finally {
      // The pool's releaseContext() returns the context as-is — it does not
      // close pages, so a page left open here leaks for the pooled context's lifetime.
      if (page) {
        await page.close().catch(() => {});
      }
      if (context) {
        try {
          await this.browser.releaseContext('X' as SocialNetwork, context, accountId);
        } catch (err) {
          this.logger.warn(`Failed to release X context: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * Extract trending topic text from X Explore page.
   * Tries multiple selectors — X changes DOM structure frequently.
   */
  private async extractXTrends(page: Page, limit: number): Promise<ScrapedTrendingTopic[]> {
    const now = new Date();

    // Try each selector until one finds trend elements
    let matchedSelector: string | null = null;
    for (const selector of X_TREND_SELECTORS) {
      try {
        await page.waitForSelector(selector, { timeout: 5_000 });
        matchedSelector = selector;
        this.logger.debug(`X trends: matched selector "${selector}"`);
        break;
      } catch {
        // Try next selector
      }
    }

    if (!matchedSelector) {
      this.logger.warn('X trend elements not found — all selectors failed (page may not have loaded trends or DOM changed)');
      // Take a screenshot for debugging if screenshots are enabled
      try {
        const url = page.url();
        this.logger.debug(`X trends: last URL was ${url}, page title: ${await page.title()}`);
      } catch {
        // Page may be closed
      }
      return [];
    }

    // Extract trend text using the matched selector + fallback extraction strategies
    const trends = await page.evaluate(
      ({ selectors, limit }: { selectors: readonly string[]; limit: number }) => {
        const results: Array<{ topic: string; rank: number }> = [];

        // Try each selector for extraction
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length === 0) continue;

          elements.forEach((el, idx) => {
            if (idx >= limit) return;
            // Try multiple text extraction strategies:
            // 1. First line of textContent (trend name is usually first)
            // 2. Look for specific trend name elements
            // 3. Fallback to full textContent
            let trendName = el.querySelector('[data-testid="trendName"]')?.textContent?.trim()
              || el.querySelector('span')?.textContent?.trim()
              || el.textContent?.trim()?.split('\n')[0]?.trim();

            if (!trendName) return;

            // 2.9.4: The fallback `div[role="link"] span` may match UI labels like
            // "Trending" or "What's happening" — skip those and keep looking.
            const lower = trendName.toLowerCase();
            if (lower === 'trending' || lower === "what's happening" || lower.includes('·')) return;

            if (trendName.length > 0 && trendName.length < 200) {
              // Dedup by topic text
              if (!results.some((r) => r.topic === trendName)) {
                results.push({ topic: trendName, rank: idx + 1 });
              }
            }
          });

          if (results.length > 0) break; // Found trends with this selector
        }

        return results;
      },
      { selectors: X_TREND_SELECTORS, limit },
    );

    return trends.map((t) => ({
      source: 'x_trends' as const,
      topic: t.topic,
      rank: t.rank,
      scrapedAt: now,
    }));
  }

  // ── Niche relevance filtering (keyword whitelist + LLM borderline) ──

  /**
   * Fast keyword filter — returns true if the topic contains at least one
   * niche keyword (case-insensitive substring match).
   * This is the first-pass filter; topics that fail go to the LLM filter.
   */
  private isRelevantByKeyword(topic: string): boolean {
    const lower = topic.toLowerCase();
    return NICHE_KEYWORDS.some((kw) => lower.includes(kw));
  }

  /**
   * LLM relevance filter for borderline topics that didn't match any keyword.
   * Asks the LLM whether the topic is relevant to the brand's topic area.
   *
   * Results are cached per-topic (lowercased) to avoid repeated LLM calls.
   * If LLM is unavailable or the call fails, the topic is rejected (fail-closed).
   *
   * @returns true if the LLM considers the topic relevant
   */
  private async isRelevantByLlm(topic: string): Promise<boolean> {
    const key = topic.toLowerCase().trim();
    const cached = this.llmRelevanceCache.get(key);
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.value;
    // Expired entry — remove it so FIFO eviction below doesn't count stale slots
    if (cached) this.llmRelevanceCache.delete(key);

    if (!this.llmService || !this.llmFilterEnabled) {
      // No LLM available — fail-closed (reject borderline topics)
      this.setRelevanceCache(key, false);
      return false;
    }

    const safeTopic = sanitizeUntrustedInput(topic, 200);
    const compiled = await this.getCompiledChat(
      'trending-relevance',
      { topic: safeTopic },
      TRENDING_RELEVANCE_PROMPT,
    );

    try {
      const response = await this.llmService.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: 0,
      });
      const answer = response.content.trim().toUpperCase();
      const relevant = answer.startsWith('YES');
      this.setRelevanceCache(key, relevant);
      this.logger.debug(`LLM relevance for "${topic}": ${relevant ? 'YES' : 'NO'}`);
      return relevant;
    } catch (err) {
      this.logger.warn(`LLM relevance filter failed for "${topic}": ${(err as Error).message}`);
      this.setRelevanceCache(key, false);
      return false;
    }
  }

  /**
   * MEM: Set a relevance cache entry with FIFO eviction when at capacity.
   */
  private setRelevanceCache(key: string, value: boolean): void {
    if (this.llmRelevanceCache.size >= this.llmCacheMaxSize) {
      const oldestKey = this.llmRelevanceCache.keys().next().value;
      if (oldestKey) this.llmRelevanceCache.delete(oldestKey);
    }
    this.llmRelevanceCache.set(key, { value, expiresAt: Date.now() + this.llmCacheTtlMs });
  }

  /**
   * Two-layer niche filter: keyword whitelist (fast) → LLM (borderline).
   * Configured event topics bypass filtering (they are always relevant by definition).
   *
   * @param topics Scraped topics from Google/X
   * @returns Topics relevant to the brand's topic area
   */
  private async filterByNicheRelevance(
    topics: ScrapedTrendingTopic[],
  ): Promise<ScrapedTrendingTopic[]> {
    const passed: ScrapedTrendingTopic[] = [];
    const borderline: ScrapedTrendingTopic[] = [];

    // Layer 1: keyword whitelist (fast, no LLM)
    for (const topic of topics) {
      if (this.isRelevantByKeyword(topic.topic)) {
        passed.push(topic);
      } else {
        borderline.push(topic);
      }
    }

    this.logger.debug(
      `Niche filter: ${passed.length} passed keyword, ${borderline.length} borderline → LLM`,
    );

    // Layer 2: LLM filter for borderline topics
    if (borderline.length === 0) return passed;

    // Batch LLM checks in parallel (limited concurrency to avoid rate limits)
    const llmResults: ScrapedTrendingTopic[] = [];

    for (let i = 0; i < borderline.length; i += this.llmConcurrency) {
      const batch = borderline.slice(i, i + this.llmConcurrency);
      const checks = await Promise.all(
        batch.map(async (t) => {
          const relevant = await this.isRelevantByLlm(t.topic);
          return relevant ? t : null;
        }),
      );
      for (const c of checks) {
        if (c) llmResults.push(c);
      }
    }

    this.logger.debug(
      `Niche filter: ${llmResults.length} borderline topics passed LLM relevance check`,
    );

    return [...passed, ...llmResults];
  }

  // ── Merged trending (all sources) ──

  /**
   * Get merged trending topics from all sources (configured events + Google Trends + X).
   * Topics that appear in multiple sources get higher priority.
   *
   * Niche filtering: Google/X trends are filtered by keyword whitelist + LLM
   * to ensure only topics relevant to the brand's topic area are included.
   * Configured event topics bypass filtering (always relevant).
   *
   * @param eventTopics - Topics from TrendingService (configured events)
   * @returns Merged and prioritized trending topics
   */
  async getMergedTrending(
    eventTopics: Array<{ topic: string; networks: string[] }>,
    options?: { includeX?: boolean },
  ): Promise<MergedTrendingTopic[]> {
    const includeX = options?.includeX ?? true;

    // 2.9.5: Cache the merged result by a stable key of event topics.
    const cacheKey = `${this.buildMergedCacheKey(eventTopics)}:x=${includeX}`;
    if (this.mergedCache && this.mergedCache.key === cacheKey && Date.now() < this.mergedCache.expiresAt) {
      this.logger.debug(`Merged trends cache hit (${this.mergedCache.topics.length} topics)`);
      return this.mergedCache.topics.slice(0, 20);
    }

    const [rawGoogleResult, rawXResult] = await Promise.allSettled([
      this.getGoogleTrends(20),
      includeX ? this.getXTrends(20) : Promise.resolve([]),
    ]);

    const rawGoogle = rawGoogleResult.status === 'fulfilled' ? rawGoogleResult.value : [];
    const rawX = rawXResult.status === 'fulfilled' ? rawXResult.value : [];
    if (rawGoogleResult.status === 'rejected') {
      this.logger.warn(`Google Trends failed: ${(rawGoogleResult.reason as Error).message}`);
    }
    if (includeX && rawXResult.status === 'rejected') {
      this.logger.warn(`X Trends failed: ${(rawXResult.reason as Error).message}`);
    }

    // Niche filter: only keep Google/X trends relevant to our content niche
    const [googleTopics, xTopics] = await Promise.all([
      this.filterByNicheRelevance(rawGoogle),
      this.filterByNicheRelevance(rawX),
    ]);

    this.logger.log(
      `Niche-filtered trends: Google ${rawGoogle.length}→${googleTopics.length}, ` +
      `X ${rawX.length}→${xTopics.length}`,
    );

    const merged = new Map<string, MergedTrendingTopic>();

    // Add configured event topics (priority base — always relevant, bypass filter)
    for (const event of eventTopics) {
      const key = event.topic.toLowerCase().trim();
      merged.set(key, {
        topic: event.topic,
        sources: ['events'],
        networks: event.networks,
        priority: 3, // event = high priority (predictable, high-value)
      });
    }

    // Add Google Trends (already niche-filtered)
    for (const gt of googleTopics) {
      const key = gt.topic.toLowerCase().trim();
      const existing = merged.get(key);
      if (existing) {
        existing.sources.push('google_trends');
        existing.priority += 2; // cross-source confirmation = higher priority
      } else {
        merged.set(key, {
          topic: gt.topic,
          sources: ['google_trends'],
          networks: ['X', 'THREADS', 'FACEBOOK'],
          priority: 2,
          scrapedAt: gt.scrapedAt,
        });
      }
    }

    // Add X Trends (already niche-filtered)
    for (const xt of xTopics) {
      const key = xt.topic.toLowerCase().trim();
      const existing = merged.get(key);
      if (existing) {
        existing.sources.push('x_trends');
        existing.priority += 2;
        // X trends are best for X posting
        if (!existing.networks.includes('X')) existing.networks.push('X');
      } else {
        merged.set(key, {
          topic: xt.topic,
          sources: ['x_trends'],
          networks: ['X', 'THREADS'], // X trends are most relevant to X/Threads
          priority: 2,
          scrapedAt: xt.scrapedAt,
        });
      }
    }

    // Sort by priority (highest first), then by rank
    const sorted = Array.from(merged.values()).sort((a, b) => b.priority - a.priority);

    // 2.9.5: Cache the merged result.
    this.mergedCache = {
      key: cacheKey,
      topics: sorted,
      expiresAt: Date.now() + this.cacheTtlMs,
    };

    return sorted;
  }

  /**
   * 2.9.5: Build a stable cache key from the event topic list.
   */
  private buildMergedCacheKey(eventTopics: Array<{ topic: string; networks: string[] }>): string {
    const normalized = eventTopics
      .map((t) => ({ topic: t.topic.toLowerCase().trim(), networks: [...t.networks].sort() }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
    return JSON.stringify(normalized);
  }

  // ── Cache management ──

  /** Invalidate both caches (for testing or manual refresh). */
  invalidateCache(): void {
    this.googleTrendsCache = null;
    this.xTrendsCache = null;
    this.mergedCache = null;
    this.llmRelevanceCache.clear();
  }

  /** Get cache status for health check / debugging. */
  getCacheStatus(): {
    googleTrends: { cached: boolean; topics: number; expiresAt?: Date };
    xTrends: { cached: boolean; topics: number; expiresAt?: Date };
  } {
    return {
      googleTrends: {
        cached: this.googleTrendsCache !== null,
        topics: this.googleTrendsCache?.topics.length ?? 0,
        expiresAt: this.googleTrendsCache
          ? new Date(this.googleTrendsCache.expiresAt)
          : undefined,
      },
      xTrends: {
        cached: this.xTrendsCache !== null,
        topics: this.xTrendsCache?.topics.length ?? 0,
        expiresAt: this.xTrendsCache ? new Date(this.xTrendsCache.expiresAt) : undefined,
      },
    };
  }

  /**
   * Fetch the prompt from Langfuse Prompt Management when available,
   * otherwise interpolate the local fallback.
   */
  private async getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback: CompiledChatPrompt,
  ): Promise<CompiledChatPrompt> {
    if (this.promptPort) {
      return this.promptPort.getCompiledChat(name, variables, fallback);
    }
    return {
      systemPrompt: interpolate(fallback.systemPrompt, variables),
      userPrompt: interpolate(fallback.userPrompt, variables),
      isFallback: true,
    };
  }
}
