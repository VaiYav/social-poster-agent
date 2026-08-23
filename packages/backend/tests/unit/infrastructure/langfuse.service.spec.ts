import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { CircuitBreaker } from "../../../src/domain/circuit-breaker.js";
import { LangfuseService } from "../../../src/infrastructure/langfuse/langfuse.service.js";

const mocks = vi.hoisted(() => ({
  callbackHandler: vi.fn().mockImplementation(function () {
    return { name: "LangfuseCallbackHandler" };
  }),
  langfuseClient: vi.fn().mockImplementation(function () {
    return {
      prompt: { get: vi.fn() },
      score: { create: vi.fn() },
      flush: vi.fn().mockResolvedValue(undefined),
    };
  }),
  propagateAttributes: vi.fn(),
  rootUpdate: vi.fn(),
  startActiveObservation: vi.fn(),
  shutdownLangfuse: vi.fn(),
}));

vi.mock("@langfuse/langchain", () => ({ CallbackHandler: mocks.callbackHandler }));
vi.mock("@langfuse/client", () => ({ LangfuseClient: mocks.langfuseClient }));
vi.mock("@langfuse/tracing", () => ({
  propagateAttributes: mocks.propagateAttributes,
  startActiveObservation: mocks.startActiveObservation,
}));
vi.mock("../../../src/langfuse-instrumentation.js", () => ({
  shutdownLangfuse: mocks.shutdownLangfuse,
}));

function createConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: vi.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  } as unknown as ConfigService;
}

function createService(values: Record<string, unknown>): LangfuseService {
  return new LangfuseService(
    new CircuitBreaker("test-langfuse", { failureThreshold: 3, resetTimeoutMs: 1000 }),
    createConfig(values),
  );
}

describe("LangfuseService trace identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.propagateAttributes.mockImplementation(
      async (_attributes: unknown, callback: () => Promise<unknown>) => callback(),
    );
    mocks.startActiveObservation.mockImplementation(
      async (
        _name: string,
        callback: (root: { update: typeof mocks.rootUpdate }) => Promise<unknown>,
      ) => callback({ update: mocks.rootUpdate }),
    );
  });

  it("creates one stable logical root and propagates attributes before children", async () => {
    const service = createService({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      NODE_ENV: "test",
      LANGFUSE_EXECUTION_MODE: "eval",
      SOURCE_SHA: "abc123fullsha",
    });

    const result = await service.withTrace(
      {
        rootName: "agent.generation",
        feature: "generation",
        sessionId: "run-101",
        tags: ["generation", "x"],
        metadata: {
          case_id: "case-7",
          repeat_index: 2,
          candidate_id: "candidate-a",
          apiKey: "must-not-leak",
        },
        input: { run_id: "run-101", topic: "test topic", apiKey: "must-not-leak" },
        output: () => ({ status: "completed", post_count: 1 }),
      },
      async () => "trace-result",
    );

    expect(result).toBe("trace-result");
    expect(mocks.startActiveObservation).toHaveBeenCalledWith(
      "agent.generation",
      expect.any(Function),
      { asType: "agent" },
    );

    const propagation = mocks.propagateAttributes.mock.calls[0]?.[0] as {
      traceName: string;
      sessionId: string;
      environment: string;
      tags: string[];
      metadata: Record<string, string>;
    };
    expect(propagation.traceName).toBe("agent.generation");
    expect(propagation.sessionId).toBe("run-101");
    expect(propagation.environment).toBe("test");
    expect(propagation.tags).toEqual(["generation", "x"]);
    expect(propagation.metadata).toMatchObject({
      feature: "generation",
      environment: "test",
      execution_mode: "eval",
      run_id: "run-101",
      source_sha: "abc123fullsha",
      case_id: "case-7",
      repeat_index: "2",
      candidate_id: "candidate-a",
    });
    expect(propagation.metadata).not.toHaveProperty("apiKey");

    expect(mocks.rootUpdate).toHaveBeenNthCalledWith(1, {
      input: { run_id: "run-101", topic: "test topic" },
    });
    expect(mocks.rootUpdate).toHaveBeenNthCalledWith(2, {
      output: { status: "completed", post_count: 1 },
    });
  });

  it("keeps the disabled path as a direct function call with no tracing work", async () => {
    const service = createService({ LANGFUSE_PUBLIC_KEY: "", NODE_ENV: "test" });
    const operation = vi.fn().mockResolvedValue("disabled-result");

    await expect(
      service.withTrace(
        {
          rootName: "agent.generation",
          feature: "generation",
          input: { topic: "no trace" },
        },
        operation,
      ),
    ).resolves.toBe("disabled-result");

    expect(operation).toHaveBeenCalledOnce();
    expect(mocks.startActiveObservation).not.toHaveBeenCalled();
    expect(mocks.propagateAttributes).not.toHaveBeenCalled();
    expect(service.createHandler()).toBeUndefined();
  });

  it("adds standard identity dimensions to callback metadata without secrets", () => {
    const service = createService({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      NODE_ENV: "staging",
      SPA_DRY_RUN: "true",
      RELEASE_SHA: "release-sha",
    });

    service.createHandler({
      sessionId: "run-102",
      tags: ["orchestrator", "decision"],
      traceMetadata: { case_id: "case-8", password: "must-not-leak" },
    });

    expect(mocks.callbackHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "run-102",
        tags: ["orchestrator", "decision"],
        traceMetadata: expect.objectContaining({
          feature: "orchestrator",
          environment: "staging",
          execution_mode: "dry-run",
          run_id: "run-102",
          source_sha: "release-sha",
          case_id: "case-8",
        }),
      }),
    );
    const options = mocks.callbackHandler.mock.calls[0]?.[0] as {
      traceMetadata: Record<string, string>;
    };
    expect(options.traceMetadata).not.toHaveProperty("password");
  });

  it("queues and flushes a score only when Langfuse is enabled", async () => {
    const service = createService({ LANGFUSE_PUBLIC_KEY: "pk-test", NODE_ENV: "test" });
    const client = mocks.langfuseClient.mock.results.at(-1)?.value as {
      score: { create: ReturnType<typeof vi.fn> };
      flush: ReturnType<typeof vi.fn>;
    };
    const score = {
      id: "spa-review:r1:human-review-decision",
      traceId: "trace-1",
      name: "human-review-decision",
      value: 1,
      dataType: "CATEGORICAL" as const,
    };

    await expect(service.createScore(score)).resolves.toBe(true);
    expect(client.score.create).toHaveBeenCalledWith(score);
    expect(client.flush).toHaveBeenCalledOnce();
  });

  it("keeps the disabled score path durable and side-effect free", async () => {
    const service = createService({ LANGFUSE_PUBLIC_KEY: "", NODE_ENV: "test" });

    await expect(
      service.createScore({ name: "human-review-decision", value: 1, traceId: "trace-1" }),
    ).resolves.toBe(false);
    expect(mocks.langfuseClient).not.toHaveBeenCalled();
  });
});
