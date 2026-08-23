import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "../../../src/domain/ports/browser-primitives.js";
import type { IBrowserPort } from "../../../src/domain/ports/browser.port.js";
import { DevtoPoster } from "../../../src/modules/posting/posters/devto.poster.js";
import type { ArticlePosterDeps } from "../../../src/modules/posting/posters/article-base.poster.js";
import type { ArticleContent } from "@spa/shared";

const validArticle: ArticleContent = {
  title: "A useful article",
  slug: "a-useful-article",
  bodyMarkdown: "# A useful article\n\nBody.",
  excerpt: "Body.",
  tags: ["testing"],
};

function createPoster(browserAgent: {
  act: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
  verify?: ReturnType<typeof vi.fn>;
}) {
  const canonicalService = {
    verifyCanonical: vi.fn().mockResolvedValue(true),
  };
  const deps = {
    browserAgent,
    canonicalService,
  } as unknown as ArticlePosterDeps;
  const browserPort = {
    suppressPageErrors: vi.fn().mockResolvedValue(undefined),
    applyResourceBlocking: vi.fn().mockResolvedValue(undefined),
  } as unknown as IBrowserPort;
  return { poster: new DevtoPoster(browserPort, deps), canonicalService };
}

describe("ArticleBasePoster article input/output boundary", () => {
  it("rejects malformed content and invalid canonical URLs before opening a page", async () => {
    const browserAgent = {
      act: vi.fn(),
      extract: vi.fn(),
    };
    const { poster } = createPoster(browserAgent);
    const context = { newPage: vi.fn() } as unknown as BrowserContext;

    const malformed = await poster.postArticle(
      context,
      { ...validArticle, bodyMarkdown: "   " },
      "https://blog.example.test/blog/a-useful-article",
    );
    const invalidCanonical = await poster.postArticle(context, validArticle, "not-a-url");

    expect(malformed).toMatchObject({ success: false, error: "Article content is malformed" });
    expect(invalidCanonical).toMatchObject({
      success: false,
      error: "A valid canonical URL is required for article publishing",
    });
    expect(context.newPage).not.toHaveBeenCalled();
    expect(browserAgent.act).not.toHaveBeenCalled();
  });

  it("fails closed when publish returns no valid article URL", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://dev.to/new"),
    } as unknown as Page;
    const context = { newPage: vi.fn().mockResolvedValue(page) } as unknown as BrowserContext;
    const browserAgent = {
      act: vi.fn().mockResolvedValue({ success: true }),
      extract: vi.fn().mockResolvedValue({ url: "not-a-url" }),
    };
    const { poster } = createPoster(browserAgent);

    const result = await poster.postArticle(
      context,
      validArticle,
      "https://blog.example.test/blog/a-useful-article",
    );

    expect(result).toMatchObject({
      success: false,
      error: "Published article URL could not be validated",
    });
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("requires the published article visibility and canonical URL to both verify", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    const context = { newPage: vi.fn().mockResolvedValue(page) } as unknown as BrowserContext;
    const browserAgent = {
      act: vi.fn(),
      extract: vi.fn(),
      verify: vi.fn().mockResolvedValue(true),
    };
    const { poster, canonicalService } = createPoster(browserAgent);
    const publishedUrl = "https://dev.to/testuser/a-useful-article-123";
    const canonicalUrl = "https://blog.example.test/blog/a-useful-article";

    await expect(poster.verifyPosted(context, publishedUrl, canonicalUrl)).resolves.toBe(
      publishedUrl,
    );
    expect(canonicalService.verifyCanonical).toHaveBeenCalledWith(publishedUrl, canonicalUrl);

    canonicalService.verifyCanonical.mockResolvedValue(false);
    await expect(poster.verifyPosted(context, publishedUrl, canonicalUrl)).resolves.toBeNull();
  });
});
