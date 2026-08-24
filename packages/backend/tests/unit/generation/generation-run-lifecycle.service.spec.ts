import { beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationRunStatus, GenerationTrigger } from "../../../src/generated/prisma/client.js";
import { GenerationRunLifecycleService } from "../../../src/modules/generation/generation-run-lifecycle.service.js";

describe("GenerationRunLifecycleService", () => {
  const prisma = {
    generationRun: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  };
  const sse = { publish: vi.fn().mockResolvedValue(undefined) };
  const checkpointSaver = { deleteRunCheckpoints: vi.fn().mockResolvedValue(undefined) };
  let service: GenerationRunLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.generationRun.create.mockResolvedValue({ id: "run-1" });
    prisma.generationRun.findUnique.mockResolvedValue({ id: "run-1", sourceTopics: ["Topic"] });
    service = new GenerationRunLifecycleService(
      prisma as never,
      sse as never,
      checkpointSaver as never,
    );
  });

  it("starts a run and publishes the initial progress event", async () => {
    const run = await service.start(GenerationTrigger.MANUAL, 2);

    expect(run).toEqual({ id: "run-1" });
    expect(prisma.generationRun.create).toHaveBeenCalledWith({
      data: { triggeredBy: GenerationTrigger.MANUAL, sourceTopics: [] },
    });
    expect(sse.publish).toHaveBeenCalledWith({
      type: "generation_started",
      runId: "run-1",
      count: 2,
    });
  });

  it("owns pause/resume state and keeps successful checkpoint cleanup local", async () => {
    const controller = service.register("run-1");
    const paused = await service.pause("run-1");

    expect(controller.signal.aborted).toBe(true);
    expect(paused).toEqual({ runId: "run-1", status: "paused" });
    expect(prisma.generationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: GenerationRunStatus.PAUSED }),
      }),
    );

    await service.prepareResume("run-1");
    await service.markCompleted("run-1", ["Topic"]);

    expect(sse.publish).toHaveBeenCalledWith({ type: "generation_resumed", runId: "run-1" });
    expect(checkpointSaver.deleteRunCheckpoints).toHaveBeenCalledWith("run-1");
  });
});
