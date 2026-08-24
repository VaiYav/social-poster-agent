import type { SocialNetwork } from "../../../generated/prisma/client.js";

/**
 * AN1: a per-network source of post-performance metrics for the tool's OWN posts.
 *
 * Research (docs/audit/research/AN1-metrics-scraper.md) settled the approach:
 *   - Threads + Facebook → free official insights HTTP APIs (own account).
 *   - X → deferred (no free read since Feb 2026: paid API or stealth scrape).
 *
 * MetricsScraperService dispatches each POSTED post to the source registered for
 * its network. A network with no configured source (e.g. no token) yields `null`,
 * and the post is skipped — never written as zero-rows.
 */
export interface PostMetricsData {
  likes: number;
  comments: number;
  shares: number;
  /** Optional — not every network/plan exposes impressions for free. */
  impressions?: number | null;
}

/** Minimal post reference a source needs to fetch metrics. */
export interface PostMetricsRef {
  id: string;
  postUrl: string;
  network: SocialNetwork;
  accountId: string;
}

export interface IMetricsSource {
  readonly network: SocialNetwork;
  /** True for HTTP API sources that don't need a human-like browser delay. */
  readonly isHttpApi: boolean;
  /** Fetch latest metrics for a post, or `null` if unavailable (skip, don't zero). */
  fetchMetrics(post: PostMetricsRef): Promise<PostMetricsData | null>;
}

/** Injectable `fetch` so sources are unit-testable without real network I/O. */
export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
