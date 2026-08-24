import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  PROMOTION_REQUIRED_HARD_GATES,
  STATISTICAL_COMPARATOR_LIMITS,
  STATISTICAL_COMPARATOR_VERSION,
  STATISTICAL_RESULT_SCHEMA_VERSION,
  assessPairedComparison,
  decidePromotion,
  pairedBootstrap,
  wilsonScoreInterval,
  type BootstrapEstimator,
  type MetricDirection,
  type MetricScale,
  type PairedBootstrapOptions,
  type PairedBootstrapResult,
  type PairedObservation,
  type PromotionHardGateEvidence,
  type PromotionHardGateStatus,
  type PromotionMetricEvidence,
  type PromotionMetricName,
} from "../../../src/modules/evaluation/statistical-comparator.js";

function makePairs(count: number): PairedObservation[] {
  return Array.from({ length: count }, (_, index) => {
    const baseline = 0.4 + (index % 5) * 0.02;
    const improvement = ((index % 7) - 2) * 0.01;
    return {
      pairId: `case-${String(index).padStart(3, "0")}`,
      baseline,
      candidate: baseline + improvement,
    };
  });
}

function bootstrapEvidence(
  low: number,
  high: number,
  direction: MetricDirection = "HIGHER_IS_BETTER",
  scale: MetricScale = "ABSOLUTE",
  estimator: BootstrapEstimator = "MEAN",
): PairedBootstrapResult {
  return Object.freeze({
    schemaVersion: STATISTICAL_RESULT_SCHEMA_VERSION,
    comparatorVersion: STATISTICAL_COMPARATOR_VERSION,
    method: "paired-bootstrap.mulberry32.v1" as const,
    status: "OK" as const,
    seed: 42,
    iterations: 10_000,
    confidenceLevel: 0.95,
    minimumPairs: 50,
    direction,
    scale,
    estimator,
    inputPairCount: 50,
    completePairCount: 50,
    missingPairCount: 0,
    pairSetDigest: "a".repeat(64),
    pointEstimate: (low + high) / 2,
    confidenceInterval: Object.freeze({ low, high }),
    reason: null,
  });
}

function passingHardGates(
  overrides: Readonly<Partial<Record<string, PromotionHardGateStatus>>> = {},
): PromotionHardGateEvidence[] {
  return PROMOTION_REQUIRED_HARD_GATES.map((name) => ({
    name,
    status: overrides[name] ?? "PASS",
  }));
}

type IntervalOverride = Readonly<[low: number, high: number]>;

function promotionMetrics(
  overrides: Readonly<Partial<Record<PromotionMetricName, IntervalOverride>>> = {},
): PromotionMetricEvidence {
  const quality = overrides.quality ?? [0, 0.01];
  const reliability = overrides.reliability ?? [0, 0.01];
  const cost = overrides.cost ?? [0, 0.01];
  const latency = overrides.latency ?? [0, 0.01];
  return {
    quality: bootstrapEvidence(quality[0], quality[1]),
    reliability: bootstrapEvidence(reliability[0], reliability[1]),
    cost: bootstrapEvidence(cost[0], cost[1], "LOWER_IS_BETTER", "RELATIVE"),
    latency: bootstrapEvidence(latency[0], latency[1], "LOWER_IS_BETTER", "RELATIVE", "P95"),
  };
}

function expectJsonSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/NaN|Infinity|undefined/);
  expect(JSON.parse(serialized)).toEqual(value);
}

describe("EVAL-204 statistical comparator", () => {
  describe("Wilson score intervals", () => {
    it.each([
      [0, 0, "NO_CONCLUSION", null, null, "zero-denominator"],
      [0, 1, "OK", 0, 0.793_450_685_6, null],
      [1, 1, "OK", 0.206_549_314_4, 1, null],
      [0, 10, "OK", 0, 0.277_532_800_2, null],
      [10, 10, "OK", 0.722_467_199_8, 1, null],
    ] as const)(
      "handles %i successes over %i trials",
      (successes, total, status, expectedLow, expectedHigh, reason) => {
        const result = wilsonScoreInterval(successes, total);
        expect(result.status).toBe(status);
        expect(result.reason).toBe(reason);
        if (expectedLow === null || expectedHigh === null) {
          expect(result.confidenceInterval).toBeNull();
          return;
        }
        expect(result.confidenceInterval?.low).toBeCloseTo(expectedLow, 8);
        expect(result.confidenceInterval?.high).toBeCloseTo(expectedHigh, 8);
      },
    );

    it("clamps interval boundaries and rejects invalid or unbounded counts", () => {
      for (const [successes, total] of [
        [0, 100],
        [1, 100],
        [99, 100],
        [100, 100],
      ] as const) {
        const interval = wilsonScoreInterval(successes, total).confidenceInterval;
        expect(interval?.low).toBeGreaterThanOrEqual(0);
        expect(interval?.high).toBeLessThanOrEqual(1);
      }

      expect(wilsonScoreInterval(2, 1)).toMatchObject({
        status: "NO_CONCLUSION",
        reason: "invalid-counts",
      });
      expect(
        wilsonScoreInterval(0, STATISTICAL_COMPARATOR_LIMITS.maxBinomialDenominator + 1),
      ).toMatchObject({ status: "NO_CONCLUSION", reason: "input-limit-exceeded" });
      expect(wilsonScoreInterval(1, 1, 1)).toMatchObject({
        status: "NO_CONCLUSION",
        reason: "invalid-confidence-level",
      });
    });
  });

  describe("paired bootstrap", () => {
    const options = Object.freeze({
      seed: 0xdecafbad,
      iterations: 1_000,
      confidenceLevel: 0.95,
      minimumPairs: 50,
      direction: "HIGHER_IS_BETTER" as const,
      scale: "ABSOLUTE" as const,
    });

    it("reproduces the same samples and confidence interval for the same seed", () => {
      const observations = makePairs(60);
      const first = pairedBootstrap(observations, options);
      const second = pairedBootstrap(observations, options);
      const reordered = pairedBootstrap([...observations].reverse(), options);

      expect(first).toEqual(second);
      expect(first).toEqual(reordered);
      expect(first).toMatchObject({
        status: "OK",
        seed: 0xdecafbad,
        iterations: 1_000,
        completePairCount: 60,
        missingPairCount: 0,
      });
      expect(first.pairSetDigest).toMatch(/^[a-f\d]{64}$/);
      expectJsonSafe(first);
    });

    it("keeps the estimate stable but changes resamples with the seed, and reacts to data", () => {
      const observations = makePairs(60);
      const first = pairedBootstrap(observations, { ...options, seed: 1, iterations: 200 });
      const second = pairedBootstrap(observations, { ...options, seed: 2, iterations: 200 });
      expect(first.pointEstimate).toBe(second.pointEstimate);
      expect(first.confidenceInterval).not.toEqual(second.confidenceInterval);

      const changed = observations.map((pair, index) =>
        index === 0 ? { ...pair, candidate: (pair.candidate ?? 0) + 0.5 } : pair,
      );
      const changedResult = pairedBootstrap(changed, { ...options, seed: 1, iterations: 200 });
      expect(changedResult.pointEstimate).not.toBe(first.pointEstimate);
      expect(changedResult.confidenceInterval).not.toEqual(first.confidenceInterval);
    });

    it("computes relative p95 improvement from paired baseline and candidate samples", () => {
      const latencyPairs = Array.from({ length: 50 }, (_, index) => ({
        pairId: `latency-${index}`,
        baseline: index < 47 ? 100 : 1_000,
        candidate: index < 47 ? 95 : 700,
      }));
      const result = pairedBootstrap(latencyPairs, {
        seed: 17,
        iterations: 100,
        minimumPairs: 50,
        direction: "LOWER_IS_BETTER",
        scale: "RELATIVE",
        estimator: "P95",
      });

      // Linear p95: baseline 595, candidate 427.75 at n=50.
      expect(result).toMatchObject({ status: "OK", estimator: "P95" });
      expect(result.pointEstimate).toBeCloseTo((595 - 427.75) / 595, 10);
    });

    it("returns NO_CONCLUSION below the minimum or when any pair is missing", () => {
      expect(pairedBootstrap(makePairs(49), { ...options, iterations: 100 })).toMatchObject({
        status: "NO_CONCLUSION",
        completePairCount: 49,
        reason: "insufficient-sample",
      });
      expect(pairedBootstrap(makePairs(50), { ...options, iterations: 100 }).status).toBe("OK");

      const withMissing = [
        ...makePairs(50),
        { pairId: "case-missing", baseline: 0.5, candidate: null },
      ];
      expect(pairedBootstrap(withMissing, { ...options, iterations: 100 })).toMatchObject({
        status: "NO_CONCLUSION",
        inputPairCount: 51,
        completePairCount: 50,
        missingPairCount: 1,
        reason: "missing-value",
      });
    });

    it("bounds malformed input, iterations and total bootstrap work", () => {
      const duplicate = makePairs(50);
      duplicate[49] = { ...duplicate[49]!, pairId: duplicate[0]!.pairId };
      expect(pairedBootstrap(duplicate, { ...options, iterations: 100 })).toMatchObject({
        status: "NO_CONCLUSION",
        reason: "duplicate-pair-id",
      });

      const invalidValue = makePairs(50);
      invalidValue[0] = { ...invalidValue[0]!, candidate: Number.NaN };
      expect(pairedBootstrap(invalidValue, { ...options, iterations: 100 })).toMatchObject({
        status: "NO_CONCLUSION",
        reason: "invalid-value",
      });

      expect(
        pairedBootstrap(makePairs(50), {
          ...options,
          iterations: STATISTICAL_COMPARATOR_LIMITS.maxBootstrapIterations + 1,
        }),
      ).toMatchObject({ status: "NO_CONCLUSION", reason: "invalid-options" });

      expect(
        pairedBootstrap(
          Array.from(
            { length: STATISTICAL_COMPARATOR_LIMITS.maxPairedObservations + 1 },
            (_, index) => ({ pairId: `large-${index}`, baseline: 1, candidate: 1 }),
          ),
          { ...options, iterations: 100 },
        ),
      ).toMatchObject({ status: "NO_CONCLUSION", reason: "input-limit-exceeded" });

      expect(
        pairedBootstrap(makePairs(101), {
          ...options,
          iterations: STATISTICAL_COMPARATOR_LIMITS.maxBootstrapIterations,
        }),
      ).toMatchObject({ status: "NO_CONCLUSION", reason: "work-limit-exceeded" });

      const relativeWithZero = makePairs(50).map((pair, index) =>
        index === 0 ? { ...pair, baseline: 0, candidate: 0 } : pair,
      );
      expect(
        pairedBootstrap(relativeWithZero, {
          ...options,
          iterations: 100,
          direction: "LOWER_IS_BETTER",
          scale: "RELATIVE",
        }),
      ).toMatchObject({ status: "NO_CONCLUSION", reason: "invalid-relative-baseline" });

      expect(pairedBootstrap(makePairs(50), {} as PairedBootstrapOptions)).toMatchObject({
        status: "NO_CONCLUSION",
        reason: "invalid-options",
      });
    });
  });

  describe("non-inferiority classification", () => {
    it.each([
      [0.05, 0.08, "SUPERIOR"],
      [-0.02, 0.04, "NON_INFERIOR"],
      [-0.021, 0.04, "INCONCLUSIVE"],
      [-0.03, -0.02, "INCONCLUSIVE"],
      [-0.05, -0.020_001, "INFERIOR"],
    ] as const)("classifies CI [%f, %f] as %s", (low, high, status) => {
      expect(
        assessPairedComparison(bootstrapEvidence(low, high), {
          improvementThreshold: 0.05,
          nonInferiorityBoundary: -0.02,
        }).status,
      ).toBe(status);
    });

    it("does not turn missing bootstrap evidence into an inferred winner", () => {
      const noConclusion = pairedBootstrap(makePairs(10), {
        seed: 1,
        iterations: 100,
        minimumPairs: 50,
      });
      expect(
        assessPairedComparison(noConclusion, {
          improvementThreshold: 0.05,
          nonInferiorityBoundary: -0.02,
        }),
      ).toMatchObject({
        status: "NO_CONCLUSION",
        reason: "bootstrap-evidence-unavailable",
      });
    });
  });

  describe("PROMOTE/HOLD/REJECT policy", () => {
    it.each([
      ["quality improvement", { quality: [0.05, 0.07] }, "PROMOTE", ["QUALITY"]],
      [
        "cost improvement with quality non-inferiority",
        { quality: [-0.02, -0.01], cost: [0.2, 0.25] },
        "PROMOTE",
        ["COST"],
      ],
      [
        "latency improvement with quality non-inferiority",
        { quality: [-0.02, -0.01], latency: [0.2, 0.25] },
        "PROMOTE",
        ["LATENCY"],
      ],
      ["no threshold met", { quality: [0.01, 0.04] }, "HOLD", []],
      ["boundary crossed", { quality: [-0.03, 0.06] }, "HOLD", []],
      ["confident quality regression", { quality: [-0.05, -0.021] }, "REJECT", []],
    ] as const)("%s -> %s", (_caseName, overrides, expectedStatus, expectedPaths) => {
      const decision = decidePromotion({
        baselineRunId: "baseline-run-1",
        candidateRunId: "candidate-run-1",
        hardGates: passingHardGates(),
        metrics: promotionMetrics(overrides),
      });

      expect(decision.status).toBe(expectedStatus);
      expect(decision.promotionPaths).toEqual(expectedPaths);
      expect(decision.evidenceStatus).toBe("COMPLETE");
      expectJsonSafe(decision);
    });

    it.each(["safety-policy-compliance", "human-factual-support"])(
      "gives %s hard-gate failure precedence over favorable or missing metrics",
      (failedGate) => {
        const decision = decidePromotion({
          baselineRunId: "baseline-run-1",
          candidateRunId: "candidate-run-1",
          hardGates: passingHardGates({ [failedGate]: "FAIL" }),
          metrics: { quality: null, reliability: null, cost: null, latency: null },
        });
        expect(decision).toMatchObject({
          status: "REJECT",
          rationale: "hard-gate-failure",
          hardGateFailures: [failedGate],
        });
        expect(decision.metricAssessments).toEqual({
          quality: null,
          reliability: null,
          cost: null,
          latency: null,
        });
      },
    );

    it("holds with BLOCKED evidence for unknown/missing gates or metrics", () => {
      const unknownGate = decidePromotion({
        baselineRunId: "baseline-run-1",
        candidateRunId: "candidate-run-1",
        hardGates: passingHardGates({ "human-factual-support": "UNKNOWN" }),
        metrics: promotionMetrics({ quality: [0.05, 0.07] }),
      });
      expect(unknownGate).toMatchObject({
        status: "HOLD",
        evidenceStatus: "BLOCKED",
        rationale: "evidence-blocked",
      });
      expect(unknownGate.hardGateUnknowns).toContain("human-factual-support");

      const missingGate = decidePromotion({
        baselineRunId: "baseline-run-1",
        candidateRunId: "candidate-run-1",
        hardGates: passingHardGates().filter((gate) => gate.name !== "budget-ceiling"),
        metrics: promotionMetrics({ quality: [0.05, 0.07] }),
      });
      expect(missingGate.status).toBe("HOLD");
      expect(missingGate.hardGateUnknowns).toContain("budget-ceiling");

      const missingMetric = decidePromotion({
        baselineRunId: "baseline-run-1",
        candidateRunId: "candidate-run-1",
        hardGates: passingHardGates(),
        metrics: { ...promotionMetrics({ quality: [0.05, 0.07] }), cost: null },
      });
      expect(missingMetric).toMatchObject({
        status: "HOLD",
        evidenceStatus: "BLOCKED",
        rationale: "evidence-blocked",
      });
      expect(missingMetric.blockingEvidence).toContain("cost:missing-or-invalid");
    });

    it("blocks promotion for an undersized or mismatched paired cohort", () => {
      const metrics = promotionMetrics({ quality: [0.05, 0.07] });
      const undersizedQuality = Object.freeze({
        ...metrics.quality!,
        minimumPairs: 2,
        inputPairCount: 49,
        completePairCount: 49,
      });
      const undersized = decidePromotion({
        baselineRunId: "baseline-run-1",
        candidateRunId: "candidate-run-1",
        hardGates: passingHardGates(),
        metrics: { ...metrics, quality: undersizedQuality },
      });
      expect(undersized).toMatchObject({ status: "HOLD", evidenceStatus: "BLOCKED" });
      expect(undersized.blockingEvidence).toContain("quality:insufficient-promotion-sample");

      const mismatchedCost = Object.freeze({
        ...metrics.cost!,
        pairSetDigest: "b".repeat(64),
      });
      const mismatched = decidePromotion({
        baselineRunId: "baseline-run-1",
        candidateRunId: "candidate-run-1",
        hardGates: passingHardGates(),
        metrics: { ...metrics, cost: mismatchedCost },
      });
      expect(mismatched).toMatchObject({ status: "HOLD", evidenceStatus: "BLOCKED" });
      expect(mismatched.blockingEvidence).toContain("metric-pair-set-mismatch");
    });
  });

  it("keeps public result versions and immutable JSON boundaries stable", () => {
    expect(STATISTICAL_COMPARATOR_VERSION).toBe("eval-204.v1");
    expect(STATISTICAL_RESULT_SCHEMA_VERSION).toBe("1");
    expect(Object.isFrozen(STATISTICAL_COMPARATOR_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROMOTION_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(PROMOTION_REQUIRED_HARD_GATES)).toBe(true);

    const wilson = wilsonScoreInterval(5, 10);
    const bootstrap = pairedBootstrap(makePairs(50), {
      seed: 7,
      iterations: 100,
      minimumPairs: 50,
    });
    const decision = decidePromotion({
      baselineRunId: "baseline-run-1",
      candidateRunId: "candidate-run-1",
      hardGates: passingHardGates(),
      metrics: promotionMetrics(),
    });

    for (const result of [wilson, bootstrap, decision]) {
      expect(result).toMatchObject({
        schemaVersion: "1",
        comparatorVersion: "eval-204.v1",
      });
      expect(Object.isFrozen(result)).toBe(true);
      expectJsonSafe(result);
    }
    expect(Object.isFrozen(wilson.confidenceInterval)).toBe(true);
    expect(Object.isFrozen(bootstrap.confidenceInterval)).toBe(true);
    expect(Object.isFrozen(decision.metricAssessments)).toBe(true);
    expect(Object.isFrozen(decision.confidenceIntervals)).toBe(true);
  });
});
