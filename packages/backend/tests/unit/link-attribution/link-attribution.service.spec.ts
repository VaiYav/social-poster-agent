/**
 * M2.1: LinkAttributionService — CTA assignment with graceful degradation.
 *
 * Source: packages/backend/src/modules/link-attribution/link-attribution.service.ts
 */
import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { LinkServiceUnavailableError } from "../../../src/domain/ports/link.port.js";
import {
  LinkAttributionService,
  type AssignedCta,
} from "../../../src/modules/link-attribution/link-attribution.service.js";

const POST_ID = "22222222-2222-4222-8222-222222222222";

function buildPost(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    network: "X",
    sourceRef: { type: "topic", topic: "astrology daily" },
    ctaUrl: null,
    ...overrides,
  };
}

function buildDeps(opts: {
  post?: Record<string, unknown> | null;
  linkPort?: Record<string, unknown>;
  env?: Record<string, string>;
}) {
  const linkPort = {
    createTrackableLink: vi.fn().mockResolvedValue({
      linkId: "link-1",
      slug: "Ab3xYz9_",
      shortUrl: "https://quiz.my-zodiac-ai.com/r/Ab3xYz9_",
    }),
    getFunnelReport: vi.fn(),
    ...opts.linkPort,
  };
  const prisma = {
    post: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const config = {
    get: vi.fn((key: string) =>
      key === "ZODIAC_DEFAULT_DESTINATION_URL"
        ? (opts.env?.ZODIAC_DEFAULT_DESTINATION_URL ?? "https://quiz.my-zodiac-ai.com")
        : undefined,
    ),
  } as unknown as ConfigService;
  const service = new LinkAttributionService(
    linkPort as never,
    prisma as never,
    config,
  );
  return { service, linkPort, prisma };
}

describe("LinkAttributionService.deliveryModeFor", () => {
  it("reply mode for X and Threads, inline for everything else", () => {
    expect(LinkAttributionService.deliveryModeFor("X")).toBe("reply");
    expect(LinkAttributionService.deliveryModeFor("THREADS")).toBe("reply");
    expect(LinkAttributionService.deliveryModeFor("FACEBOOK")).toBe("inline");
  });
});

describe("LinkAttributionService.appendInline", () => {
  it("appends the URL once and is idempotent", () => {
    const url = "https://quiz.my-zodiac-ai.com/r/x";
    const once = LinkAttributionService.appendInline("Body text.", url);
    expect(once).toBe(`Body text.\n\n${url}`);
    expect(LinkAttributionService.appendInline(once, url)).toBe(once);
  });
});

describe("LinkAttributionService.assignForPost", () => {
  it("is idempotent — an existing ctaUrl is reused without minting a new link", async () => {
    const { service, linkPort, prisma } = buildDeps({
      post: buildPost({ ctaUrl: "https://quiz.my-zodiac-ai.com/r/existing" }),
    });
    const res: AssignedCta | null = await service.assignForPost(buildPost({ ctaUrl: "https://quiz.my-zodiac-ai.com/r/existing" }));
    expect(res?.ctaUrl).toBe("https://quiz.my-zodiac-ai.com/r/existing");
    expect(linkPort.createTrackableLink).not.toHaveBeenCalled();
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("zodiac success persists shortUrl + attribution fields, reply mode for X", async () => {
    const post = buildPost();
    const { service, linkPort, prisma } = buildDeps({});
    const res = await service.assignForPost(post);

    expect(res).toEqual({
      ctaUrl: "https://quiz.my-zodiac-ai.com/r/Ab3xYz9_",
      mode: "reply",
      source: "provider",
    });
    expect(linkPort.createTrackableLink).toHaveBeenCalledWith(
      expect.objectContaining({ network: "X", postId: POST_ID, campaign: expect.stringMatching(/^astrology-daily-\d{4}-\d{2}$/) }),
    );
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: POST_ID },
      data: {
        ctaUrl: "https://quiz.my-zodiac-ai.com/r/Ab3xYz9_",
        attributionLinkId: "link-1",
        attributionSlug: "Ab3xYz9_",
      },
    });
  });

  it("inline mode for FACEBOOK on the zodiac path", async () => {
    const { service } = buildDeps({});
    const res = await service.assignForPost(buildPost({ network: "FACEBOOK" }));
    expect(res?.mode).toBe("inline");
  });

  it("degrades to a direct UTM URL when zodiac is unavailable; attribution stays null", async () => {
    const { service, prisma } = buildDeps({
      linkPort: {
        createTrackableLink: vi
          .fn()
          .mockRejectedValue(new LinkServiceUnavailableError("down")),
      },
    });
    const res = await service.assignForPost(buildPost());

    expect(res?.source).toBe("utm-fallback");
    expect(res?.ctaUrl).toContain("utm_source=x");
    expect(res?.ctaUrl).toContain("utm_campaign=");
    const updateArg = prisma.post.update.mock.calls[0][0];
    expect(updateArg.data.ctaUrl).toBe(res?.ctaUrl);
    expect(updateArg.data.attributionLinkId).toBeUndefined();
    expect(updateArg.data.attributionSlug).toBeUndefined();
  });

  it("returns null when zodiac is down AND no fallback destination is configured", async () => {
    const { service } = buildDeps({
      linkPort: {
        createTrackableLink: vi
          .fn()
          .mockRejectedValue(new LinkServiceUnavailableError("down")),
      },
      env: { ZODIAC_DEFAULT_DESTINATION_URL: "" },
    });
    await expect(service.assignForPost(buildPost())).resolves.toBeNull();
  });

  it("unexpected port errors also degrade to UTM instead of throwing", async () => {
    const { service } = buildDeps({
      linkPort: { createTrackableLink: vi.fn().mockRejectedValue(new TypeError("bad json")) },
    });
    const res = await service.assignForPost(buildPost());
    expect(res?.source).toBe("utm-fallback");
  });
});
