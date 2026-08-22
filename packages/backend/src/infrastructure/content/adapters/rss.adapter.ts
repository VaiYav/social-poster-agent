import { XMLParser } from "fast-xml-parser";
import type { ContentTopic } from "@spa/shared";
import { ContentSourceConfig } from "@spa/shared";
import type { IContentAdapter } from "./content-adapter.interface.js";

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0];
  return undefined;
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

function parseRssDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function flattenText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if ("#text" in value) return String(value["#text"]);
    if ("__text" in value) return String(value["__text"]);
    if ("text" in value) return String(value["text"]);
  }
  return undefined;
}

export interface RssAdapterConfig {
  url: string;
  language?: string;
  category?: string;
  titlePath?: string;
  summaryPath?: string;
  linkPath?: string;
  publishedAtPath?: string;
  keywordsPath?: string;
  categoryPath?: string;
}

interface ResolvedRssAdapterConfig {
  url: string;
  language: string;
  category?: string;
  titlePath: string;
  summaryPath: string;
  linkPath: string;
  publishedAtPath: string;
  keywordsPath: string;
  categoryPath: string;
}

interface RssItem {
  title?: string | unknown;
  description?: string | unknown;
  "content:encoded"?: string | unknown;
  summary?: string | unknown;
  link?: string | unknown;
  guid?: string | unknown;
  pubDate?: string | unknown;
  published?: string | unknown;
  updated?: string | unknown;
  category?: string | unknown | (string | unknown)[];
  "media:keywords"?: string | unknown;
  tags?: string | unknown | (string | unknown)[];
}

/**
 * RssAdapter — RSS/Atom feed content source.
 *
 * Fetches an RSS or Atom feed, parses the XML, and maps entries into
 * ContentTopic objects with sourceType 'article'.
 */
export class RssAdapter implements IContentAdapter {
  readonly sourceType = "rss";
  lastError: string | null = null;

  constructor(private readonly source: ContentSourceConfig) {}

  canHandle(sourceType: string): boolean {
    return sourceType === "article";
  }

  async fetchTopics(limit: number, since?: Date): Promise<ContentTopic[]> {
    const items = await this.fetchItems();
    const filtered = since
      ? items.filter((item) => {
          const publishedAt = this.extractDate(item);
          return publishedAt && publishedAt >= since;
        })
      : items;

    return filtered.slice(0, limit).map((item, index) => this.toTopic(item, index));
  }

  async fetchArticle(path: string): Promise<ContentTopic | null> {
    const all = await this.fetchTopics(1);
    return all.find((t) => t.path === path) ?? null;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.parseConfig();
    try {
      const res = await fetch(cfg.url, { method: "GET" });
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
    // RSS feeds are read-only; persistence is not meaningful here.
  }

  private parseConfig(): ResolvedRssAdapterConfig {
    const cfg = this.source.config as unknown as RssAdapterConfig;
    if (!cfg.url || typeof cfg.url !== "string") {
      throw new Error("RssAdapter requires a config.url string");
    }
    return {
      url: cfg.url,
      language: cfg.language ?? "en",
      category: cfg.category,
      titlePath: cfg.titlePath ?? "title",
      summaryPath: cfg.summaryPath ?? "description",
      linkPath: cfg.linkPath ?? "link",
      publishedAtPath: cfg.publishedAtPath ?? "pubDate",
      keywordsPath: cfg.keywordsPath ?? "category",
      categoryPath: cfg.categoryPath ?? "category",
    };
  }

  private async fetchItems(): Promise<RssItem[]> {
    const cfg = this.parseConfig();
    try {
      const res = await fetch(cfg.url, { method: "GET" });
      if (!res.ok) {
        this.lastError = `HTTP ${res.status} from ${cfg.url}`;
        return [];
      }
      const raw = await res.text();
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        isArray: (name) => name === "item" || name === "entry",
      });
      const parsed = parser.parse(raw) as Record<string, unknown>;

      let items: unknown[] = [];
      if (parsed.rss && typeof parsed.rss === "object") {
        const channel = (parsed.rss as Record<string, unknown>).channel;
        if (channel && typeof channel === "object") {
          const item = (channel as Record<string, unknown>).item;
          items = Array.isArray(item) ? item : item ? [item] : [];
        }
      } else if (parsed.feed && typeof parsed.feed === "object") {
        const entry = (parsed.feed as Record<string, unknown>).entry;
        items = Array.isArray(entry) ? entry : entry ? [entry] : [];
      }

      return items.filter((i): i is RssItem => i !== null && typeof i === "object");
    } catch (err) {
      this.lastError = (err as Error).message;
      return [];
    }
  }

  private toTopic(item: RssItem, index: number): ContentTopic {
    const cfg = this.parseConfig();
    const title = this.extractString(item, cfg.titlePath) ?? `rss-${index}`;
    const summary = this.extractString(item, cfg.summaryPath) ?? "";
    const link =
      this.extractString(item, cfg.linkPath) ??
      this.extractString(item, "guid") ??
      `${cfg.url}#${index}`;
    const publishedAt = this.extractDate(item);
    const keywords = toStringArray(this.extractValue(item, cfg.keywordsPath));
    const category = this.extractString(item, cfg.categoryPath) ?? cfg.category;

    return {
      sourceType: "article",
      path: link,
      topic: title,
      keywords,
      facts: summary ? [summary] : [],
      category,
      publishedAt,
      language: cfg.language,
    };
  }

  private extractValue(item: RssItem, path: string): unknown {
    const keys = path.split(".");
    let value: unknown = item;
    for (const key of keys) {
      if (value && typeof value === "object" && key in value) {
        value = (value as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return value;
  }

  private extractString(item: RssItem, path: string): string | undefined {
    const value = this.extractValue(item, path);
    const flat = flattenText(value);
    if (flat) return flat;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.length > 0) {
      const first = flattenText(value[0]);
      if (first) return first;
      if (typeof value[0] === "string") return value[0];
    }
    return undefined;
  }

  private extractDate(item: RssItem): Date | undefined {
    const cfg = this.parseConfig();
    const value = this.extractValue(item, cfg.publishedAtPath);
    return parseRssDate(value);
  }
}
