/**
 * LlmDecisionService unit tests.
 *
 * Source: packages/backend/src/modules/orchestrator/llm-decision.service.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { LlmDecisionService } from "../../../src/modules/orchestrator/llm-decision.service.js";
import type { WorldState } from "../../../src/modules/orchestrator/types.js";

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    timestamp: 0,
    topicPool: { count: 0, threshold: 0, oldestAgeMs: 0 },
    drafts: { pending: 0, approved: 0, rejected: 0, approvedByNetwork: {} },
    queueDepth: {},
    sessions: {},
    rateLimits: {},
    now: 0,
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

describe("LlmDecisionService.parseLlmResponse (via decide)", () => {
  function buildService(responseContent: string) {
    const configService = { get: vi.fn((_k: string, d?: unknown) => d) };
    const llm = {
      generateChat: vi.fn().mockResolvedValue({ content: responseContent, model: "test" }),
    };
    return new LlmDecisionService(configService as never, llm as never, undefined, undefined);
  }

  it("parses a clean JSON POST action", async () => {
    const service = buildService('{"action":"POST","network":"X","reason":"post now"}');
    const action = await service.decide(makeWorld());
    expect(action.type).toBe("POST");
    expect(action.network).toBe(SocialNetwork.X);
    expect(action.reason).toBe("post now");
  });

  it("strips markdown code fences and parses JSON", async () => {
    const service = buildService(
      '```json\n{"action":"BROWSE","network":"THREADS","reason":"scroll"}\n```',
    );
    const action = await service.decide(makeWorld());
    expect(action.type).toBe("BROWSE");
    expect(action.network).toBe(SocialNetwork.THREADS);
  });

  it("handles pipe-separated networks and picks the first valid one", async () => {
    const service = buildService(
      '{"action":"POST","network":"FOOBAR|THREADS|X","reason":"fallback"}',
    );
    const action = await service.decide(makeWorld());
    expect(action.type).toBe("POST");
    expect(action.network).toBe(SocialNetwork.THREADS);
  });

  it("rejects unknown action type and throws", async () => {
    const service = buildService('{"action":"FLY_TO_THE_MOON","network":"X"}');
    await expect(service.decide(makeWorld())).rejects.toThrow(/Invalid action type/);
  });

  it("rejects network action without network and throws", async () => {
    const service = buildService('{"action":"POST","network":null,"reason":"missing"}');
    await expect(service.decide(makeWorld())).rejects.toThrow(/requires a network/);
  });

  it("preserves optional params from the LLM response", async () => {
    const service = buildService('{"action":"WAIT","reason":"idle","params":{"sleepMs":300000}}');
    const action = await service.decide(makeWorld());
    expect(action.type).toBe("WAIT");
    expect(action.params).toEqual({ sleepMs: 300000 });
  });
});
