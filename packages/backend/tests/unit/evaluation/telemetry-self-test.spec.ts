import { describe, expect, it, vi } from "vitest";
import { TokenBudgetExceeded } from "../../../src/infrastructure/llm/token-budget.service.js";
import { normalizeLlmErrorCategory } from "../../../src/infrastructure/llm/llm-attempt-telemetry.js";
import {
  createIncompleteSyntheticTelemetryFixture,
  createSyntheticTelemetryFixture,
} from "../../../src/infrastructure/telemetry/telemetry-self-test.fixture.js";
import {
  TELEMETRY_SELF_TEST_MAX_REPORT_BYTES,
  TelemetrySelfTestReportTooLargeError,
  exerciseDisabledTracingPath,
  runTelemetrySelfTest,
  runTelemetrySelfTestCommand,
  serializeTelemetrySelfTestReport,
  type DisabledTracingPathEvidence,
  type TelemetrySelfTestFixture,
} from "../../../src/infrastructure/telemetry/telemetry-self-test.js";

const SOURCE_SHA = "a".repeat(40);
const DISABLED_PATH: DisabledTracingPathEvidence = {
  is_enabled: false,
  handler_created: false,
  operation_calls: 1,
  operation_result_matches: true,
};

function createCompleteFixture(): TelemetrySelfTestFixture {
  return createSyntheticTelemetryFixture({
    sourceSha: SOURCE_SHA,
    workingTree: "dirty",
    dirtyPathCount: 73,
    disabledPath: DISABLED_PATH,
  });
}

describe("EVAL-104 deterministic telemetry self-test", () => {
  it("reports 100% actual provider/model attribution across a multi-provider fallback", () => {
    const report = runTelemetrySelfTest(createCompleteFixture());

    expect(report.passed).toBe(true);
    expect(report.coverage.attempt_attribution).toMatchObject({
      total: 2,
      covered: 2,
      coverage: 1,
      passed: true,
    });
    expect(report.coverage.multi_provider_fallback).toMatchObject({
      total: 2,
      covered: 2,
      coverage: 1,
      passed: true,
    });
    expect(report.exported_surfaces.attempts).toEqual([
      expect.objectContaining({
        provider_actual: "groq",
        model_actual: "llama-4-scout",
        fallback_depth: 0,
        normalized_error_category: "rate_limit",
      }),
      expect.objectContaining({
        provider_actual: "openai",
        model_actual: "gpt-5-nano-2026-08-01",
        fallback_depth: 1,
        normalized_error_category: "none",
      }),
    ]);
  });

  it("requires exact native prompt identity and explicit fallback label/digest coverage", () => {
    const fixture = createCompleteFixture();
    const report = runTelemetrySelfTest(fixture);

    expect(report.coverage.prompt_native_linkage).toMatchObject({
      total: 1,
      covered: 1,
      coverage: 1,
      passed: true,
    });
    expect(report.coverage.prompt_fallback_identity).toMatchObject({
      total: 1,
      covered: 1,
      coverage: 1,
      passed: true,
    });
    expect(report.exported_surfaces.prompt_references).toEqual([
      expect.objectContaining({
        observation_name: "generation.research_extract",
        prompt_name: "research-extract",
        prompt_label: "production",
        prompt_version: 7,
        prompt_is_fallback: false,
        native_linked: true,
      }),
      expect.objectContaining({
        observation_name: "generation.draft.X",
        prompt_name: "draft-post",
        prompt_label: "production",
        prompt_is_fallback: true,
        prompt_fallback_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        native_linked: false,
      }),
    ]);

    const managedProbe = fixture.promptLinks.find((probe) => !probe.reference.isFallback);
    if (!managedProbe) throw new Error("managed prompt probe missing");
    const mismatched = runTelemetrySelfTest({
      ...fixture,
      promptLinks: [{ ...managedProbe, linkedNativePrompt: {} }, ...fixture.promptLinks.slice(1)],
    });
    expect(mismatched.passed).toBe(false);
    expect(mismatched.failures.map((failure) => failure.code)).toContain(
      "PROMPT_NATIVE_LINK_INCOMPLETE",
    );
  });

  it("accounts for unknown usage/cost explicitly without treating it as zero", () => {
    const report = runTelemetrySelfTest(createCompleteFixture());

    expect(report.coverage.usage_accounting).toMatchObject({
      total: 2,
      covered: 2,
      unknown: 1,
      coverage: 1,
      passed: true,
    });
    expect(report.coverage.cost_accounting).toMatchObject({
      total: 2,
      covered: 2,
      unknown: 1,
      coverage: 1,
      passed: true,
    });
    expect(report.exported_surfaces.attempts[0]).toMatchObject({
      usage_status: "unknown",
      cost_source: "unknown",
    });
    expect(report.exported_surfaces.attempts[1]).toMatchObject({
      usage_status: "known",
      input_tokens: 120,
      output_tokens: 34,
      reasoning_tokens: 8,
      cached_input_tokens: 16,
      total_tokens: 162,
      cost_usd: 0.000_042,
      cost_source: "provider",
      latency_ms: 43,
      time_to_first_token_ms: 12,
    });
  });

  it.each([
    ["rate_limit", Object.assign(new Error("too many requests"), { status: 429 })],
    ["auth", Object.assign(new Error("unauthorized"), { status: 401 })],
    ["billing", Object.assign(new Error("insufficient quota"), { status: 402 })],
    ["timeout", Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })],
    ["model_not_found", Object.assign(new Error("model not found"), { status: 404 })],
    ["empty_output", new Error("provider returned empty output")],
    ["aborted", new DOMException("The operation was aborted", "AbortError")],
    [
      "budget_exceeded",
      new TokenBudgetExceeded("generation", "eval-104", "pre-call reserve over budget"),
    ],
    ["unknown", new Error("unclassified failure")],
  ] as const)("normalizes %s without retaining provider error text", (expected, error) => {
    expect(normalizeLlmErrorCategory(error)).toBe(expected);
  });

  it("exercises the Langfuse-disabled direct path exactly once", async () => {
    const operationWrapper = vi.fn(async (operation: () => Promise<string>): Promise<string> =>
      operation(),
    );
    const createHandler = vi.fn(() => undefined);

    const evidence = await exerciseDisabledTracingPath({
      isEnabled: false,
      createHandler,
      run: operationWrapper,
    });

    expect(evidence).toEqual(DISABLED_PATH);
    expect(createHandler).toHaveBeenCalledOnce();
    expect(operationWrapper).toHaveBeenCalledOnce();
    expect(
      runTelemetrySelfTest({ ...createCompleteFixture(), disabledPath: evidence }).passed,
    ).toBe(true);
    expect(runTelemetrySelfTest(createCompleteFixture()).disabled_path).toEqual(DISABLED_PATH);
  });

  it("removes every injected canary from each exported surface and the report", () => {
    const fixture = createCompleteFixture();
    const report = runTelemetrySelfTest(fixture);
    const serialized = serializeTelemetrySelfTestReport(report);

    expect(report.coverage.redaction_injection).toMatchObject({
      total: fixture.redactionCanaries.length * 4,
      covered: fixture.redactionCanaries.length * 4,
      coverage: 1,
      passed: true,
    });
    expect(report.redaction.surfaces).toHaveLength(5);
    expect(report.redaction.surfaces.every((surface) => surface.leaks_found === 0)).toBe(true);
    for (const canary of fixture.redactionCanaries) {
      expect(JSON.stringify(report.exported_surfaces)).not.toContain(canary.value);
      expect(serialized).not.toContain(canary.value);
    }
    expect(serialized).not.toContain("provider timeout");
    expect(serialized).not.toContain("prompt: private");
  });

  it("returns a nonzero command result for a deliberately incomplete fixture", () => {
    const fixture = createIncompleteSyntheticTelemetryFixture({
      sourceSha: SOURCE_SHA,
      workingTree: "dirty",
      dirtyPathCount: 73,
      disabledPath: DISABLED_PATH,
    });

    const result = runTelemetrySelfTestCommand(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.report.passed).toBe(false);
    expect(result.report.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "ATTEMPT_ATTRIBUTION_INCOMPLETE",
        "MULTI_PROVIDER_FALLBACK_MISSING",
        "PROMPT_NATIVE_LINK_INCOMPLETE",
        "PROMPT_FALLBACK_IDENTITY_INCOMPLETE",
        "LATENCY_COVERAGE_INCOMPLETE",
      ]),
    );
    const serialized = serializeTelemetrySelfTestReport(result.report);
    for (const canary of fixture.redactionCanaries) expect(serialized).not.toContain(canary.value);
  });

  it("serializes deterministically within the bounded report size", () => {
    const fixture = createCompleteFixture();
    const largeMetadata = Array.from({ length: 1_000 }, (_, index) => ({
      index,
      untrusted: "x".repeat(20_000),
    }));
    const largeFixture: TelemetrySelfTestFixture = {
      ...fixture,
      callbackMetadata: [...fixture.callbackMetadata, ...largeMetadata],
      telemetryRecords: [...fixture.telemetryRecords, ...largeMetadata],
    };

    const first = serializeTelemetrySelfTestReport(runTelemetrySelfTest(largeFixture));
    const second = serializeTelemetrySelfTestReport(runTelemetrySelfTest(largeFixture));

    expect(first).toBe(second);
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(
      TELEMETRY_SELF_TEST_MAX_REPORT_BYTES,
    );
    expect(JSON.parse(first)).toMatchObject({
      serialization: {
        max_bytes: TELEMETRY_SELF_TEST_MAX_REPORT_BYTES,
        truncated_samples: 1_987,
      },
    });
    expect(() => serializeTelemetrySelfTestReport(runTelemetrySelfTest(fixture), 100)).toThrow(
      TelemetrySelfTestReportTooLargeError,
    );
  });
});
