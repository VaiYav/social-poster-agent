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
import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { Inject } from '@nestjs/common';
import { SocialNetwork, PostStatus } from '@prisma/client';
import { isOrchestratorEnabled } from '../orchestrator/feature-flag.js';
import type { IMetricsSource, PostMetricsData } from './metrics-sources/metrics-source.port.js';
import { ThreadsInsightsSource } from './metrics-sources/threads-insights.source.js';
import { FacebookInsightsSource } from './metrics-sources/facebook-insights.source.js';
import { ABVariantService } from '../content-enhancements/ab-variant.service.js';

export interface ScrapedMetrics {
  likes: number;
  comments: number;
  shares: number;
}

@Injectable()
export class MetricsScraperService implements OnModuleInit {
  private readonly logger = new Logger(MetricsScraperService.name);
  private readonly maxPostsPerRun = 50;
  private readonly daysLookback = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(IBrowserPort) @Optional() private readonly browser?: IBrowserPort,
    @Optional() private readonly abVariantService?: ABVariantService,
  ) {}

  // AN1: per-network metrics sources, built lazily from env tokens. A network with
  // no source (no token) is skipped — never written as zero-rows. HTTP sources
  // (Threads/FB) need no browser; X (deferred, research §3) would use the browser.
  private sourcesCache?: Partial<Record<SocialNetwork, IMetricsSource>>;

  private getSources(): Partial<Record<SocialNetwork, IMetricsSource>> {
    if (this.sourcesCache) return this.sourcesCache;
    const sources: Partial<Record<SocialNetwork, IMetricsSource>> = {};
    const threadsToken = process.env.THREADS_ACCESS_TOKEN;
    if (threadsToken) sources[SocialNetwork.THREADS] = new ThreadsInsightsSource(threadsToken);
    const facebookToken = process.env.FACEBOOK_PAGE_TOKEN;
    if (facebookToken) sources[SocialNetwork.FACEBOOK] = new FacebookInsightsSource(facebookToken);
    // X (Twitter): deferred per AN1 research §3 (no free read since Feb 2026).
    this.sourcesCache = sources;
    return sources;
  }

  /**
   * Daily cron — collect metrics from posted content.
   * Default: 6:00 AM daily. Configurable via METRICS_SCRAPER_SCHEDULE.
   * Gated by METRICS_SCRAPER_ENABLED env var (default: false).
   *
   * Dynamically registered (not @Cron) so it is NOT created when orchestrator is enabled.
   */
  onModuleInit(): void {
    if (isOrchestratorEnabled()) {
      this.logger.log('Orchestrator is enabled — metrics scraper cron NOT registered');
      return;
    }
    if (process.env.METRICS_SCRAPER_ENABLED !== 'true') {
      return;
    }

    const cronExpr = process.env.METRICS_SCRAPER_SCHEDULE ?? '0 6 * * *';
    const job = new CronJob(cronExpr, async () => { await this.collectMetrics(); });
    try {
      this.schedulerRegistry.addCronJob('metrics-scraper', job);
      job.start();
      this.logger.log(`Metrics scraper cron registered: ${cronExpr}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — metrics scraper cron will not run');
    }
  }

  /**
   * Main metrics collection logic — can be called manually for testing.
   * Returns summary of collected metrics.
   */
  async collectMetrics(): Promise<{ collected: number; failed: number; skipped: number }> {
    // HTTP API sources (Threads/FB) need no browser; only skip everything when
    // there is neither a browser nor any configured API source.
    if (!this.browser && Object.keys(this.getSources()).length === 0) {
      this.logger.warn('F6: no browser and no metrics API sources configured — skipped');
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
        const metrics = await this.scrapePostMetrics({ ...post, postUrl: post.postUrl! });
        if (metrics === null) {
          // No source configured for this network (or unavailable) — skip without
          // writing zero-rows that would pollute analytics.
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
            ...(metrics.impressions != null ? { impressions: metrics.impressions } : {}),
          },
        });

        // P7: Push the latest metrics onto the selected A/B variant.
        if (this.abVariantService) {
          await this.abVariantService.updateMetrics(post.id, metrics).catch(() => {});
        }

        collected++;
        this.logger.debug(`F6: Collected metrics for ${post.id} — likes: ${metrics.likes}, comments: ${metrics.comments}, shares: ${metrics.shares}`);
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`F6: Failed to scrape metrics for ${post.id}: ${message}`);
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
   * AN1: fetch metrics for a single post via the source registered for its network
   * (Threads/FB → free official insights API). Returns null when no source is
   * configured for the network — the post is then skipped, not zeroed. Per-post
   * errors propagate to the caller's try/catch.
   */
  private async scrapePostMetrics(post: {
    id: string;
    postUrl: string;
    network: SocialNetwork;
    accountId: string;
  }): Promise<PostMetricsData | null> {
    const source = this.getSources()[post.network];
    if (!source) {
      this.logger.debug(`F6: no metrics source for ${post.network} — skipping ${post.id}`);
      return null;
    }
    return source.fetchMetrics(post);
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
