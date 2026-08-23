/**
 * HumanBehaviorEngine unit tests.
 *
 * Tests the LLM-driven engagement behavior loop: decision execution,
 * interaction recording, budget enforcement, and human-like timing.
 *
 * Source: packages/backend/src/modules/engagement/human-behavior-engine.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HumanBehaviorEngine,
  type BehaviorEngineConfig,
} from "../../../src/modules/engagement/human-behavior-engine.js";
import type {
  IEngagementDecisionPort,
  ActionDecision,
  PostContext,
} from "../../../src/domain/ports/engagement-decision.port.js";
import type { IBrowserPort } from "../../../src/domain/ports/browser.port.js";
import type { SocialNetwork } from "../../../src/generated/prisma/client.js";
import type { BaseEngager } from "../../../src/modules/engagement/engagers/base.engager.js";
import {
  createMockBrowserPort,
  createMockSseService,
  createMockRateLimitService,
  createMockPage,
} from "../../mocks/index.js";
import { EngagementCandidateScorer } from "../../../src/modules/engagement/engagement-candidate-scorer.js";

// ── Mock Decision Port ──

function createMockDecisionPort(decision: Partial<ActionDecision> = {}): IEngagementDecisionPort {
  return {
    decideAction: vi.fn().mockResolvedValue({
      action: "scroll",
      reason: "test",
      confidence: 0.5,
      ...decision,
    } as ActionDecision),
    generateComment: vi.fn().mockResolvedValue("Test comment in brand voice."),
    generateQuoteText: vi.fn().mockResolvedValue("Test quote text in brand voice."),
  };
}

// ── Mock Engager ──

function createMockEngager(overrides: Partial<BaseEngager> = {}): BaseEngager {
  return {
    like: vi.fn().mockResolvedValue({ success: true }),
    comment: vi.fn().mockResolvedValue({ success: true }),
    follow: vi.fn().mockResolvedValue({ success: true }),
    reply: vi.fn().mockResolvedValue({ success: true }),
    repost: vi.fn().mockResolvedValue({ success: true }),
    quote: vi.fn().mockResolvedValue({ success: true }),
    scrollFeed: vi.fn().mockResolvedValue([]),
    scrollUrl: vi.fn().mockResolvedValue([]),
    extractPostText: vi.fn().mockResolvedValue({
      text: "Remote Work in Q1 brings energy today.",
      hasMedia: false,
      authorHandle: "analyst",
    }),
    openCommentsThread: vi.fn().mockResolvedValue(3),
    navigateBack: vi.fn().mockResolvedValue(undefined),
    visitProfile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as BaseEngager;
}

// ── Mock Prisma ──

const mockPrisma = {
  interaction: {
    create: vi.fn().mockResolvedValue({ id: "interaction-1" }),
    update: vi.fn().mockResolvedValue({}),
  },
};

describe("HumanBehaviorEngine", () => {
  let engine: HumanBehaviorEngine;
  let browser: IBrowserPort;
  let decisionPort: IEngagementDecisionPort;
  let engager: BaseEngager;

  const config: BehaviorEngineConfig = {
    network: "X" as SocialNetwork,
    accountId: "account-1",
    browsingSessionId: "session-1",
    source: "home-feed" as const,
    likesMaxPerSession: 15,
    commentsMaxPerSession: 4,
    maxPosts: 5,
    durationSec: 60,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    browser = createMockBrowserPort();
    decisionPort = createMockDecisionPort();
    engager = createMockEngager();
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );
  });

  // ── processPosts ──

  it("HB-001: processes all posts up to maxPosts limit", async () => {
    const postUrls = ["url1", "url2", "url3", "url4", "url5", "url6", "url7"];
    const page = createMockPage();
    const results = await engine.processPosts(page, postUrls, engager, config);

    // maxPosts is 5, so only 5 should be processed
    expect(results.length).toBe(5);
    expect(decisionPort.decideAction).toHaveBeenCalledTimes(5);
  });

  it("HB-002: asks LLM for decision on each post", async () => {
    const postUrls = ["url1", "url2"];
    const page = createMockPage();
    await engine.processPosts(page, postUrls, engager, config);

    expect(decisionPort.decideAction).toHaveBeenCalledTimes(2);
  });

  it("ENGAGE-101: terminal SKIP candidate never reaches LLM decision", async () => {
    const scorer = { score: vi.fn().mockReturnValue({ decision: "SKIP", reasons: ["duplicate"] }) };
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
      undefined,
      scorer as unknown as EngagementCandidateScorer,
    );

    const results = await engine.processPosts(createMockPage(), ["url1"], engager, config);

    expect(decisionPort.decideAction).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: true, decision: { action: "skip" } });
  });

  it("ENGAGE-102: HUMAN_APPROVAL_REQUIRED reply is persisted as a suggestion, not executed", async () => {
    const authorizer = {
      authorize: vi.fn().mockResolvedValue({
        allowedMode: "HUMAN_APPROVAL_REQUIRED",
        policyHash: "policy-hash",
        policyVersionIds: ["policy-1"],
        blockReasons: [],
        requirements: [],
        reputationState: "HEALTHY",
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      }),
      reauthorize: vi.fn(),
    };
    const suggestions = { create: vi.fn().mockResolvedValue({ id: "suggestion-1" }) };
    const authorContext = {
      resolve: vi.fn().mockResolvedValue({
        accountId: config.accountId,
        network: config.network,
        personaId: "persona-1",
        personaRevisionId: "revision-1",
        voiceMode: "pattern_breakdown",
        experimentAssignmentId: null,
        profile: null,
        disclosure: "AI-assisted",
        safetyPolicyVersion: "policy-v1",
        source: "PERSONA",
      }),
    };
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
      authorizer,
      undefined,
      suggestions as never,
      authorContext as never,
    );

    const result = await (engine as any).createSuggestionIfRequired(
      {
        action: "comment",
        reason: "specific invitation",
        confidence: 0.9,
        commentText: "A bounded reply",
      },
      {
        network: config.network,
        postUrl: "https://x.com/user/status/1",
        postText: "A public question?",
        authorHandle: "author",
        hasMedia: false,
        source: config.source,
      },
      config,
    );

    expect(result).toMatchObject({ suggested: true, suggestionId: "suggestion-1" });
    expect(suggestions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        policyMode: "HUMAN_APPROVAL_REQUIRED",
        personaRevisionId: "revision-1",
      }),
    );
    expect(authorizer.reauthorize).not.toHaveBeenCalled();
  });

  it("HB-003: executes like action when LLM decides like", async () => {
    decisionPort = createMockDecisionPort({ action: "like", reason: "relevant", confidence: 0.9 });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, config);

    expect(engager.like).toHaveBeenCalledWith(page, "url1");
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.interactionId).toBe("interaction-1");
  });

  it("HB-004: executes comment action when LLM decides comment", async () => {
    decisionPort = createMockDecisionPort({
      action: "comment",
      reason: "valuable",
      confidence: 0.8,
      commentText: "Great insight about Workflow!",
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, config);

    expect(engager.comment).toHaveBeenCalledWith(page, "url1", "Great insight about Workflow!");
    expect(results[0]!.success).toBe(true);
  });

  it("HB-005: generates comment text if LLM decision lacks it", async () => {
    decisionPort = createMockDecisionPort({
      action: "comment",
      reason: "valuable",
      confidence: 0.8,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    await engine.processPosts(page, ["url1"], engager, config);

    expect(decisionPort.generateComment).toHaveBeenCalled();
    expect(engager.comment).toHaveBeenCalledWith(page, "url1", "Test comment in brand voice.");
  });

  it("HB-006: executes open-thread action when LLM decides open-thread", async () => {
    decisionPort = createMockDecisionPort({
      action: "open-thread",
      reason: "active discussion",
      confidence: 0.7,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, config);

    expect(engager.openCommentsThread).toHaveBeenCalledWith(page, "url1");
    expect(results[0]!.success).toBe(true);
  });

  it("HB-007: executes visit-profile action when LLM decides visit-profile", async () => {
    decisionPort = createMockDecisionPort({
      action: "visit-profile",
      reason: "interesting author",
      confidence: 0.6,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, config);

    expect(engager.visitProfile).toHaveBeenCalledWith(page, "analyst");
    expect(engager.navigateBack).toHaveBeenCalled();
    expect(results[0]!.success).toBe(true);
  });

  it("HB-008: scroll action does not trigger any engager method", async () => {
    decisionPort = createMockDecisionPort({
      action: "scroll",
      reason: "browsing",
      confidence: 0.5,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    await engine.processPosts(page, ["url1"], engager, config);

    expect(engager.like).not.toHaveBeenCalled();
    expect(engager.comment).not.toHaveBeenCalled();
    expect(engager.openCommentsThread).not.toHaveBeenCalled();
  });

  it("HB-009: read action simulates reading (dwell) without interaction", async () => {
    decisionPort = createMockDecisionPort({
      action: "read",
      reason: "interesting",
      confidence: 0.7,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    await engine.processPosts(page, ["url1"], engager, config);

    // read should call randomDelay (dwell) but no engager interactions
    expect(browser.randomDelay).toHaveBeenCalled();
    expect(engager.like).not.toHaveBeenCalled();
  });

  it("HB-010: creates interaction record for like action", async () => {
    decisionPort = createMockDecisionPort({ action: "like", reason: "good", confidence: 0.9 });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    await engine.processPosts(page, ["url1"], engager, config);

    expect(mockPrisma.interaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: "account-1",
          type: "LIKE",
          targetUrl: "url1",
          browsingSessionId: "session-1",
        }),
      }),
    );
  });

  it("HB-011: handles extractPostText failure gracefully", async () => {
    engager = createMockEngager({
      extractPostText: vi.fn().mockRejectedValue(new Error("selector not found")),
    });
    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, config);

    // Should not crash — just skip the post
    expect(results.length).toBe(0);
    expect(decisionPort.decideAction).not.toHaveBeenCalled();
  });

  it("HB-012: handles empty post list", async () => {
    const page = createMockPage();
    const results = await engine.processPosts(page, [], engager, config);
    expect(results).toEqual([]);
  });

  it("HB-013: increments like counter after successful like", async () => {
    // First post: like, second post: like — budget allows both
    decisionPort = createMockDecisionPort({ action: "like", reason: "good", confidence: 0.9 });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    await engine.processPosts(page, ["url1", "url2"], engager, { ...config, maxPosts: 2 });

    // Both likes should be executed
    expect(engager.like).toHaveBeenCalledTimes(2);
  });

  it("HB-014: handles like failure from engager", async () => {
    engager = createMockEngager({
      like: vi.fn().mockResolvedValue({ success: false, error: "Button not found" }),
    });
    decisionPort = createMockDecisionPort({ action: "like", reason: "good", confidence: 0.9 });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, config);

    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toBe("Button not found");
  });

  it("HB-015: visit-profile fails gracefully when no author handle", async () => {
    engager = createMockEngager({
      extractPostText: vi.fn().mockResolvedValue({
        text: "test",
        hasMedia: false,
        authorHandle: undefined,
      }),
    });
    decisionPort = createMockDecisionPort({
      action: "visit-profile",
      reason: "interesting",
      confidence: 0.6,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, config);

    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain("No author handle");
  });

  // ── Batch decision mode ──

  function createMockBatchDecisionPort(
    decisions: Partial<ActionDecision>[],
  ): IEngagementDecisionPort {
    return {
      decideAction: vi.fn().mockResolvedValue({
        action: "scroll",
        reason: "test",
        confidence: 0.5,
      } as ActionDecision),
      decideActionsBatch: vi
        .fn()
        .mockResolvedValue(
          decisions.map(
            (d) => ({ action: "scroll", reason: "test", confidence: 0.5, ...d }) as ActionDecision,
          ),
        ),
      generateComment: vi.fn().mockResolvedValue("Test comment in brand voice."),
    };
  }

  it("HB-016: uses batch decision when port supports it (fewer LLM calls)", async () => {
    const batchDecisions = [
      { action: "scroll" as const, reason: "batch-1", confidence: 0.5 },
      { action: "scroll" as const, reason: "batch-2", confidence: 0.5 },
      { action: "scroll" as const, reason: "batch-3", confidence: 0.5 },
      { action: "scroll" as const, reason: "batch-4", confidence: 0.5 },
      { action: "scroll" as const, reason: "batch-5", confidence: 0.5 },
    ];
    decisionPort = createMockBatchDecisionPort(batchDecisions);
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const postUrls = ["url1", "url2", "url3", "url4", "url5"];
    const page = createMockPage();
    await engine.processPosts(page, postUrls, engager, { ...config, maxPosts: 5 });

    // Batch mode: 1 LLM call for all 5 posts (instead of 5 individual calls)
    expect(decisionPort.decideActionsBatch).toHaveBeenCalledTimes(1);
    expect(decisionPort.decideAction).not.toHaveBeenCalled();
  });

  it("HB-017: batch mode processes all posts and returns results", async () => {
    const batchDecisions = [
      { action: "like" as const, reason: "good", confidence: 0.9 },
      { action: "scroll" as const, reason: "boring", confidence: 0.5 },
      { action: "read" as const, reason: "interesting", confidence: 0.7 },
    ];
    decisionPort = createMockBatchDecisionPort(batchDecisions);
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1", "url2", "url3"], engager, {
      ...config,
      maxPosts: 3,
    });

    expect(results).toHaveLength(3);
    expect(results[0]!.decision.action).toBe("like");
    expect(results[1]!.decision.action).toBe("scroll");
    expect(results[2]!.decision.action).toBe("read");
  });

  it("HB-018: batch mode enforces budget mid-batch (downgrades extra likes)", async () => {
    // LLM says "like" for all 3 posts, but budget only allows 1 like
    const batchDecisions = [
      { action: "like" as const, reason: "good", confidence: 0.9 },
      { action: "like" as const, reason: "good", confidence: 0.9 },
      { action: "like" as const, reason: "good", confidence: 0.9 },
    ];
    decisionPort = createMockBatchDecisionPort(batchDecisions);
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1", "url2", "url3"], engager, {
      ...config,
      maxPosts: 3,
      likesMaxPerSession: 1,
    });

    // First like succeeds, subsequent ones are downgraded to 'read'
    expect(results[0]!.decision.action).toBe("like");
    expect(results[1]!.decision.action).toBe("read");
    expect(results[2]!.decision.action).toBe("read");
  });

  it("HB-019: falls back to individual calls when batch throws", async () => {
    const batchPort: IEngagementDecisionPort = {
      decideAction: vi.fn().mockResolvedValue({
        action: "scroll",
        reason: "individual",
        confidence: 0.5,
      } as ActionDecision),
      decideActionsBatch: vi.fn().mockRejectedValue(new Error("batch API error")),
      generateComment: vi.fn().mockResolvedValue("Test comment."),
    };
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      batchPort,
    );

    const page = createMockPage();
    await engine.processPosts(page, ["url1", "url2"], engager, { ...config, maxPosts: 2 });

    // Batch failed → fell back to individual decideAction calls
    expect(batchPort.decideActionsBatch).toHaveBeenCalledTimes(1);
    expect(batchPort.decideAction).toHaveBeenCalledTimes(2);
  });

  it("HB-020: batch mode generates comment text when missing", async () => {
    // Use 2 posts so batch mode is activated (contexts.length > 1)
    const batchDecisions = [
      { action: "comment" as const, reason: "valuable", confidence: 0.8 },
      { action: "scroll" as const, reason: "boring", confidence: 0.5 },
    ];
    decisionPort = createMockBatchDecisionPort(batchDecisions);
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    await engine.processPosts(page, ["url1", "url2"], engager, { ...config, maxPosts: 2 });

    expect(decisionPort.generateComment).toHaveBeenCalled();
    expect(engager.comment).toHaveBeenCalledWith(page, "url1", "Test comment in brand voice.");
  });

  it("HB-021: sessionStartMs enforces a shared total budget across scroll + processing", async () => {
    // Set the session start far in the past so the deadline is already exceeded.
    // Without sessionStartMs, the loop would get a fresh 60s budget and process all posts.
    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1", "url2", "url3"], engager, {
      ...config,
      maxPosts: 3,
      sessionStartMs: Date.now() - 120_000, // 2 min ago with a 60s duration -> already expired
    });

    expect(results.length).toBe(0);
    expect(decisionPort.decideAction).not.toHaveBeenCalled();
  });

  it("HB-022: executes repost action when LLM decides repost", async () => {
    decisionPort = createMockDecisionPort({
      action: "repost",
      reason: "worth sharing",
      confidence: 0.9,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, {
      ...config,
      repostsMaxPerSession: 1,
    });

    expect(engager.repost).toHaveBeenCalledWith(page, "url1");
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.interactionId).toBe("interaction-1");
  });

  it("HB-023: executes quote action when LLM decides quote", async () => {
    decisionPort = createMockDecisionPort({
      action: "quote",
      reason: "sharp take",
      confidence: 0.8,
      quoteText: "My sharp take on this.",
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1"], engager, {
      ...config,
      quotesMaxPerSession: 1,
    });

    expect(engager.quote).toHaveBeenCalledWith(page, "url1", "My sharp take on this.");
    expect(results[0]!.success).toBe(true);
  });

  it("HB-024: enforces repost and quote budget mid-batch", async () => {
    decisionPort = createMockDecisionPort({
      action: "repost",
      reason: "worth sharing",
      confidence: 0.9,
    });
    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      decisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1", "url2"], engager, {
      ...config,
      maxPosts: 2,
      repostsMaxPerSession: 1,
      quotesMaxPerSession: 0,
    });

    // First repost succeeds, second is downgraded to read
    expect(engager.repost).toHaveBeenCalledTimes(1);
    expect(results[0]!.decision.action).toBe("repost");
    expect(results[1]!.decision.action).toBe("read");
  });

  it("HB-025: falls back to read decisions when batch returns the wrong length", async () => {
    const batchDecisionPort: IEngagementDecisionPort = {
      decideAction: vi
        .fn()
        .mockResolvedValue({ action: "like", reason: "test", confidence: 0.9 } as ActionDecision),
      decideActionsBatch: vi
        .fn()
        .mockResolvedValue([
          { action: "like", reason: "test", confidence: 0.9 },
        ] as ActionDecision[]), // only 1 decision for 2 contexts
      generateComment: vi.fn().mockResolvedValue("Test comment in brand voice."),
      generateQuoteText: vi.fn().mockResolvedValue("Test quote text in brand voice."),
    };

    engine = new HumanBehaviorEngine(
      mockPrisma as never,
      browser,
      createMockSseService() as never,
      createMockRateLimitService() as never,
      batchDecisionPort,
    );

    const page = createMockPage();
    const results = await engine.processPosts(page, ["url1", "url2"], engager, {
      ...config,
      maxPosts: 2,
      likesMaxPerSession: 2,
    });

    // Batch was called, but due to length mismatch it should fall back to read decisions
    expect(batchDecisionPort.decideActionsBatch).toHaveBeenCalled();
    expect(results.length).toBe(2);
    expect(results.every((r) => r.decision.action === "read")).toBe(true);
  });
});
