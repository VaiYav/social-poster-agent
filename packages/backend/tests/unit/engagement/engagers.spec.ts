import { describe, expect, it, vi } from "vitest";
import {
  createMockBrowserPort,
  createMockConfigService,
  createMockPage,
} from "../../mocks/index.js";
import { XEngager } from "../../../src/modules/engagement/engagers/x.engager.js";
import { ThreadsEngager } from "../../../src/modules/engagement/engagers/threads.engager.js";
import { FacebookEngager } from "../../../src/modules/engagement/engagers/facebook.engager.js";
import { BaseEngager } from "../../../src/modules/engagement/engagers/base.engager.js";
import type { Page } from "../../../src/domain/ports/browser-primitives.js";

function internals(engager: BaseEngager) {
  return engager as unknown as Record<string, (...args: unknown[]) => unknown>;
}

function mockCalls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

function page(url = "https://x.com/example/status/1") {
  return createMockPage({ url }) as unknown as Page;
}

function prepareAction(
  engager: BaseEngager,
  result: unknown = { performed: true, alreadyLiked: false },
) {
  const api = internals(engager);
  api.navigate = vi.fn().mockResolvedValue(undefined);
  api.screenshot = vi.fn().mockResolvedValue("/tmp/engagement.png");
  api.performLike = vi.fn().mockResolvedValue(result);
  api.performComment = vi.fn().mockResolvedValue(undefined);
  api.performFollow = vi.fn().mockResolvedValue(true);
  api.performRepost = vi.fn().mockResolvedValue({ performed: true, alreadyReposted: false });
  api.performQuote = vi.fn().mockResolvedValue(undefined);
  api.doScrollFeed = vi.fn().mockResolvedValue(["https://example.com/post/1"]);
  api.doExtractPostText = vi.fn().mockResolvedValue({ text: "post text", hasMedia: true });
  api.doOpenCommentsThread = vi.fn().mockResolvedValue(3);
  return api;
}

function buildEngagers() {
  const browser = createMockBrowserPort();
  const config = createMockConfigService({ SOCIAL_FACEBOOK_PAGE_SLUG: "example-page" });
  return {
    x: new XEngager(browser, config),
    threads: new ThreadsEngager(browser, config),
    facebook: new FacebookEngager(browser, config),
    browser,
    config,
  };
}

describe("network engagers", () => {
  it("validates network-specific post URLs and profile URLs", () => {
    const { x, threads, facebook } = buildEngagers();
    const xApi = internals(x);
    const threadsApi = internals(threads);
    const facebookApi = internals(facebook);

    expect(xApi.isValidPostUrl("https://x.com/user/status/123")).toBe(true);
    expect(xApi.isValidPostUrl("https://x.com/user/status/123/analytics")).toBe(false);
    expect(xApi.isValidPostUrl("not-a-url")).toBe(false);
    expect(threadsApi.isValidPostUrl("https://www.threads.com/@user/post/abc")).toBe(true);
    expect(threadsApi.isValidPostUrl("https://www.threads.com/@user/post/abc/extra")).toBe(false);
    expect(facebookApi.resolveProfileUrl("@page")).toBe("https://www.facebook.com/page");
    expect(xApi.resolveProfileUrl("@user")).toBe("https://x.com/user");
    expect(threadsApi.resolveProfileUrl("@user")).toBe("https://www.threads.com/@user");
    expect(xApi.resolveAbsoluteUrl("/user/status/1")).toBe("https://x.com/user/status/1");
    expect(threadsApi.resolveAbsoluteUrl("/t/abc")).toBe("https://www.threads.com/t/abc");
    expect(facebookApi.resolveAbsoluteUrl("/page/posts/1")).toBe(
      "https://www.facebook.com/page/posts/1",
    );
  });

  it.each([
    ["x", "https://x.com/user/status/1"],
    ["threads", "https://www.threads.com/@user/post/abc"],
    ["facebook", "https://www.facebook.com/page/posts/1"],
  ])("executes like successfully for %s", async (network, postUrl) => {
    const { x, threads, facebook } = buildEngagers();
    const engager = ({ x, threads, facebook } as Record<string, BaseEngager>)[network]!;
    const api = prepareAction(engager);
    const result = await engager.like(page(postUrl), postUrl);

    expect(result).toEqual({ success: true, screenshotPath: "/tmp/engagement.png" });
    expect(mockCalls(api.navigate).some((args) => args[1] === postUrl)).toBe(true);
    expect(api.performLike).toHaveBeenCalledOnce();
  });

  it("maps already-liked and failed-like outcomes without false success", async () => {
    const { x } = buildEngagers();
    const already = prepareAction(x, { performed: false, alreadyLiked: true });
    await expect(x.like(page(), "https://x.com/u/status/1")).resolves.toEqual({
      success: true,
      screenshotPath: "/tmp/engagement.png",
    });
    expect(already.screenshot).toHaveBeenCalledWith(expect.anything(), "after-like");

    prepareAction(x, { performed: false, alreadyLiked: false });
    await expect(x.like(page(), "https://x.com/u/status/1")).resolves.toMatchObject({
      success: false,
      error: "Like button found but state did not change",
    });
  });

  it("returns structured failures when wrapper navigation or action fails", async () => {
    const { x, facebook } = buildEngagers();
    const xApi = prepareAction(x);
    xApi.navigate = vi.fn().mockRejectedValue(new Error("navigation failed"));
    await expect(x.follow(page(), "@user")).resolves.toEqual({
      success: false,
      error: "navigation failed",
    });

    const fbApi = prepareAction(facebook);
    fbApi.performComment = vi.fn().mockRejectedValue(new Error("comment failed"));
    await expect(
      facebook.comment(page("https://facebook.com/p"), "https://facebook.com/p", "hi"),
    ).resolves.toEqual({ success: false, error: "comment failed" });
  });

  it("handles comment, follow, reply, repost, and quote wrapper contracts", async () => {
    const { x, threads, facebook } = buildEngagers();
    for (const engager of [x, threads]) {
      const api = prepareAction(engager);
      const p = page();
      await expect(
        engager.comment(p, "https://example.com/post/1", "hello"),
      ).resolves.toMatchObject({
        success: true,
        screenshotPath: "/tmp/engagement.png",
      });
      await expect(engager.follow(p, "@creator")).resolves.toMatchObject({
        success: true,
        screenshotPath: "/tmp/engagement.png",
      });
      await expect(engager.reply(p, "https://example.com/post/1", "reply")).resolves.toMatchObject({
        success: true,
      });
      await expect(engager.repost(p, "https://example.com/post/1")).resolves.toMatchObject({
        success: true,
      });
      await expect(engager.quote(p, "https://example.com/post/1", "quote")).resolves.toMatchObject({
        success: true,
      });
      expect(api.screenshot).toHaveBeenCalled();
    }
  });

  it("returns unsupported Facebook repost and quote results", async () => {
    const { facebook } = buildEngagers();
    await expect(facebook.repost(page(), "url")).resolves.toEqual({
      success: false,
      error: "Repost is not supported on Facebook",
    });
    await expect(facebook.quote(page(), "url", "text")).resolves.toEqual({
      success: false,
      error: "Quote is not supported on Facebook",
    });
  });

  it("delegates scroll, extraction, and comments to common helpers", async () => {
    const { x, threads, facebook } = buildEngagers();
    for (const [engager, feedUrl] of [
      [x, "https://x.com/home"],
      [threads, "https://www.threads.com/"],
      [facebook, "https://www.facebook.com/example-page/"],
    ] as const) {
      const api = prepareAction(engager);
      const p = page();
      await expect(engager.scrollFeed(p, 0)).resolves.toEqual(["https://example.com/post/1"]);
      await expect(engager.scrollUrl(p, "https://example.com/explore", 0)).resolves.toEqual([
        "https://example.com/post/1",
      ]);
      await expect(engager.extractPostText(p, "https://example.com/post/1")).resolves.toEqual({
        text: "post text",
        hasMedia: true,
      });
      await expect(engager.openCommentsThread(p, "https://example.com/post/1")).resolves.toBe(3);
      expect(mockCalls(api.navigate).some((args) => args[1] === feedUrl)).toBe(true);
      expect(api.doScrollFeed).toHaveBeenCalled();
    }
  });

  it("enforces the Facebook page slug for feed scrolling", async () => {
    const browser = createMockBrowserPort();
    const noSlug = new FacebookEngager(
      browser,
      createMockConfigService({ SOCIAL_FACEBOOK_PAGE_SLUG: "" }),
    );
    await expect(noSlug.scrollFeed(page(), 0)).rejects.toThrow(
      "SOCIAL_FACEBOOK_PAGE_SLUG not configured",
    );
    const { facebook } = buildEngagers();
    expect(facebook.getPageUrl()).toBe("https://www.facebook.com/example-page/");
  });

  it("covers common BaseEngager navigation helpers and safe aria state", async () => {
    const { x, browser } = buildEngagers();
    const api = prepareAction(x);
    const p = page("https://x.com/home");
    await x.navigateBack(p);
    expect(p.goBack).toHaveBeenCalledWith({ waitUntil: "domcontentloaded" });
    await x.visitProfile(p, "@creator");
    expect(api.navigate).toHaveBeenCalledWith(p, "https://x.com/creator");
    await expect(x.scrollUrl(p, "https://x.com/explore", 0)).resolves.toEqual([
      "https://example.com/post/1",
    ]);
    expect(browser.randomDelay).toHaveBeenCalled();

    const aria = internals(x).isAriaPressed as (...args: unknown[]) => Promise<boolean>;
    await expect(
      aria({ getAttribute: vi.fn().mockResolvedValueOnce("true").mockResolvedValueOnce(null) }),
    ).resolves.toBe(true);
    await expect(aria({ getAttribute: vi.fn().mockResolvedValue(null) })).resolves.toBe(false);
  });

  it("runs the zero-duration common scroll path without collecting links", async () => {
    const { x, browser } = buildEngagers();
    const api = internals(x);
    const result = await api.doScrollFeed(page("https://x.com/home"), 0, {
      css: ['a[href*="/status/"]'],
    });
    expect(result).toEqual([]);
    expect(browser.randomDelay).toHaveBeenCalledWith(1500, 2500);
  });
});
