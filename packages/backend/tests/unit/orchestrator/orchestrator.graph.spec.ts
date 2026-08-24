import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import {
  buildOrchestratorGraph,
  createInitialOrchestratorState,
  type OrchestratorGraphDeps,
} from "../../../src/modules/orchestrator/orchestrator.graph.js";
import type { Action, WorldState } from "../../../src/modules/orchestrator/types.js";

function world(overrides: Partial<WorldState> = {}): WorldState {
  return {
    timestamp: 1,
    topicPool: { count: 5, threshold: 1, oldestAgeMs: 0 },
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
    ...overrides,
  };
}

function makeDeps(action: Action, overrides: Partial<OrchestratorGraphDeps> = {}) {
  const observed = world();
  const stateCollector = {
    collectWorldState: vi.fn().mockResolvedValue(observed),
  };
  const decisionEngine = { decide: vi.fn().mockResolvedValue(action) };
  const actionExecutor = {
    execute: vi.fn().mockResolvedValue({ success: true, type: action.type, duration: 4 }),
  };
  const deps: OrchestratorGraphDeps = {
    stateCollector: stateCollector as never,
    decisionEngine: decisionEngine as never,
    actionExecutor: actionExecutor as never,
    writeHeartbeat: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    isStopped: vi.fn().mockReturnValue(false),
    onCycleEnd: vi.fn(),
    onEngagementCheck: vi.fn(),
    timeoutConfig: { f1BrowsingSessionMinutes: 15, orchestratorGenerateTimeoutMs: 120_000 },
    ...overrides,
  };
  return { deps, observed, stateCollector, decisionEngine, actionExecutor };
}

describe("OrchestratorGraph", () => {
  it("runs one observe-decide-execute-evaluate cycle and returns state", async () => {
    const action: Action = {
      type: "POST",
      network: SocialNetwork.X,
      reason: "approved draft",
      source: "rules_fallback",
    };
    const { deps, observed, stateCollector, decisionEngine, actionExecutor } = makeDeps(action);
    const result = await buildOrchestratorGraph(deps)
      .compile()
      .invoke(createInitialOrchestratorState(), { configurable: { thread_id: "test" } });

    expect(stateCollector.collectWorldState).toHaveBeenCalledOnce();
    expect(decisionEngine.decide).toHaveBeenCalledWith(observed, expect.any(AbortSignal));
    expect(actionExecutor.execute).toHaveBeenCalledWith(action, {
      signal: expect.any(AbortSignal),
    });
    expect(deps.writeHeartbeat).toHaveBeenCalledTimes(2);
    expect(deps.onEngagementCheck).toHaveBeenCalledWith(observed);
    expect(deps.onCycleEnd).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ success: true }),
      60_000,
    );
    expect(result.cycle).toBe(1);
    expect(result.result).toMatchObject({ success: true, type: "POST" });
  });

  it("does not execute WAIT and respects its requested sleep duration", async () => {
    const action: Action = {
      type: "WAIT",
      reason: "idle",
      source: "rules_fallback",
      params: { sleepMs: 7_000 },
    };
    const { deps, actionExecutor } = makeDeps(action);

    const result = await buildOrchestratorGraph(deps)
      .compile()
      .invoke(createInitialOrchestratorState(), { configurable: { thread_id: "wait" } });

    expect(actionExecutor.execute).not.toHaveBeenCalled();
    expect(deps.writeHeartbeat).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledWith(7_000);
    expect(result.result).toEqual({ success: true, type: "WAIT", duration: 0 });
  });

  it("returns a bounded error result when an action times out", async () => {
    const action: Action = {
      type: "GENERATE_POSTS",
      network: SocialNetwork.X,
      reason: "generate",
      source: "rules_fallback",
    };
    const pending = new Promise<never>(() => undefined);
    const { deps } = makeDeps(action, {
      actionExecutor: { execute: vi.fn().mockReturnValue(pending) } as never,
      timeoutConfig: { f1BrowsingSessionMinutes: 1, orchestratorGenerateTimeoutMs: 1 },
    });

    const result = await buildOrchestratorGraph(deps)
      .compile()
      .invoke(createInitialOrchestratorState(), { configurable: { thread_id: "timeout" } });

    expect(result.result).toMatchObject({
      success: false,
      type: "GENERATE_POSTS",
      error: "Action GENERATE_POSTS timed out after 1ms",
    });
    expect(result.errors).toHaveLength(1);
    expect(deps.sleep).toHaveBeenCalledWith(60_000);
  });

  it("uses the hard-rule WAIT action when observe returns no world", async () => {
    const action: Action = {
      type: "WAIT",
      reason: "unused",
      source: "rules_fallback",
    };
    const { deps, decisionEngine } = makeDeps(action, {
      stateCollector: { collectWorldState: vi.fn().mockResolvedValue(null) } as never,
    });

    const result = await buildOrchestratorGraph(deps)
      .compile()
      .invoke(createInitialOrchestratorState(), { configurable: { thread_id: "no-world" } });

    expect(decisionEngine.decide).not.toHaveBeenCalled();
    expect(result.action).toMatchObject({ type: "WAIT", source: "hard_rule" });
    expect(result.result).toEqual({ success: true, type: "WAIT", duration: 0 });
  });
});
