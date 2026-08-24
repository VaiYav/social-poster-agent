/**
 * M2.1: ZodiacLinkClient — ILinkPort adapter over zodiac-back
 * /internal/attribution-links. Covers enablement, request shape,
 * response mapping and failure semantics (everything →
 * LinkServiceUnavailableError).
 *
 * Source: packages/backend/src/infrastructure/link/zodiac-link.client.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { LinkServiceUnavailableError } from "../../../src/domain/ports/link.port.js";
import { ZodiacLinkClient } from "../../../src/infrastructure/link/zodiac-link.client.js";

function buildConfig(env: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    ZODIAC_API_URL: "https://zodiac.example.com",
    ZODIAC_INTERNAL_TOKEN: "secret-token",
    ZODIAC_DEFAULT_DESTINATION_URL: "https://quiz.my-zodiac-ai.com",
    ZODIAC_TIMEOUT_MS: "2000",
    ...env,
  };
  return {
    get: vi.fn((key: string) => defaults[key]),
  } as unknown as ConfigService;
}

function okFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => body });
}

describe("ZodiacLinkClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is disabled when ZODIAC_API_URL is empty and throws unavailable on use", async () => {
    const svc = new ZodiacLinkClient(buildConfig({ ZODIAC_API_URL: "" }));
    expect(svc.enabled).toBe(false);
    await expect(
      svc.createTrackableLink({ network: "X", campaign: "spa-2026-08" }),
    ).rejects.toThrow(LinkServiceUnavailableError);
  });

  it("createTrackableLink posts bearer-authenticated payload and maps the response", async () => {
    const fetchMock = okFetch({ id: "link-1", slug: "Ab3xYz9_", shortUrl: "https://quiz.my-zodiac-ai.com/r/Ab3xYz9_" });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new ZodiacLinkClient(buildConfig());

    const result = await svc.createTrackableLink({
      network: "X",
      campaign: "astro-daily-2026-08",
      postId: "post-1",
    });

    expect(result).toEqual({
      linkId: "link-1",
      slug: "Ab3xYz9_",
      shortUrl: "https://quiz.my-zodiac-ai.com/r/Ab3xYz9_",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://zodiac.example.com/internal/attribution-links");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      platform: "x",
      medium: "social",
      campaign: "astro-daily-2026-08",
      customFields: { post_id: "post-1" },
      destinationUrl: "https://quiz.my-zodiac-ai.com",
    });
  });

  it("non-2xx responses become LinkServiceUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }),
    );
    const svc = new ZodiacLinkClient(buildConfig());
    await expect(
      svc.createTrackableLink({ network: "THREADS", campaign: "c" }),
    ).rejects.toThrow(LinkServiceUnavailableError);
  });

  it("network failures become LinkServiceUnavailableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const svc = new ZodiacLinkClient(buildConfig());
    await expect(
      svc.createTrackableLink({ network: "FACEBOOK", campaign: "c" }),
    ).rejects.toThrow(LinkServiceUnavailableError);
  });

  it("getFunnelReport builds the funnel path with date query params", async () => {
    const report = { found: true, totals: { clicks: 5, converted: 1, conversionRate: 0.2 } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => report });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new ZodiacLinkClient(buildConfig());

    const res = await svc.getFunnelReport("link-9", {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-22T00:00:00Z"),
    });

    expect(res).toEqual(report);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://zodiac.example.com/internal/attribution-links/link-9/funnel" +
        "?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-22T00%3A00%3A00.000Z",
    );
  });
});
