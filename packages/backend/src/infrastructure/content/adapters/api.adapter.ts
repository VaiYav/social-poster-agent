import type { ContentTopic } from "@spa/shared";
import { ContentSourceConfig } from "@spa/shared";
import type { IContentAdapter } from "./content-adapter.interface.js";

function getAtPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce((acc: unknown, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function toFacts(value: unknown): string[] {
  const arr = toArray(value);
  const result: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      result.push(item);
    } else if (item && typeof item === "object") {
      result.push(JSON.stringify(item));
    }
  }
  return result.filter(Boolean);
}

export interface ApiAdapterConfig {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  itemsPath?: string;
  topicPath?: string;
  factsPath?: string;
  keywordsPath?: string;
  categoryPath?: string;
  publishedAtPath?: string;
  linkPath?: string;
  language?: string;
  topicType?: "brief" | "article" | "topic" | "create_run";
}

interface ResolvedApiAdapterConfig {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  itemsPath: string;
  topicPath: string;
  factsPath: string;
  keywordsPath: string;
  categoryPath: string;
  publishedAtPath: string;
  linkPath: string;
  language: string;
  topicType: "brief" | "article" | "topic" | "create_run";
}

/**
 * ApiAdapter — generic REST/JSON content source.
 *
 * Fetches a JSON endpoint and maps item fields into ContentTopic objects using
 * dot-path extraction. Useful for CMS APIs, custom topic endpoints, or any JSON
 * source that can be flattened into topics.
 */
export class ApiAdapter implements IContentAdapter {
  readonly sourceType = "api";
  lastError: string | null = null;

  constructor(private readonly source: ContentSourceConfig) {
    this.source = source;
  }

  canHandle(sourceType: string): boolean {
    return sourceType === this.parseConfig().topicType;
  }

  async fetchTopics(limit: number, since?: Date): Promise<ContentTopic[]> {
    const cfg = this.parseConfig();
    const items = await this.fetchItems(cfg);
    const filtered = since
      ? items.filter((item) => {
          const publishedAt = this.extractDate(item, cfg.publishedAtPath);
          return publishedAt && publishedAt >= since;
        })
      : items;

    return filtered.slice(0, limit).map((item, index) => this.toTopic(item, cfg, index));
  }

  async fetchArticle(path: string): Promise<ContentTopic | null> {
    const all = await this.fetchTopics(1);
    return all.find((t) => t.path === path) ?? null;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.parseConfig();
    try {
      const res = await fetch(cfg.url, {
        method: cfg.method ?? "GET",
        headers: cfg.headers ?? {},
        body: cfg.body,
      });
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
    // API sources are read-only; persistence is not meaningful here.
  }

  private parseConfig(): ResolvedApiAdapterConfig {
    const cfg = this.source.config as unknown as ApiAdapterConfig;
    if (!cfg.url || typeof cfg.url !== "string") {
      throw new Error("ApiAdapter requires a config.url string");
    }
    const topicType: ResolvedApiAdapterConfig["topicType"] =
      cfg.topicType === "brief" ||
      cfg.topicType === "article" ||
      cfg.topicType === "topic" ||
      cfg.topicType === "create_run"
        ? cfg.topicType
        : "topic";
    return {
      url: cfg.url,
      method: cfg.method ?? "GET",
      headers: cfg.headers ?? {},
      body: cfg.body,
      itemsPath: cfg.itemsPath ?? "",
      topicPath: cfg.topicPath ?? "title",
      factsPath: cfg.factsPath ?? "summary",
      keywordsPath: cfg.keywordsPath ?? "keywords",
      categoryPath: cfg.categoryPath ?? "category",
      publishedAtPath: cfg.publishedAtPath ?? "publishedAt",
      linkPath: cfg.linkPath ?? "link",
      language: cfg.language ?? "en",
      topicType,
    };
  }

  private async fetchItems(cfg: ResolvedApiAdapterConfig): Promise<unknown[]> {
    try {
      const res = await fetch(cfg.url, {
        method: cfg.method,
        headers: cfg.headers,
        body: cfg.body,
      });
      if (!res.ok) {
        this.lastError = `HTTP ${res.status} from ${cfg.url}`;
        return [];
      }
      const data = (await res.json()) as unknown;
      const items = getAtPath(data, cfg.itemsPath);
      if (Array.isArray(items)) return items;
      if (items && typeof items === "object") return [items];
      return [];
    } catch (err) {
      this.lastError = (err as Error).message;
      return [];
    }
  }

  private toTopic(item: unknown, cfg: ResolvedApiAdapterConfig, index: number): ContentTopic {
    const topic = this.extractString(item, cfg.topicPath) ?? `api-${index}`;
    const facts = toFacts(getAtPath(item, cfg.factsPath));
    const keywords = toStringArray(getAtPath(item, cfg.keywordsPath));
    const category = this.extractString(item, cfg.categoryPath);
    const publishedAt = this.extractDate(item, cfg.publishedAtPath);
    const link = this.extractString(item, cfg.linkPath) ?? `${cfg.url}#${index}`;
    const language = cfg.language;
    const sourceType = cfg.topicType;

    return {
      sourceType,
      path: link,
      topic,
      keywords,
      facts,
      category,
      publishedAt,
      language,
    };
  }

  private extractString(item: unknown, path: string): string | undefined {
    const value = getAtPath(item, path);
    if (typeof value === "string") return value;
    return undefined;
  }

  private extractDate(item: unknown, path: string): Date | undefined {
    const value = getAtPath(item, path);
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    return date;
  }
}
