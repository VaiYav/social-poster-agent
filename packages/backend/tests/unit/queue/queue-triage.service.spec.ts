/**
 * QueueTriageService unit tests (P2 eval harness).
 *
 * Focus: flow-control kill-switches and LLM triage pause behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueueTriageService } from "../../../src/modules/queue/queue-triage.service.js";

function createMockConfig(values: Record<string, unknown> = {}): {
  get: (key: string, defaultValue?: unknown) => unknown;
} {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
    ),
  };
}

function createMockQueueFactory() {
  return {
    getQueue: vi.fn().mockReturnValue({
      getFailed: vi.fn().mockResolvedValue([]),
    }),
  };
}

function createMockPrisma() {
  return { post: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() } } as unknown as {
    post: { findMany: any; update: any };
  };
}

function createMockLlm() {
  return {
    generateChat: vi.fn().mockResolvedValue({ content: "[]", model: "mock" }),
  };
}

function createFlowControl(paused: boolean) {
  return {
    isPaused: vi.fn().mockResolvedValue(paused),
  };
}

describe("QueueTriageService (P2 eval harness)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("TRIAGE-PAUSE-001: triageAll returns empty when flow:pause_llm_triage is set", async () => {
    const service = new QueueTriageService(
      createMockQueueFactory() as any,
      createMockPrisma() as any,
      createMockConfig({ LLM_QUEUE_TRIAGE_ENABLED: "true" }) as any,
      createMockLlm() as any,
      undefined,
      undefined,
      createFlowControl(true) as any,
    );

    const results = await service.triageAll();
    expect(results).toEqual([]);
  });

  it("TRIAGE-PAUSE-002: triageNetwork returns a SKIP result when flow:pause_llm_triage is set", async () => {
    const service = new QueueTriageService(
      createMockQueueFactory() as any,
      createMockPrisma() as any,
      createMockConfig({ LLM_QUEUE_TRIAGE_ENABLED: "true" }) as any,
      createMockLlm() as any,
      undefined,
      undefined,
      createFlowControl(true) as any,
    );

    const result = await service.triageNetwork("X");
    expect(result.examined).toBe(0);
    expect(result.retried).toBe(0);
    expect(result.requeuedDelayed).toBe(0);
    expect(result.rejected).toBe(0);
  });
});
