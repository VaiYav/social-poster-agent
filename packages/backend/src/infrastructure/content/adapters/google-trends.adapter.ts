import type { ContentTopic } from '@spa/shared';
import { ContentSourceConfig } from '@spa/shared';
import type { IContentAdapter } from './content-adapter.interface.js';
import { parseGoogleTrendsRss } from '../google-trends-rss.js';

export interface GoogleTrendsAdapterConfig {
  url?: string;
  geo?: string;
  headers?: Record<string, string>;
  language?: string;
}

/**
 * GoogleTrendsAdapter — public Google Trends RSS feed as a content source.
 *
 * Wraps the existing dependency-free parser from `google-trends-rss.ts` and maps
 * trending topics into `ContentTopic` objects with sourceType `topic`.
 */
export class GoogleTrendsAdapter implements IContentAdapter {
  readonly sourceType = 'google_trends';
  lastError: string | null = null;

  constructor(private readonly source: ContentSourceConfig) {}

  canHandle(sourceType: string): boolean {
    return sourceType === 'topic';
  }

  async fetchTopics(limit: number, since?: Date): Promise<ContentTopic[]> {
    const cfg = this.parseConfig();
    try {
      const res = await fetch(cfg.url, {
        method: 'GET',
        headers: cfg.headers,
      });
      if (!res.ok) {
        this.lastError = `HTTP ${res.status} from Google Trends RSS`;
        return [];
      }
      const xml = await res.text();
      const parsed = parseGoogleTrendsRss(xml, limit);
      const topics = parsed.map((t): ContentTopic => {
        const facts: string[] = [];
        if (t.traffic) facts.push(`Trending traffic: ${t.traffic}`);
        if (t.url) facts.push(`Source: ${t.url}`);
        return {
          sourceType: 'topic',
          path: t.url ?? `google-trends:${t.rank}`,
          topic: t.topic,
          keywords: [],
          facts,
          category: 'Google Trends',
          publishedAt: new Date(),
          language: cfg.language,
        };
      });
      return since
        ? topics.filter((t) => t.publishedAt && t.publishedAt >= since)
        : topics;
    } catch (err) {
      this.lastError = (err as Error).message;
      return [];
    }
  }

  async fetchArticle(path: string): Promise<ContentTopic | null> {
    const all = await this.fetchTopics(1);
    return all.find((t) => t.path === path) ?? null;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.parseConfig();
    try {
      const res = await fetch(cfg.url, { method: 'GET', headers: cfg.headers });
      if (!res.ok) {
        this.lastError = `HTTP ${res.status} from ${cfg.url}`;
        return { ok: false, error: this.lastError };
      }
      return { ok: true };
    } catch (err) {
      this.lastError = (err as Error).message;
      return { ok: false, error: this.lastError };
    }
  }

  async markUsed(_topic: ContentTopic): Promise<void> {
    // Google Trends is read-only; persistence is not meaningful here.
  }

  private parseConfig(): { url: string; headers: Record<string, string>; language: string } {
    const cfg = this.source.config as unknown as GoogleTrendsAdapterConfig;
    const geo = cfg.geo ?? 'US';
    return {
      url: cfg.url ?? `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`,
      headers: cfg.headers ?? { 'User-Agent': 'SocialPosterAgent/1.0 (content adapter)' },
      language: cfg.language ?? 'en',
    };
  }
}
