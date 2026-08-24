import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { RulesEngine } from "../../../src/modules/orchestrator/rules-engine.js";
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
    now: Date.now(),
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

function buildSelector(overrides: Record<string, unknown> = {}) {
  return {
    selectBestReadyNetwork: vi.fn().mockReturnValue(SocialNetwork.X),
    selectBestGenerationNetwork: vi.fn().mockReturnValue(SocialNetwork.THREADS),
    selectBestEngagementNetwork: vi.fn().mockReturnValue(SocialNetwork.X),
    ...overrides,
  } as never;
}

describe("RulesEngine — deterministic orchestrator fallback", () => {
  it("prioritizes low topic inventory", () => {
    const engine = new RulesEngine(
      buildSelector({ selectBestGenerationNetwork: vi.fn().mockReturnValue(null) }),
    );
    const action = engine.decide(
      makeWorld({ topicPool: { count: 0, threshold: 1, oldestAgeMs: 0 } }),
    );
    expect(action).toMatchObject({ type: "GENERATE_TOPICS", source: "rules_fallback" });
  });

  it("posts approved drafts on the best ready network", () => {
    const engine = new RulesEngine(
      buildSelector({ selectBestGenerationNetwork: vi.fn().mockReturnValue(null) }),
    );
    const action = engine.decide(
      makeWorld({ drafts: { pending: 0, approved: 2, rejected: 0, approvedByNetwork: { X: 2 } } }),
    );
    expect(action).toMatchObject({ type: "POST", network: SocialNetwork.X });
  });

  it("generates on a healthy alternative when approved drafts have no ready network", () => {
    const engine = new RulesEngine(
      buildSelector({ selectBestReadyNetwork: vi.fn().mockReturnValue(null) }),
    );
    const action = engine.decide(
      makeWorld({ drafts: { pending: 0, approved: 1, rejected: 0, approvedByNetwork: { X: 1 } } }),
    );
    expect(action).toMatchObject({ type: "GENERATE_POSTS", network: SocialNetwork.THREADS });
  });

  it("browses when engagement debt is present and no post work is pending", () => {
    const engine = new RulesEngine(
      buildSelector({ selectBestGenerationNetwork: vi.fn().mockReturnValue(null) }),
    );
    const action = engine.decide(
      makeWorld({ engagement: { ...makeWorld().engagement, engagementDebt: 2 } }),
    );
    expect(action).toMatchObject({ type: "BROWSE", network: SocialNetwork.X });
  });

  it("handles replies before generation when replies are unchecked", () => {
    const engine = new RulesEngine(
      buildSelector({ selectBestGenerationNetwork: vi.fn().mockReturnValue(null) }),
    );
    const action = engine.decide(
      makeWorld({ engagement: { ...makeWorld().engagement, uncheckedReplies: 3 } }),
    );
    expect(action.type).toBe("CHECK_REPLIES");
  });

  it("triages a non-empty DLQ before lower-priority maintenance", () => {
    const engine = new RulesEngine(
      buildSelector({ selectBestGenerationNetwork: vi.fn().mockReturnValue(null) }),
    );
    const action = engine.decide(makeWorld({ health: { ...makeWorld().health, dlqDepth: 1 } }));
    expect(action.type).toBe("TRIAGE_QUEUE");
  });

  it("refreshes stale trends", () => {
    const engine = new RulesEngine(
      buildSelector({ selectBestGenerationNetwork: vi.fn().mockReturnValue(null) }),
    );
    const action = engine.decide(
      makeWorld({ trends: { lastRefreshMs: Date.now() - 3 * 60 * 60 * 1000, count: 1 } }),
    );
    expect(action.type).toBe("REFRESH_TRENDS");
  });

  it("returns an idle WAIT action when no rule matches", () => {
    const engine = new RulesEngine(
      buildSelector({
        selectBestReadyNetwork: vi.fn().mockReturnValue(null),
        selectBestGenerationNetwork: vi.fn().mockReturnValue(null),
        selectBestEngagementNetwork: vi.fn().mockReturnValue(null),
      }),
    );
    const action = engine.decide(makeWorld());
    expect(action).toMatchObject({ type: "WAIT", source: "rules_fallback" });
  });
});
