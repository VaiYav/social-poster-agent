import { afterEach, describe, expect, it, vi } from "vitest";
import { PostingWindowService } from "../../../src/modules/orchestrator/posting-window.service.js";

function buildService(
  configValues: Record<string, string> = {},
  options: { cached?: string | null; metrics?: unknown[]; metricsError?: Error } = {},
) {
  const redis = {
    get: vi.fn().mockResolvedValue(options.cached ?? null),
    setex: vi.fn().mockResolvedValue("OK"),
  };
  const postMetrics = {
    findMany: options.metricsError
      ? vi.fn().mockRejectedValue(options.metricsError)
      : vi.fn().mockResolvedValue(options.metrics ?? []),
  };
  const prisma = { postMetrics };
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => configValues[key] ?? fallback),
  };
  return {
    service: new PostingWindowService(prisma as never, config as never, redis as never),
    redis,
    postMetrics,
  };
}

function heatmap(entries: Array<{ hour: number; score: number; samples: number }>): string {
  const byHour = new Map(entries.map((entry) => [entry.hour, entry]));
  return JSON.stringify(
    Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, score: 0, samples: 0 }),
  );
}

describe("PostingWindowService", () => {
  afterEach(() => vi.useRealTimers());

  it("uses configured fallback hours during cold start with ±1h tolerance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:30:00Z"));
    const { service } = buildService({ POSTING_WINDOW_FALLBACK_HOURS: "18, 9, 12" });

    await expect(service.getRecommendation("X")).resolves.toEqual({
      bestHours: [9, 12, 18],
      inWindow: true,
      confidence: "low",
    });
  });

  it("returns cached heatmap scores in sorted recommendation order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00Z"));
    const { service, postMetrics } = buildService(
      { POSTING_WINDOW_MIN_SAMPLES: "10", POSTING_WINDOW_TOP_HOURS: "2" },
      {
        cached: heatmap([
          { hour: 3, score: 10, samples: 5 },
          { hour: 9, score: 30, samples: 5 },
          { hour: 16, score: 20, samples: 5 },
        ]),
      },
    );

    await expect(service.getRecommendation("X")).resolves.toEqual({
      bestHours: [9, 16],
      inWindow: true,
      confidence: "medium",
    });
    expect(postMetrics.findMany).not.toHaveBeenCalled();
  });

  it("builds and caches a decayed, deduplicated heatmap from PostMetrics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00Z"));
    const recent = new Date("2026-08-23T10:00:00Z");
    const older = new Date("2026-08-22T09:00:00Z");
    const metrics = [
      { postId: "p-new", likes: 5, comments: 1, shares: 0, post: { postedAt: recent } },
      // Duplicate post is ignored because the newest record is first.
      { postId: "p-new", likes: 1, comments: 0, shares: 0, post: { postedAt: older } },
      ...Array.from({ length: 2 }, (_, i) => ({
        postId: `p-${i}`,
        likes: 4,
        comments: 1,
        shares: 0,
        post: { postedAt: recent },
      })),
    ];
    const { service, redis, postMetrics } = buildService(
      { POSTING_WINDOW_MIN_SAMPLES: "2", POSTING_WINDOW_TOP_HOURS: "1" },
      { metrics },
    );

    const result = await service.getRecommendation("X");

    expect(result.bestHours).toEqual([10]);
    expect(result.confidence).toBe("medium");
    expect(postMetrics.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500, orderBy: { collectedAt: "desc" } }),
    );
    expect(redis.setex).toHaveBeenCalledWith(
      "spa:posting-window:heatmap:X",
      3600,
      expect.any(String),
    );
  });

  it("falls back safely on invalid cache or database failure", async () => {
    const invalidCache = buildService(
      { POSTING_WINDOW_FALLBACK_HOURS: "7,19" },
      { cached: "not-json", metricsError: new Error("db down") },
    );
    await expect(invalidCache.service.getRecommendation("X")).resolves.toEqual({
      bestHours: [7, 19],
      inWindow: false,
      confidence: "low",
    });

    const bypass = buildService(
      { POSTING_WINDOW_FALLBACK_HOURS: "7,19", POSTING_WINDOW_BYPASS: "true" },
      { metricsError: new Error("db down") },
    );
    await expect(bypass.service.getRecommendation("X")).resolves.toMatchObject({
      bestHours: [7, 19],
      inWindow: true,
      confidence: "low",
    });
  });

  it("finds the next window today, wraps to tomorrow, and returns a non-negative delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00Z"));
    const { service } = buildService({ POSTING_WINDOW_FALLBACK_HOURS: "12,18" });
    const now = Date.parse("2026-08-23T10:00:00Z");

    await expect(service.getNextWindowAt("X", now)).resolves.toBe(
      Date.parse("2026-08-23T12:00:00Z"),
    );
    await expect(service.getDelayToNextWindow("X", now)).resolves.toBe(2 * 60 * 60 * 1000);
    await expect(service.getNextWindowAt("X", Date.parse("2026-08-23T19:00:00Z"))).resolves.toBe(
      Date.parse("2026-08-24T12:00:00Z"),
    );
  });
});
