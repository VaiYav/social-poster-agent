import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_PILLARS,
  ContentPillarTracker,
  classifyPillar,
} from "../../../src/modules/content-enhancements/content-pillar.tracker.js";

function buildTracker(values: Record<string, string | null> = {}) {
  const redis = {
    get: vi.fn((key: string) => Promise.resolve(values[key] ?? null)),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
  return { tracker: new ContentPillarTracker(redis as never), redis };
}

describe("ContentPillarTracker", () => {
  it.each([
    ["Fresh blog article", [], "blog_promo"],
    ["An unpopular opinion", [], "opinion"],
    ["Behind the scenes process", [], "behind-the-scenes"],
    ["New product launch", [], "product"],
    ["Breaking news trending today", [], "trending"],
    ["How to learn this skill", [], "educational"],
    ["A calm reflection", [], "general"],
  ])("classifies %s as %s", (topic, keywords, expected) => {
    expect(classifyPillar(topic, keywords)).toBe(expected);
  });

  it("uses keywords and first-match priority when classifying", () => {
    expect(classifyPillar("A launch", ["fresh article"])).toBe("blog_promo");
    expect(classifyPillar("A topic", ["tutorial", "product"])).toBe("product");
    expect(classifyPillar("A topic", ["what is", "breaking news"])).toBe("trending");
  });

  it("returns zeroed stats and recommends the first pillar on an empty window", async () => {
    const { tracker, redis } = buildTracker();
    const stats = await tracker.getPillarStats();

    expect(stats).toHaveLength(CONTENT_PILLARS.length);
    expect(stats.every((entry) => entry.count === 0 && entry.actualRatio === 0)).toBe(true);
    await expect(tracker.recommendPillar()).resolves.toMatchObject({
      recommended: "general",
      reason: expect.stringContaining('Pillar "general"'),
    });
    expect(redis.get).toHaveBeenCalledTimes(CONTENT_PILLARS.length * 2);
  });

  it("computes ratios/deficits and recommends the most underrepresented pillar", async () => {
    const { tracker } = buildTracker({
      "spa:pillar:general:count": "20",
      "spa:pillar:educational:count": "1",
      "spa:pillar:product:count": "15",
      "spa:pillar:opinion:count": "10",
      "spa:pillar:behind-the-scenes:count": "10",
      "spa:pillar:trending:count": "10",
      "spa:pillar:blog_promo:count": "15",
    });
    const recommendation = await tracker.recommendPillar();
    const educational = recommendation.stats.find((entry) => entry.pillar === "educational");

    expect(educational).toMatchObject({ count: 1, targetRatio: 0.2 });
    expect(educational?.actualRatio).toBeCloseTo(1 / 81, 6);
    expect(recommendation.recommended).toBe("educational");
    expect(recommendation.reason).toContain("1%");
  });

  it("breaks equal deficits by the canonical pillar order", async () => {
    const { tracker } = buildTracker({
      "spa:pillar:general:count": "0",
      "spa:pillar:educational:count": "0",
      "spa:pillar:product:count": "0",
      "spa:pillar:opinion:count": "0",
      "spa:pillar:behind-the-scenes:count": "0",
      "spa:pillar:trending:count": "0",
      "spa:pillar:blog_promo:count": "0",
    });
    await expect(tracker.recommendPillar()).resolves.toMatchObject({ recommended: "general" });
  });

  it("records a pillar and sets the seven-day expiry only on the first increment", async () => {
    const { tracker, redis } = buildTracker();
    await tracker.recordPillar("educational");
    expect(redis.incr).toHaveBeenCalledWith("spa:pillar:educational:count");
    expect(redis.expire).toHaveBeenCalledWith("spa:pillar:educational:count", 604800);

    redis.incr.mockResolvedValue(2);
    await tracker.recordPillar("educational");
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it("classifies and records a post in one operation", async () => {
    const { tracker, redis } = buildTracker();

    await expect(tracker.recordPost("A new article", [])).resolves.toBe("blog_promo");
    expect(redis.incr).toHaveBeenCalledWith("spa:pillar:blog_promo:count");
  });
});
