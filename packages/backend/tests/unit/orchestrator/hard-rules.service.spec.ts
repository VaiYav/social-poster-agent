import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStatus, SocialNetwork } from "../../../src/generated/prisma/client.js";
import { HardRulesService } from "../../../src/modules/orchestrator/hard-rules.service.js";
import type { WorldState } from "../../../src/modules/orchestrator/types.js";

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    timestamp: 0,
    topicPool: { count: 5, threshold: 1, oldestAgeMs: 0 },
    drafts: { pending: 0, approved: 0, rejected: 0, approvedByNetwork: {} },
    queueDepth: {},
    sessions: {},
    rateLimits: {},
    accounts: { total: 0, byNetwork: {}, accounts: {} },
    now: 0,
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
    _collectedAt: 0,
    ...overrides,
  };
}

function buildService(ttl = 0) {
  const redis = {
    pttl: vi.fn().mockResolvedValue(ttl),
    set: vi.fn().mockResolvedValue("OK"),
  };
  return { service: new HardRulesService(redis as never), redis };
}

describe("HardRulesService — H1-H10 deterministic safety gates", () => {
  beforeEach(() => {
    process.env.ENABLED_NETWORKS = "X,THREADS";
  });

  it("H1 stops all work under the kill switch", async () => {
    const { service } = buildService();
    const result = await service.check(
      makeWorld({ flowControl: { ...makeWorld().flowControl, pauseAll: true } }),
    );
    expect(result).toMatchObject({ type: "WAIT", reason: "Kill switch active" });
  });

  it("H2 recovers the first expired session and sets a cooldown", async () => {
    const { service, redis } = buildService();
    const result = await service.check(
      makeWorld({
        sessions: {
          X: { status: SessionStatus.EXPIRED, lastCheckMs: 0, circuitBreaker: "closed" },
        },
      }),
    );
    expect(result).toMatchObject({ type: "RECOVER_SESSION", network: SocialNetwork.X });
    expect(redis.set).toHaveBeenCalledWith(
      "spa:orchestrator:recover-cooldown:X",
      "1",
      "PX",
      300_000,
    );
  });

  it("H2 waits while recovery cooldown is active", async () => {
    const { service } = buildService(12_345);
    const result = await service.check(
      makeWorld({
        sessions: { X: { status: SessionStatus.ERROR, lastCheckMs: 0, circuitBreaker: "closed" } },
      }),
    );
    expect(result).toMatchObject({ type: "WAIT", reason: expect.stringContaining("12s left") });
  });

  it("H4 waits only when every enabled network circuit is open", async () => {
    const { service } = buildService();
    const allOpen = await service.check(
      makeWorld({
        sessions: {
          X: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: "open" },
          THREADS: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: "open" },
        },
      }),
    );
    expect(allOpen).toMatchObject({
      type: "WAIT",
      reason: expect.stringContaining("all networks"),
    });

    const oneOpen = await service.check(
      makeWorld({
        sessions: {
          X: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: "open" },
          THREADS: { status: SessionStatus.ACTIVE, lastCheckMs: 0, circuitBreaker: "closed" },
        },
      }),
    );
    expect(oneOpen).toBeNull();
  });

  it("H5 and H6 stop when all finite daily or weekly limits are exhausted", async () => {
    const daily = {
      dailyRemaining: 0,
      weeklyRemaining: 10,
      dailyLimit: 10,
      weeklyLimit: 20,
      minIntervalMs: 0,
      lastPostMs: 0,
    };
    const { service } = buildService();
    await expect(
      service.check(makeWorld({ rateLimits: { X: daily, THREADS: daily } })),
    ).resolves.toMatchObject({
      type: "WAIT",
      reason: "Daily rate limit exhausted for all networks",
    });

    const weekly = {
      dailyRemaining: 10,
      weeklyRemaining: 0,
      dailyLimit: 10,
      weeklyLimit: 20,
      minIntervalMs: 0,
      lastPostMs: 0,
    };
    await expect(
      service.check(makeWorld({ rateLimits: { X: weekly, THREADS: weekly } })),
    ).resolves.toMatchObject({
      type: "WAIT",
      reason: "Weekly rate limit exhausted for all networks",
    });
  });

  it("H7/H8 reconcile operational backlogs before lower-priority decisions", async () => {
    const { service } = buildService();
    await expect(
      service.check(makeWorld({ health: { ...makeWorld().health, dlqDepth: 11 } })),
    ).resolves.toMatchObject({ type: "HEALTH_CHECK" });
    await expect(
      service.check(makeWorld({ health: { ...makeWorld().health, stuckPosting: 6 } })),
    ).resolves.toMatchObject({ type: "RECONCILE" });
    await expect(
      service.check(makeWorld({ health: { ...makeWorld().health, stuckBrowsingSessions: 1 } })),
    ).resolves.toMatchObject({ type: "RECONCILE" });
  });

  it("H9 waits when every network is banned but preserves healthy-network routing", async () => {
    const { service } = buildService();
    await expect(
      service.check(makeWorld({ health: { ...makeWorld().health, bans: 2 } })),
    ).resolves.toMatchObject({ type: "WAIT", reason: "2 ban(s) detected" });
    await expect(
      service.check(makeWorld({ health: { ...makeWorld().health, bans: 1 } })),
    ).resolves.toBeNull();
  });

  it("H10 waits when one queue exceeds the hard backstop", async () => {
    const { service } = buildService();
    await expect(service.check(makeWorld({ queueDepth: { X: 6 } }))).resolves.toMatchObject({
      type: "WAIT",
      reason: "Queue depth for X > 5 (6)",
    });
  });

  it("returns null when no deterministic safety rule matches", async () => {
    const { service } = buildService();
    await expect(service.check(makeWorld())).resolves.toBeNull();
  });

  it("treats Redis cooldown failures as non-critical", async () => {
    const { service, redis } = buildService();
    redis.pttl.mockRejectedValue(new Error("redis down"));
    const result = await service.check(
      makeWorld({
        sessions: {
          X: { status: SessionStatus.EXPIRED, lastCheckMs: 0, circuitBreaker: "closed" },
        },
      }),
    );
    expect(result).toMatchObject({ type: "RECOVER_SESSION", network: SocialNetwork.X });
  });
});
