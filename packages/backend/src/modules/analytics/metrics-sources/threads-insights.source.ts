import { withTimeout } from '../../../infrastructure/util/with-timeout.js';
import { parseGraphInsights, type InsightMapping } from './graph-insights.js';
import type { FetchFn, IMetricsSource, PostMetricsData, PostMetricsRef } from './metrics-source.port.js';

// Threads Insights metric names → our PostMetricsData fields (research §2).
const THREADS_MAPPING: InsightMapping = {
  likes: 'likes',
  comments: 'replies',
  shares: 'reposts',
  impressions: 'views',
};

/**
 * AN1: Threads post metrics via the free official Threads Insights API
 * (`GET /{media-id}/insights`). Own-account / tester mode needs no App Review.
 *
 * Token comes from THREADS_ACCESS_TOKEN. The HTTP call + media-id resolution are
 * the LIVE-VERIFY surface (needs a real token); the response parsing is the pure,
 * unit-tested core (graph-insights.ts).
 */
export class ThreadsInsightsSource implements IMetricsSource {
  readonly network = 'THREADS' as const;

  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
    private readonly base = 'https://graph.threads.net/v1.0',
    private readonly timeoutMs = 8000,
  ) {}

  async fetchMetrics(post: PostMetricsRef): Promise<PostMetricsData | null> {
    const mediaId = this.resolveMediaId(post.postUrl);
    if (!mediaId) return null;

    const metric = Array.from(new Set(Object.values(THREADS_MAPPING))).join(',');
    const url =
      `${this.base}/${encodeURIComponent(mediaId)}/insights` +
      `?metric=${metric}&access_token=${encodeURIComponent(this.accessToken)}`;

    const res = await withTimeout(this.fetchFn(url), this.timeoutMs, 'threads insights');
    if (!res.ok) return null;
    return parseGraphInsights(await res.json(), THREADS_MAPPING);
  }

  /**
   * Threads URLs are `https://www.threads.com/@handle/post/<shortcode>`.
   * LIVE-VERIFY: confirm whether the Insights API keys on this shortcode or on the
   * numeric media-id (in which case capture+store the media-id at post time — see
   * P1 network-capture). Returns null when no id can be resolved → post is skipped.
   */
  private resolveMediaId(postUrl: string): string | null {
    return /\/post\/([A-Za-z0-9_-]+)/.exec(postUrl)?.[1] ?? null;
  }
}
