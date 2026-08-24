import { describe, expect, it, vi } from "vitest";
import {
  createFailingSideEffectPort,
  createRecordingSideEffectPort,
  executeEvaluationCandidate,
  type CandidateExecutorInput,
} from "../../../src/modules/evaluation/candidate-executor.js";

const baseCase = {
  id: "case-1",
  schemaVersion: "1" as const,
  task: "generation" as const,
  split: "test" as const,
  input: { topic: "pure" },
  expectedOutput: { secret: "ground-truth" },
  metadata: { datasetVersion: "v1", archetype: "unit", riskTags: [] },
};

const ports = () => ({
  sideEffects: createRecordingSideEffectPort(),
  llm: { generate: vi.fn(async () => ({ text: "generated" })) },
});

describe("candidate executor", () => {
  it("runs pure candidates and keeps expectedOutput out of the input", async () => {
    const p = ports();
    const candidate = vi.fn(async (input) => {
      expect(input).not.toHaveProperty("expectedOutput");
      return { ok: true };
    });
    const result = await executeEvaluationCandidate({ case: baseCase, candidate, ports: p });
    expect(result).toEqual({ status: "completed", output: { ok: true }, violations: [] });
  });

  it("records every prohibited operation deterministically", async () => {
    const p = ports();
    const result = await executeEvaluationCandidate({
      case: baseCase,
      ports: p,
      candidate: async (_input, candidatePorts) => {
        candidatePorts.sideEffects.record({ kind: "queue-enqueue", operation: "queue.add" });
        candidatePorts.sideEffects.record({
          kind: "production-post-mutation",
          operation: "post.create",
        });
        return { ok: true };
      },
    });
    expect(result).toEqual({
      status: "completed",
      output: { ok: true },
      violations: [
        { kind: "queue-enqueue", operation: "queue.add" },
        { kind: "production-post-mutation", operation: "post.create" },
      ],
    });
  });

  it("fails closed with the failing adapter", async () => {
    const result = await executeEvaluationCandidate({
      case: baseCase,
      ports: { ...ports(), sideEffects: createFailingSideEffectPort() },
      candidate: async (_input, candidatePorts) => {
        candidatePorts.sideEffects.record({ kind: "browser-submit", operation: "page.click" });
        return { unreachable: true };
      },
    });
    expect(result).toMatchObject({ status: "failed", failure: { category: "boundary" } });
  });

  it("classifies cancellation and timeout without swallowing failures", async () => {
    const controller = new AbortController();
    const cancelled: CandidateExecutorInput = {
      case: baseCase,
      ports: ports(),
      signal: controller.signal,
      candidate: async () => {
        controller.abort();
        await new Promise(() => undefined);
        return null;
      },
      timeoutMs: 50,
    };
    const pending = executeEvaluationCandidate(cancelled);
    const result = await pending;
    expect(result.failure?.category).toBe("cancelled");

    const timeout = await executeEvaluationCandidate({
      case: baseCase,
      ports: ports(),
      timeoutMs: 5,
      candidate: async () => new Promise(() => undefined),
    });
    expect(timeout.failure?.category).toBe("timeout");
  });

  it("does not start a candidate when the external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const candidate = vi.fn(async () => ({ unreachable: true }));
    const result = await executeEvaluationCandidate({
      case: baseCase,
      ports: ports(),
      signal: controller.signal,
      candidate,
    });

    expect(candidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", failure: { category: "cancelled" } });
  });

  it("preserves recorded violations when the candidate subsequently fails", async () => {
    const p = ports();
    const result = await executeEvaluationCandidate({
      case: baseCase,
      ports: p,
      candidate: async (_input, candidatePorts) => {
        candidatePorts.sideEffects.record({
          kind: "production-checkpoint",
          operation: "checkpoint.put",
        });
        throw new Error("candidate failed");
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      violations: [{ kind: "production-checkpoint", operation: "checkpoint.put" }],
      failure: { category: "candidate", message: "candidate failed" },
    });
  });

  it("rejects non-JSON output at the evidence boundary", async () => {
    const result = await executeEvaluationCandidate({
      case: baseCase,
      ports: ports(),
      candidate: async () => ({ invalid: undefined }) as never,
    });
    expect(result).toMatchObject({ status: "failed", failure: { category: "candidate" } });
  });
});
