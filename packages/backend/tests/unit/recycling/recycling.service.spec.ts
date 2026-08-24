/**
 * RC2/RC3: RecyclingService.
 *
 * RC3 — recyclePost must re-write content through the generation graph (delegate to
 *        GenerationService.recycleById), never create a verbatim copy of the original.
 * RC2 — the recycling cron is flag-gated (RECYCLING_CRON_ENABLED), default OFF.
 *
 * Source: packages/backend/src/modules/recycling/recycling.service.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RecyclingService } from "../../../src/modules/recycling/recycling.service.js";
import { createMockConfigService } from "../../mocks/index.js";
import { simhash } from "../../../src/modules/generation/simhash.js";

function mockPrisma() {
  return {
    post: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function mockGeneration() {
  return {
    recycleById: vi.fn().mockResolvedValue({ id: "draft-1", status: "DRAFT" }),
    recycleTopPosts: vi.fn().mockResolvedValue("run-1"),
  };
}

describe("RecyclingService (RC2/RC3)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gen: any;
  let service: RecyclingService;

  beforeEach(() => {
    prisma = mockPrisma();
    gen = mockGeneration();
    const config = createMockConfigService();
    const schedulerRegistry = {
      addCronJob: vi.fn(),
      deleteCronJob: vi.fn(),
    } as unknown as import("@nestjs/schedule").SchedulerRegistry;
    service = new RecyclingService(config, prisma, gen, schedulerRegistry);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("RC3: recyclePost re-writes via the generation graph (delegates to recycleById)", async () => {
    const result = await service.recyclePost("post-1");

    expect(gen.recycleById).toHaveBeenCalledWith("post-1");
    expect(result).toEqual({ id: "draft-1", status: "DRAFT" });
    // The old verbatim path is gone — RecyclingService no longer creates a draft directly.
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("RC3: recyclePost propagates a null (ineligible post) from recycleById", async () => {
    gen.recycleById.mockResolvedValue(null);
    expect(await service.recyclePost("missing")).toBeNull();
  });

  it("RC2: runRecycling can be called directly (cron registration is in onModuleInit)", async () => {
    const spy = vi.spyOn(service, "runRecycling");
    await service.runRecycling();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("selects old posted candidates and filters exact recent duplicates", async () => {
    const candidates = [
      {
        id: "old-1",
        network: "X",
        content: "A timeless post",
        postedAt: new Date("2026-07-01T00:00:00.000Z"),
        accountId: "acc-1",
        sourceRef: null,
      },
      {
        id: "old-2",
        network: "X",
        content: "A distinct post",
        postedAt: new Date("2026-07-02T00:00:00.000Z"),
        accountId: "acc-1",
        sourceRef: null,
      },
    ];
    prisma.post.findMany
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce([{ content: "A timeless post", simhash: simhash("A timeless post") }]);

    await expect(service.findRecyclablePosts(1)).resolves.toEqual([candidates[1]]);
    expect(prisma.post.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ status: "POSTED", postedAt: expect.any(Object) }),
        take: 2,
      }),
    );
    expect(prisma.post.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ take: 100, select: { content: true, simhash: true } }),
    );
  });

  it("counts successful, ineligible, and failed candidates without aborting the batch", async () => {
    vi.spyOn(service, "findRecyclablePosts").mockResolvedValue([
      { id: "p-1", network: "X", content: "one", postedAt: null },
      { id: "p-2", network: "X", content: "two", postedAt: null },
      { id: "p-3", network: "X", content: "three", postedAt: null },
    ]);
    gen.recycleById
      .mockResolvedValueOnce({ id: "draft-1", status: "DRAFT" })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("generation unavailable"));

    await expect(service.runRecycling(3)).resolves.toEqual({ recycled: 1, skipped: 2 });
    expect(gen.recycleById).toHaveBeenCalledTimes(3);
  });

  it("exposes configurable cron state and registers only when explicitly enabled", () => {
    const scheduler = { addCronJob: vi.fn(), deleteCronJob: vi.fn() };
    const enabledConfig = createMockConfigService({
      RECYCLING_CRON_ENABLED: "true",
      RECYCLING_CRON_SCHEDULE: "0 6 * * *",
    });
    const enabled = new RecyclingService(enabledConfig, prisma, gen, scheduler as never);
    expect(enabled.getCronConfig()).toEqual({ enabled: true, schedule: "0 6 * * *" });

    vi.stubEnv("ORCHESTRATOR_ENABLED", "true");
    enabled.onModuleInit();
    expect(scheduler.addCronJob).not.toHaveBeenCalled();

    vi.stubEnv("ORCHESTRATOR_ENABLED", "false");
    enabled.onModuleInit();
    expect(scheduler.addCronJob).toHaveBeenCalledWith(
      "recycling",
      expect.objectContaining({ start: expect.any(Function) }),
    );

    const disabled = new RecyclingService(
      createMockConfigService({ RECYCLING_CRON_ENABLED: "false" }),
      prisma,
      gen,
      scheduler as never,
    );
    disabled.onModuleInit();
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
  });
});
