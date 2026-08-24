import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ContentTopic } from "@spa/shared";
import { IContentPort } from "../../../domain/ports/content.port.js";
import { IContentAdapter, CONTENT_ADAPTERS } from "./content-adapter.interface.js";

const sourcePriority: Record<string, number> = {
  brief: 0,
  create_run: 1,
  topic: 2,
  article: 3,
};

function byPriorityThenDate(a: ContentTopic, b: ContentTopic): number {
  const pA = sourcePriority[a.sourceType] ?? 4;
  const pB = sourcePriority[b.sourceType] ?? 4;
  if (pA !== pB) return pA - pB;
  const tA = a.publishedAt?.getTime() ?? 0;
  const tB = b.publishedAt?.getTime() ?? 0;
  return tB - tA;
}

function adapterName(adapter: IContentAdapter): string {
  return (adapter as { sourceType?: string }).sourceType ?? "unknown";
}

/**
 * ContentAdapterRegistry — aggregates IContentAdapter implementations into a
 * single IContentPort. Supports the existing brief/article/getTopics contract
 * while allowing multiple pluggable sources (CAP filesystem, RSS, API, DB, ...).
 *
 * The registry is defensive about adapter shape so legacy mocks and partial
 * implementations still work: fetchTopics falls back to getTopics, healthCheck
 * and markUsed are optional, and canHandle defaults to true when absent.
 */
@Injectable()
export class ContentAdapterRegistry implements IContentPort {
  private readonly logger = new Logger(ContentAdapterRegistry.name);
  private readonly cacheTtlMs: number;
  private topicsCache: { limit: number; topics: ContentTopic[]; expiresAt: number } | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject(CONTENT_ADAPTERS)
    @Optional()
    private readonly adapters: IContentAdapter[] = [],
  ) {
    this.cacheTtlMs = this.configService.get<number>("CONTENT_CACHE_TTL_MS", 120_000);
  }

  async getTopics(limit = 5): Promise<ContentTopic[]> {
    if (
      this.topicsCache &&
      Date.now() < this.topicsCache.expiresAt &&
      this.topicsCache.limit >= limit
    ) {
      this.logger.debug(`Content cache hit (limit: ${limit})`);
      return this.topicsCache.topics.slice(0, limit);
    }

    const all: ContentTopic[] = [];
    for (const adapter of this.adapters) {
      try {
        const batch = await this.fetchTopicsFrom(adapter, limit);
        all.push(...batch);
      } catch (err) {
        (adapter as { lastError?: string | null }).lastError = (err as Error).message;
        this.logger.warn(`Adapter ${adapterName(adapter)} failed: ${(err as Error).message}`);
      }
    }

    const result = all.sort(byPriorityThenDate).slice(0, limit);
    this.topicsCache = { limit, topics: result, expiresAt: Date.now() + this.cacheTtlMs };
    return result;
  }

  async readBriefs(limit = 10): Promise<ContentTopic[]> {
    const all = await this.fetchByType("brief", limit);
    return all.sort(byPriorityThenDate).slice(0, limit);
  }

  async readArticles(limit = 10): Promise<ContentTopic[]> {
    const all = await this.fetchByType("article", limit);
    return all.sort(byPriorityThenDate).slice(0, limit);
  }

  async markUsed(topic: ContentTopic): Promise<void> {
    for (const adapter of this.adapters) {
      const canHandle =
        typeof adapter.canHandle === "function" ? adapter.canHandle(topic.sourceType) : true;
      if (!canHandle) continue;

      if (typeof adapter.markUsed !== "function") continue;
      try {
        await adapter.markUsed(topic);
      } catch (err) {
        (adapter as { lastError?: string | null }).lastError = (err as Error).message;
        this.logger.debug(
          `markUsed failed for adapter ${adapterName(adapter)}: ${(err as Error).message}`,
        );
      }
    }
  }

  async getSources(): Promise<{ sourceType: string; ok: boolean; error?: string }[]> {
    return Promise.all(
      this.adapters.map(async (adapter) => {
        if (typeof adapter.healthCheck !== "function") {
          return { sourceType: adapterName(adapter), ok: true };
        }
        const res = await adapter.healthCheck();
        return { sourceType: adapterName(adapter), ...res };
      }),
    );
  }

  async healthCheck(): Promise<{ ok: boolean; errors: string[] }> {
    const results = await this.getSources();
    const errors = results.filter((r) => !r.ok).map((r) => `${r.sourceType}: ${r.error}`);
    return { ok: errors.length === 0, errors };
  }

  invalidateCache(): void {
    this.topicsCache = null;
    for (const adapter of this.adapters) {
      const withCache = adapter as IContentAdapter & { invalidateCache?: () => void };
      if (typeof withCache.invalidateCache === "function") {
        withCache.invalidateCache();
      }
    }
  }

  private async fetchTopicsFrom(adapter: IContentAdapter, limit: number): Promise<ContentTopic[]> {
    if (typeof adapter.fetchTopics === "function") {
      return adapter.fetchTopics(limit);
    }
    const legacy = adapter as unknown as { getTopics?: (limit: number) => Promise<ContentTopic[]> };
    if (typeof legacy.getTopics === "function") {
      return legacy.getTopics(limit);
    }
    return [];
  }

  private async fetchByType(type: string, limit: number): Promise<ContentTopic[]> {
    const all: ContentTopic[] = [];
    const needed = limit * 4;
    for (const adapter of this.adapters) {
      try {
        let batch: ContentTopic[] = [];
        if (type === "brief" && typeof adapter.readBriefs === "function") {
          batch = await adapter.readBriefs(needed);
        } else if (type === "article" && typeof adapter.readArticles === "function") {
          batch = await adapter.readArticles(needed);
        } else {
          batch = await this.fetchTopicsFrom(adapter, needed);
        }
        all.push(...batch.filter((t) => t.sourceType === type));
      } catch (err) {
        (adapter as { lastError?: string | null }).lastError = (err as Error).message;
        this.logger.warn(
          `Adapter ${adapterName(adapter)} failed for ${type}: ${(err as Error).message}`,
        );
      }
    }
    return all;
  }
}
