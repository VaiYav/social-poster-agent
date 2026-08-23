import { describe, expect, it, vi } from "vitest";
import { OrchestratorController } from "../../../src/modules/orchestrator/orchestrator.controller.js";

function buildController(restartDelay = "0") {
  const orchestrator = {
    getStatus: vi.fn().mockResolvedValue({ running: false }),
    getHistory: vi.fn().mockResolvedValue([{ cycle: 1 }]),
    getWorldState: vi.fn().mockResolvedValue({ cycle: 1 }),
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    resetCheckpoint: vi.fn().mockResolvedValue(undefined),
  };
  const flowControl = {
    pauseAll: vi.fn().mockResolvedValue(undefined),
    resumeAll: vi.fn().mockResolvedValue(undefined),
  };
  const config = { get: vi.fn().mockReturnValue(restartDelay) };
  return {
    controller: new OrchestratorController(
      orchestrator as never,
      flowControl as never,
      config as never,
    ),
    orchestrator,
    flowControl,
  };
}

describe("OrchestratorController", () => {
  it("delegates status, world and bounded history queries", async () => {
    const { controller, orchestrator } = buildController();

    await expect(controller.getStatus()).resolves.toEqual({ running: false });
    await expect(controller.getWorldState()).resolves.toEqual({ cycle: 1 });
    await controller.getHistory("999");
    expect(orchestrator.getHistory).toHaveBeenCalledWith(200);
    await controller.getHistory("invalid");
    expect(orchestrator.getHistory).toHaveBeenLastCalledWith(50);
    await controller.getHistory("0");
    expect(orchestrator.getHistory).toHaveBeenLastCalledWith(1);
  });

  it("pauses and resumes all flows through flow control", async () => {
    const { controller, flowControl } = buildController();

    await expect(controller.pause()).resolves.toEqual({
      success: true,
      message: "All flows paused",
    });
    await expect(controller.resume()).resolves.toEqual({
      success: true,
      message: "All flows resumed",
    });
    expect(flowControl.pauseAll).toHaveBeenCalledWith("Manual pause via orchestrator API");
    expect(flowControl.resumeAll).toHaveBeenCalledOnce();
  });

  it("restarts and resets the orchestrator through lifecycle seams", async () => {
    const { controller, orchestrator } = buildController("0");

    await expect(controller.restart()).resolves.toEqual({
      success: true,
      message: "Orchestrator restarted",
    });
    await expect(controller.resetCheckpoint()).resolves.toEqual({
      success: true,
      message: "Checkpoint reset — next restart will begin fresh",
    });
    expect(orchestrator.stop).toHaveBeenCalledOnce();
    expect(orchestrator.start).toHaveBeenCalledOnce();
    expect(orchestrator.resetCheckpoint).toHaveBeenCalledOnce();
  });
});
