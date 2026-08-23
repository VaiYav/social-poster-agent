import {
  CandidateInputSchema,
  type CandidateInput,
  type DeepReadonly,
  type JsonValue,
  JsonValueSchema,
  toCandidateInput,
} from "./contracts.js";
import type { ProhibitedEvaluationSideEffect } from "./deterministic-evaluators.js";

export type EvaluationFailureCategory = "cancelled" | "timeout" | "candidate" | "boundary";

export interface EvaluationViolation {
  readonly kind: ProhibitedEvaluationSideEffect;
  readonly operation: string;
  readonly details?: JsonValue;
}

export interface EvaluationSideEffectPort {
  readonly record: (violation: EvaluationViolation) => void;
}

export interface EvaluationCandidatePorts {
  readonly sideEffects: EvaluationSideEffectPort;
  readonly llm: {
    readonly generate: (input: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
  };
}

export type EvaluationCandidate = (
  input: DeepReadonly<CandidateInput>,
  ports: EvaluationCandidatePorts,
  signal: AbortSignal,
) => Promise<JsonValue>;

export interface CandidateExecutorInput {
  readonly case: unknown;
  readonly candidate: EvaluationCandidate;
  readonly ports: EvaluationCandidatePorts;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CandidateExecutionEvidence {
  readonly status: "completed" | "failed";
  readonly output?: JsonValue;
  readonly violations: readonly EvaluationViolation[];
  readonly failure?: { readonly category: EvaluationFailureCategory; readonly message: string };
}

export class EvaluationSideEffectError extends Error {
  readonly name = "EvaluationSideEffectError";

  constructor(readonly violation: EvaluationViolation) {
    super(`prohibited evaluation side effect: ${violation.kind}`);
  }
}

export function createRecordingSideEffectPort(): EvaluationSideEffectPort & {
  readonly violations: readonly EvaluationViolation[];
} {
  const violations: EvaluationViolation[] = [];
  return {
    get violations() {
      return violations;
    },
    record(violation) {
      violations.push(Object.freeze({ ...violation }));
    },
  };
}

export function createFailingSideEffectPort(): EvaluationSideEffectPort {
  return {
    record: (violation) => {
      throw new EvaluationSideEffectError(violation);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "candidate failed with an unknown error";
}

function classify(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean,
): EvaluationFailureCategory {
  if (timedOut) return "timeout";
  if (signal.aborted) return "cancelled";
  if (error instanceof EvaluationSideEffectError) return "boundary";
  return "candidate";
}

/** Executes a candidate with only explicitly supplied ports; expectedOutput is never exposed. */
export async function executeEvaluationCandidate(
  input: CandidateExecutorInput,
): Promise<CandidateExecutionEvidence> {
  const candidateInput = toCandidateInput(input.case);
  CandidateInputSchema.parse(candidateInput);
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new RangeError("timeoutMs must be an integer between 1 and 300000");
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (controller.signal.aborted) throw new Error("evaluation aborted");
    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(new Error("evaluation aborted"));
      else
        controller.signal.addEventListener("abort", () => reject(new Error("evaluation aborted")), {
          once: true,
        });
    });
    const output = await Promise.race([
      input.candidate(candidateInput, input.ports, controller.signal),
      abortPromise,
    ]);
    // Validate at the boundary so evidence remains JSON-safe even when a
    // candidate is supplied by an untrusted test harness.
    JsonValueSchema.parse(output);
    return Object.freeze({
      status: "completed",
      output,
      violations:
        input.ports.sideEffects && "violations" in input.ports.sideEffects
          ? (
              input.ports.sideEffects as EvaluationSideEffectPort & {
                violations: readonly EvaluationViolation[];
              }
            ).violations
          : [],
    });
  } catch (error) {
    return Object.freeze({
      status: "failed",
      violations:
        input.ports.sideEffects && "violations" in input.ports.sideEffects
          ? (
              input.ports.sideEffects as EvaluationSideEffectPort & {
                violations: readonly EvaluationViolation[];
              }
            ).violations
          : [],
      failure: Object.freeze({
        category: classify(error, controller.signal, timedOut),
        message: messageOf(error),
      }),
    });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
