import { describe, expect, it, vi } from "vitest";
import { QueueController } from "../../../src/modules/queue/queue.controller.js";

function buildController() {
  const queueService = {
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 2, failed: 1, completed: 3 }),
    isQueuePaused: vi.fn().mockResolvedValue(false),
    getFailedJobs: vi.fn().mockResolvedValue([{ id: "job-1", status: "failed" }]),
    pauseQueue: vi.fn().mockResolvedValue(undefined),
    resumeQueue: vi.fn().mockResolvedValue(undefined),
    retryAllFailed: vi.fn().mockResolvedValue(2),
    clearCompleted: vi.fn().mockResolvedValue(4),
  };
  const queueTriageService = {
    triageAll: vi.fn().mockResolvedValue([{ network: "X", examined: 1 }]),
    triageNetwork: vi.fn().mockResolvedValue({ network: "X", examined: 1 }),
  };
  return {
    controller: new QueueController(queueService as never, queueTriageService as never),
    queueService,
    queueTriageService,
  };
}

describe("QueueController", () => {
  it("returns per-network stats and dashboard aggregates", async () => {
    const { controller, queueService } = buildController();

    await expect(controller.getAllStats()).resolves.toEqual([
      { network: "X", waiting: 2, failed: 1, completed: 3, paused: false },
      { network: "THREADS", waiting: 2, failed: 1, completed: 3, paused: false },
      { network: "FACEBOOK", waiting: 2, failed: 1, completed: 3, paused: false },
    ]);

    const dashboard = await controller.getDashboard();
    expect(dashboard.networks).toHaveLength(3);
    expect(dashboard.summary).toEqual({ totalFailed: 3, totalWaiting: 6 });
    expect(new Date(dashboard.generatedAt).toString()).not.toBe("Invalid Date");
    expect(queueService.getFailedJobs).toHaveBeenCalledWith("X");
  });

  it("delegates network inspection and pause/resume controls", async () => {
    const { controller, queueService } = buildController();

    await expect(controller.getStats("X" as never)).resolves.toEqual({
      waiting: 2,
      failed: 1,
      completed: 3,
    });
    await expect(controller.getFailed("THREADS" as never)).resolves.toEqual([
      { id: "job-1", status: "failed" },
    ]);
    await expect(controller.isPaused("X" as never)).resolves.toEqual({ paused: false });
    await expect(controller.pause("X" as never)).resolves.toEqual({ paused: true, network: "X" });
    await expect(controller.resume("X" as never)).resolves.toEqual({
      paused: false,
      network: "X",
    });
    await expect(controller.retryFailed("X" as never)).resolves.toEqual({
      retried: 2,
      network: "X",
    });
    await expect(controller.clearCompleted("X" as never)).resolves.toEqual({
      cleared: 4,
      network: "X",
    });

    expect(queueService.pauseQueue).toHaveBeenCalledWith("X");
    expect(queueService.resumeQueue).toHaveBeenCalledWith("X");
    expect(queueService.retryAllFailed).toHaveBeenCalledWith("X");
    expect(queueService.clearCompleted).toHaveBeenCalledWith("X");
  });

  it("exposes triage actions for all networks and one network", async () => {
    const { controller, queueTriageService } = buildController();

    await expect(controller.triageAll()).resolves.toEqual({
      results: [{ network: "X", examined: 1 }],
    });
    await expect(controller.triageNetwork("THREADS" as never)).resolves.toEqual({
      network: "X",
      examined: 1,
    });
    expect(queueTriageService.triageAll).toHaveBeenCalledOnce();
    expect(queueTriageService.triageNetwork).toHaveBeenCalledWith("THREADS");
  });
});
