import { withTimeout } from '../../../infrastructure/util/with-timeout.js';
import type { FetchFn, IMetricsSource, PostMetricsData, PostMetricsRef } from './metrics-source.port.js';

/**
 * AN1: parse a Facebook Graph **post node** counts response (pure, tested):
 *
 *   { "likes":    { "summary": { "total_count": 42 } },
 *     "comments": { "summary": { "total_count": 7 } },
 *     "shares":   { "count": 3 } }
 *
 * Defensive — any missing/oddly-shaped field counts as 0.
 */
export function parseFacebookPostCounts(json: unknown): {
  likes: number;
  comments: number;
  shares: number;
} {
  const j = json as {
    likes?: { summary?: { total_count?: unknown } };
    comments?: { summary?: { total_count?: unknown } };
    shares?: { count?: unknown };
  } | null;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    likes: n(j?.likes?.summary?.total_count),
    comments: n(j?.comments?.summary?.total_count),
    shares: n(j?.shares?.count),
  };
}

/**
 * AN1: Facebook Page post metrics via the free official Graph API (Standard
 * Access for your own Pages — no App Review). Token from FACEBOOK_PAGE_TOKEN.
 *
 * Scope of this increment: the high-confidence engagement COUNTS from the post
 * node (likes/comments/shares). `impressions` is left null on purpose — the
 * post-June-2026 reach/impression fields ("Total Unique Media Views") need live
 * verification before we query them (research §2), and counts are useful without.
 *
 * LIVE-VERIFY: the Graph post id is often `{pageId}_{postId}` while the post URL
 * only carries `{postId}`. We pass the URL id; capturing the full id at post time
 * (or composing it with the page id) is the robust path.
 */
export class FacebookInsightsSource implements IMetricsSource {
  readonly network = 'FACEBOOK' as const;

  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
    private readonly base = 'https://graph.facebook.com/v21.0',
    private readonly timeoutMs = 8000,
  ) {}

  async fetchMetrics(post: PostMetricsRef): Promise<PostMetricsData | null> {
    const id = this.resolvePostId(post.postUrl);
    if (!id) return null;

    const url =
      `${this.base}/${encodeURIComponent(id)}` +
      `?fields=likes.summary(true),comments.summary(true),shares` +
      `&access_token=${encodeURIComponent(this.accessToken)}`;

    const res = await withTimeout(this.fetchFn(url), this.timeoutMs, 'facebook post counts');
    if (!res.ok) return null;

    return { ...parseFacebookPostCounts(await res.json()), impressions: null };
  }

  /**
   * FB post URLs look like `…/{slug}/posts/{id}`, `…/permalink/{id}`, `…/photos/{id}`.
   * Returns the numeric id, or null → post skipped. LIVE-VERIFY: the Graph API may
   * need `{pageId}_{postId}`.
   */
  private resolvePostId(postUrl: string): string | null {
    return /\/(?:posts|permalink|photos)\/(\d+)/.exec(postUrl)?.[1] ?? null;
  }
}
