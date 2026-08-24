import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { DecisionEngineService } from "../../../src/modules/orchestrator/decision-engine.service.js";
import type { Action, WorldState } from "../../../src/modules/orchestrator/types.js";

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    timestamp: 1_000_000,
    topicPool: { count: 5, threshold: 1, oldestAgeMs: 0 },
    drafts: { pending: 0, approved: 0, rejected: 0, approvedByNetwork: {} },
    queueDepth: {},
    sessions: {},
    rateLimits: {},
    accounts: { total: 0, byNetwork: {}, accounts: {} },
    now: 1_000_000,
    utcHour: 12,
    utcDayOfWeek: 2,
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
    trends: { lastRefreshMs: Date.now(), count: 1 },
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
    _collectedAt: 1_000_000,
    ...overrides,
  };
}

function config(values: Record<string, string | number> = {}): ConfigService {
  return {
    get: vi.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

function makeRedis() {
  return {
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcount: vi.fn().mockResolvedValue(0),
    zadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
}

function buildService(options: {
  config?: ConfigService;
  redis?: ReturnType<typeof makeRedis>;
  hardRuleAction?: Action | null;
  llmAction?: Action;
  llmError?: Error;
  guardedAction?: Action;
  rulesAction?: Action;
  postingWindowError?: boolean;
}) {
  const redis = options.redis ?? makeRedis();
  const hardRules = {
    check: vi.fn().mockResolvedValue(options.hardRuleAction ?? null),
  };
  const llmDecision = {
    decide: options.llmError
      ? vi.fn().mockRejectedValue(options.llmError)
      : vi.fn().mockResolvedValue(
          options.llmAction ?? {
            type: "POST",
            network: SocialNetwork.X,
            reason: "llm choice",
            source: "llm",
          },
        ),
  };
  const guardrails = {
    apply: vi.fn((action: Action) => options.guardedAction ?? action),
  };
  const rulesEngine = {
    decide: vi.fn().mockReturnValue(
      options.rulesAction ?? {
        type: "WAIT",
        reason: "rules fallback",
        source: "rules_fallback",
        params: { sleepMs: 120_000 },
      },
    ),
  };
  const postingWindowService = {
    getRecommendation: options.postingWindowError
      ? vi.fn().mockRejectedValue(new Error("window unavailable"))
      : vi.fn().mockResolvedValue({ bestHours: [12], inWindow: true, confidence: "high" }),
  };

  return {
    service: new DecisionEngineService(
      options.config ?? config({ ENABLED_NETWORKS: "X" }),
      redis as never,
      postingWindowService as never,
      hardRules as never,
      llmDecision as never,
      guardrails as never,
      rulesEngine as never,
    ),
    redis,
    hardRules,
    llmDecision,
    guardrails,
    rulesEngine,
    postingWindowService,
  };
}

describe("DecisionEngineService — orchestrator safety pipeline", () => {
  beforeEach(() => {
    process.env.ENABLED_NETWORKS = "X";
  });

  it("short-circuits on a hard-rule action after enriching posting windows", async () => {
    const hardRuleAction: Action = {
      type: "RECOVER_SESSION",
      network: SocialNetwork.X,
      reason: "session expired",
      source: "hard_rule",
    };
    const { service, hardRules, llmDecision, postingWindowService } = buildService({
      hardRuleAction,
    });
    const world = makeWorld();

    const result = await service.decide(world);

    expect(result).toEqual(hardRuleAction);
    expect(world.postingWindows.X).toEqual({ bestHours: [12], inWindow: true, confidence: "high" });
    expect(world.inPostingWindow.X).toBe(true);
    expect(postingWindowService.getRecommendation).toHaveBeenCalledWith("X");
    expect(hardRules.check).toHaveBeenCalledWith(world);
    expect(llmDecision.decide).not.toHaveBeenCalled();
  });

  it("uses the LLM action, applies guardrails, and records the final non-WAIT action", async () => {
    const llmAction: Action = {
      type: "BROWSE",
      network: SocialNetwork.X,
      reason: "browse now",
      source: "llm",
    };
    const guardedAction: Action = {
      type: "POST",
      network: SocialNetwork.X,
      reason: "approved draft",
      source: "guardrail_override",
    };
    const { service, redis, guardrails } = buildService({ llmAction, guardedAction });

    const result = await service.decide(makeWorld());

    expect(result).toEqual(guardedAction);
    expect(guardrails.apply).toHaveBeenCalledWith(llmAction, expect.any(Object));
    expect(redis.zadd).toHaveBeenCalledWith(
      "spa:orchestrator:action-history",
      expect.any(String),
      expect.stringContaining("POST:X"),
    );
    expect(redis.expire).toHaveBeenCalledWith("spa:orchestrator:action-history", 3600);
  });

  it("falls back to deterministic rules when the LLM decision fails", async () => {
    const rulesAction: Action = {
      type: "GENERATE_TOPICS",
      reason: "topic pool is low",
      source: "rules_fallback",
    };
    const { service, llmDecision, rulesEngine } = buildService({
      llmError: new Error("provider timeout"),
      rulesAction,
    });

    await expect(service.decide(makeWorld())).resolves.toEqual(rulesAction);
    expect(llmDecision.decide).toHaveBeenCalledOnce();
    expect(rulesEngine.decide).toHaveBeenCalledOnce();
  });

  it("uses rules fallback when full-loop LLM budget is exhausted", async () => {
    const redis = makeRedis();
    redis.zcount.mockImplementation((key: string) =>
      Promise.resolve(key.includes("llm-decision") ? 1 : 0),
    );
    const rulesAction: Action = {
      type: "WAIT",
      reason: "budget fallback",
      source: "rules_fallback",
      params: { sleepMs: 120_000 },
    };
    const { service, llmDecision, rulesEngine } = buildService({
      redis,
      config: config({ LLM_FULL_LOOP_ENABLED: "true", LLM_FULL_LOOP_MAX_DECISIONS_PER_HOUR: 1 }),
      rulesAction,
    });

    await expect(service.decide(makeWorld())).resolves.toEqual(rulesAction);
    expect(llmDecision.decide).not.toHaveBeenCalled();
    expect(rulesEngine.decide).toHaveBeenCalledOnce();
  });

  it("overrides a non-WAIT action when the hourly action budget is exhausted", async () => {
    const redis = makeRedis();
    redis.zcount.mockResolvedValue(60);
    const { service } = buildService({
      redis,
      config: config({ ORCHESTRATOR_MAX_ACTIONS_PER_HOUR: 60 }),
    });

    const result = await service.decide(makeWorld());

    expect(result.type).toBe("WAIT");
    expect(result.source).toBe("guardrail_override");
    expect(result.reason).toContain("Hourly action budget exhausted");
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it("fails open only for observability when Redis history is unavailable", async () => {
    const redis = makeRedis();
    redis.zremrangebyscore.mockRejectedValue(new Error("redis down"));
    redis.zadd.mockRejectedValue(new Error("redis down"));
    redis.expire.mockRejectedValue(new Error("redis down"));
    const { service } = buildService({ redis });

    await expect(service.getActionsThisHour()).resolves.toBe(0);
    await expect(
      service.recordAction({
        type: "POST",
        network: SocialNetwork.X,
        reason: "test",
        source: "rules_fallback",
      }),
    ).resolves.toBeUndefined();
  });

  it("marks a failed posting-window probe as degraded instead of aborting a decision", async () => {
    const { service, hardRules } = buildService({ postingWindowError: true });
    const world = makeWorld();

    await service.decide(world);

    expect(world.postingWindows.X).toBeNull();
    expect(world.inPostingWindow.X).toBe(false);
    expect(hardRules.check).toHaveBeenCalledWith(world);
  });
});
