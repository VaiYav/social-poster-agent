/**
 * EngagementDecisionService unit tests.
 *
 * Tests LLM-driven decision making and comment generation,
 * including budget enforcement and fallback behavior.
 *
 * Source: packages/backend/src/modules/engagement/engagement-decision.service.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { EngagementDecisionService } from "../../../src/modules/engagement/engagement-decision.service";
import type { ILlmPort, LlmResponse } from "../../../src/domain/ports/llm.port";
import type { PostContext } from "../../../src/domain/ports/engagement-decision.port";

function createMockLlm(responses: Partial<LlmResponse>[] = []): ILlmPort {
  let callIndex = 0;
  return {
    generate: vi.fn(async (): Promise<LlmResponse> => {
      const resp = responses[callIndex] ?? {
        content: '{"action":"scroll","reason":"test","confidence":0.5}',
        model: "mock",
      };
      callIndex++;
      return resp as LlmResponse;
    }),
    generateChat: vi.fn(async (_system: string, _user: string): Promise<LlmResponse> => {
      const resp = responses[callIndex] ?? {
        content: '{"action":"scroll","reason":"test","confidence":0.5}',
        model: "mock",
      };
      callIndex++;
      return resp as LlmResponse;
    }),
    getPromptVersion: vi.fn(() => "test"),
  };
}

function createPostContext(overrides: Partial<PostContext> = {}): PostContext {
  return {
    network: "X",
    postUrl: "https://x.com/user/status/123",
    postText: "Remote Work in Q1 brings energy and initiative today.",
    hasMedia: false,
    source: "home-feed",
    likesThisSession: 0,
    commentsThisSession: 0,
    likesMaxPerSession: 15,
    commentsMaxPerSession: 4,
    ...overrides,
  };
}

describe("EngagementDecisionService", () => {
  let service: EngagementDecisionService;
  let mockLlm: ILlmPort;
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = { get: vi.fn().mockReturnValue(0.7) } as unknown as ConfigService;
  });

  // ── decideAction ──

  it("ED-001: parses valid JSON decision from LLM", async () => {
    mockLlm = createMockLlm([
      {
        content: '{"action":"like","reason":"relevant to productivity","confidence":0.8}',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe("like");
    expect(decision.reason).toBe("relevant to productivity");
    expect(decision.confidence).toBe(0.8);
  });

  it("ED-002: falls back to probabilistic decision when LLM returns invalid JSON", async () => {
    mockLlm = createMockLlm([{ content: "not json at all", model: "mock" }]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    // Non-committal parsed default (scroll, confidence 0.3) triggers the fallback.
    // Fallback no longer returns comment/quote (requires LLM text).
    expect(["scroll", "read", "like"]).toContain(decision.action);
    expect(decision.confidence).toBeLessThan(0.5);
  });

  it("ED-003: falls back to probabilistic decision when LLM returns invalid action", async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"invalid_action","reason":"test","confidence":0.5}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    // Invalid action parses as non-committal scroll (confidence 0.3) -> fallback
    expect(["scroll", "read", "like"]).toContain(decision.action);
    expect(decision.confidence).toBeLessThan(0.5);
  });

  it("ED-003a: uses probabilistic fallback when LLM is non-committal about scroll", async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"scroll","reason":"meh","confidence":0.3}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    // Low-confidence non-engagement triggers the fallback distribution.
    // Fallback no longer returns comment/quote/repost (requires LLM text).
    expect(["scroll", "read", "like"]).toContain(decision.action);
    expect(decision.confidence).toBeLessThan(0.5);
  });

  it("ED-004: downgrades like to read when like budget exhausted", async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"like","reason":"good post","confidence":0.9}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        likesThisSession: 15,
        likesMaxPerSession: 15,
      }),
    );
    expect(decision.action).toBe("read");
  });

  it("ED-005: downgrades comment to read when comment budget exhausted", async () => {
    mockLlm = createMockLlm([
      {
        content:
          '{"action":"comment","reason":"great discussion","confidence":0.9,"commentText":"test"}',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        commentsThisSession: 4,
        commentsMaxPerSession: 4,
      }),
    );
    expect(decision.action).toBe("read");
  });

  it("ED-006: generates comment text when LLM decides comment but provides none", async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"comment","reason":"relevant","confidence":0.8}', model: "mock" },
      {
        content: "Product cycle hit me too — completely reframed how I see delays.",
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe("comment");
    expect(decision.commentText).toBeDefined();
    expect(decision.commentText!.length).toBeGreaterThan(0);
  });

  it("ED-007: uses fallback decision when LLM is null", async () => {
    service = new EngagementDecisionService(null as never, configService);

    const decision = await service.decideAction(createPostContext());
    // Fallback no longer returns comment/quote (requires LLM text)
    expect(["scroll", "read", "like"]).toContain(decision.action);
    expect(decision.confidence).toBeLessThan(0.5);
  });

  it("ED-008: uses fallback decision when LLM throws", async () => {
    mockLlm = {
      generate: vi.fn().mockRejectedValue(new Error("API down")),
      generateChat: vi.fn().mockRejectedValue(new Error("API down")),
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    expect(["scroll", "read", "like"]).toContain(decision.action);
  });

  it("ED-009: handles markdown-wrapped JSON from LLM", async () => {
    mockLlm = createMockLlm([
      {
        content: '```json\n{"action":"read","reason":"interesting","confidence":0.7}\n```',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe("read");
    expect(decision.confidence).toBe(0.7);
  });

  // ── generateComment ──

  it("ED-010: generates comment from LLM", async () => {
    mockLlm = createMockLlm([
      { content: "The workflow in summer energy is so real this week.", model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const comment = await service.generateComment(createPostContext());
    expect(comment).toBe("The workflow in summer energy is so real this week.");
  });

  it("ED-011: rejects forbidden comments (self-promo) — returns null", async () => {
    mockLlm = createMockLlm([{ content: "Check out my site for your plan!", model: "mock" }]);
    service = new EngagementDecisionService(mockLlm, configService);

    const comment = await service.generateComment(createPostContext());
    // Forbidden comment → null (caller downgrades action, never posts fallback)
    expect(comment).toBeNull();
  });

  it("ED-012: rejects forbidden comments (generic phrases) — returns null", async () => {
    mockLlm = createMockLlm([{ content: "Great post! Thanks for sharing.", model: "mock" }]);
    service = new EngagementDecisionService(mockLlm, configService);

    const comment = await service.generateComment(createPostContext());
    expect(comment).toBeNull();
  });

  it("ED-013: rejects forbidden comments (links) — returns null", async () => {
    mockLlm = createMockLlm([{ content: "Interesting! https://bit.ly/something", model: "mock" }]);
    service = new EngagementDecisionService(mockLlm, configService);

    const comment = await service.generateComment(createPostContext());
    expect(comment).toBeNull();
  });

  it("ED-014: returns null when LLM is null (no generic fallback)", async () => {
    service = new EngagementDecisionService(null as never, configService);

    const comment = await service.generateComment(createPostContext());
    expect(comment).toBeNull();
  });

  it("ED-015: returns null when LLM throws (no generic fallback)", async () => {
    mockLlm = {
      generate: vi.fn().mockRejectedValue(new Error("API down")),
      generateChat: vi.fn().mockRejectedValue(new Error("API down")),
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm, configService);

    const comment = await service.generateComment(createPostContext());
    expect(comment).toBeNull();
  });

  // ── decideActionsBatch ──

  it("ED-016: batch decision returns one decision per context", async () => {
    mockLlm = createMockLlm([
      {
        content:
          '[{"action":"like","reason":"good","confidence":0.9},{"action":"scroll","reason":"boring","confidence":0.6}]',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const contexts = [createPostContext(), createPostContext({ postText: "Off-topic post" })];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.action).toBe("like");
    expect(decisions[1]!.action).toBe("scroll");
  });

  it("ED-017: batch decision makes single LLM call", async () => {
    mockLlm = createMockLlm([
      {
        content:
          '[{"action":"scroll","reason":"test","confidence":0.5},{"action":"scroll","reason":"test","confidence":0.5}]',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const contexts = [createPostContext(), createPostContext()];
    await service.decideActionsBatch!(contexts);
    expect(mockLlm.generateChat).toHaveBeenCalledTimes(1);
  });

  it("ED-018: batch decision enforces like budget per-post", async () => {
    mockLlm = createMockLlm([
      {
        content:
          '[{"action":"like","reason":"good","confidence":0.9},{"action":"like","reason":"good","confidence":0.9}]',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const contexts = [
      createPostContext({ likesThisSession: 15, likesMaxPerSession: 15 }),
      createPostContext({ likesThisSession: 15, likesMaxPerSession: 15 }),
    ];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions[0]!.action).toBe("read"); // budget exhausted → downgraded
    expect(decisions[1]!.action).toBe("read");
  });

  it("ED-019: batch decision enforces comment budget per-post", async () => {
    mockLlm = createMockLlm([
      {
        content: '[{"action":"comment","reason":"good","confidence":0.9,"commentText":"test"}]',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const contexts = [createPostContext({ commentsThisSession: 4, commentsMaxPerSession: 4 })];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions[0]!.action).toBe("read"); // budget exhausted → downgraded
  });

  it("ED-020: batch decision falls back to individual calls on LLM failure", async () => {
    mockLlm = {
      generate: vi.fn().mockRejectedValue(new Error("API down")),
      generateChat: vi
        .fn()
        .mockRejectedValueOnce(new Error("API down")) // batch call fails
        .mockResolvedValueOnce({
          content: '{"action":"scroll","reason":"fallback","confidence":0.7}',
          model: "mock",
        }) // individual call 1: confident scroll, stays scroll
        .mockResolvedValueOnce({
          content: '{"action":"scroll","reason":"fallback","confidence":0.7}',
          model: "mock",
        }), // individual call 2: confident scroll, stays scroll
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm, configService);

    const contexts = [createPostContext(), createPostContext()];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.action).toBe("scroll");
    expect(decisions[1]!.action).toBe("scroll");
  });

  it("ED-021: batch decision uses fallback when LLM is null", async () => {
    service = new EngagementDecisionService(null as never, configService);

    const contexts = [createPostContext(), createPostContext()];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions).toHaveLength(2);
    for (const d of decisions) {
      // Fallback no longer returns comment/quote (requires LLM text)
      expect(["scroll", "read", "like"]).toContain(d.action);
      expect(d.confidence).toBeLessThan(0.5);
    }
  });

  it("ED-022: batch decision handles empty context array", async () => {
    mockLlm = createMockLlm();
    service = new EngagementDecisionService(mockLlm, configService);

    const decisions = await service.decideActionsBatch!([]);
    expect(decisions).toEqual([]);
    expect(mockLlm.generateChat).not.toHaveBeenCalled();
  });

  it("ED-023: batch decision parses markdown-wrapped JSON array", async () => {
    mockLlm = createMockLlm([
      {
        content: '```json\n[{"action":"read","reason":"interesting","confidence":0.7}]\n```',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decisions = await service.decideActionsBatch!([createPostContext()]);
    expect(decisions[0]!.action).toBe("read");
    expect(decisions[0]!.confidence).toBe(0.7);
  });

  // ── comment/quote generation failure → action downgrade ──

  it("ED-024: downgrades comment → like when generateComment fails (LLM throws on 2nd call)", async () => {
    // 1st call: LLM decides "comment" without commentText.
    // 2nd call: generateComment LLM call throws → returns null → downgrade to like.
    mockLlm = {
      generate: vi.fn(),
      generateChat: vi
        .fn()
        .mockResolvedValueOnce({
          content: '{"action":"comment","reason":"relevant","confidence":0.8}',
          model: "mock",
        })
        .mockRejectedValueOnce(new Error("All LLM providers failed")),
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe("like");
    expect(decision.commentText).toBeUndefined();
  });

  it("ED-025: downgrades comment → read when generateComment fails AND like budget exhausted", async () => {
    mockLlm = {
      generate: vi.fn(),
      generateChat: vi
        .fn()
        .mockResolvedValueOnce({
          content: '{"action":"comment","reason":"relevant","confidence":0.8}',
          model: "mock",
        })
        .mockRejectedValueOnce(new Error("All LLM providers failed")),
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        likesThisSession: 15,
        likesMaxPerSession: 15,
      }),
    );
    expect(decision.action).toBe("read");
  });

  it("ED-026: downgrades quote → read when generateQuoteText fails", async () => {
    mockLlm = {
      generate: vi.fn(),
      generateChat: vi
        .fn()
        .mockResolvedValueOnce({
          content: '{"action":"quote","reason":"sharp","confidence":0.8}',
          model: "mock",
        })
        .mockRejectedValueOnce(new Error("All LLM providers failed")),
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe("read");
  });

  // ── Language matching (script validation) ──
  // The LLM is asked to detect the post's language and write the comment in it.
  // We post-validate: if the LLM says "es" or "it" but writes in the wrong script, return null
  // (caller downgrades comment → like → read) instead of posting an English comment.

  it("ED-LANG-004: accepts English comment for English post", async () => {
    mockLlm = createMockLlm([
      { content: '{"language":"en","comment":"Product cycle hit me at 28 too."}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const comment = await service.generateComment(createPostContext());
    expect(comment).toBe("Product cycle hit me at 28 too.");
  });

  it("ED-LANG-005: rejects non-English posts and returns null", async () => {
    mockLlm = createMockLlm([
      { content: "Un ciclo de producto tarda 18 meses. Y aun así te destroza.", model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const comment = await service.generateComment(
      createPostContext({ postText: "Productividad en Q1 hoy" }),
    );
    expect(comment).toBeNull();
  });

  it("ED-LANG-006: rejects Cyrillic posts and returns null", async () => {
    mockLlm = createMockLlm([
      { content: "Это правило двух недель ударило меня в 28...", model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const comment = await service.generateComment(
      createPostContext({ postText: "Продуктивность в Q1 сегодня" }),
    );
    expect(comment).toBeNull();
  });

  it("ED-LANG-009: backward compat — plain text response (no JSON) still works", async () => {
    mockLlm = createMockLlm([
      { content: "The workflow in summer energy is so real this week.", model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const comment = await service.generateComment(createPostContext());
    // No JSON → fallback to raw text, no language field → skip script validation
    expect(comment).toBe("The workflow in summer energy is so real this week.");
  });

  it("ED-LANG-012: accepts JSON with locale variant detectedLanguage (en-US normalizes to en)", async () => {
    mockLlm = createMockLlm([
      { content: '{"language":"en-US","comment":"Product cycle is real."}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const comment = await service.generateComment(createPostContext());
    expect(comment).toBe("Product cycle is real.");
  });

  // ── judgeComment (P0) ──

  it("ED-JUDGE-001: approves a comment when LLM returns approved=true with score >= threshold", async () => {
    mockLlm = createMockLlm([
      { content: '{"approved":true,"score":0.8,"reason":"relevant and human"}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const result = await service.judgeComment(createPostContext(), "Product cycle is real.");
    expect(result.approved).toBe(true);
    expect(result.score).toBe(0.8);
  });

  it("ED-JUDGE-002: rejects a comment when LLM returns approved=false", async () => {
    mockLlm = createMockLlm([
      { content: '{"approved":false,"score":0.4,"reason":"generic spam"}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const result = await service.judgeComment(createPostContext(), "Great post!");
    expect(result.approved).toBe(false);
  });

  it("ED-JUDGE-003: rejects when score is below COMMENT_JUDGE_MIN_SCORE even if approved=true", async () => {
    mockLlm = createMockLlm([
      { content: '{"approved":true,"score":0.5,"reason":"barely relevant"}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);
    const result = await service.judgeComment(createPostContext(), "Okay.");
    expect(result.approved).toBe(false);
  });

  it("ED-JUDGE-004: rejects by default when LLM fails", async () => {
    mockLlm = {
      generate: vi.fn().mockRejectedValue(new Error("LLM down")),
      generateChat: vi.fn().mockRejectedValue(new Error("LLM down")),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm, configService);
    const result = await service.judgeComment(createPostContext(), "Product cycle is real.");
    expect(result.approved).toBe(false);
    expect(result.score).toBe(0);
  });

  // ── discussion budget (repost + quote) ──

  it("ED-DISC-001: downgrades repost → read when discussion budget exhausted", async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"repost","reason":"worth sharing","confidence":0.9}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        repostsThisSession: 0,
        repostsMaxPerSession: 5,
        quotesThisSession: 0,
        quotesMaxPerSession: 5,
        discussionsThisSession: 1,
        discussionsMaxPerSession: 1,
      }),
    );
    expect(decision.action).toBe("read");
    expect(decision.reason).toContain("Discussion");
  });

  it("ED-DISC-002: downgrades quote → read when discussion budget exhausted", async () => {
    mockLlm = createMockLlm([
      {
        content: '{"action":"quote","reason":"sharp take","confidence":0.9,"quoteText":"Yes"}',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        repostsThisSession: 1,
        repostsMaxPerSession: 5,
        quotesThisSession: 0,
        quotesMaxPerSession: 5,
        discussionsThisSession: 1,
        discussionsMaxPerSession: 1,
      }),
    );
    expect(decision.action).toBe("read");
    expect(decision.reason).toContain("Discussion");
  });

  it("ED-DISC-003: allows repost when discussion budget is available", async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"repost","reason":"worth sharing","confidence":0.9}', model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        repostsThisSession: 0,
        repostsMaxPerSession: 5,
        quotesThisSession: 0,
        quotesMaxPerSession: 5,
        discussionsThisSession: 0,
        discussionsMaxPerSession: 2,
      }),
    );
    expect(decision.action).toBe("repost");
  });

  it("ED-DISC-004: discussion budget falls back to repostsMax + quotesMax when not provided", async () => {
    mockLlm = createMockLlm([
      {
        content: '{"action":"quote","reason":"sharp take","confidence":0.9,"quoteText":"Yes"}',
        model: "mock",
      },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        repostsThisSession: 2,
        repostsMaxPerSession: 1,
        quotesThisSession: 0,
        quotesMaxPerSession: 1,
      }),
    );
    expect(decision.action).toBe("read");
    expect(decision.reason).toContain("Discussion");
  });

  it("ED-SAFE-001: rejects generated comment with troll/spam keywords", async () => {
    mockLlm = createMockLlm([
      {
        content:
          '{"action":"comment","reason":"relevant","confidence":0.8,"commentText":"This is a fake scam bot."}',
        model: "mock",
      },
      { content: "This is a fake scam bot.", model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(createPostContext());
    // Safety rejects the comment text, then it downgrades to like if budget allows.
    expect(["like", "read"]).toContain(decision.action);
  });

  it("ED-SAFE-002: rejects generated quote with self-promo bait", async () => {
    mockLlm = createMockLlm([
      {
        content:
          '{"action":"quote","reason":"relevant","confidence":0.8,"quoteText":"Follow me for more productivity!"}',
        model: "mock",
      },
      { content: "Follow me for more productivity!", model: "mock" },
    ]);
    service = new EngagementDecisionService(mockLlm, configService);

    const decision = await service.decideAction(
      createPostContext({
        repostsMaxPerSession: 0,
        quotesMaxPerSession: 1,
      }),
    );
    expect(decision.action).toBe("read");
    expect(decision.reason).toContain("Quote generation failed");
  });
});
