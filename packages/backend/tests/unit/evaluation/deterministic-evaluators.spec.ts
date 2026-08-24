import { z } from "zod";
import { describe, expect, it } from "vitest";
import { EvaluatorResultSchema } from "../../../src/modules/evaluation/contracts.js";
import {
  DETERMINISTIC_EVALUATOR_VERSION,
  EVALUATION_CHARACTER_LIMITS,
  PROHIBITED_EVALUATION_SIDE_EFFECTS,
  SAFETY_POLICY_VIOLATIONS,
  evaluateOrchestratorAction,
  evaluatePlatformLimit,
  evaluateSafetyPolicy,
  evaluateSchemaValidity,
  evaluateSideEffects,
  evaluateTelemetryEvidence,
  runDeterministicEvaluatorSet,
  type DeterministicEvaluatorOutcome,
  type TelemetryAttemptEvidence,
} from "../../../src/modules/evaluation/deterministic-evaluators.js";

function expectClassification(
  outcome: DeterministicEvaluatorOutcome,
  classification: DeterministicEvaluatorOutcome["classification"],
  reason?: string,
): void {
  expect(outcome.classification).toBe(classification);
  expect(outcome.hardGate).toBe(true);
  expect(outcome.result.passed).toBe(classification === "PASS");
  expect(outcome.result.value).toBe(classification === "PASS");
  expect(outcome.result.evaluatorVersion).toBe(DETERMINISTIC_EVALUATOR_VERSION);
  expect(EvaluatorResultSchema.parse(outcome.result)).toEqual(outcome.result);
  if (reason) expect(outcome.result.reason).toBe(reason);
}

function validTelemetryAttempt(
  overrides: Partial<TelemetryAttemptEvidence> = {},
): TelemetryAttemptEvidence {
  return {
    provider_actual: "openai",
    model_actual: "gpt-5-nano-2026-08-01",
    outcome: "success",
    normalized_error_category: "none",
    attempt_index: 0,
    fallback_depth: 0,
    total_tokens: 42,
    cost_usd: 0.000_02,
    cost_source: "provider",
    latency_ms: 25,
    prompt_name: "draft-post",
    prompt_label: "production",
    prompt_version: 7,
    prompt_is_fallback: false,
    ...overrides,
  };
}

describe("EVAL-203 deterministic evaluators", () => {
  describe("schema validity", () => {
    const outputSchema = z.strictObject({ content: z.string().min(1), score: z.number().min(0) });

    it.each([
      ["valid output", { content: "specific post", score: 1 }, "PASS", undefined],
      ["missing field", { content: "specific post" }, "FAIL", "schema-invalid"],
      [
        "unknown field",
        { content: "specific post", score: 1, extra: true },
        "FAIL",
        "schema-invalid",
      ],
      ["wrong type", { content: "specific post", score: "1" }, "FAIL", "schema-invalid"],
    ] as const)("classifies %s", (_caseName, value, classification, reason) => {
      expectClassification(
        evaluateSchemaValidity({ schema: outputSchema, value }),
        classification,
        reason,
      );
    });

    it("keeps missing or broken validator evidence visible as UNKNOWN", () => {
      expectClassification(evaluateSchemaValidity(undefined), "UNKNOWN", "schema-evidence-missing");
      expectClassification(
        evaluateSchemaValidity({
          schema: {
            safeParse: () => {
              throw new Error("private");
            },
          },
          value: {},
        }),
        "UNKNOWN",
        "schema-validator-error",
      );
      expectClassification(
        evaluateSchemaValidity({ schema: { safeParse: () => ({ success: "yes" }) }, value: {} }),
        "UNKNOWN",
        "schema-validator-error",
      );
    });
  });

  describe("platform limits", () => {
    it.each([
      ["X at boundary", "X", 280, "PASS"],
      ["X over boundary", "X", 281, "FAIL"],
      ["Threads at boundary", "THREADS", 500, "PASS"],
      ["Threads over boundary", "THREADS", 501, "FAIL"],
    ] as const)("classifies %s", (_caseName, network, length, classification) => {
      expectClassification(
        evaluatePlatformLimit({ network, content: "a".repeat(length) }),
        classification,
        classification === "FAIL" ? "platform-limit-exceeded" : undefined,
      );
    });

    it("counts Unicode code points and freezes the supported limits", () => {
      expectClassification(
        evaluatePlatformLimit({ network: "X", content: "🌙".repeat(280) }),
        "PASS",
      );
      expect(EVALUATION_CHARACTER_LIMITS).toEqual({ X: 280, THREADS: 500 });
      expect(Object.isFrozen(EVALUATION_CHARACTER_LIMITS)).toBe(true);
      expect(Object.isFrozen(SAFETY_POLICY_VIOLATIONS)).toBe(true);
      expect(Object.isFrozen(PROHIBITED_EVALUATION_SIDE_EFFECTS)).toBe(true);
    });

    it.each([
      [undefined, "post", "platform-evidence-missing", "UNKNOWN"],
      ["FACEBOOK", "post", "platform-target-unsupported", "FAIL"],
      ["X", 42, "platform-content-invalid", "FAIL"],
    ] as const)(
      "does not pass invalid platform evidence",
      (network, content, reason, classification) => {
        expectClassification(evaluatePlatformLimit({ network, content }), classification, reason);
      },
    );
  });

  describe("safety and policy", () => {
    const cleanEvidence = { status: "known", violations: [] } as const;

    it("passes complete evidence with no deterministic violation", () => {
      expectClassification(
        evaluateSafetyPolicy({ content: "A supported claim.", evidence: cleanEvidence }),
        "PASS",
      );
    });

    it.each(SAFETY_POLICY_VIOLATIONS)("hard-fails the %s safety case", (violation) => {
      expectClassification(
        evaluateSafetyPolicy({
          content: "Candidate output",
          evidence: { status: "known", violations: [violation] },
        }),
        "FAIL",
        "safety-policy-violation",
      );
    });

    it("hard-fails forbidden content and secret-like output without echoing it", () => {
      expectClassification(
        evaluateSafetyPolicy({
          content: "This contains an unsupported certainty",
          evidence: cleanEvidence,
          forbiddenPhrases: ["unsupported certainty"],
        }),
        "FAIL",
        "safety-forbidden-content",
      );

      const secret = "sk-evalsecret12345";
      const outcome = evaluateSafetyPolicy({ content: `leak ${secret}`, evidence: cleanEvidence });
      expectClassification(outcome, "FAIL", "safety-secret-detected");
      expect(JSON.stringify(outcome)).not.toContain(secret);
    });

    it.each([
      [undefined, "safety-evidence-missing"],
      [
        { content: "post", evidence: { status: "unknown", violations: [] } },
        "safety-evidence-unknown",
      ],
      [
        { content: "post", evidence: { status: "known", violations: ["new-policy"] } },
        "safety-evidence-invalid",
      ],
    ] as const)("classifies missing or unknown safety evidence", (input, reason) => {
      expectClassification(evaluateSafetyPolicy(input), "UNKNOWN", reason);
    });
  });

  describe("allowed orchestrator actions and networks", () => {
    it.each([
      [
        "network action",
        { action: "POST", network: "X", allowedActions: ["POST"], enabledNetworks: ["X"] },
        "PASS",
        undefined,
      ],
      [
        "generic action",
        { action: "WAIT", network: "NONE", allowedActions: ["WAIT"], enabledNetworks: [] },
        "PASS",
        undefined,
      ],
      [
        "unknown action",
        { action: "DELETE", allowedActions: ["WAIT"], enabledNetworks: ["X"] },
        "FAIL",
        "action-unknown",
      ],
      [
        "disallowed action",
        { action: "POST", network: "X", allowedActions: ["WAIT"], enabledNetworks: ["X"] },
        "FAIL",
        "action-not-allowed",
      ],
      [
        "missing network",
        { action: "POST", allowedActions: ["POST"], enabledNetworks: ["X"] },
        "FAIL",
        "action-target-required",
      ],
      [
        "disabled network",
        { action: "POST", network: "THREADS", allowedActions: ["POST"], enabledNetworks: ["X"] },
        "FAIL",
        "action-target-disabled",
      ],
      [
        "unexpected network",
        { action: "WAIT", network: "X", allowedActions: ["WAIT"], enabledNetworks: ["X"] },
        "FAIL",
        "action-target-unexpected",
      ],
    ] as const)("classifies %s", (_caseName, input, classification, reason) => {
      expectClassification(evaluateOrchestratorAction(input), classification, reason);
    });

    it("classifies malformed constraints as UNKNOWN instead of passing", () => {
      expectClassification(
        evaluateOrchestratorAction({
          action: "WAIT",
          allowedActions: [],
          enabledNetworks: ["X"],
        }),
        "UNKNOWN",
        "action-constraints-invalid",
      );
    });
  });

  describe("side-effect evidence", () => {
    it("passes only complete evidence with zero prohibited effects", () => {
      expectClassification(
        evaluateSideEffects({
          status: "complete",
          events: PROHIBITED_EVALUATION_SIDE_EFFECTS.map((kind) => ({ kind, count: 0 })),
        }),
        "PASS",
      );
    });

    it.each(PROHIBITED_EVALUATION_SIDE_EFFECTS)("hard-fails observed %s", (kind) => {
      expectClassification(
        evaluateSideEffects({ status: "complete", events: [{ kind, count: 1 }] }),
        "FAIL",
        "eval-side-effect-blocked",
      );
    });

    it.each([
      [undefined, "side-effect-evidence-missing"],
      [{ status: "unknown", events: [] }, "side-effect-evidence-unknown"],
      [
        { status: "complete", events: [{ kind: "future-effect", count: 0 }] },
        "side-effect-evidence-invalid",
      ],
    ] as const)("does not silently pass missing/unknown evidence", (input, reason) => {
      expectClassification(evaluateSideEffects(input), "UNKNOWN", reason);
    });
  });

  describe("telemetry evidence", () => {
    it("passes complete provider, model, prompt, usage, cost and latency evidence", () => {
      expectClassification(
        evaluateTelemetryEvidence({ attempts: [validTelemetryAttempt()] }),
        "PASS",
      );
    });

    it.each([
      ["missing evidence", undefined, "telemetry-evidence-missing"],
      ["no attempts", { attempts: [] }, "telemetry-evidence-missing"],
      [
        "unknown provider",
        { attempts: [validTelemetryAttempt({ provider_actual: "unknown" })] },
        "telemetry-evidence-unknown",
      ],
      [
        "unknown model",
        { attempts: [validTelemetryAttempt({ model_actual: "unspecified" })] },
        "telemetry-evidence-unknown",
      ],
      [
        "unknown usage",
        { attempts: [validTelemetryAttempt({ total_tokens: undefined })] },
        "telemetry-evidence-unknown",
      ],
      [
        "unknown cost",
        { attempts: [validTelemetryAttempt({ cost_source: "unknown", cost_usd: undefined })] },
        "telemetry-evidence-unknown",
      ],
      [
        "unknown prompt",
        { attempts: [validTelemetryAttempt({ prompt_version: undefined })] },
        "telemetry-evidence-unknown",
      ],
    ] as const)("classifies %s as UNKNOWN", (_caseName, input, reason) => {
      expectClassification(evaluateTelemetryEvidence(input), "UNKNOWN", reason);
    });

    it.each([
      ["negative latency", { attempts: [validTelemetryAttempt({ latency_ms: -1 })] }],
      [
        "inconsistent outcome",
        { attempts: [validTelemetryAttempt({ normalized_error_category: "timeout" })] },
      ],
      ["cost without source", { attempts: [validTelemetryAttempt({ cost_source: "unknown" })] }],
    ] as const)("hard-fails %s", (_caseName, input) => {
      expectClassification(evaluateTelemetryEvidence(input), "FAIL", "telemetry-evidence-invalid");
    });

    it.each([
      [
        "secret value",
        { attempts: [validTelemetryAttempt({ model_actual: "sk-evalsecret12345" })] },
      ],
      [
        "secret field",
        { attempts: [validTelemetryAttempt()], surfaces: [{ authorization: "redacted" }] },
      ],
    ] as const)("hard-fails %s without exposing raw evidence", (_caseName, input) => {
      const outcome = evaluateTelemetryEvidence(input);
      expectClassification(outcome, "FAIL", "telemetry-secret-detected");
      expect(JSON.stringify(outcome)).not.toMatch(/evalsecret|authorization/);
    });
  });

  describe("promotion hard-gate summary", () => {
    it("is deterministic, version-stable and cannot average away FAIL or UNKNOWN", () => {
      const inputs = [
        evaluateTelemetryEvidence(undefined),
        evaluatePlatformLimit({ network: "X", content: "a".repeat(281) }),
        evaluateSchemaValidity({ schema: z.string(), value: "valid" }),
        evaluateSafetyPolicy({
          content: "valid",
          evidence: { status: "known", violations: [] },
        }),
        evaluateOrchestratorAction({
          action: "WAIT",
          allowedActions: ["WAIT"],
          enabledNetworks: [],
        }),
        evaluateSideEffects({ status: "complete", events: [] }),
      ] as const;

      const first = runDeterministicEvaluatorSet(inputs);
      const second = runDeterministicEvaluatorSet([...inputs].reverse());

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        evaluatorVersion: "eval-203.v1",
        passed: false,
        eligibleForPromotion: false,
        hardGateFailures: ["code-platform-limit-valid", "code-telemetry-valid"],
      });
      expect(first.results.every((result) => result.evaluatorVersion === "eval-203.v1")).toBe(true);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.results)).toBe(true);
    });

    it("passes only when every supplied hard gate passes", () => {
      const report = runDeterministicEvaluatorSet([
        evaluateSchemaValidity({ schema: z.string(), value: "valid" }),
        evaluatePlatformLimit({ network: "THREADS", content: "valid" }),
        evaluateSafetyPolicy({
          content: "valid",
          evidence: { status: "known", violations: [] },
        }),
        evaluateOrchestratorAction({
          action: "WAIT",
          allowedActions: ["WAIT"],
          enabledNetworks: [],
        }),
        evaluateSideEffects({ status: "complete", events: [] }),
        evaluateTelemetryEvidence({ attempts: [validTelemetryAttempt()] }),
      ]);

      expect(report).toMatchObject({ passed: true, eligibleForPromotion: true });
      expect(report.hardGateFailures).toEqual([]);
    });

    it("fails closed and names every missing required evaluator", () => {
      const report = runDeterministicEvaluatorSet([]);
      expect(report).toMatchObject({
        passed: false,
        eligibleForPromotion: false,
      });
      expect(report.hardGateFailures).toEqual([
        "code-orchestrator-action-valid",
        "code-platform-limit-valid",
        "code-safety-valid",
        "code-schema-valid",
        "code-side-effect-free",
        "code-telemetry-valid",
      ]);
      expect(report.outcomes.every((outcome) => outcome.classification === "UNKNOWN")).toBe(true);
    });
  });
});
