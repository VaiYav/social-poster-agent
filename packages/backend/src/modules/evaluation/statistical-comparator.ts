/**
 * Pure, infrastructure-free statistics and promotion policy for EVAL-204.
 *
 * Every public result is versioned, JSON-safe and fail-closed. Missing values
 * are never coerced to zero and hard-gate failures are evaluated before any
 * statistical comparison.
 */

import { createHash } from "node:crypto";

export const STATISTICAL_COMPARATOR_VERSION = "eval-204.v1" as const;
export const STATISTICAL_RESULT_SCHEMA_VERSION = "1" as const;

export const DEFAULT_CONFIDENCE_LEVEL = 0.95;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
export const DEFAULT_MINIMUM_PAIRED_SAMPLES = 50;

export const STATISTICAL_COMPARATOR_LIMITS = Object.freeze({
  maxBinomialDenominator: 1_000_000_000,
  maxPairedObservations: 10_000,
  minBootstrapIterations: 100,
  maxBootstrapIterations: 100_000,
  maxBootstrapDraws: 10_000_000,
  minConfidenceLevel: 0.5,
  maxConfidenceLevel: 0.999,
  maxPairIdLength: 128,
  maxAbsoluteMetricValue: 1_000_000_000_000,
  maxAbsoluteRelativeDelta: 1_000_000,
  maxHardGates: 64,
} as const);

export interface NumericInterval {
  readonly low: number;
  readonly high: number;
}

export type StatisticalEvidenceStatus = "OK" | "NO_CONCLUSION";

export type WilsonNoConclusionReason =
  | "invalid-counts"
  | "invalid-confidence-level"
  | "input-limit-exceeded"
  | "zero-denominator";

export interface WilsonIntervalResult {
  readonly schemaVersion: typeof STATISTICAL_RESULT_SCHEMA_VERSION;
  readonly comparatorVersion: typeof STATISTICAL_COMPARATOR_VERSION;
  readonly method: "wilson-score";
  readonly status: StatisticalEvidenceStatus;
  readonly successes: number | null;
  readonly total: number | null;
  readonly confidenceLevel: number | null;
  readonly estimate: number | null;
  readonly confidenceInterval: Readonly<NumericInterval> | null;
  readonly reason: WilsonNoConclusionReason | null;
}

export type MetricDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
export type MetricScale = "ABSOLUTE" | "RELATIVE";
export type BootstrapEstimator = "MEAN" | "P95";

export interface PairedObservation {
  readonly pairId: string;
  readonly baseline: number | null;
  readonly candidate: number | null;
}

export interface PairedBootstrapOptions {
  /** Required deterministic unsigned 32-bit seed. */
  readonly seed: number;
  readonly iterations?: number;
  readonly confidenceLevel?: number;
  readonly minimumPairs?: number;
  readonly direction?: MetricDirection;
  /** RELATIVE expresses improvement as a fraction of the positive baseline. */
  readonly scale?: MetricScale;
  readonly estimator?: BootstrapEstimator;
}

export type PairedBootstrapNoConclusionReason =
  | "duplicate-pair-id"
  | "input-limit-exceeded"
  | "insufficient-sample"
  | "invalid-observation"
  | "invalid-options"
  | "invalid-relative-baseline"
  | "invalid-value"
  | "missing-value"
  | "work-limit-exceeded";

export interface PairedBootstrapResult {
  readonly schemaVersion: typeof STATISTICAL_RESULT_SCHEMA_VERSION;
  readonly comparatorVersion: typeof STATISTICAL_COMPARATOR_VERSION;
  readonly method: "paired-bootstrap.mulberry32.v1";
  readonly status: StatisticalEvidenceStatus;
  readonly seed: number | null;
  readonly iterations: number | null;
  readonly confidenceLevel: number | null;
  readonly minimumPairs: number | null;
  readonly direction: MetricDirection | null;
  readonly scale: MetricScale | null;
  readonly estimator: BootstrapEstimator | null;
  readonly inputPairCount: number;
  readonly completePairCount: number;
  readonly missingPairCount: number;
  readonly pairSetDigest: string | null;
  /** Positive values always favor the candidate. */
  readonly pointEstimate: number | null;
  readonly confidenceInterval: Readonly<NumericInterval> | null;
  readonly reason: PairedBootstrapNoConclusionReason | null;
}

export interface ComparisonThresholds {
  readonly improvementThreshold: number;
  readonly nonInferiorityBoundary: number;
}

export type ComparisonAssessmentStatus =
  | "SUPERIOR"
  | "NON_INFERIOR"
  | "INCONCLUSIVE"
  | "INFERIOR"
  | "NO_CONCLUSION";

export interface ComparisonAssessment {
  readonly schemaVersion: typeof STATISTICAL_RESULT_SCHEMA_VERSION;
  readonly comparatorVersion: typeof STATISTICAL_COMPARATOR_VERSION;
  readonly status: ComparisonAssessmentStatus;
  readonly pointEstimate: number | null;
  readonly confidenceInterval: Readonly<NumericInterval> | null;
  readonly improvementThreshold: number | null;
  readonly nonInferiorityBoundary: number | null;
  readonly reason:
    | "bootstrap-evidence-unavailable"
    | "confidence-interval-below-non-inferiority"
    | "confidence-interval-crosses-boundary"
    | "confidence-interval-meets-improvement"
    | "confidence-interval-meets-non-inferiority"
    | "invalid-bootstrap-result"
    | "invalid-thresholds";
}

export const PROMOTION_REQUIRED_HARD_GATES = Object.freeze([
  "schema-compliance",
  "platform-limit-compliance",
  "safety-policy-compliance",
  "task-completion",
  "invalid-structured-output",
  "human-factual-support",
  "provider-model-attribution",
  "token-cost-telemetry-coverage",
  "budget-ceiling",
] as const);

export type PromotionHardGateStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface PromotionHardGateEvidence {
  readonly name: string;
  readonly status: PromotionHardGateStatus;
}

export interface PromotionThresholds {
  readonly qualityImprovement: number;
  readonly qualityNonInferiority: number;
  readonly reliabilityImprovement: number;
  readonly reliabilityNonInferiority: number;
  readonly costImprovement: number;
  readonly costNonInferiority: number;
  readonly latencyImprovement: number;
  readonly latencyNonInferiority: number;
}

export const DEFAULT_PROMOTION_THRESHOLDS = Object.freeze({
  qualityImprovement: 0.05,
  qualityNonInferiority: -0.02,
  reliabilityImprovement: 0.05,
  reliabilityNonInferiority: 0,
  costImprovement: 0.2,
  costNonInferiority: 0,
  latencyImprovement: 0.2,
  latencyNonInferiority: 0,
} satisfies PromotionThresholds);

export type PromotionMetricName = "quality" | "reliability" | "cost" | "latency";
export type PromotionPath = "QUALITY" | "COST" | "LATENCY";

export interface PromotionMetricEvidence {
  readonly quality: PairedBootstrapResult | null;
  readonly reliability: PairedBootstrapResult | null;
  readonly cost: PairedBootstrapResult | null;
  readonly latency: PairedBootstrapResult | null;
}

export interface PromotionPolicyInput {
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly hardGates: readonly PromotionHardGateEvidence[];
  readonly metrics: PromotionMetricEvidence;
  readonly thresholds?: Partial<PromotionThresholds>;
}

export interface PromotionDecision {
  readonly schemaVersion: typeof STATISTICAL_RESULT_SCHEMA_VERSION;
  readonly comparatorVersion: typeof STATISTICAL_COMPARATOR_VERSION;
  readonly status: "PROMOTE" | "HOLD" | "REJECT";
  readonly evidenceStatus: "COMPLETE" | "BLOCKED";
  readonly baselineRunId: string | null;
  readonly candidateRunId: string | null;
  readonly hardGateFailures: readonly string[];
  readonly hardGateUnknowns: readonly string[];
  readonly blockingEvidence: readonly string[];
  readonly confidenceIntervals: Readonly<
    Record<PromotionMetricName, Readonly<NumericInterval> | null>
  >;
  readonly metricAssessments: Readonly<
    Record<PromotionMetricName, Readonly<ComparisonAssessment> | null>
  >;
  readonly promotionPaths: readonly PromotionPath[];
  readonly thresholds: Readonly<PromotionThresholds> | null;
  readonly rationale:
    | "comparison-inconclusive"
    | "evidence-blocked"
    | "hard-gate-failure"
    | "metric-regression"
    | "promotion-threshold-met";
}

interface ResolvedBootstrapOptions {
  readonly seed: number;
  readonly iterations: number;
  readonly confidenceLevel: number;
  readonly minimumPairs: number;
  readonly direction: MetricDirection;
  readonly scale: MetricScale;
  readonly estimator: BootstrapEstimator;
}

const PAIR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UINT32_MAX = 0xffff_ffff;
const PROMOTION_METRIC_NAMES = Object.freeze([
  "quality",
  "reliability",
  "cost",
  "latency",
] as const satisfies readonly PromotionMetricName[]);
const BOOTSTRAP_OPTION_KEYS = new Set([
  "seed",
  "iterations",
  "confidenceLevel",
  "minimumPairs",
  "direction",
  "scale",
  "estimator",
]);
const PAIRED_OBSERVATION_KEYS = new Set(["pairId", "baseline", "candidate"]);
const PROMOTION_THRESHOLD_KEYS = new Set<keyof PromotionThresholds>([
  "qualityImprovement",
  "qualityNonInferiority",
  "reliabilityImprovement",
  "reliabilityNonInferiority",
  "costImprovement",
  "costNonInferiority",
  "latencyImprovement",
  "latencyNonInferiority",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isFiniteBoundedNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= STATISTICAL_COMPARATOR_LIMITS.maxAbsoluteMetricValue
  );
}

function isConfidenceLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= STATISTICAL_COMPARATOR_LIMITS.minConfidenceLevel &&
    value <= STATISTICAL_COMPARATOR_LIMITS.maxConfidenceLevel
  );
}

function isStableIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= STATISTICAL_COMPARATOR_LIMITS.maxPairIdLength &&
    PAIR_ID_PATTERN.test(value)
  );
}

function freezeInterval(low: number, high: number): Readonly<NumericInterval> {
  return Object.freeze({ low, high });
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Acklam's deterministic rational approximation of the standard-normal quantile. */
function inverseStandardNormal(probability: number): number {
  const a = [
    -39.696_830_286_653_76, 220.946_098_424_520_5, -275.928_510_446_968_7, 138.357_751_867_269,
    -30.664_798_066_147_16, 2.506_628_277_459_239,
  ] as const;
  const b = [
    -54.476_098_798_224_06, 161.585_836_858_040_9, -155.698_979_859_886_6, 66.801_311_887_719_72,
    -13.280_681_552_885_72,
  ] as const;
  const c = [
    -0.007_784_894_002_430_293, -0.322_396_458_041_136_5, -2.400_758_277_161_838,
    -2.549_732_539_343_734, 4.374_664_141_464_968, 2.938_163_982_698_783,
  ] as const;
  const d = [
    0.007_784_695_709_041_462, 0.322_467_129_070_039_8, 2.445_134_137_142_996,
    3.754_408_661_907_416,
  ] as const;
  const lowerBoundary = 0.024_25;
  const upperBoundary = 1 - lowerBoundary;

  if (probability < lowerBoundary) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  if (probability <= upperBoundary) {
    const q = probability - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }

  const q = Math.sqrt(-2 * Math.log(1 - probability));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

function createWilsonNoConclusion(
  successes: unknown,
  total: unknown,
  confidenceLevel: unknown,
  reason: WilsonNoConclusionReason,
): WilsonIntervalResult {
  return Object.freeze({
    schemaVersion: STATISTICAL_RESULT_SCHEMA_VERSION,
    comparatorVersion: STATISTICAL_COMPARATOR_VERSION,
    method: "wilson-score" as const,
    status: "NO_CONCLUSION" as const,
    successes: Number.isSafeInteger(successes) ? (successes as number) : null,
    total: Number.isSafeInteger(total) ? (total as number) : null,
    confidenceLevel:
      typeof confidenceLevel === "number" && Number.isFinite(confidenceLevel)
        ? confidenceLevel
        : null,
    estimate: null,
    confidenceInterval: null,
    reason,
  });
}

/** Compute a two-sided Wilson score interval for a binomial proportion. */
export function wilsonScoreInterval(
  successes: number,
  total: number,
  confidenceLevel: number = DEFAULT_CONFIDENCE_LEVEL,
): WilsonIntervalResult {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(total) ||
    successes < 0 ||
    total < 0 ||
    successes > total
  ) {
    return createWilsonNoConclusion(successes, total, confidenceLevel, "invalid-counts");
  }
  if (total > STATISTICAL_COMPARATOR_LIMITS.maxBinomialDenominator) {
    return createWilsonNoConclusion(successes, total, confidenceLevel, "input-limit-exceeded");
  }
  if (!isConfidenceLevel(confidenceLevel)) {
    return createWilsonNoConclusion(successes, total, confidenceLevel, "invalid-confidence-level");
  }
  if (total === 0) {
    return createWilsonNoConclusion(successes, total, confidenceLevel, "zero-denominator");
  }

  const estimate = successes / total;
  const z = inverseStandardNormal(0.5 + confidenceLevel / 2);
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (estimate + zSquared / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((estimate * (1 - estimate) + zSquared / (4 * total)) / total)) / denominator;
  const low = successes === 0 ? 0 : clampProbability(center - margin);
  const high = successes === total ? 1 : clampProbability(center + margin);

  return Object.freeze({
    schemaVersion: STATISTICAL_RESULT_SCHEMA_VERSION,
    comparatorVersion: STATISTICAL_COMPARATOR_VERSION,
    method: "wilson-score" as const,
    status: "OK" as const,
    successes,
    total,
    confidenceLevel,
    estimate,
    confidenceInterval: freezeInterval(low, high),
    reason: null,
  });
}

function resolveBootstrapOptions(input: unknown): ResolvedBootstrapOptions | null {
  if (!isPlainRecord(input) || Object.keys(input).some((key) => !BOOTSTRAP_OPTION_KEYS.has(key))) {
    return null;
  }

  const iterations = input.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const confidenceLevel = input.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;
  const minimumPairs = input.minimumPairs ?? DEFAULT_MINIMUM_PAIRED_SAMPLES;
  const direction = input.direction ?? "HIGHER_IS_BETTER";
  const scale = input.scale ?? "ABSOLUTE";
  const estimator = input.estimator ?? "MEAN";

  if (
    !Number.isSafeInteger(input.seed) ||
    (input.seed as number) < 0 ||
    (input.seed as number) > UINT32_MAX ||
    !Number.isSafeInteger(iterations) ||
    (iterations as number) < STATISTICAL_COMPARATOR_LIMITS.minBootstrapIterations ||
    (iterations as number) > STATISTICAL_COMPARATOR_LIMITS.maxBootstrapIterations ||
    !Number.isSafeInteger(minimumPairs) ||
    (minimumPairs as number) < 2 ||
    (minimumPairs as number) > STATISTICAL_COMPARATOR_LIMITS.maxPairedObservations ||
    !isConfidenceLevel(confidenceLevel) ||
    (direction !== "HIGHER_IS_BETTER" && direction !== "LOWER_IS_BETTER") ||
    (scale !== "ABSOLUTE" && scale !== "RELATIVE") ||
    (estimator !== "MEAN" && estimator !== "P95")
  ) {
    return null;
  }

  return Object.freeze({
    seed: input.seed as number,
    iterations: iterations as number,
    confidenceLevel,
    minimumPairs: minimumPairs as number,
    direction,
    scale,
    estimator,
  });
}

function createBootstrapNoConclusion(
  inputPairCount: number,
  options: ResolvedBootstrapOptions | null,
  reason: PairedBootstrapNoConclusionReason,
  completePairCount = 0,
  missingPairCount = 0,
): PairedBootstrapResult {
  return Object.freeze({
    schemaVersion: STATISTICAL_RESULT_SCHEMA_VERSION,
    comparatorVersion: STATISTICAL_COMPARATOR_VERSION,
    method: "paired-bootstrap.mulberry32.v1" as const,
    status: "NO_CONCLUSION" as const,
    seed: options?.seed ?? null,
    iterations: options?.iterations ?? null,
    confidenceLevel: options?.confidenceLevel ?? null,
    minimumPairs: options?.minimumPairs ?? null,
    direction: options?.direction ?? null,
    scale: options?.scale ?? null,
    estimator: options?.estimator ?? null,
    inputPairCount,
    completePairCount,
    missingPairCount,
    pairSetDigest: null,
    pointEstimate: null,
    confidenceInterval: null,
    reason,
  });
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function arithmeticMean(values: ArrayLike<number>): number {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) total += values[index] as number;
  return total / values.length;
}

function sortedQuantile(values: Float64Array, probability: number): number {
  const position = probability * (values.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = values[lowerIndex] as number;
  if (lowerIndex === upperIndex) return lower;
  const upper = values[upperIndex] as number;
  return lower + (upper - lower) * (position - lowerIndex);
}

function calculateStatistic(values: readonly number[], estimator: BootstrapEstimator): number {
  if (estimator === "MEAN") return arithmeticMean(values);
  const sorted = Float64Array.from(values);
  sorted.sort();
  return sortedQuantile(sorted, 0.95);
}

function calculateImprovement(
  baselineStatistic: number,
  candidateStatistic: number,
  options: ResolvedBootstrapOptions,
): number | null {
  const absoluteImprovement =
    options.direction === "HIGHER_IS_BETTER"
      ? candidateStatistic - baselineStatistic
      : baselineStatistic - candidateStatistic;
  const improvement =
    options.scale === "RELATIVE" ? absoluteImprovement / baselineStatistic : absoluteImprovement;
  const maximum =
    options.scale === "RELATIVE"
      ? STATISTICAL_COMPARATOR_LIMITS.maxAbsoluteRelativeDelta
      : STATISTICAL_COMPARATOR_LIMITS.maxAbsoluteMetricValue;
  return Number.isFinite(improvement) && Math.abs(improvement) <= maximum ? improvement : null;
}

/**
 * Bootstrap a paired mean or p95 candidate improvement. Missing pairs
 * invalidate the conclusion instead of silently changing the denominator.
 */
export function pairedBootstrap(
  observations: readonly PairedObservation[],
  rawOptions: PairedBootstrapOptions,
): PairedBootstrapResult {
  const options = resolveBootstrapOptions(rawOptions);
  const inputPairCount = Array.isArray(observations) ? observations.length : 0;
  if (!options) {
    return createBootstrapNoConclusion(inputPairCount, null, "invalid-options");
  }
  if (!Array.isArray(observations)) {
    return createBootstrapNoConclusion(0, options, "invalid-observation");
  }
  if (observations.length > STATISTICAL_COMPARATOR_LIMITS.maxPairedObservations) {
    return createBootstrapNoConclusion(inputPairCount, options, "input-limit-exceeded");
  }
  if (
    options.iterations * Math.max(observations.length, 1) >
    STATISTICAL_COMPARATOR_LIMITS.maxBootstrapDraws
  ) {
    return createBootstrapNoConclusion(inputPairCount, options, "work-limit-exceeded");
  }

  const pairIds = new Set<string>();
  const completePairs: Array<{ pairId: string; baseline: number; candidate: number }> = [];
  let missingPairCount = 0;

  for (const observation of observations as readonly unknown[]) {
    if (
      !isPlainRecord(observation) ||
      Object.keys(observation).some((key) => !PAIRED_OBSERVATION_KEYS.has(key)) ||
      !isStableIdentifier(observation.pairId)
    ) {
      return createBootstrapNoConclusion(
        inputPairCount,
        options,
        "invalid-observation",
        completePairs.length,
        missingPairCount,
      );
    }
    if (pairIds.has(observation.pairId)) {
      return createBootstrapNoConclusion(
        inputPairCount,
        options,
        "duplicate-pair-id",
        completePairs.length,
        missingPairCount,
      );
    }
    pairIds.add(observation.pairId);

    if (
      observation.baseline === null ||
      observation.baseline === undefined ||
      observation.candidate === null ||
      observation.candidate === undefined
    ) {
      missingPairCount += 1;
      continue;
    }
    if (
      !isFiniteBoundedNumber(observation.baseline) ||
      !isFiniteBoundedNumber(observation.candidate)
    ) {
      return createBootstrapNoConclusion(
        inputPairCount,
        options,
        "invalid-value",
        completePairs.length,
        missingPairCount,
      );
    }

    if (options.scale === "RELATIVE") {
      if (observation.baseline <= 0 || observation.candidate < 0) {
        return createBootstrapNoConclusion(
          inputPairCount,
          options,
          "invalid-relative-baseline",
          completePairs.length,
          missingPairCount,
        );
      }
    }
    completePairs.push({
      pairId: observation.pairId,
      baseline: observation.baseline,
      candidate: observation.candidate,
    });
  }

  if (missingPairCount > 0) {
    return createBootstrapNoConclusion(
      inputPairCount,
      options,
      "missing-value",
      completePairs.length,
      missingPairCount,
    );
  }
  if (completePairs.length < options.minimumPairs) {
    return createBootstrapNoConclusion(
      inputPairCount,
      options,
      "insufficient-sample",
      completePairs.length,
      0,
    );
  }

  completePairs.sort((left, right) =>
    left.pairId < right.pairId ? -1 : left.pairId > right.pairId ? 1 : 0,
  );
  const baselineValues = completePairs.map((pair) => pair.baseline);
  const candidateValues = completePairs.map((pair) => pair.candidate);
  const pairSetDigest = createHash("sha256")
    .update(JSON.stringify(completePairs.map((pair) => pair.pairId)), "utf8")
    .digest("hex");

  const baselineStatistic = calculateStatistic(baselineValues, options.estimator);
  const candidateStatistic = calculateStatistic(candidateValues, options.estimator);
  const pointEstimate = calculateImprovement(baselineStatistic, candidateStatistic, options);
  if (pointEstimate === null) {
    return createBootstrapNoConclusion(
      inputPairCount,
      options,
      "invalid-value",
      baselineValues.length,
      0,
    );
  }

  const random = createMulberry32(options.seed);
  const bootstrapStatistics = new Float64Array(options.iterations);
  const sampledBaseline =
    options.estimator === "P95" ? new Float64Array(baselineValues.length) : null;
  const sampledCandidate =
    options.estimator === "P95" ? new Float64Array(candidateValues.length) : null;
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let baselineTotal = 0;
    let candidateTotal = 0;
    for (let draw = 0; draw < baselineValues.length; draw += 1) {
      const index = Math.floor(random() * baselineValues.length);
      const baseline = baselineValues[index] as number;
      const candidate = candidateValues[index] as number;
      if (sampledBaseline && sampledCandidate) {
        sampledBaseline[draw] = baseline;
        sampledCandidate[draw] = candidate;
      } else {
        baselineTotal += baseline;
        candidateTotal += candidate;
      }
    }
    let sampledBaselineStatistic: number;
    let sampledCandidateStatistic: number;
    if (sampledBaseline && sampledCandidate) {
      sampledBaseline.sort();
      sampledCandidate.sort();
      sampledBaselineStatistic = sortedQuantile(sampledBaseline, 0.95);
      sampledCandidateStatistic = sortedQuantile(sampledCandidate, 0.95);
    } else {
      sampledBaselineStatistic = baselineTotal / baselineValues.length;
      sampledCandidateStatistic = candidateTotal / candidateValues.length;
    }
    const improvement = calculateImprovement(
      sampledBaselineStatistic,
      sampledCandidateStatistic,
      options,
    );
    if (improvement === null) {
      return createBootstrapNoConclusion(
        inputPairCount,
        options,
        "invalid-value",
        baselineValues.length,
        0,
      );
    }
    bootstrapStatistics[iteration] = improvement;
  }
  bootstrapStatistics.sort();

  const tailProbability = (1 - options.confidenceLevel) / 2;
  const low = sortedQuantile(bootstrapStatistics, tailProbability);
  const high = sortedQuantile(bootstrapStatistics, 1 - tailProbability);

  if (![low, high, pointEstimate].every(Number.isFinite)) {
    return createBootstrapNoConclusion(
      inputPairCount,
      options,
      "invalid-value",
      baselineValues.length,
      0,
    );
  }

  return Object.freeze({
    schemaVersion: STATISTICAL_RESULT_SCHEMA_VERSION,
    comparatorVersion: STATISTICAL_COMPARATOR_VERSION,
    method: "paired-bootstrap.mulberry32.v1" as const,
    status: "OK" as const,
    seed: options.seed,
    iterations: options.iterations,
    confidenceLevel: options.confidenceLevel,
    minimumPairs: options.minimumPairs,
    direction: options.direction,
    scale: options.scale,
    estimator: options.estimator,
    inputPairCount,
    completePairCount: baselineValues.length,
    missingPairCount: 0,
    pairSetDigest,
    pointEstimate,
    confidenceInterval: freezeInterval(low, high),
    reason: null,
  });
}

function isValidNumericInterval(value: unknown): value is NumericInterval {
  return (
    isPlainRecord(value) &&
    typeof value.low === "number" &&
    Number.isFinite(value.low) &&
    typeof value.high === "number" &&
    Number.isFinite(value.high) &&
    value.low <= value.high
  );
}

type UsablePairedBootstrapResult = PairedBootstrapResult & {
  readonly status: "OK";
  readonly seed: number;
  readonly iterations: number;
  readonly confidenceLevel: number;
  readonly minimumPairs: number;
  readonly direction: MetricDirection;
  readonly scale: MetricScale;
  readonly estimator: BootstrapEstimator;
  readonly pairSetDigest: string;
  readonly pointEstimate: number;
  readonly confidenceInterval: Readonly<NumericInterval>;
  readonly reason: null;
};

function isUsableBootstrapResult(value: unknown): value is UsablePairedBootstrapResult {
  if (!isPlainRecord(value)) return false;
  return (
    value.schemaVersion === STATISTICAL_RESULT_SCHEMA_VERSION &&
    value.comparatorVersion === STATISTICAL_COMPARATOR_VERSION &&
    value.method === "paired-bootstrap.mulberry32.v1" &&
    value.status === "OK" &&
    Number.isSafeInteger(value.seed) &&
    (value.seed as number) >= 0 &&
    (value.seed as number) <= UINT32_MAX &&
    Number.isSafeInteger(value.iterations) &&
    (value.iterations as number) >= STATISTICAL_COMPARATOR_LIMITS.minBootstrapIterations &&
    (value.iterations as number) <= STATISTICAL_COMPARATOR_LIMITS.maxBootstrapIterations &&
    isConfidenceLevel(value.confidenceLevel) &&
    Number.isSafeInteger(value.minimumPairs) &&
    (value.minimumPairs as number) >= 2 &&
    Number.isSafeInteger(value.inputPairCount) &&
    (value.inputPairCount as number) <= STATISTICAL_COMPARATOR_LIMITS.maxPairedObservations &&
    Number.isSafeInteger(value.completePairCount) &&
    value.inputPairCount === value.completePairCount &&
    value.missingPairCount === 0 &&
    (value.completePairCount as number) >= (value.minimumPairs as number) &&
    (value.iterations as number) * (value.completePairCount as number) <=
      STATISTICAL_COMPARATOR_LIMITS.maxBootstrapDraws &&
    typeof value.pairSetDigest === "string" &&
    /^[a-f\d]{64}$/i.test(value.pairSetDigest) &&
    isFiniteBoundedNumber(value.pointEstimate) &&
    isValidNumericInterval(value.confidenceInterval) &&
    value.reason === null &&
    (value.direction === "HIGHER_IS_BETTER" || value.direction === "LOWER_IS_BETTER") &&
    (value.scale === "ABSOLUTE" || value.scale === "RELATIVE") &&
    (value.estimator === "MEAN" || value.estimator === "P95")
  );
}

function createComparisonAssessment(
  status: ComparisonAssessmentStatus,
  result: PairedBootstrapResult | null,
  thresholds: ComparisonThresholds | null,
  reason: ComparisonAssessment["reason"],
): ComparisonAssessment {
  const interval =
    result && isValidNumericInterval(result.confidenceInterval)
      ? freezeInterval(result.confidenceInterval.low, result.confidenceInterval.high)
      : null;
  return Object.freeze({
    schemaVersion: STATISTICAL_RESULT_SCHEMA_VERSION,
    comparatorVersion: STATISTICAL_COMPARATOR_VERSION,
    status,
    pointEstimate:
      result && typeof result.pointEstimate === "number" && Number.isFinite(result.pointEstimate)
        ? result.pointEstimate
        : null,
    confidenceInterval: interval,
    improvementThreshold: thresholds?.improvementThreshold ?? null,
    nonInferiorityBoundary: thresholds?.nonInferiorityBoundary ?? null,
    reason,
  });
}

/** Classify an already paired interval against superiority and non-inferiority boundaries. */
export function assessPairedComparison(
  result: PairedBootstrapResult,
  thresholds: ComparisonThresholds,
): ComparisonAssessment {
  if (
    !isPlainRecord(thresholds) ||
    !isFiniteBoundedNumber(thresholds.improvementThreshold) ||
    !isFiniteBoundedNumber(thresholds.nonInferiorityBoundary) ||
    thresholds.nonInferiorityBoundary > thresholds.improvementThreshold
  ) {
    return createComparisonAssessment("NO_CONCLUSION", null, null, "invalid-thresholds");
  }

  const frozenThresholds = Object.freeze({ ...thresholds });
  if (isPlainRecord(result) && result.status === "NO_CONCLUSION") {
    return createComparisonAssessment(
      "NO_CONCLUSION",
      result,
      frozenThresholds,
      "bootstrap-evidence-unavailable",
    );
  }
  if (!isUsableBootstrapResult(result)) {
    return createComparisonAssessment(
      "NO_CONCLUSION",
      null,
      frozenThresholds,
      "invalid-bootstrap-result",
    );
  }

  const interval = result.confidenceInterval;
  if (interval.low >= thresholds.improvementThreshold) {
    return createComparisonAssessment(
      "SUPERIOR",
      result,
      frozenThresholds,
      "confidence-interval-meets-improvement",
    );
  }
  if (interval.low >= thresholds.nonInferiorityBoundary) {
    return createComparisonAssessment(
      "NON_INFERIOR",
      result,
      frozenThresholds,
      "confidence-interval-meets-non-inferiority",
    );
  }
  if (interval.high < thresholds.nonInferiorityBoundary) {
    return createComparisonAssessment(
      "INFERIOR",
      result,
      frozenThresholds,
      "confidence-interval-below-non-inferiority",
    );
  }
  return createComparisonAssessment(
    "INCONCLUSIVE",
    result,
    frozenThresholds,
    "confidence-interval-crosses-boundary",
  );
}

function resolvePromotionThresholds(input: unknown): Readonly<PromotionThresholds> | null {
  if (input === undefined) return DEFAULT_PROMOTION_THRESHOLDS;
  if (
    !isPlainRecord(input) ||
    Object.keys(input).some(
      (key) => !PROMOTION_THRESHOLD_KEYS.has(key as keyof PromotionThresholds),
    )
  ) {
    return null;
  }

  const thresholds: PromotionThresholds = {
    ...DEFAULT_PROMOTION_THRESHOLDS,
    ...input,
  };
  const comparisons = [
    [thresholds.qualityImprovement, thresholds.qualityNonInferiority],
    [thresholds.reliabilityImprovement, thresholds.reliabilityNonInferiority],
    [thresholds.costImprovement, thresholds.costNonInferiority],
    [thresholds.latencyImprovement, thresholds.latencyNonInferiority],
  ] as const;
  if (
    comparisons.some(
      ([improvement, nonInferiority]) =>
        !isFiniteBoundedNumber(improvement) ||
        !isFiniteBoundedNumber(nonInferiority) ||
        nonInferiority > improvement,
    )
  ) {
    return null;
  }
  return Object.freeze(thresholds);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

interface HardGateInspection {
  readonly failures: readonly string[];
  readonly unknowns: readonly string[];
  readonly invalid: boolean;
}

function inspectHardGates(input: unknown): HardGateInspection {
  if (!Array.isArray(input) || input.length > STATISTICAL_COMPARATOR_LIMITS.maxHardGates) {
    return Object.freeze({
      failures: Object.freeze([]),
      unknowns: Object.freeze(["hard-gate-evidence-invalid"]),
      invalid: true,
    });
  }

  const names = new Set<string>();
  const failures: string[] = [];
  const unknowns: string[] = [];
  let invalid = false;

  for (const item of input as readonly unknown[]) {
    if (
      !isPlainRecord(item) ||
      Object.keys(item).some((key) => key !== "name" && key !== "status") ||
      !isStableIdentifier(item.name) ||
      (item.status !== "PASS" && item.status !== "FAIL" && item.status !== "UNKNOWN")
    ) {
      invalid = true;
      continue;
    }
    if (names.has(item.name)) {
      invalid = true;
      continue;
    }
    names.add(item.name);
    if (item.status === "FAIL") failures.push(item.name);
    if (item.status === "UNKNOWN") unknowns.push(item.name);
  }

  for (const requiredName of PROMOTION_REQUIRED_HARD_GATES) {
    if (!names.has(requiredName)) unknowns.push(requiredName);
  }
  if (invalid) unknowns.push("hard-gate-evidence-invalid");

  return Object.freeze({
    failures: uniqueSorted(failures),
    unknowns: uniqueSorted(unknowns),
    invalid,
  });
}

function emptyMetricAssessments(): PromotionDecision["metricAssessments"] {
  return Object.freeze({ quality: null, reliability: null, cost: null, latency: null });
}

function emptyConfidenceIntervals(): PromotionDecision["confidenceIntervals"] {
  return Object.freeze({ quality: null, reliability: null, cost: null, latency: null });
}

interface PromotionDecisionFields {
  readonly status: PromotionDecision["status"];
  readonly evidenceStatus: PromotionDecision["evidenceStatus"];
  readonly baselineRunId: string | null;
  readonly candidateRunId: string | null;
  readonly hardGateFailures: readonly string[];
  readonly hardGateUnknowns: readonly string[];
  readonly blockingEvidence: readonly string[];
  readonly confidenceIntervals: PromotionDecision["confidenceIntervals"];
  readonly metricAssessments: PromotionDecision["metricAssessments"];
  readonly promotionPaths: readonly PromotionPath[];
  readonly thresholds: Readonly<PromotionThresholds> | null;
  readonly rationale: PromotionDecision["rationale"];
}

function createPromotionDecision(fields: PromotionDecisionFields): PromotionDecision {
  return Object.freeze({
    schemaVersion: STATISTICAL_RESULT_SCHEMA_VERSION,
    comparatorVersion: STATISTICAL_COMPARATOR_VERSION,
    ...fields,
    hardGateFailures: uniqueSorted(fields.hardGateFailures),
    hardGateUnknowns: uniqueSorted(fields.hardGateUnknowns),
    blockingEvidence: uniqueSorted(fields.blockingEvidence),
    promotionPaths: Object.freeze([...fields.promotionPaths]),
  });
}

function isAtLeastNonInferior(assessment: ComparisonAssessment): boolean {
  return assessment.status === "SUPERIOR" || assessment.status === "NON_INFERIOR";
}

const EXPECTED_METRIC_SHAPES: Readonly<
  Record<
    PromotionMetricName,
    { direction: MetricDirection; scale: MetricScale; estimator: BootstrapEstimator }
  >
> = Object.freeze({
  quality: Object.freeze({
    direction: "HIGHER_IS_BETTER",
    scale: "ABSOLUTE",
    estimator: "MEAN",
  }),
  reliability: Object.freeze({
    direction: "HIGHER_IS_BETTER",
    scale: "ABSOLUTE",
    estimator: "MEAN",
  }),
  cost: Object.freeze({
    direction: "LOWER_IS_BETTER",
    scale: "RELATIVE",
    estimator: "MEAN",
  }),
  latency: Object.freeze({
    direction: "LOWER_IS_BETTER",
    scale: "RELATIVE",
    estimator: "P95",
  }),
});

function comparisonThresholdsForMetric(
  metric: PromotionMetricName,
  thresholds: PromotionThresholds,
): ComparisonThresholds {
  switch (metric) {
    case "quality":
      return Object.freeze({
        improvementThreshold: thresholds.qualityImprovement,
        nonInferiorityBoundary: thresholds.qualityNonInferiority,
      });
    case "reliability":
      return Object.freeze({
        improvementThreshold: thresholds.reliabilityImprovement,
        nonInferiorityBoundary: thresholds.reliabilityNonInferiority,
      });
    case "cost":
      return Object.freeze({
        improvementThreshold: thresholds.costImprovement,
        nonInferiorityBoundary: thresholds.costNonInferiority,
      });
    case "latency":
      return Object.freeze({
        improvementThreshold: thresholds.latencyImprovement,
        nonInferiorityBoundary: thresholds.latencyNonInferiority,
      });
  }
}

/**
 * Apply ADR-009 promotion policy. A known hard-gate failure rejects before
 * metrics are inspected; missing or inconclusive evidence can only hold.
 */
export function decidePromotion(input: PromotionPolicyInput): PromotionDecision {
  const baselineRunId = isStableIdentifier(input?.baselineRunId) ? input.baselineRunId : null;
  const candidateRunId = isStableIdentifier(input?.candidateRunId) ? input.candidateRunId : null;
  const hardGates = inspectHardGates(input?.hardGates);
  const identifierBlockers = [
    ...(baselineRunId ? [] : ["baseline-run-id-invalid"]),
    ...(candidateRunId ? [] : ["candidate-run-id-invalid"]),
    ...(baselineRunId && candidateRunId && baselineRunId === candidateRunId
      ? ["run-ids-not-distinct"]
      : []),
  ];

  if (hardGates.failures.length > 0) {
    return createPromotionDecision({
      status: "REJECT",
      evidenceStatus: "COMPLETE",
      baselineRunId,
      candidateRunId,
      hardGateFailures: hardGates.failures,
      hardGateUnknowns: hardGates.unknowns,
      blockingEvidence: identifierBlockers,
      confidenceIntervals: emptyConfidenceIntervals(),
      metricAssessments: emptyMetricAssessments(),
      promotionPaths: [],
      thresholds: null,
      rationale: "hard-gate-failure",
    });
  }

  if (hardGates.unknowns.length > 0 || identifierBlockers.length > 0) {
    return createPromotionDecision({
      status: "HOLD",
      evidenceStatus: "BLOCKED",
      baselineRunId,
      candidateRunId,
      hardGateFailures: [],
      hardGateUnknowns: hardGates.unknowns,
      blockingEvidence: [...identifierBlockers, ...hardGates.unknowns],
      confidenceIntervals: emptyConfidenceIntervals(),
      metricAssessments: emptyMetricAssessments(),
      promotionPaths: [],
      thresholds: null,
      rationale: "evidence-blocked",
    });
  }

  const thresholds = resolvePromotionThresholds(input?.thresholds);
  if (!thresholds) {
    return createPromotionDecision({
      status: "HOLD",
      evidenceStatus: "BLOCKED",
      baselineRunId,
      candidateRunId,
      hardGateFailures: [],
      hardGateUnknowns: [],
      blockingEvidence: ["promotion-thresholds-invalid"],
      confidenceIntervals: emptyConfidenceIntervals(),
      metricAssessments: emptyMetricAssessments(),
      promotionPaths: [],
      thresholds: null,
      rationale: "evidence-blocked",
    });
  }

  const metricInput: Record<string, unknown> = isPlainRecord(input?.metrics) ? input.metrics : {};
  const mutableAssessments: Record<PromotionMetricName, ComparisonAssessment | null> = {
    quality: null,
    reliability: null,
    cost: null,
    latency: null,
  };
  const mutableIntervals: Record<PromotionMetricName, Readonly<NumericInterval> | null> = {
    quality: null,
    reliability: null,
    cost: null,
    latency: null,
  };
  const metricBlockers: string[] = [];
  const pairSetDigests = new Set<string>();
  const bootstrapSeeds = new Set<number>();
  const bootstrapIterations = new Set<number>();

  for (const metric of PROMOTION_METRIC_NAMES) {
    const evidence = metricInput[metric];
    if (!isUsableBootstrapResult(evidence)) {
      const reason =
        isPlainRecord(evidence) && typeof evidence.reason === "string"
          ? evidence.reason
          : "missing-or-invalid";
      metricBlockers.push(`${metric}:${reason}`);
      continue;
    }
    if (evidence.completePairCount < DEFAULT_MINIMUM_PAIRED_SAMPLES) {
      metricBlockers.push(`${metric}:insufficient-promotion-sample`);
      continue;
    }
    if (evidence.iterations < DEFAULT_BOOTSTRAP_ITERATIONS) {
      metricBlockers.push(`${metric}:insufficient-bootstrap-iterations`);
      continue;
    }
    if (evidence.confidenceLevel !== DEFAULT_CONFIDENCE_LEVEL) {
      metricBlockers.push(`${metric}:promotion-confidence-level-mismatch`);
      continue;
    }
    const expectedShape = EXPECTED_METRIC_SHAPES[metric];
    if (
      evidence.direction !== expectedShape.direction ||
      evidence.scale !== expectedShape.scale ||
      evidence.estimator !== expectedShape.estimator
    ) {
      metricBlockers.push(`${metric}:incompatible-metric-shape`);
      continue;
    }

    pairSetDigests.add(evidence.pairSetDigest);
    bootstrapSeeds.add(evidence.seed);
    bootstrapIterations.add(evidence.iterations);

    const assessment = assessPairedComparison(
      evidence,
      comparisonThresholdsForMetric(metric, thresholds),
    );
    mutableAssessments[metric] = assessment;
    mutableIntervals[metric] = freezeInterval(
      evidence.confidenceInterval.low,
      evidence.confidenceInterval.high,
    );
    if (assessment.status === "NO_CONCLUSION") {
      metricBlockers.push(`${metric}:no-conclusion`);
    }
  }

  if (pairSetDigests.size > 1) metricBlockers.push("metric-pair-set-mismatch");
  if (bootstrapSeeds.size > 1) metricBlockers.push("metric-bootstrap-seed-mismatch");
  if (bootstrapIterations.size > 1) metricBlockers.push("metric-bootstrap-iterations-mismatch");

  const metricAssessments = Object.freeze({ ...mutableAssessments });
  const confidenceIntervals = Object.freeze({ ...mutableIntervals });
  if (metricBlockers.length > 0) {
    return createPromotionDecision({
      status: "HOLD",
      evidenceStatus: "BLOCKED",
      baselineRunId,
      candidateRunId,
      hardGateFailures: [],
      hardGateUnknowns: [],
      blockingEvidence: metricBlockers,
      confidenceIntervals,
      metricAssessments,
      promotionPaths: [],
      thresholds,
      rationale: "evidence-blocked",
    });
  }

  const quality = metricAssessments.quality;
  const reliability = metricAssessments.reliability;
  const cost = metricAssessments.cost;
  const latency = metricAssessments.latency;
  if (!quality || !reliability || !cost || !latency) {
    return createPromotionDecision({
      status: "HOLD",
      evidenceStatus: "BLOCKED",
      baselineRunId,
      candidateRunId,
      hardGateFailures: [],
      hardGateUnknowns: [],
      blockingEvidence: ["metric-evidence-incomplete"],
      confidenceIntervals,
      metricAssessments,
      promotionPaths: [],
      thresholds,
      rationale: "evidence-blocked",
    });
  }

  const regressions = PROMOTION_METRIC_NAMES.filter(
    (metric) => metricAssessments[metric]?.status === "INFERIOR",
  );
  if (regressions.length > 0) {
    return createPromotionDecision({
      status: "REJECT",
      evidenceStatus: "COMPLETE",
      baselineRunId,
      candidateRunId,
      hardGateFailures: [],
      hardGateUnknowns: [],
      blockingEvidence: regressions.map((metric) => `${metric}:regression`),
      confidenceIntervals,
      metricAssessments,
      promotionPaths: [],
      thresholds,
      rationale: "metric-regression",
    });
  }

  const promotionPaths: PromotionPath[] = [];
  if (
    quality.status === "SUPERIOR" &&
    isAtLeastNonInferior(reliability) &&
    isAtLeastNonInferior(cost)
  ) {
    promotionPaths.push("QUALITY");
  }
  if (
    cost.status === "SUPERIOR" &&
    isAtLeastNonInferior(quality) &&
    isAtLeastNonInferior(reliability)
  ) {
    promotionPaths.push("COST");
  }
  if (
    latency.status === "SUPERIOR" &&
    isAtLeastNonInferior(quality) &&
    isAtLeastNonInferior(reliability)
  ) {
    promotionPaths.push("LATENCY");
  }

  if (promotionPaths.length > 0) {
    return createPromotionDecision({
      status: "PROMOTE",
      evidenceStatus: "COMPLETE",
      baselineRunId,
      candidateRunId,
      hardGateFailures: [],
      hardGateUnknowns: [],
      blockingEvidence: [],
      confidenceIntervals,
      metricAssessments,
      promotionPaths,
      thresholds,
      rationale: "promotion-threshold-met",
    });
  }

  return createPromotionDecision({
    status: "HOLD",
    evidenceStatus: "COMPLETE",
    baselineRunId,
    candidateRunId,
    hardGateFailures: [],
    hardGateUnknowns: [],
    blockingEvidence: [],
    confidenceIntervals,
    metricAssessments,
    promotionPaths: [],
    thresholds,
    rationale: "comparison-inconclusive",
  });
}
