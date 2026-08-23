/**
 * Content adapter layer unit tests — registry, API/RSS adapters, and factory.
 *
 * Covers the new IContentAdapter contract introduced by Content Adapters Beyond CAP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import type { ContentTopic, ContentSourceConfig } from "@spa/shared";

const mockExistsSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));
import { ContentAdapterRegistry } from "../../../../src/infrastructure/content/adapters/content-adapter.registry.js";
import { ApiAdapter } from "../../../../src/infrastructure/content/adapters/api.adapter.js";
import { RssAdapter } from "../../../../src/infrastructure/content/adapters/rss.adapter.js";
import { buildContentAdapters } from "../../../../src/infrastructure/content/adapters/content-adapter.factory.js";
import { ContentReader } from "../../../../src/infrastructure/content/content-reader.js";
import { DbContentReader } from "../../../../src/infrastructure/content/db-content-reader.js";
import type { PrismaService } from "../../../../src/infrastructure/prisma/prisma.service.js";

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = { CONTENT_CACHE_TTL_MS: 1000 };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key in overrides) return overrides[key];
      if (key in defaults) return defaults[key];
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

function mockFetchJson(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchText(body: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  });
}

function mockFetchError(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  });
}

describe("ContentAdapterRegistry", () => {
  it("merges and sorts topics from multiple adapters", async () => {
    const adapterA = {
      sourceType: "a",
      canHandle: () => true,
      fetchTopics: async (): Promise<ContentTopic[]> => [
        {
          sourceType: "article",
          path: "a-1",
          topic: "A article",
          keywords: [],
          facts: [],
          language: "en",
        },
      ],
    };
    const adapterB = {
      sourceType: "b",
      canHandle: () => true,
      fetchTopics: async (): Promise<ContentTopic[]> => [
        {
          sourceType: "brief",
          path: "b-1",
          topic: "B brief",
          keywords: [],
          facts: [],
          language: "en",
        },
      ],
    };
    const registry = new ContentAdapterRegistry(createMockConfigService(), [adapterA, adapterB]);
    const topics = await registry.getTopics(10);
    expect(topics.length).toBe(2);
    expect(topics[0].sourceType).toBe("brief");
    expect(topics[1].sourceType).toBe("article");
  });

  it("caches results and invalidates on demand", async () => {
    const fetchTopics = vi
      .fn()
      .mockResolvedValue([
        { sourceType: "topic", path: "t-1", topic: "T", keywords: [], facts: [], language: "en" },
      ]);
    const registry = new ContentAdapterRegistry(
      createMockConfigService({ CONTENT_CACHE_TTL_MS: 10000 }),
      [{ sourceType: "a", canHandle: () => true, fetchTopics }],
    );
    await registry.getTopics(5);
    await registry.getTopics(5);
    expect(fetchTopics).toHaveBeenCalledTimes(1);
    registry.invalidateCache();
    await registry.getTopics(5);
    expect(fetchTopics).toHaveBeenCalledTimes(2);
  });

  it("filters readBriefs and readArticles by topic sourceType", async () => {
    const adapter = {
      sourceType: "a",
      canHandle: () => true,
      fetchTopics: async (): Promise<ContentTopic[]> => [
        {
          sourceType: "brief",
          path: "b-1",
          topic: "Brief",
          keywords: [],
          facts: [],
          language: "en",
        },
        {
          sourceType: "article",
          path: "a-1",
          topic: "Article",
          keywords: [],
          facts: [],
          language: "en",
        },
      ],
    };
    const registry = new ContentAdapterRegistry(createMockConfigService(), [adapter]);
    const briefs = await registry.readBriefs(10);
    const articles = await registry.readArticles(10);
    expect(briefs.length).toBe(1);
    expect(briefs[0].sourceType).toBe("brief");
    expect(articles.length).toBe(1);
    expect(articles[0].sourceType).toBe("article");
  });

  it("getSources returns health check results", async () => {
    const adapter = {
      sourceType: "a",
      canHandle: () => true,
      fetchTopics: async () => [],
      healthCheck: async () => ({ ok: false, error: "unreachable" }),
    };
    const registry = new ContentAdapterRegistry(createMockConfigService(), [adapter]);
    const sources = await registry.getSources();
    expect(sources).toEqual([{ sourceType: "a", ok: false, error: "unreachable" }]);
  });
});

describe("ApiAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a root JSON array to ContentTopic", async () => {
    const source: ContentSourceConfig = {
      sourceType: "api",
      config: {
        url: "https://api.example.com/topics",
        topicType: "topic",
      },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          {
            title: "T1",
            summary: "S1",
            keywords: ["k1"],
            category: "c1",
            publishedAt: "2026-01-01T00:00:00Z",
            link: "https://x/1",
          },
        ]),
      text: () => Promise.resolve(""),
    });
    const adapter = new ApiAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics.length).toBe(1);
    expect(topics[0]).toMatchObject({
      sourceType: "topic",
      topic: "T1",
      facts: ["S1"],
      keywords: ["k1"],
      category: "c1",
      path: "https://x/1",
    });
  });

  it("maps a nested items path", async () => {
    const source: ContentSourceConfig = {
      sourceType: "api",
      config: {
        url: "https://api.example.com/topics",
        itemsPath: "data.items",
        topicPath: "headline",
      },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { items: [{ headline: "H1" }] } }),
      text: () => Promise.resolve(""),
    });
    const adapter = new ApiAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics[0].topic).toBe("H1");
  });

  it("returns empty array on HTTP error and sets lastError", async () => {
    const source: ContentSourceConfig = {
      sourceType: "api",
      config: { url: "https://api.example.com/topics" },
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    });
    const adapter = new ApiAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics).toEqual([]);
    expect(adapter.lastError).toContain("500");
  });
});

describe("RssAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses RSS <item> into article topics", async () => {
    const source: ContentSourceConfig = {
      sourceType: "rss",
      config: { url: "https://feed.example.com/rss" },
    };
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>Item 1</title>
            <link>https://feed.example.com/1</link>
            <description>Summary 1</description>
            <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
            <category>tech</category>
          </item>
        </channel>
      </rss>`;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    });
    const adapter = new RssAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics.length).toBe(1);
    expect(topics[0]).toMatchObject({
      sourceType: "article",
      topic: "Item 1",
      path: "https://feed.example.com/1",
      facts: ["Summary 1"],
      category: "tech",
    });
  });

  it("parses Atom <entry> into article topics", async () => {
    const source: ContentSourceConfig = {
      sourceType: "rss",
      config: { url: "https://feed.example.com/atom" },
    };
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Atom 1</title>
          <link>https://feed.example.com/a1</link>
          <summary>Atom summary</summary>
          <published>2026-01-01T00:00:00Z</published>
          <category>news</category>
        </entry>
      </feed>`;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    });
    const adapter = new RssAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics.length).toBe(1);
    expect(topics[0].topic).toBe("Atom 1");
  });

  it("returns empty array on HTTP error and sets lastError", async () => {
    const source: ContentSourceConfig = {
      sourceType: "rss",
      config: { url: "https://feed.example.com/rss" },
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    });
    const adapter = new RssAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics).toEqual([]);
    expect(adapter.lastError).toContain("503");
  });
});

describe("GoogleTrendsAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses Google Trends RSS into topic topics", async () => {
    const source: ContentSourceConfig = { sourceType: "google_trends", config: {} };
    const xml = `<?xml version="1.0"?>
      <rss>
        <channel>
          <item>
            <title>Trend A</title>
            <link>https://trends.google.com/trends/explore?q=Trend+A</link>
            <ht:approx_traffic>100K+ searches</ht:approx_traffic>
          </item>
        </channel>
      </rss>`;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    });
    const { GoogleTrendsAdapter } =
      await import("../../../../src/infrastructure/content/adapters/google-trends.adapter.js");
    const adapter = new GoogleTrendsAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics.length).toBe(1);
    expect(topics[0]).toMatchObject({
      sourceType: "topic",
      topic: "Trend A",
      path: "https://trends.google.com/trends/explore?q=Trend+A",
      category: "Google Trends",
    });
    expect(topics[0].facts[0]).toContain("100K+ searches");
  });

  it("defaults to US geo URL", async () => {
    const source: ContentSourceConfig = { sourceType: "google_trends", config: { geo: "US" } };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<?xml version="1.0"?><rss><channel></channel></rss>'),
      json: () => Promise.resolve({}),
    });
    const { GoogleTrendsAdapter } =
      await import("../../../../src/infrastructure/content/adapters/google-trends.adapter.js");
    const adapter = new GoogleTrendsAdapter(source);
    await adapter.fetchTopics(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("trends.google.com/trending/rss?geo=US"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns empty array on HTTP error and sets lastError", async () => {
    const source: ContentSourceConfig = { sourceType: "google_trends", config: {} };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    });
    const { GoogleTrendsAdapter } =
      await import("../../../../src/infrastructure/content/adapters/google-trends.adapter.js");
    const adapter = new GoogleTrendsAdapter(source);
    const topics = await adapter.fetchTopics(1);
    expect(topics).toEqual([]);
    expect(adapter.lastError).toContain("500");
  });
});

describe("buildContentAdapters", () => {
  const fsReader = { sourceType: "cap_file" } as unknown as ContentReader;
  const dbReader = { sourceType: "db" } as unknown as DbContentReader;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("queries ContentSource table and instantiates adapters", async () => {
    const prisma = {
      contentSource: {
        findMany: vi.fn().mockResolvedValue([
          {
            sourceType: "api",
            name: "API",
            enabled: true,
            priority: 0,
            config: { url: "https://api.example.com" },
          },
          {
            sourceType: "rss",
            name: "RSS",
            enabled: true,
            priority: 1,
            config: { url: "https://feed.example.com" },
          },
        ]),
      },
    };
    const config = createMockConfigService({});
    const adapters = await buildContentAdapters({
      configService: config,
      prisma: prisma as unknown as PrismaService,
      fsReader,
      dbReader,
    });
    expect(adapters.length).toBe(2);
    expect(adapters.map((a) => a.sourceType)).toEqual(["api", "rss"]);
    expect(prisma.contentSource.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  });

  it("parses CONTENT_SOURCES and instantiates API, RSS, and Google Trends adapters", async () => {
    const config = createMockConfigService({
      CONTENT_SOURCES: JSON.stringify([
        { sourceType: "api", name: "API", config: { url: "https://api.example.com" } },
        { sourceType: "rss", name: "RSS", config: { url: "https://feed.example.com" } },
        { sourceType: "google_trends", name: "GT", config: { geo: "US" } },
      ]),
    });
    const adapters = await buildContentAdapters({ configService: config, fsReader, dbReader });
    expect(adapters.length).toBe(3);
    expect(adapters.map((a) => a.sourceType)).toEqual(["api", "rss", "google_trends"]);
  });

  it("skips disabled sources and falls back to legacy detection", async () => {
    const config = createMockConfigService({
      CONTENT_SOURCES: JSON.stringify([{ sourceType: "api", enabled: false, config: {} }]),
      CONTENT_AGENT_PLATFORM_PATH: "/tmp/cap",
    });
    mockExistsSync.mockReturnValue(false);
    const adapters = await buildContentAdapters({ configService: config, fsReader, dbReader });
    expect(adapters.length).toBe(1);
    expect(adapters[0].sourceType).toBe("db");
  });

  it("falls back to fsReader when CAP path exists and no CONTENT_SOURCES", async () => {
    const config = createMockConfigService({
      CONTENT_AGENT_PLATFORM_PATH: "/tmp/cap",
    });
    mockExistsSync.mockReturnValue(true);
    const adapters = await buildContentAdapters({ configService: config, fsReader, dbReader });
    expect(adapters.length).toBe(1);
    expect(adapters[0]).toBe(fsReader);
  });
});
