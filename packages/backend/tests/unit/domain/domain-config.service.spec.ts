import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainConfigService } from "../../../src/domain/domain-config/domain-config.service.js";
import { createMockConfigService } from "../../mocks/index.js";

const tempDirs: string[] = [];

async function tempConfig() {
  const dir = await mkdtemp(join(tmpdir(), "spa-domain-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("DomainConfigService", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("provides safe generic defaults and a complete resolved snapshot", async () => {
    const service = new DomainConfigService(createMockConfigService());

    expect(service.brandName).toBe("Social Poster Agent");
    expect(service.brandDescription).toContain("social posting");
    expect(service.domain).toBe("your product or topic area");
    expect(service.brandVoicePath).toBe("../brand-voice.md");
    expect(service.promptDir).toBe("config/prompts");
    expect(service.blogBaseUrl).toBe("");
    expect(service.getTopicCategories()).toContain("general");
    await expect(service.getConfig()).resolves.toMatchObject({
      brandName: "Social Poster Agent",
      contentPillars: [{ id: "general" }],
      contentStyles: [],
      humorMechanics: [],
      slopLexicon: {},
      visualStyles: expect.arrayContaining([expect.objectContaining({ id: "quote_card" })]),
    });
  });

  it("uses env overrides and parses topic categories", () => {
    const service = new DomainConfigService(
      createMockConfigService({
        BRAND_NAME: "Soulwise",
        BRAND_DESCRIPTION: "A grounded astrology product",
        DOMAIN: "astrology",
        BLOG_BASE_URL: "https://example.com/blog",
        TOPIC_CATEGORIES: " education, , product,opinion ",
      }),
    );

    expect(service.brandName).toBe("Soulwise");
    expect(service.domainDescription).toBe("A grounded astrology product");
    expect(service.domain).toBe("astrology");
    expect(service.blogBaseUrl).toBe("https://example.com/blog");
    expect(service.getTopicCategories()).toEqual(["education", "product", "opinion"]);
  });

  it("loads and caches brand voice, then falls back safely when absent", async () => {
    const dir = await tempConfig();
    const voicePath = join(dir, "voice.md");
    await writeFile(voicePath, "Be warm and specific.", "utf8");
    const service = new DomainConfigService(
      createMockConfigService({ BRAND_VOICE_PATH: voicePath }),
    );

    await expect(service.getBrandVoice()).resolves.toBe("Be warm and specific.");
    await expect(service.getBrandVoice()).resolves.toBe("Be warm and specific.");

    const fallback = new DomainConfigService(
      createMockConfigService({ BRAND_VOICE_PATH: join(dir, "missing.md") }),
    );
    await expect(fallback.getBrandVoice()).resolves.toContain("No fear-mongering");
  });

  it("splits chat prompts and caches templates", async () => {
    const dir = await tempConfig();
    await writeFile(join(dir, "chat.md"), "system rules\n---\nuser template", "utf8");
    await writeFile(join(dir, "plain.md"), "plain prompt", "utf8");
    const service = new DomainConfigService(createMockConfigService({ DOMAIN_PROMPT_DIR: dir }));

    await expect(service.getChatPromptTemplate("chat")).resolves.toEqual({
      systemPrompt: "system rules",
      userPrompt: "user template",
    });
    await expect(service.getChatPromptTemplate("plain")).resolves.toEqual({
      systemPrompt: "plain prompt",
      userPrompt: "",
    });
    await expect(service.getPromptTemplate("missing")).resolves.toBeNull();
    await expect(service.getPromptTemplate("chat")).resolves.toBe(
      "system rules\n---\nuser template",
    );
    await expect(service.getPromptTemplate("chat")).resolves.toBe(
      "system rules\n---\nuser template",
    );
  });

  it("loads structured JSON overrides for all optional config families", async () => {
    const dir = await tempConfig();
    const files: Record<string, unknown> = {
      CONTENT_PILLARS_PATH: [{ id: "custom", name: "Custom", targetRatio: 1, description: "x" }],
      CONTENT_STYLES_PATH: [{ id: "style", name: "Style", guidance: "g" }],
      HUMOR_MECHANICS_PATH: [{ id: "dry", name: "Dry", description: "d" }],
      SLOP_LEXICON_PATH: { generic: { replacements: ["specific"] } },
      TRENDING_NICHES_PATH: [{ id: "niche", keywords: ["n"] }],
      TRENDING_EVENTS_PATH: [{ id: "event", name: "Event", startDate: "2026-01-01" }],
      TRENDING_KEYWORD_OVERRIDES_PATH: [{ keyword: "x", replacement: "y" }],
      VISUAL_STYLES_PATH: [{ id: "custom", name: "Custom", description: "c" }],
    };
    const configValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(files)) {
      const file = join(dir, `${key}.json`);
      await writeFile(file, JSON.stringify(value), "utf8");
      configValues[key] = file;
    }
    const service = new DomainConfigService(createMockConfigService(configValues));

    await expect(service.getContentPillars()).resolves.toEqual(files.CONTENT_PILLARS_PATH);
    await expect(service.getContentStyles()).resolves.toEqual(files.CONTENT_STYLES_PATH);
    await expect(service.getHumorMechanics()).resolves.toEqual(files.HUMOR_MECHANICS_PATH);
    await expect(service.getSlopLexicon()).resolves.toEqual(files.SLOP_LEXICON_PATH);
    await expect(service.getTrendingNiches()).resolves.toEqual(files.TRENDING_NICHES_PATH);
    await expect(service.getTrendingEvents()).resolves.toEqual(files.TRENDING_EVENTS_PATH);
    await expect(service.getTrendingKeywordOverrides()).resolves.toEqual(
      files.TRENDING_KEYWORD_OVERRIDES_PATH,
    );
    await expect(service.getVisualStyles()).resolves.toEqual(files.VISUAL_STYLES_PATH);
  });

  it("falls back when configured JSON is malformed or missing", async () => {
    const dir = await tempConfig();
    const invalid = join(dir, "invalid.json");
    await writeFile(invalid, "{not-json", "utf8");
    const service = new DomainConfigService(
      createMockConfigService({
        CONTENT_PILLARS_PATH: invalid,
        CONTENT_STYLES_PATH: invalid,
        HUMOR_MECHANICS_PATH: invalid,
        SLOP_LEXICON_PATH: invalid,
        TRENDING_NICHES_PATH: invalid,
        TRENDING_EVENTS_PATH: invalid,
        TRENDING_KEYWORD_OVERRIDES_PATH: invalid,
        VISUAL_STYLES_PATH: invalid,
      }),
    );

    await expect(service.getContentPillars()).resolves.toEqual([
      expect.objectContaining({ id: "general" }),
    ]);
    await expect(service.getContentStyles()).resolves.toEqual([]);
    await expect(service.getHumorMechanics()).resolves.toEqual([]);
    await expect(service.getSlopLexicon()).resolves.toEqual({});
    await expect(service.getTrendingNiches()).resolves.toEqual([]);
    await expect(service.getTrendingEvents()).resolves.toEqual([]);
    await expect(service.getTrendingKeywordOverrides()).resolves.toEqual([]);
    await expect(service.getVisualStyles()).resolves.toHaveLength(2);
  });

  it("logs domain context during module initialization", () => {
    const service = new DomainConfigService(createMockConfigService({ BRAND_NAME: "Brand" }));
    expect(() => service.onModuleInit()).not.toThrow();
  });
});
