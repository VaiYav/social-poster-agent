import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { OrchestratorEvents } from "../../../src/events/enums/post-events.enum.js";
import { OrchestratorService } from "../../../src/modules/orchestrator/orchestrator.service.js";
import type { ActionResult, WorldState } from "../../../src/modules/orchestrator/types.js";

vi.mock("../../../src/modules/orchestrator/orchestrator.graph.js", () => ({
  buildOrchestratorGraph: vi.fn(() => ({
    compile: vi.fn(() => ({
      invoke: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { cycle: 1 };
      }),
    })),
  })),
  createInitialOrchestratorState: vi.fn(() => ({
    world: null,
    action: null,
    result: null,
    cycle: 0,
    sleepMs: 60_000,
    heartbeat: Date.now(),
    errors: [],
  })),
}));

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

function makeWorld(): WorldState {
  return {
    timestamp: 1,
    topicPool: { count: 1, threshold: 1, oldestAgeMs: 0 },
    drafts: { pending: 0, approved: 0, rejected: 0, approvedByNetwork: {} },
    queueDepth: {},
    sessions: {},
    rateLimits: {},
    accounts: { total: 0, byNetwork: {}, accounts: {} },
    now: 1,
    utcHour: 12,
    utcDayOfWeek: 1,
    postingWindows: {},
    inPostingWindow: {},
    performance: {},
    engagement: {
      lastBrowseMs: {},
      uncheckedReplies: 0,
      warmupPhase: {},
      lastSessionStatus: {},
      lastSessionInteractions: {},
      engagementDebt: 0,
      commentsTargetToday: 0,
      commentsActualToday: 0,
      likesTargetToday: 0,
      likesActualToday: 0,
      debt: 0,
    },
    health: {
      bans: 0,
      dlqDepth: 0,
      stuckPosting: 0,
      stuckBrowsingSessions: 0,
      orphanedPosts: 0,
      killSwitch: false,
    },
    trends: { lastRefreshMs: 1, count: 0 },
    flowControl: {
      pauseAll: false,
      pauseGeneration: false,
      pausePosting: false,
      pauseEngagement: false,
      pauseReplies: false,
      pauseLlmTriage: false,
      pauseAutoApprove: false,
    },
    _degraded: [],
    _collectedAt: 1,
  };
}

function buildService(configValues: Record<string, string> = {}) {
  const redis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  };
  const lock = {
    extend: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const lockService = {
    tryAcquire: vi.fn().mockResolvedValue(lock),
  };
  const stateCollector = {
    collectWorldState: vi.fn().mockResolvedValue(makeWorld()),
  };
  const decisionEngine = { decide: vi.fn() };
  const actionExecutor = { execute: vi.fn() };
  const historyService = {
    record: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([{ cycle: 1 }]),
  };
  const checkpointSaver = {
    deleteRunCheckpoints: vi.fn().mockResolvedValue(undefined),
    getTuple: vi.fn().mockResolvedValue(null),
  };
  const eventEmitter = { emit: vi.fn() };
  const service = new OrchestratorService(
    makeConfig(configValues),
    redis as never,
    stateCollector as never,
    decisionEngine as never,
    actionExecutor as never,
    historyService as never,
    lockService as never,
    checkpointSaver as never,
    eventEmitter as never,
    undefined,
  );
  return {
    service,
    redis,
    lock,
    lockService,
    stateCollector,
    historyService,
    checkpointSaver,
    eventEmitter,
  };
}

describe("OrchestratorService lifecycle and operational boundaries", () => {
  beforeEach(() => {
    vi.useRealTimers();
    process.env.ENABLED_NETWORKS = "X";
  });

  it("does not start the graph when the orchestrator feature is disabled", async () => {
    const { service } = buildService({ ORCHESTRATOR_ENABLED: "false" });
    const start = vi.spyOn(service, "start");

    await service.onModuleInit();

    expect(start).not.toHaveBeenCalled();
    expect(service.isRunning()).toBe(false);
  });

  it("stops cleanly when another instance owns the leader lease", async () => {
    const { service, lockService } = buildService({ ORCHESTRATOR_ENABLED: "true" });
    lockService.tryAcquire.mockResolvedValue(null);

    await expect(service.start()).resolves.toBeUndefined();

    expect(service.isRunning()).toBe(false);
    expect(lockService.tryAcquire).toHaveBeenCalledWith("spa:orchestrator:leader", 30_000);
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("acquires leadership, starts a graph loop, and releases the lease on stop", async () => {
    const { service, lock } = buildService({
      ORCHESTRATOR_ENABLED: "true",
      ORCHESTRATOR_LEADER_RENEW_INTERVAL_MS: "60000",
    });

    await service.start();
    expect(service.isRunning()).toBe(true);

    await service.stop();

    expect(lock.release).toHaveBeenCalledOnce();
    expect(service.isRunning()).toBe(false);
  });

  it("reports heartbeat and lifecycle state without throwing on Redis failure", async () => {
    const { service, redis } = buildService({ ORCHESTRATOR_ENABLED: "true" });
    const heartbeat = String(Date.now() - 1000);
    redis.get.mockResolvedValue(heartbeat);

    const status = await service.getStatus();
    expect(status).toMatchObject({ enabled: true, running: false, heartbeat: Number(heartbeat) });
    expect(status.heartbeatAgeMs).toBeGreaterThanOrEqual(0);

    redis.get.mockRejectedValue(new Error("redis unavailable"));
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: true,
      running: false,
      heartbeat: null,
      heartbeatAgeMs: null,
    });
  });

  it("delegates history, world state and checkpoint reset to their seams", async () => {
    const { service, historyService, stateCollector, checkpointSaver } = buildService();

    await expect(service.getHistory(7)).resolves.toEqual([{ cycle: 1 }]);
    await expect(service.getWorldState()).resolves.toEqual(
      expect.objectContaining({ timestamp: 1 }),
    );
    await service.resetCheckpoint();

    expect(historyService.getHistory).toHaveBeenCalledWith(7);
    expect(stateCollector.collectWorldState).toHaveBeenCalledOnce();
    expect(checkpointSaver.deleteRunCheckpoints).toHaveBeenCalledWith("orchestrator");
  });

  it("records cycle history and emits the typed cycle-end event", async () => {
    const { service, historyService, eventEmitter } = buildService();
    const result: ActionResult = { success: true, type: "POST", duration: 42 };

    (
      service as unknown as {
        onCycleEnd: (cycle: number, result: ActionResult, sleepMs: number) => void;
      }
    ).onCycleEnd(3, result, 60_000);
    await Promise.resolve();

    expect(historyService.record).toHaveBeenCalledWith(3, result, 60_000);
    expect(eventEmitter.emit).toHaveBeenCalledWith(OrchestratorEvents.CYCLE_END, {
      cycle: 3,
      action: "POST",
      success: true,
      duration: 42,
      sleepMs: 60_000,
    });
  });

  it("ignores checkpoint reset failures because reset is an operator convenience", async () => {
    const { service, checkpointSaver } = buildService();
    checkpointSaver.deleteRunCheckpoints.mockRejectedValue(new Error("checkpoint redis down"));

    await expect(service.resetCheckpoint()).resolves.toBeUndefined();
  });
});
