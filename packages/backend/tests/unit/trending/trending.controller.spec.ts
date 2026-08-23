import { describe, expect, it, vi } from "vitest";
import { TrendingController } from "../../../src/modules/trending/trending.controller.js";

describe("TrendingController", () => {
  it("delegates event, scraper, cache, and merged-trend endpoints", async () => {
    const trendingService = {
      getTrendingTopics: vi.fn().mockResolvedValue([{ topic: "event" }]),
      getActiveTrending: vi.fn().mockReturnValue([{ topic: "active", networks: ["X"] }]),
      getNextUpcoming: vi.fn().mockResolvedValue({ topic: "next" }),
    };
    const scraperService = {
      getGoogleTrends: vi.fn().mockResolvedValue(["google"]),
      getXTrends: vi.fn().mockResolvedValue(["x"]),
      getMergedTrending: vi.fn().mockResolvedValue(["merged"]),
      getCacheStatus: vi.fn().mockResolvedValue({ googleTrends: null, xTrends: null }),
    };
    const controller = new TrendingController(trendingService as never, scraperService as never);

    await expect(controller.getAll()).resolves.toEqual([{ topic: "event" }]);
    await expect(controller.getActive()).resolves.toEqual([{ topic: "active", networks: ["X"] }]);
    await expect(controller.getNext()).resolves.toEqual({ topic: "next" });
    await expect(controller.getGoogleTrends()).resolves.toEqual(["google"]);
    await expect(controller.getXTrends()).resolves.toEqual(["x"]);
    await expect(controller.getCacheStatus()).resolves.toEqual({
      googleTrends: null,
      xTrends: null,
    });
    await expect(controller.getMerged()).resolves.toEqual(["merged"]);

    expect(scraperService.getGoogleTrends).toHaveBeenCalledWith(20);
    expect(scraperService.getXTrends).toHaveBeenCalledWith(20);
    expect(scraperService.getMergedTrending).toHaveBeenCalledWith([
      { topic: "active", networks: ["X"] },
    ]);
  });
});
