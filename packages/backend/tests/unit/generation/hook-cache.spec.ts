/**
 * Hook cache unit tests.
 *
 * Tests the module-level hook cache in generation.graph.ts — verifies that
 * hook_generation skips the LLM call on cache hit and stores results for
 * future runs with the same topic.
 *
 * Source: packages/backend/src/modules/generation/generation.graph.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearHookCache,
  getHookCacheStats,
} from "../../../src/modules/generation/generation.graph";
import type { ILlmPort, LlmResponse } from "../../../src/domain/ports/llm.port";
import type { ContentTopic } from "@spa/shared";
import { SocialNetwork } from "../../../src/generated/prisma/client";

// We need to access the internal hookGenerationNode to test the cache.
// Since it's not exported, we test via the graph builder + createInitialState.
// But that requires the full LangGraph runtime. Instead, we test the cache
// utilities directly by importing the graph module and checking side effects.
//
// Strategy: import the graph builder, run hook_generation twice with the same
// topic, and verify the LLM is called only once.

import {
  buildGenerationGraph,
  createInitialState,
} from "../../../src/modules/generation/generation.graph";

function createMockLlm(responses: Partial<LlmResponse>[] = []): ILlmPort {
  let callIndex = 0;
  const generateChat = vi.fn(async (): Promise<LlmResponse> => {
    const resp = responses[callIndex] ?? {
      content: "1. Hook one\n2. Hook two\n3. Hook three",
      model: "mock-llm",
      tokens: 100,
    };
    callIndex++;
    return resp as LlmResponse;
  });
  return {
    generate: vi.fn(async () => {
      callIndex++;
      return responses[callIndex - 1] as LlmResponse;
    }),
    generateChat,
    getPromptVersion: vi.fn(() => "test"),
  };
}

function createTopic(overrides: Partial<ContentTopic> = {}): ContentTopic {
  return {
    topic: "Workflow Trends 2026",
    keywords: ["workflow", "slowdown", "productivity"],
    category: "productivity",
    facts: ["Workflow Trends happens 3-4 times a year"],
    outline: [],
    path: "/blog/workflow-slowdown",
    ...overrides,
  } as ContentTopic;
}

describe("Hook Cache", () => {
  beforeEach(() => {
    clearHookCache();
  });

  it("HC-001: cache stats report correct size and limits", () => {
    const stats = getHookCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.maxSize).toBe(50);
    expect(stats.ttlMs).toBe(30 * 60 * 1000);
  });

  it("HC-002: second run with same topic skips LLM call (cache hit)", async () => {
    const mockLlm = createMockLlm([
      {
        content:
          "1. Why is Workflow acting up?\n2. Workflow Trends is not what you think\n3. The hidden gift of slowdown",
        model: "mock",
      },
    ]);

    const graph = buildGenerationGraph(mockLlm);
    const compiled = graph.compile();

    const topic = createTopic();
    const networks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];

    // First run — calls LLM for hook_generation + drafts + critiques + refines
    const state1 = createInitialState(topic, networks, "brand voice");
    await compiled.invoke(state1, { configurable: { thread_id: "run-1" } });
    const callsAfterFirstRun = (mockLlm.generateChat as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirstRun).toBeGreaterThan(0); // at least hook_generation
    expect(getHookCacheStats().size).toBe(1); // hook cached after first run

    // Second run with same topic — hook_generation should hit cache
    const state2 = createInitialState(topic, networks, "brand voice");
    await compiled.invoke(state2, { configurable: { thread_id: "run-2" } });
    const callsAfterSecondRun = (mockLlm.generateChat as ReturnType<typeof vi.fn>).mock.calls
      .length;

    // The second run should have exactly 1 fewer LLM call than first+second
    // (the hook_generation call was skipped due to cache hit)
    // First run: hook(1) + drafts(3) + critiques(3) + refines(0-3) = 7-10
    // Second run: hook(0, cached) + drafts(3) + critiques(3) + refines(0-3) = 6-9
    // So callsAfterSecondRun - callsAfterFirstRun should be 1 less than callsAfterFirstRun
    const secondRunCalls = callsAfterSecondRun - callsAfterFirstRun;
    expect(secondRunCalls).toBe(callsAfterFirstRun - 1); // exactly 1 fewer (the hook call)
    expect(getHookCacheStats().size).toBe(1); // still 1 entry (same topic)
  });

  it("HC-003: different topic does not hit cache", async () => {
    const mockLlm = createMockLlm([
      { content: "1. Hook A\n2. Hook B\n3. Hook C", model: "mock" },
      { content: "1. Hook D\n2. Hook E\n3. Hook F", model: "mock" },
    ]);

    const graph = buildGenerationGraph(mockLlm);
    const compiled = graph.compile();

    const networks = [SocialNetwork.X];

    // Run with topic 1
    await compiled.invoke(
      createInitialState(createTopic({ topic: "Topic A" }), networks, "brand voice"),
      { configurable: { thread_id: "run-a" } },
    );

    // Run with topic 2 (different)
    await compiled.invoke(
      createInitialState(createTopic({ topic: "Topic B" }), networks, "brand voice"),
      { configurable: { thread_id: "run-b" } },
    );

    // Cache should have 2 entries (one per topic)
    expect(getHookCacheStats().size).toBe(2);
  });

  it("HC-004: same topic with different facts does not hit cache", async () => {
    const mockLlm = createMockLlm([
      { content: "1. Hook A\n2. Hook B\n3. Hook C", model: "mock" },
      { content: "1. Hook D\n2. Hook E\n3. Hook F", model: "mock" },
    ]);

    const graph = buildGenerationGraph(mockLlm);
    const compiled = graph.compile();

    const networks = [SocialNetwork.X];

    // Run with facts set A
    await compiled.invoke(
      createInitialState(createTopic({ facts: ["Fact A"] }), networks, "brand voice"),
      { configurable: { thread_id: "run-1" } },
    );

    // Run with same topic but different facts
    await compiled.invoke(
      createInitialState(createTopic({ facts: ["Fact B"] }), networks, "brand voice"),
      { configurable: { thread_id: "run-2" } },
    );

    // Cache should have 2 entries (facts are part of the cache key)
    expect(getHookCacheStats().size).toBe(2);
  });

  it("HC-005: clearHookCache empties the cache", async () => {
    const mockLlm = createMockLlm([{ content: "1. Hook A\n2. Hook B\n3. Hook C", model: "mock" }]);

    const graph = buildGenerationGraph(mockLlm);
    const compiled = graph.compile();

    await compiled.invoke(createInitialState(createTopic(), [SocialNetwork.X], "brand voice"), {
      configurable: { thread_id: "run-1" },
    });

    expect(getHookCacheStats().size).toBe(1);

    clearHookCache();

    expect(getHookCacheStats().size).toBe(0);
  });
});
