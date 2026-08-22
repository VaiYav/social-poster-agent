/**
 * Orchestrator prompt unit tests.
 *
 * Source: packages/backend/src/modules/orchestrator/prompts/orchestrator-prompt.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildOrchestratorUserPrompt } from "../../../src/modules/orchestrator/prompts/orchestrator-prompt.js";
import type { WorldState } from "../../../src/modules/orchestrator/types.js";

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    timestamp: 0,
    topicPool: { count: 0, threshold: 0, oldestAgeMs: 0 },
    drafts: { pending: 0, approved: 0, rejected: 0, approvedByNetwork: {} },
    queueDepth: {},
    sessions: {},
    rateLimits: {},
    now: 1_000_000,
    utcHour: 12,
    utcDayOfWeek: 0,
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
    health: { bans: 0, dlqDepth: 0, stuckPosting: 0, orphanedPosts: 0, killSwitch: false },
    trends: { lastRefreshMs: 0, count: 0 },
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

describe("buildOrchestratorUserPrompt", () => {
  const originalEnv = process.env.ENABLED_NETWORKS;

  beforeEach(() => {
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLED_NETWORKS;
    } else {
      process.env.ENABLED_NETWORKS = originalEnv;
    }
  });

  it("includes all enabled networks in queue depth and approved drafts", () => {
    const world = makeWorld({
      queueDepth: { X: 1, THREADS: 2, FACEBOOK: 3 },
      drafts: {
        approved: 6,
        pending: 0,
        rejected: 0,
        approvedByNetwork: { X: 1, THREADS: 2, FACEBOOK: 3 },
      },
    });
    const prompt = buildOrchestratorUserPrompt(world);
    expect(prompt).toContain("X=1, THREADS=2, FACEBOOK=3"); // queue
    expect(prompt).toContain("X=1, THREADS=2, FACEBOOK=3"); // approved
  });

  it("uses world.now for age calculations, not Date.now", () => {
    const now = 100_000_000;
    const hourAgo = 60 * 60 * 1000;
    const world = makeWorld({
      now,
      rateLimits: {
        X: {
          dailyRemaining: 10,
          weeklyRemaining: 50,
          dailyLimit: 10,
          weeklyLimit: 50,
          minIntervalMs: 0,
          lastPostMs: now - hourAgo,
        },
        THREADS: {
          dailyRemaining: 10,
          weeklyRemaining: 50,
          dailyLimit: 10,
          weeklyLimit: 50,
          minIntervalMs: 0,
          lastPostMs: 0,
        },
      },
    });
    const prompt = buildOrchestratorUserPrompt(world);
    expect(prompt).toContain("Last post: X=1h ago");
  });
});
