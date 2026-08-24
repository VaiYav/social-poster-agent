import { describe, expect, it, vi } from "vitest";
import { LinkAttributionController } from "../../../src/modules/link-attribution/link-attribution.controller.js";

function buildPost(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-zodiac",
    network: "X",
    status: "PUBLISHED",
    ctaUrl: "https://quiz.my-zodiac-ai.com/r/zodiac-1",
    attributionLinkId: "link-zodiac-1",
    attributionSlug: "zodiac-1",
    sourceRef: { topic: "daily astrology", credentials: "must-not-leak" },
    postedAt: new Date("2026-08-23T10:00:00.000Z"),
    ...overrides,
  };
}

function buildController(posts: Record<string, unknown>[], report = {}) {
  const prisma = {
    post: { findMany: vi.fn().mockResolvedValue(posts) },
  };
  const linkPort = {
    getFunnelReport: vi.fn().mockResolvedValue({
      found: true,
      totals: { clicks: 10, converted: 2, conversionRate: 0.2 },
      ...report,
    }),
  };
  return {
    controller: new LinkAttributionController(prisma as never, linkPort as never),
    prisma,
    linkPort,
  };
}

describe("LinkAttributionController.summary", () => {
  it("clamps days to 365, aggregates Zodiac funnels, and returns only bounded fields", async () => {
    const { controller, prisma, linkPort } = buildController([
      buildPost(),
      buildPost({
        id: "post-fallback",
        network: "FACEBOOK",
        ctaUrl: "https://quiz.my-zodiac-ai.com/quiz?utm_source=facebook&utm_content=post-fallback",
        attributionLinkId: null,
        attributionSlug: null,
        sourceRef: { topic: "fallback topic", password: "must-not-leak" },
        postedAt: null,
      }),
    ]);

    const result = await controller.summary("999");

    expect(result.windowDays).toBe(365);
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, orderBy: { createdAt: "desc" } }),
    );
    expect(linkPort.getFunnelReport).toHaveBeenCalledTimes(1);
    expect(linkPort.getFunnelReport).toHaveBeenCalledWith("link-zodiac-1");
    expect(result.totals).toEqual({
      posts: 2,
      clicks: 10,
      conversions: 2,
      conversionRate: 0.2,
    });
    expect(result.degradedLinks).toBe(0);
    expect(result.posts).toEqual([
      expect.objectContaining({
        postId: "post-zodiac",
        source: "provider",
        clicks: 10,
        conversions: 2,
        deliveryMode: "reply",
      }),
      expect.objectContaining({
        postId: "post-fallback",
        source: "utm-fallback",
        clicks: 0,
        conversions: 0,
        deliveryMode: "inline",
        postedAt: null,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("credentials");
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it.each([
    [undefined, 30],
    ["0", 30],
    ["-4", 1],
    ["2.5", 2.5],
    ["365", 365],
  ])("normalizes days %s to %s", async (days, expected) => {
    const { controller } = buildController([]);
    const result = await controller.summary(days);
    expect(result.windowDays).toBe(expected);
  });

  it("does not fabricate conversions for fallback links and returns null rate for zero clicks", async () => {
    const { controller, linkPort } = buildController(
      [
        buildPost({
          ctaUrl: "https://quiz.my-zodiac-ai.com/quiz?utm_source=x",
          attributionLinkId: null,
          attributionSlug: null,
        }),
      ],
      { totals: { clicks: 99, converted: 33, conversionRate: 1 / 3 } },
    );

    const result = await controller.summary("1");

    expect(linkPort.getFunnelReport).not.toHaveBeenCalled();
    expect(result.totals).toEqual({ posts: 1, clicks: 0, conversions: 0, conversionRate: null });
    expect(result.posts[0]).toEqual(
      expect.objectContaining({ source: "utm-fallback", clicks: 0, conversions: 0 }),
    );
  });

  it("counts provider failures as degraded without exposing provider payloads", async () => {
    const { controller, linkPort } = buildController([buildPost()]);
    linkPort.getFunnelReport.mockRejectedValue(new Error("provider secret payload"));

    const result = await controller.summary("30");

    expect(result.degradedLinks).toBe(1);
    expect(result.totals).toEqual({ posts: 1, clicks: 0, conversions: 0, conversionRate: null });
    expect(result.posts[0]).toEqual(
      expect.objectContaining({ source: "provider", clicks: 0, conversions: 0 }),
    );
    expect(JSON.stringify(result)).not.toContain("provider secret payload");
  });
});
