import { describe, expect, it } from "vitest";

import {
  buildDirectUtmUrl,
  buildSourceUrl,
  extractBlogSlug,
  type DirectUtmParams,
} from "../../../src/modules/content-enhancements/source-url.util.js";

describe("source-url.util — P10 blog slug extraction (existing behaviour)", () => {
  it("extracts a slug from an en blog path", () => {
    expect(extractBlogSlug("../content/blog/en/example-post.md")).toBe("example-post");
  });

  it("extracts a slug from a localized blog path", () => {
    expect(extractBlogSlug("../content/blog/ru/primer.md")).toBe("primer");
  });

  it("returns null for non-blog paths", () => {
    expect(extractBlogSlug("../runs/brief-1/brief.json")).toBeNull();
    expect(extractBlogSlug("")).toBeNull();
  });

  it("builds locale-aware source URLs", () => {
    expect(buildSourceUrl("../content/blog/en/example-post.md", "https://example.com")).toBe(
      "https://example.com/blog/example-post",
    );
    expect(buildSourceUrl("../content/blog/ru/primer.md", "https://example.com")).toBe(
      "https://example.com/ru/blog/primer",
    );
  });
});

describe("buildDirectUtmUrl — ROADMAP_V2 M0.6 fallback UTM builder", () => {
  const base = "https://quiz.my-zodiac-ai.com";

  it("appends utm params with medium defaulting to social", () => {
    expect(buildDirectUtmUrl(base, { utmSource: "X" })).toBe(
      `${base}/?utm_source=X&utm_medium=social`,
    );
  });

  it("includes campaign and content in deterministic order", () => {
    const url = buildDirectUtmUrl(base, {
      utmSource: "THREADS",
      utmCampaign: "astro-daily-2026-08",
      utmContent: "post-abc-123",
    });
    expect(url).toBe(
      `${base}/?utm_source=THREADS&utm_medium=social&utm_campaign=astro-daily-2026-08&utm_content=post-abc-123`,
    );
  });

  it("preserves existing query params and does not overwrite them", () => {
    const url = buildDirectUtmUrl(`${base}/?lang=en`, { utmSource: "X", utmContent: "p1" });
    expect(url).toBe(`${base}/?lang=en&utm_source=X&utm_medium=social&utm_content=p1`);
  });

  it("does not duplicate utm params if the destination already carries one", () => {
    const url = buildDirectUtmUrl(`${base}/?utm_source=NEWSLETTER`, { utmSource: "X" });
    expect(url).toBe(`${base}/?utm_source=NEWSLETTER&utm_medium=social`);
  });

  it("is deterministic — same input yields byte-identical output", () => {
    const p: DirectUtmParams = { utmSource: "FACEBOOK", utmCampaign: "c1", utmContent: "p2" };
    expect(buildDirectUtmUrl(base, p)).toBe(buildDirectUtmUrl(base, { ...p }));
  });

  it("encodes special characters in values", () => {
    const url = buildDirectUtmUrl(base, { utmSource: "X", utmContent: "handle a&b" });
    const content = new URL(url).searchParams.get("utm_content");
    expect(content).toBe("handle a&b");
  });

  it("throws TypeError on invalid destination URLs", () => {
    expect(() => buildDirectUtmUrl("not-a-url", { utmSource: "X" })).toThrow(TypeError);
    expect(() => buildDirectUtmUrl("ftp://example.com", { utmSource: "X" })).toThrow(TypeError);
  });

  it("throws TypeError when utmSource is missing", () => {
    expect(() => buildDirectUtmUrl(base, {} as DirectUtmParams)).toThrow(/utmSource/);
  });
});
