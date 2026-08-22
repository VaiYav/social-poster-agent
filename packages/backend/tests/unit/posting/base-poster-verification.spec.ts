/**
 * A3-2 / M1: BasePoster post-verification methods against a mock DOM.
 *
 * These methods are the M1 anti-duplicate / shadowban guards — the highest-risk
 * untested code in the posting path. They were only mocked out at the service
 * level (posting.service.spec stubs `verifyPosted`), so the real DOM logic
 * (domcontentloaded nav + waitForSelector + content/URL matching) had no direct
 * coverage. This drives them with a fake Playwright page (the "mock DOM" A3 is
 * about) — no real browser.
 *
 * Source: packages/backend/src/modules/posting/posters/base.poster.ts
 *   - verifyPosted(context, content)         — M1/P3 anti-dup guard
 *   - detectPostShadowban(page, url, content) — submitted-but-not-visible check
 *   - verifyPostVisible(page, url, content)   — Sprint K visibility check
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "@nestjs/common";

import { BasePoster } from "../../../src/modules/posting/posters/base.poster";
import {
  createMockPage,
  createMockContext,
  createMockBrowserPort,
  createMockConfigService,
} from "../../mocks/index.js";

// Minimal concrete poster (network=X) exposing the protected verification methods.
// getVerificationProfileUrl/Pattern + getProfilePostContentSelector are private and
// network-driven, so X + the SOCIAL_X_USERNAME config value control verifyPosted's path.
class VerifyPoster extends BasePoster {
  protected readonly logger = new Logger("VerifyPoster");
  protected readonly network = "X" as const;

  constructor(browser: any, configService: any) {
    super(browser, configService);
  }

  detectPostShadowbanPublic(page: any, postUrl: string, expected: string) {
    return this.detectPostShadowban(page, postUrl, expected);
  }
  verifyPostVisiblePublic(page: any, postUrl: string, expected?: string) {
    return this.verifyPostVisible(page, postUrl, expected);
  }
}

const POST_URL = "https://x.com/myhandle/status/1788000000000000001";

describe("BasePoster verification (A3-2 / M1 — mock-DOM post checks)", () => {
  let poster: VerifyPoster;

  beforeEach(() => {
    poster = new VerifyPoster(
      createMockBrowserPort() as unknown as never,
      createMockConfigService({ SOCIAL_X_USERNAME: "" }) as unknown as never,
    );
  });

  describe("detectPostShadowban", () => {
    it('flags a "no longer available" page as shadowbanned', async () => {
      const page = createMockPage({ url: POST_URL, bodyText: "This post is no longer available" });
      expect(await poster.detectPostShadowbanPublic(page, POST_URL, "my tweet text")).toBe(true);
    });

    it("flags a page where the expected content is absent", async () => {
      const page = createMockPage({ url: POST_URL, bodyText: "unrelated page chrome and nav" });
      expect(await poster.detectPostShadowbanPublic(page, POST_URL, "my unique tweet text")).toBe(
        true,
      );
    });

    it("returns false when the content is visible and the page is healthy", async () => {
      const content = "my unique tweet text";
      const page = createMockPage({ url: POST_URL, bodyText: `header ${content} footer` });
      expect(await poster.detectPostShadowbanPublic(page, POST_URL, content)).toBe(false);
    });

    it("is conservative (returns false) when navigation throws", async () => {
      const page = createMockPage({ url: POST_URL });
      page.goto.mockRejectedValueOnce(new Error("nav failed"));
      expect(await poster.detectPostShadowbanPublic(page, POST_URL, "anything")).toBe(false);
    });
  });

  describe("verifyPostVisible", () => {
    it("true when the URL matches and the content is present", async () => {
      const content = "visible post text";
      const page = createMockPage({ url: POST_URL, bodyText: `x ${content} y` });
      expect(await poster.verifyPostVisiblePublic(page, POST_URL, content)).toBe(true);
    });

    it("false when redirected to a different URL", async () => {
      const page = createMockPage({ url: "https://x.com/home" });
      expect(await poster.verifyPostVisiblePublic(page, POST_URL, "whatever")).toBe(false);
    });

    it("false when the expected content is missing from the page", async () => {
      const page = createMockPage({ url: POST_URL, bodyText: "nothing relevant here" });
      expect(await poster.verifyPostVisiblePublic(page, POST_URL, "absent content")).toBe(false);
    });

    it("true when no content is required and the URL matches", async () => {
      const page = createMockPage({ url: POST_URL });
      expect(await poster.verifyPostVisiblePublic(page, POST_URL)).toBe(true);
    });
  });

  describe("verifyPosted (M1 anti-duplicate guard)", () => {
    it("returns null and opens no page when no profile URL is configured", async () => {
      const context = createMockContext(createMockPage());

      expect(await poster.verifyPosted(context as unknown as never, "content")).toBeNull();
      expect(context.newPage).not.toHaveBeenCalled();
    });

    it("returns null and closes the page when the content is not found on the profile", async () => {
      const posterWithUser = new VerifyPoster(
        createMockBrowserPort() as unknown as never,
        createMockConfigService({ SOCIAL_X_USERNAME: "myhandle" }) as unknown as never,
      );
      const page = createMockPage({ url: "https://x.com/myhandle", bodyText: "" }); // empty → not found → throws
      const context = createMockContext(page);

      expect(
        await posterWithUser.verifyPosted(context as unknown as never, "a brand new post"),
      ).toBeNull();
      expect(page.close).toHaveBeenCalled();
    });

    it("returns the profile URL (and closes the page) when the content is found", async () => {
      const posterWithUser = new VerifyPoster(
        createMockBrowserPort() as unknown as never,
        createMockConfigService({ SOCIAL_X_USERNAME: "myhandle" }) as unknown as never,
      );
      const content = "a brand new post";
      const page = createMockPage({
        url: "https://x.com/myhandle",
        bodyText: `feed ${content} more`,
      });
      const context = createMockContext(page);

      const result = await posterWithUser.verifyPosted(context as unknown as never, content);
      expect(result).toBe("https://x.com/myhandle");
      expect(page.close).toHaveBeenCalled();
    });
  });
});
