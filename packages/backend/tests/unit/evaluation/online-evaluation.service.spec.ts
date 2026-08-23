import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock("@sentry/nestjs", () => ({ captureMessage: sentryMocks.captureMessage }));

import {
  OnlineEvaluationService,
  deterministicChecks,
} from "../../../src/modules/evaluation/online-evaluation.service.js";

function buildService(overrides: Record<string, unknown> = {}) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => (key in overrides ? overrides[key] : fallback)),
  };
  const discord = {
    warning: vi.fn().mockResolvedValue(undefined),
    critical: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new OnlineEvaluationService(config as never, discord as never),
    discord,
  };
}

const healthyInput = {
  postId: "post-1",
  content: "A useful final post",
  network: "X" as const,
  maxCharacters: 280,
  taskCompleted: true,
  provider: "openai",
  model: "gpt-5-nano",
  promptManaged: true,
  promptLinked: true,
  usageKnown: true,
  costKnown: true,
  fallbackDepth: 0,
};

describe("EVAL-702 OnlineEvaluationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs deterministic checks for every final output", async () => {
    const { service } = buildService({ ONLINE_EVAL_SEMANTIC_SAMPLE_RATE: "0" });
    const result = await service.evaluate(healthyInput, undefined, () => 0.99);

    expect(result.deterministic.passed).toBe(true);
    expect(result.deterministic.checks).toHaveLength(6);
    expect(result.semantic).toMatchObject({ selected: false, status: "NOT_SELECTED" });
  });

  it("force-includes rejections and material edits despite zero random sample", async () => {
    const { service } = buildService({ ONLINE_EVAL_SEMANTIC_SAMPLE_RATE: "0" });
    const result = await service.evaluate(
      { ...healthyInput, decision: "REJECT", normalizedEditDistance: 0.2 },
      async () => ({ passed: false, score: 0.1, reason: "bad" }),
      () => 0.99,
    );

    expect(result.semantic).toMatchObject({
      selected: true,
      forced: true,
      status: "SCORED",
      result: { passed: false, score: 0.1 },
    });
  });

  it("takes exactly the configured random sampling path for ordinary outputs", async () => {
    const { service } = buildService({ ONLINE_EVAL_SEMANTIC_SAMPLE_RATE: "0.05" });
    const notSelected = await service.evaluate(healthyInput, undefined, () => 0.051);
    const selected = await service.evaluate(healthyInput, undefined, () => 0.049);

    expect(notSelected.semantic.selected).toBe(false);
    expect(selected.semantic).toMatchObject({ selected: true, status: "UNAVAILABLE" });
  });

  it("returns explicit deterministic failures for missing attribution and limits", () => {
    const checks = deterministicChecks({
      ...healthyInput,
      content: "x".repeat(281),
      provider: undefined,
      model: undefined,
      usageKnown: false,
      costKnown: false,
      promptLinked: false,
    });

    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "character_limit",
      "provider_model_attributed",
      "usage_cost_coverage",
      "prompt_linkage",
    ]);
  });

  it("maintains bounded SLO snapshots and p95 fallback depth", async () => {
    const { service } = buildService({ ONLINE_EVAL_SEMANTIC_SAMPLE_RATE: "0" });
    for (let index = 0; index < 20; index += 1) {
      await service.evaluate({ ...healthyInput, fallbackDepth: index % 4 });
    }

    const snapshot = service.getSloSnapshot();
    expect(snapshot.sampleCount).toBe(20);
    expect(snapshot.deterministicPassRate).toBe(1);
    expect(snapshot.usageCostCoverage).toBe(1);
    expect(snapshot.promptLinkCoverage).toBe(1);
    expect(snapshot.fallbackDepthP95).toBe(3);
  });

  it("routes threshold alerts to Discord and Sentry with cooldown deduplication", async () => {
    const { service, discord } = buildService({
      ONLINE_EVAL_SEMANTIC_SAMPLE_RATE: "0",
      ONLINE_EVAL_ALERT_COOLDOWN_MS: "1800000",
    });
    for (let index = 0; index < 20; index += 1) {
      await service.evaluate({
        ...healthyInput,
        taskCompleted: index < 18,
      });
    }
    await service.evaluate({ ...healthyInput, taskCompleted: true });

    expect(discord.warning).toHaveBeenCalledWith(
      "[EVAL-A03] Online task completion below 95%",
      "Online task completion below 95%",
      expect.any(Array),
    );
    expect(discord.warning).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
      "Online task completion below 95%",
      expect.objectContaining({ tags: { evaluator_alert_id: "EVAL-A03" } }),
    );
  });

  it("covers the external SLO alert catalog A02 and A07-A12", async () => {
    const { service, discord } = buildService();

    await service.evaluateExternalSignals({
      safetyHardGateFailure: true,
      acceptedOutputCostUsd: 3,
      baselineAcceptedOutputCostUsd7d: 1,
      generationP95LatencyMs: 1600,
      baselineGenerationP95LatencyMs7d: 1000,
      feedbackSyncP95AgeMs: 900_000,
      feedbackSyncFailed: 10,
      humanQuality: 0.7,
      humanQualityBaseline: 0.8,
      humanReviewedSampleCount: 30,
      judgeKappa: 0.5,
      experimentHardGateRegression: true,
    });

    expect(discord.critical).toHaveBeenCalledTimes(2);
    expect(discord.warning).toHaveBeenCalledTimes(4);
    const alertIds = sentryMocks.captureMessage.mock.calls.map(
      ([, context]) =>
        (context as { tags: { evaluator_alert_id: string } }).tags.evaluator_alert_id,
    );
    expect(alertIds).toEqual(
      expect.arrayContaining([
        "EVAL-A02",
        "EVAL-A07",
        "EVAL-A08",
        "EVAL-A09",
        "EVAL-A10",
        "EVAL-A12",
      ]),
    );
    expect(service.getDashboardAlerts()).toEqual([
      expect.objectContaining({ id: "EVAL-A11", severity: "info" }),
    ]);
  });
});
