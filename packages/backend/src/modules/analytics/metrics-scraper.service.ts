/**
 * F6: Metrics Scraper Service — collects engagement metrics (likes, comments,
 * shares) from posted social media content via browser scraping.
 *
 * Runs as a daily cron job (6:00 AM by default, configurable via
 * METRICS_SCRAPER_SCHEDULE env var). For each POSTED post with a postUrl:
 *   1. Opens a browser context with the account's saved session
 *   2. Navigates to the post URL
 *   3. Scrapes engagement metrics using network-specific selectors
 *   4. Persists metrics to PostMetrics table
 *
 * Graceful degradation:
 *   - If browser is unavailable → skip, log warning
 *   - If session is expired → skip that post, log warning
 *   - If selectors fail → record zeros, log warning (selector health monitors)
 *   - If METRICS_SCRAPER_ENABLED != 'true' → cron does nothing
 *
 * Safety:
 *   - Only scrapes own posts (postUrl from DB)
 *   - Uses saved sessions (no new logins)
 *   - Human-like delays between page loads (5-15s)
 *   - Limited to posts from last 30 days (configurable)
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { Inject } from '@nestjs/common';
import { SocialNetwork, PostStatus } from '@prisma/client';

export interface ScrapedMetrics {
  likes: number;
  comments: number;
  shares: number;
}

@Injectable()
export class MetricsScraperService {
  private readonly logger = new Logger(MetricsScraperService.name);
  private readonly maxPostsPerRun = 50;
  private readonly daysLookback = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    @Inject(IBrowserPort) @Optional() private readonly browser?: IBrowserPort,
  ) {}

  /**
   * Daily cron — collect metrics from posted content.
   * Default: 6:00 AM daily. Configurable via METRICS_SCRAPER_SCHEDULE.
   * Gated by METRICS_SCRAPER_ENABLED env var (default: false).
   */
  @Cron(process.env.METRICS_SCRAPER_SCHEDULE ?? '0 6 * * *')
  async collectMetricsCron(): Promise<void> {
    if (process.env.METRICS_SCRAPER_ENABLED !== 'true') {
      return;
    }
    await this.collectMetrics();
  }

  /**
   * Main metrics collection logic — can be called manually for testing.
   * Returns summary of collected metrics.
   */
  async collectMetrics(): Promise<{ collected: number; failed: number; skipped: number }> {
    if (!this.browser) {
      this.logger.warn('F6: Browser port not available — metrics scraping skipped');
      return { collected: 0, failed: 0, skipped: 0 };
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - this.daysLookback);

    const posts = await this.prisma.post.findMany({
      where: {
        status: PostStatus.POSTED,
        postUrl: { not: null },
        postedAt: { gte: startDate },
      },
      orderBy: { postedAt: 'desc' },
      take: this.maxPostsPerRun,
      select: {
        id: true,
        postUrl: true,
        network: true,
        accountId: true,
      },
    });

    this.logger.log(`F6: Collecting metrics for ${posts.length} posts (last ${this.daysLookback} days)`);

    let collected = 0;
    let failed = 0;
    let skipped = 0;

    for (const post of posts) {
      try {
        const metrics = await this.scrapePostMetrics(post.postUrl!, post.network);
        if (metrics === null) {
          // Stub mode — scraping not implemented yet, skip without writing zeros
          skipped++;
          continue;
        }
        await this.prisma.postMetrics.create({
          data: {
            postId: post.id,
            network: post.network,
            likes: metrics.likes,
            comments: metrics.comments,
            shares: metrics.shares,
          },
        });
        collected++;
        this.logger.debug(`F6: Collected metrics for ${post.id} — likes: ${metrics.likes}, comments: ${metrics.comments}, shares: ${metrics.shares}`);
      } catch (err) {
        failed++;
        this.logger.warn(`F6: Failed to scrape metrics for ${post.id}: ${(err as Error).message}`);
      }

      // Human-like delay between page loads
      if (this.browser?.randomDelay) {
        await this.browser.randomDelay(5000, 15000);
      }
    }

    // SSE notification
    await this.sseService.publish({
      type: 'health_alert',
      severity: 'info',
      error: `F6: Metrics collected — ${collected} ok, ${failed} failed, ${skipped} skipped`,
    });

    this.logger.log(`F6: Metrics collection complete — collected: ${collected}, failed: ${failed}, skipped: ${skipped}`);
    return { collected, failed, skipped };
  }

  /**
   * Scrape metrics from a single post URL.
   * Uses network-specific selectors to extract likes/comments/shares.
   *
   * STUB: Returns null until real selector implementation is added.
   * When null is returned, collectMetrics() skips the post instead of
   * writing zero-rows to the DB (prevents data pollution).
   */
  private async scrapePostMetrics(postUrl: string, network: SocialNetwork): Promise<ScrapedMetrics | null> {
    if (!this.browser) throw new Error('Browser not available');

    // STUB: Real scraping not yet implemented.
    // The selector scaffolding below documents the intended approach.
    // Until implemented, return null → collectMetrics() skips the post
    // instead of writing zero-rows that pollute analytics.
    //
    // TODO(F6): Implement real scraping:
    //   const context = await this.browser.createContext(network);
    //   try {
    //     const page = await context.newPage();
    //     await page.goto(postUrl);
    //     await page.waitForLoadState('networkidle');
    //     const metrics = await this.extractMetricsByNetwork(page, network);
    //     await page.close();
    //     return metrics;
    //   } finally {
    //     if (context && typeof (context as any).close === 'function') {
    //       await (context as any).close().catch(() => {});
    //     }
    //   }
    this.logger.debug(`F6: scrapePostMetrics stub — skipping ${network} post at ${postUrl}`);
    return null;
  }

  /**
   * Get aggregated metrics for a specific post (latest snapshot).
   */
  async getLatestMetricsForPost(postId: string): Promise<{
    likes: number;
    comments: number;
    shares: number;
    impressions: number | null;
    collectedAt: Date;
  } | null> {
    const latest = await this.prisma.postMetrics.findFirst({
      where: { postId },
      orderBy: { collectedAt: 'desc' },
    });
    if (!latest) return null;
    return {
      likes: latest.likes,
      comments: latest.comments,
      shares: latest.shares,
      impressions: latest.impressions,
      collectedAt: latest.collectedAt,
    };
  }

  /**
   * Get metrics time-series for a post (all snapshots).
   */
  async getMetricsHistory(postId: string): Promise<Array<{
    likes: number;
    comments: number;
    shares: number;
    collectedAt: Date;
  }>> {
    return this.prisma.postMetrics.findMany({
      where: { postId },
      orderBy: { collectedAt: 'asc' },
      select: {
        likes: true,
        comments: true,
        shares: true,
        collectedAt: true,
      },
    });
  }
}
