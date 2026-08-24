import { describe, expect, it, vi } from "vitest";
import { RecyclingController } from "../../../src/modules/recycling/recycling.controller.js";

function buildController() {
  const service = {
    findRecyclablePosts: vi.fn().mockResolvedValue([]),
    getCronConfig: vi.fn().mockReturnValue({ enabled: false, schedule: "0 8 * * 1" }),
    runRecycling: vi.fn().mockResolvedValue({ recycled: 1, skipped: 0 }),
    recyclePost: vi.fn().mockResolvedValue({ id: "draft-1", status: "DRAFT" }),
  };
  return { controller: new RecyclingController(service as never), service };
}

describe("RecyclingController", () => {
  it("caps and defaults candidate limits before delegation", async () => {
    const { controller, service } = buildController();

    await controller.getCandidates();
    await controller.getCandidates("0");
    await controller.getCandidates("bad");
    await controller.getCandidates("100");

    expect(service.findRecyclablePosts).toHaveBeenNthCalledWith(1, 10);
    expect(service.findRecyclablePosts).toHaveBeenNthCalledWith(2, 10);
    expect(service.findRecyclablePosts).toHaveBeenNthCalledWith(3, 10);
    expect(service.findRecyclablePosts).toHaveBeenNthCalledWith(4, 50);
  });

  it("delegates config, capped run limits, and single-post recycle", async () => {
    const { controller, service } = buildController();

    expect(controller.getConfig()).toEqual({
      enabled: false,
      schedule: "0 8 * * 1",
    });
    await expect(controller.runRecycling()).resolves.toEqual({ recycled: 1, skipped: 0 });
    await controller.runRecycling("0");
    await controller.runRecycling("100");
    await expect(controller.recyclePost("post-1")).resolves.toEqual({
      id: "draft-1",
      status: "DRAFT",
    });

    expect(service.runRecycling).toHaveBeenNthCalledWith(1, 5);
    expect(service.runRecycling).toHaveBeenNthCalledWith(2, 5);
    expect(service.runRecycling).toHaveBeenNthCalledWith(3, 20);
    expect(service.recyclePost).toHaveBeenCalledWith("post-1");
  });
});
