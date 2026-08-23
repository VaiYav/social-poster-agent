import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOOK_TECHNIQUES,
  HookPerformanceBank,
  classifyHookTechnique,
} from "../../../src/modules/content-enhancements/hook-performance-bank.js";
import { PostStatus, SocialNetwork } from "../../../src/generated/prisma/client.js";

function buildBank(options: { stats?: Record<string, string>; prisma?: unknown } = {}) {
  const pipeline = {
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  const redis = {
    get: vi.fn((key: string) => Promise.resolve(options.stats?.[key] ?? null)),
    multi: vi.fn().mockReturnValue(pipeline),
  };
  const config = {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  };
  const scheduler = { addCronJob: vi.fn(), deleteCronJob: vi.fn() };
  const bank = new HookPerformanceBank(
    config as never,
    redis as never,
    scheduler as never,
    options.prisma as never,
  );
  return { bank, redis, pipeline, config, scheduler };
}

describe("HookPerformanceBank", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ["What should we change?", "question"],
    ["This always works!", "bold"],
    ["Actually, most people think this", "counter_intuitive"],
    ["Yesterday I learned a lesson", "story"],
    ["Studies show 42 percent improvement", "data"],
    ["A calm observation", "question"],
  ])("classifies %s as %s", (hook, expected) => {
    expect(classifyHookTechnique(hook)).toBe(expected);
  });

  it("returns neutral fallback when no cached data exists or JSON is invalid", async () => {
    const empty = buildBank();
    await expect(empty.bank.getRecommendation(SocialNetwork.X)).resolves.toMatchObject({
      topTechnique: "question",
      bottomTechnique: null,
      hasData: false,
      rankedTechniques: expect.arrayContaining([
        expect.objectContaining({ technique: "question", hybridScore: 0.5 }),
      ]),
    });

    const invalid = buildBank({ stats: { "spa:hookbank:stats:X": "not-json" } });
    await expect(invalid.bank.getRecommendation(SocialNetwork.X)).resolves.toMatchObject({
      hasData: false,
      guidance: expect.stringContaining("No historical data yet"),
    });
  });

  it("ranks data-backed techniques and identifies a weak technique", async () => {
    const stats = {
      question: { avg: 10, count: 3, avgQuality: 8, qualityCount: 3 },
      bold: { avg: 1, count: 3, avgQuality: 2, qualityCount: 3 },
      story: { avg: 0, count: 0, avgQuality: 9, qualityCount: 3 },
    };
    const { bank } = buildBank({
      stats: { "spa:hookbank:stats:X": JSON.stringify(stats) },
    });
    const recommendation = await bank.getRecommendation(SocialNetwork.X);

    expect(recommendation).toMatchObject({
      topTechnique: "story",
      bottomTechnique: "bold",
      hasData: true,
      guidance: expect.stringContaining('Best technique: "story"'),
    });
    expect(recommendation.rankedTechniques[0]).toMatchObject({
      technique: "story",
      sampleSize: 3,
      avgQualityScore: 9,
    });
    expect(recommendation.rankedTechniques).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ technique: "story", avgQualityScore: 9, sampleSize: 3 }),
      ]),
    );
  });

  it("reads dashboard stats for all networks and last update", async () => {
    const { bank } = buildBank({
      stats: {
        "spa:hookbank:stats:X": JSON.stringify({ question: { avg: 1 } }),
        "spa:hookbank:stats:THREADS": "{}",
        "spa:hookbank:updated": "1787500000000",
      },
    });
    await expect(bank.getStats()).resolves.toEqual({
      networks: { X: { question: { avg: 1 } }, THREADS: {}, FACEBOOK: {} },
      lastUpdated: 1787500000000,
    });
  });

  it("skips aggregation without Prisma and writes grouped metrics to Redis", async () => {
    const noPrisma = buildBank();
    await expect(noPrisma.bank.aggregateStats()).resolves.toBeUndefined();
    expect(noPrisma.redis.multi).not.toHaveBeenCalled();

    const prisma = {
      post: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "post-1",
            network: SocialNetwork.X,
            llmMetadata: { hook: "What changed?", qualityScore: 8 },
            metrics: [{ likes: 10, comments: 2, shares: 1 }],
          },
          {
            id: "post-2",
            network: SocialNetwork.X,
            llmMetadata: { hook: "This always works!", hookTechnique: "bold" },
            metrics: [],
          },
          {
            id: "post-3",
            network: SocialNetwork.THREADS,
            llmMetadata: { hook: "A post", hookTechnique: "invalid" },
            metrics: [{ likes: 1, comments: 0, shares: 0 }],
          },
        ]),
      },
    };
    const aggregated = buildBank({ prisma });
    await aggregated.bank.aggregateStats();

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: PostStatus.POSTED, llmMetadata: expect.anything() },
        take: 500,
      }),
    );
    expect(aggregated.redis.multi).toHaveBeenCalledOnce();
    expect(aggregated.pipeline.set).toHaveBeenCalledWith(
      "spa:hookbank:stats:X",
      expect.stringContaining('"question"'),
      "EX",
      3600,
    );
    expect(aggregated.pipeline.set).toHaveBeenCalledWith(
      "spa:hookbank:updated",
      expect.any(String),
      "EX",
      3600,
    );
    expect(aggregated.pipeline.exec).toHaveBeenCalledOnce();
  });

  it("swallows aggregation failures and gates cron registration on orchestrator mode", async () => {
    const failingPrisma = { post: { findMany: vi.fn().mockRejectedValue(new Error("db down")) } };
    const failed = buildBank({ prisma: failingPrisma });
    await expect(failed.bank.aggregateStats()).resolves.toBeUndefined();
    expect(failed.pipeline.exec).not.toHaveBeenCalled();

    vi.stubEnv("ORCHESTRATOR_ENABLED", "true");
    const orchestrated = buildBank();
    orchestrated.bank.onModuleInit();
    expect(orchestrated.scheduler.addCronJob).not.toHaveBeenCalled();

    vi.stubEnv("ORCHESTRATOR_ENABLED", "false");
    const legacy = buildBank();
    legacy.bank.onModuleInit();
    expect(legacy.scheduler.addCronJob).toHaveBeenCalledWith(
      "hook-bank-aggregate",
      expect.objectContaining({ start: expect.any(Function) }),
    );
  });

  it("keeps the technique registry aligned with the recommendation shape", () => {
    expect(HOOK_TECHNIQUES).toEqual(["question", "bold", "counter_intuitive", "story", "data"]);
  });
});
