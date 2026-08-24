import type {
  LlmAttemptOutcome,
  LlmAttemptTelemetry,
  LlmCostSource,
  LlmNormalizedErrorCategory,
} from "../../domain/ports/llm.port.js";
import type { PromptReference } from "../../domain/ports/prompt.port.js";
import {
  extractLlmErrorStatusCode,
  normalizeLlmErrorCategory,
} from "../llm/llm-attempt-telemetry.js";

export const TELEMETRY_SELF_TEST_TASK_ID = "EVAL-104" as const;
export const TELEMETRY_SELF_TEST_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_SELF_TEST_MAX_REPORT_BYTES = 32_768;

const MAX_SURFACE_SAMPLES = 8;
const MAX_ARRAY_ITEMS = 16;
const MAX_OBJECT_KEYS = 24;
const MAX_STRING_LENGTH = 256;
const MAX_SANITIZE_DEPTH = 5;

const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|cookie|authorization|credential|private[_-]?(?:key|source)|proxy(?:[_-]?(?:url|password|username))?)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|gsk)[-_][A-Za-z0-9._-]{8,}/gi,
  /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
] as const;

export type TelemetryWorkingTreeState = "clean" | "dirty" | "unknown";
export type TelemetrySurfaceName =
  | "callback_metadata"
  | "prompt_references"
  | "telemetry_records"
  | "errors"
  | "generated_report";

export type TelemetryJsonValue =
  | string
  | number
  | boolean
  | null
  | TelemetryJsonValue[]
  | { [key: string]: TelemetryJsonValue };

export interface TelemetryRedactionCanary {
  /** Stable, non-sensitive identifier emitted in the report. */
  id: string;
  /** Synthetic value kept in-memory only and never emitted. */
  value: string;
}

export interface TelemetryPromptLinkProbe {
  observationName: string;
  reference: PromptReference;
  /** Exact native handle observed at the prompt runnable boundary. */
  linkedNativePrompt?: object;
}

export interface DisabledTracingPathEvidence {
  is_enabled: boolean;
  handler_created: boolean;
  operation_calls: number;
  operation_result_matches: boolean;
}

export interface DisabledTracingBoundary {
  readonly isEnabled: boolean;
  createHandler(): unknown;
  run(operation: () => Promise<string>): Promise<string>;
}

export interface TelemetrySelfTestFixture {
  sourceSha: string;
  workingTree: TelemetryWorkingTreeState;
  dirtyPathCount: number;
  attempts: readonly LlmAttemptTelemetry[];
  promptLinks: readonly TelemetryPromptLinkProbe[];
  callbackMetadata: readonly Record<string, unknown>[];
  telemetryRecords: readonly Record<string, unknown>[];
  errors: readonly unknown[];
  disabledPath: DisabledTracingPathEvidence;
  redactionCanaries: readonly TelemetryRedactionCanary[];
}

export interface TelemetryCoverageMetric {
  total: number;
  covered: number;
  unknown: number;
  coverage: number;
  required: number;
  passed: boolean;
}

export interface TelemetrySelfTestFailure {
  code: string;
  detail: string;
}

export interface TelemetryRedactionSurfaceResult {
  surface: TelemetrySurfaceName;
  injected: number;
  expected: number;
  leaks_found: number;
  passed: boolean;
}

export interface SafePromptLinkEvidence {
  observation_name: string;
  prompt_name: string;
  prompt_label: string;
  prompt_is_fallback: boolean;
  prompt_version?: number;
  prompt_fallback_digest?: string;
  native_linked: boolean;
}

export interface SafeErrorEvidence {
  normalized_error_category: LlmNormalizedErrorCategory;
  error_status_code?: number;
}

export interface SafeAttemptEvidence {
  provider_requested: string;
  provider_actual: string;
  model_requested: string;
  model_actual: string;
  model_snapshot_or_alias: string;
  fallback_policy: LlmAttemptTelemetry["fallback_policy"];
  fallback_depth: number;
  attempt_index: number;
  cache_hit: boolean;
  rate_limit_retry: boolean;
  outcome: LlmAttemptOutcome;
  normalized_error_category: LlmNormalizedErrorCategory;
  usage_status: "known" | "unknown";
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  cost_source: LlmCostSource;
  latency_ms: number;
  time_to_first_token_ms?: number;
  prompt_name?: string;
  prompt_label?: string;
  prompt_version?: number;
  prompt_is_fallback?: boolean;
  prompt_fallback_digest?: string;
}

export interface TelemetrySelfTestReport {
  schema_version: typeof TELEMETRY_SELF_TEST_SCHEMA_VERSION;
  task_id: typeof TELEMETRY_SELF_TEST_TASK_ID;
  passed: boolean;
  source: {
    sha: string;
    working_tree: TelemetryWorkingTreeState;
    dirty_path_count: number;
  };
  evidence_boundary: {
    classification: "LOCAL_SYNTHETIC_NO_SECRET";
    provider_calls: "NOT_RUN";
    langfuse_hosted_mutations: "NOT_RUN";
    external: "NOT_RUN";
    manual: "NOT_RUN";
    staging: "NOT_RUN";
    production: "NOT_RUN";
  };
  coverage: {
    attempt_attribution: TelemetryCoverageMetric;
    multi_provider_fallback: TelemetryCoverageMetric;
    prompt_native_linkage: TelemetryCoverageMetric;
    prompt_fallback_identity: TelemetryCoverageMetric;
    usage_accounting: TelemetryCoverageMetric;
    cost_accounting: TelemetryCoverageMetric;
    latency: TelemetryCoverageMetric;
    normalized_errors: TelemetryCoverageMetric;
    disabled_path: TelemetryCoverageMetric;
    redaction_injection: TelemetryCoverageMetric;
  };
  redaction: {
    canary_ids: string[];
    surfaces: TelemetryRedactionSurfaceResult[];
  };
  disabled_path: DisabledTracingPathEvidence;
  failures: TelemetrySelfTestFailure[];
  exported_surfaces: {
    attempts: SafeAttemptEvidence[];
    callback_metadata: TelemetryJsonValue[];
    prompt_references: SafePromptLinkEvidence[];
    telemetry_records: TelemetryJsonValue[];
    errors: SafeErrorEvidence[];
  };
  serialization: {
    max_bytes: number;
    max_surface_samples: number;
    truncated_samples: number;
  };
}

export class TelemetrySelfTestReportTooLargeError extends Error {
  constructor(actualBytes: number, maximumBytes: number) {
    super(`Telemetry self-test report exceeds ${maximumBytes} byte limit (${actualBytes} bytes)`);
    this.name = "TelemetrySelfTestReportTooLargeError";
  }
}

/** Exercise the observable disabled seam without importing a concrete tracing adapter. */
export async function exerciseDisabledTracingPath(
  boundary: DisabledTracingBoundary,
): Promise<DisabledTracingPathEvidence> {
  let operationCalls = 0;
  const expectedResult = "disabled-path-result";
  const handler = boundary.createHandler();
  const result = await boundary.run(async () => {
    operationCalls += 1;
    return expectedResult;
  });

  return {
    is_enabled: boundary.isEnabled,
    handler_created: handler !== undefined,
    operation_calls: operationCalls,
    operation_result_matches: result === expectedResult,
  };
}

/** Build the deterministic LOCAL/no-secret coverage result. */
export function runTelemetrySelfTest(fixture: TelemetrySelfTestFixture): TelemetrySelfTestReport {
  const failures: TelemetrySelfTestFailure[] = [];
  const attempts = fixture.attempts;

  if (!/^[a-f0-9]{40}$/i.test(fixture.sourceSha)) {
    failures.push({
      code: "SOURCE_SHA_INVALID",
      detail: "source SHA must be a full 40-character Git commit identifier",
    });
  }

  const attributedAttempts = attempts.filter(hasConcreteAttemptAttribution).length;
  const attemptAttribution = coverageMetric(attempts.length, attributedAttempts, 0, 1);
  recordCoverageFailure(
    failures,
    "ATTEMPT_ATTRIBUTION_INCOMPLETE",
    "every synthetic attempt must identify the actual provider and model",
    attemptAttribution,
  );

  const providerCount = new Set(
    attempts.filter(hasConcreteAttemptAttribution).map((attempt) => attempt.provider_actual),
  ).size;
  const hasFallbackDepth = attempts.some((attempt) => attempt.fallback_depth > 0);
  const multiProviderFallback = coverageMetric(2, providerCount >= 2 ? 2 : providerCount, 0, 1);
  if (!hasFallbackDepth) {
    multiProviderFallback.covered = Math.min(multiProviderFallback.covered, 1);
    multiProviderFallback.coverage = multiProviderFallback.covered / multiProviderFallback.total;
    multiProviderFallback.passed = false;
  }
  recordCoverageFailure(
    failures,
    "MULTI_PROVIDER_FALLBACK_MISSING",
    "fixture must include at least two actual providers and a positive fallback depth",
    multiProviderFallback,
  );

  const managedPrompts = fixture.promptLinks.filter((probe) => !probe.reference.isFallback);
  const linkedManagedPrompts = managedPrompts.filter(hasExactNativePromptLink).length;
  const promptNativeLinkage = coverageMetric(managedPrompts.length, linkedManagedPrompts, 0, 1);
  recordCoverageFailure(
    failures,
    "PROMPT_NATIVE_LINK_INCOMPLETE",
    "every managed prompt must retain its exact native handle and version",
    promptNativeLinkage,
  );

  const fallbackPrompts = fixture.promptLinks.filter((probe) => probe.reference.isFallback);
  const identifiedFallbackPrompts = fallbackPrompts.filter(hasFallbackPromptIdentity).length;
  const promptFallbackIdentity = coverageMetric(
    fallbackPrompts.length,
    identifiedFallbackPrompts,
    0,
    1,
  );
  recordCoverageFailure(
    failures,
    "PROMPT_FALLBACK_IDENTITY_INCOMPLETE",
    "every fallback prompt must retain its label and SHA-256 digest without a native link",
    promptFallbackIdentity,
  );

  const usageStatuses = attempts.map(classifyUsageAccounting);
  const usageKnown = usageStatuses.filter((status) => status === "known").length;
  const usageUnknown = usageStatuses.filter((status) => status === "unknown").length;
  const usageAccounting = coverageMetric(
    attempts.length,
    usageKnown + usageUnknown,
    usageUnknown,
    1,
  );
  recordCoverageFailure(
    failures,
    "USAGE_ACCOUNTING_INCOMPLETE",
    "usage must be valid and present or explicitly classified as unknown",
    usageAccounting,
  );

  const costStatuses = attempts.map(classifyCostAccounting);
  const knownCost = costStatuses.filter((status) => status === "known").length;
  const unknownCost = costStatuses.filter((status) => status === "unknown").length;
  const costAccounting = coverageMetric(attempts.length, knownCost + unknownCost, unknownCost, 1);
  recordCoverageFailure(
    failures,
    "COST_ACCOUNTING_INCOMPLETE",
    "cost must include a valid source and amount or use the explicit unknown source",
    costAccounting,
  );

  const validLatency = attempts.filter(
    (attempt) => Number.isFinite(attempt.latency_ms) && attempt.latency_ms >= 0,
  ).length;
  const latency = coverageMetric(attempts.length, validLatency, 0, 1);
  recordCoverageFailure(
    failures,
    "LATENCY_COVERAGE_INCOMPLETE",
    "every attempt must include finite non-negative latency",
    latency,
  );

  const normalizedErrors = attempts.filter(hasConsistentNormalizedOutcome).length;
  const normalizedErrorCoverage = coverageMetric(attempts.length, normalizedErrors, 0, 1);
  recordCoverageFailure(
    failures,
    "NORMALIZED_ERROR_COVERAGE_INCOMPLETE",
    "attempt outcome and normalized error category must agree",
    normalizedErrorCoverage,
  );

  const disabledPathPassed =
    fixture.disabledPath.is_enabled === false &&
    fixture.disabledPath.handler_created === false &&
    fixture.disabledPath.operation_calls === 1 &&
    fixture.disabledPath.operation_result_matches;
  const disabledPath = coverageMetric(1, disabledPathPassed ? 1 : 0, 0, 1);
  recordCoverageFailure(
    failures,
    "LANGFUSE_DISABLED_PATH_FAILED",
    "disabled tracing must create no handler and execute the operation exactly once",
    disabledPath,
  );

  const canaryValues = fixture.redactionCanaries.map((canary) => canary.value);
  const sanitizedCallbackMetadata = fixture.callbackMetadata
    .slice(0, MAX_SURFACE_SAMPLES)
    .map((value) => sanitizeForExport(value, canaryValues));
  const safePromptReferences = fixture.promptLinks
    .slice(0, MAX_SURFACE_SAMPLES)
    .map(toSafePromptLinkEvidence);
  const sanitizedTelemetryRecords = fixture.telemetryRecords
    .slice(0, MAX_SURFACE_SAMPLES)
    .map((value) => sanitizeForExport(value, canaryValues));
  const safeErrors = fixture.errors.slice(0, MAX_SURFACE_SAMPLES).map(toSafeErrorEvidence);
  const safeAttempts = attempts.slice(0, MAX_SURFACE_SAMPLES).map(toSafeAttemptEvidence);

  const rawSurfaces: ReadonlyArray<
    readonly [Exclude<TelemetrySurfaceName, "generated_report">, unknown]
  > = [
    ["callback_metadata", fixture.callbackMetadata],
    ["prompt_references", fixture.promptLinks.map((probe) => probe.reference)],
    ["telemetry_records", fixture.telemetryRecords],
    ["errors", fixture.errors],
  ];
  const safeSurfaceValues: Readonly<
    Record<Exclude<TelemetrySurfaceName, "generated_report">, unknown>
  > = {
    callback_metadata: sanitizedCallbackMetadata,
    prompt_references: safePromptReferences,
    telemetry_records: sanitizedTelemetryRecords,
    errors: safeErrors,
  };
  const redactionSurfaces = rawSurfaces.map(([surface, rawValue]) => {
    const injected = countCanaryMatches(rawValue, canaryValues);
    const leaksFound = countCanaryMatches(safeSurfaceValues[surface], canaryValues);
    return {
      surface,
      injected,
      expected: canaryValues.length,
      leaks_found: leaksFound,
      passed: injected === canaryValues.length && leaksFound === 0,
    } satisfies TelemetryRedactionSurfaceResult;
  });

  const expectedInjections = canaryValues.length * rawSurfaces.length;
  const actualInjections = redactionSurfaces.reduce((sum, result) => sum + result.injected, 0);
  const redactionInjection = coverageMetric(expectedInjections, actualInjections, 0, 1);
  recordCoverageFailure(
    failures,
    "REDACTION_CANARY_INJECTION_INCOMPLETE",
    "every canary must be injected into every local export surface",
    redactionInjection,
  );
  if (redactionSurfaces.some((result) => result.leaks_found > 0)) {
    failures.push({
      code: "REDACTION_CANARY_LEAK",
      detail: "one or more synthetic canaries survived local export sanitization",
    });
  }

  const truncatedSamples =
    Math.max(0, fixture.callbackMetadata.length - MAX_SURFACE_SAMPLES) +
    Math.max(0, fixture.promptLinks.length - MAX_SURFACE_SAMPLES) +
    Math.max(0, fixture.telemetryRecords.length - MAX_SURFACE_SAMPLES) +
    Math.max(0, fixture.errors.length - MAX_SURFACE_SAMPLES) +
    Math.max(0, attempts.length - MAX_SURFACE_SAMPLES);

  const report: TelemetrySelfTestReport = {
    schema_version: TELEMETRY_SELF_TEST_SCHEMA_VERSION,
    task_id: TELEMETRY_SELF_TEST_TASK_ID,
    passed: false,
    source: {
      sha: sanitizeString(fixture.sourceSha, canaryValues),
      working_tree: fixture.workingTree,
      dirty_path_count: Math.max(0, Math.trunc(fixture.dirtyPathCount)),
    },
    evidence_boundary: {
      classification: "LOCAL_SYNTHETIC_NO_SECRET",
      provider_calls: "NOT_RUN",
      langfuse_hosted_mutations: "NOT_RUN",
      external: "NOT_RUN",
      manual: "NOT_RUN",
      staging: "NOT_RUN",
      production: "NOT_RUN",
    },
    coverage: {
      attempt_attribution: attemptAttribution,
      multi_provider_fallback: multiProviderFallback,
      prompt_native_linkage: promptNativeLinkage,
      prompt_fallback_identity: promptFallbackIdentity,
      usage_accounting: usageAccounting,
      cost_accounting: costAccounting,
      latency,
      normalized_errors: normalizedErrorCoverage,
      disabled_path: disabledPath,
      redaction_injection: redactionInjection,
    },
    redaction: {
      canary_ids: fixture.redactionCanaries.map((canary) =>
        sanitizeString(canary.id, canaryValues),
      ),
      surfaces: redactionSurfaces,
    },
    disabled_path: { ...fixture.disabledPath },
    failures,
    exported_surfaces: {
      attempts: safeAttempts,
      callback_metadata: sanitizedCallbackMetadata,
      prompt_references: safePromptReferences,
      telemetry_records: sanitizedTelemetryRecords,
      errors: safeErrors,
    },
    serialization: {
      max_bytes: TELEMETRY_SELF_TEST_MAX_REPORT_BYTES,
      max_surface_samples: MAX_SURFACE_SAMPLES,
      truncated_samples: truncatedSamples,
    },
  };

  const generatedReportLeaks = countCanaryMatches(report, canaryValues);
  report.redaction.surfaces.push({
    surface: "generated_report",
    injected: canaryValues.length,
    expected: canaryValues.length,
    leaks_found: generatedReportLeaks,
    passed: generatedReportLeaks === 0,
  });
  if (generatedReportLeaks > 0) {
    failures.push({
      code: "GENERATED_REPORT_CANARY_LEAK",
      detail: "one or more synthetic canaries reached the generated report",
    });
  }

  report.passed = failures.length === 0;
  return report;
}

export function runTelemetrySelfTestCommand(fixture: TelemetrySelfTestFixture): {
  exitCode: 0 | 1;
  report: TelemetrySelfTestReport;
} {
  const report = runTelemetrySelfTest(fixture);
  return { exitCode: report.passed ? 0 : 1, report };
}

export function serializeTelemetrySelfTestReport(
  report: TelemetrySelfTestReport,
  maximumBytes = TELEMETRY_SELF_TEST_MAX_REPORT_BYTES,
): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes > maximumBytes) {
    throw new TelemetrySelfTestReportTooLargeError(actualBytes, maximumBytes);
  }
  return serialized;
}

function coverageMetric(
  total: number,
  covered: number,
  unknown: number,
  required: number,
): TelemetryCoverageMetric {
  const normalizedTotal = Math.max(0, Math.trunc(total));
  const normalizedCovered = Math.min(normalizedTotal, Math.max(0, Math.trunc(covered)));
  const coverage = normalizedTotal === 0 ? 0 : normalizedCovered / normalizedTotal;
  return {
    total: normalizedTotal,
    covered: normalizedCovered,
    unknown: Math.min(normalizedTotal, Math.max(0, Math.trunc(unknown))),
    coverage,
    required,
    passed: normalizedTotal > 0 && coverage >= required,
  };
}

function recordCoverageFailure(
  failures: TelemetrySelfTestFailure[],
  code: string,
  detail: string,
  metric: TelemetryCoverageMetric,
): void {
  if (!metric.passed) failures.push({ code, detail });
}

function hasConcreteAttemptAttribution(attempt: LlmAttemptTelemetry): boolean {
  return (
    isConcreteDimension(attempt.provider_actual) &&
    isConcreteDimension(attempt.model_actual) &&
    Number.isInteger(attempt.attempt_index) &&
    attempt.attempt_index >= 0 &&
    Number.isInteger(attempt.fallback_depth) &&
    attempt.fallback_depth >= 0
  );
}

function isConcreteDimension(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "unknown" && normalized !== "openai-compatible";
}

function hasExactNativePromptLink(probe: TelemetryPromptLinkProbe): boolean {
  const reference = probe.reference;
  return (
    !reference.isFallback &&
    reference.nativePrompt !== undefined &&
    probe.linkedNativePrompt === reference.nativePrompt &&
    reference.version !== undefined &&
    Number.isInteger(reference.version) &&
    reference.version > 0 &&
    reference.name.trim().length > 0 &&
    reference.label.trim().length > 0
  );
}

function hasFallbackPromptIdentity(probe: TelemetryPromptLinkProbe): boolean {
  const reference = probe.reference;
  return (
    reference.isFallback &&
    probe.linkedNativePrompt === undefined &&
    reference.name.trim().length > 0 &&
    reference.label.trim().length > 0 &&
    /^[a-f0-9]{64}$/i.test(reference.fallbackDigest)
  );
}

function classifyUsageAccounting(attempt: LlmAttemptTelemetry): "known" | "unknown" | "invalid" {
  const usageValues = [
    attempt.input_tokens,
    attempt.output_tokens,
    attempt.reasoning_tokens,
    attempt.cached_input_tokens,
    attempt.total_tokens,
  ];
  if (usageValues.some((value) => value !== undefined && !isNonNegativeInteger(value))) {
    return "invalid";
  }
  if (attempt.total_tokens !== undefined) return "known";
  if (usageValues.every((value) => value === undefined)) return "unknown";
  return "invalid";
}

function classifyCostAccounting(attempt: LlmAttemptTelemetry): "known" | "unknown" | "invalid" {
  if (attempt.cost_source === "unknown") {
    return attempt.cost_usd === undefined || isNonNegativeFinite(attempt.cost_usd)
      ? "unknown"
      : "invalid";
  }
  if (attempt.cost_source !== "provider" && attempt.cost_source !== "price_table") {
    return "invalid";
  }
  return isNonNegativeFinite(attempt.cost_usd) ? "known" : "invalid";
}

function hasConsistentNormalizedOutcome(attempt: LlmAttemptTelemetry): boolean {
  if (attempt.outcome === "error") return attempt.normalized_error_category !== "none";
  return attempt.normalized_error_category === "none";
}

function isNonNegativeFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function toSafePromptLinkEvidence(probe: TelemetryPromptLinkProbe): SafePromptLinkEvidence {
  const reference = probe.reference;
  const base: SafePromptLinkEvidence = {
    observation_name: clampString(referenceSafeString(probe.observationName)),
    prompt_name: clampString(referenceSafeString(reference.name)),
    prompt_label: clampString(referenceSafeString(reference.label)),
    prompt_is_fallback: reference.isFallback,
    native_linked:
      !reference.isFallback &&
      reference.nativePrompt !== undefined &&
      probe.linkedNativePrompt === reference.nativePrompt,
  };
  if (reference.isFallback) base.prompt_fallback_digest = reference.fallbackDigest;
  else if (reference.version !== undefined) base.prompt_version = reference.version;
  return base;
}

function toSafeAttemptEvidence(attempt: LlmAttemptTelemetry): SafeAttemptEvidence {
  const safe: SafeAttemptEvidence = {
    provider_requested: clampString(referenceSafeString(attempt.provider_requested)),
    provider_actual: clampString(referenceSafeString(attempt.provider_actual)),
    model_requested: clampString(referenceSafeString(attempt.model_requested)),
    model_actual: clampString(referenceSafeString(attempt.model_actual)),
    model_snapshot_or_alias: clampString(referenceSafeString(attempt.model_snapshot_or_alias)),
    fallback_policy: attempt.fallback_policy,
    fallback_depth: attempt.fallback_depth,
    attempt_index: attempt.attempt_index,
    cache_hit: attempt.cache_hit,
    rate_limit_retry: attempt.rate_limit_retry,
    outcome: attempt.outcome,
    normalized_error_category: attempt.normalized_error_category,
    usage_status: classifyUsageAccounting(attempt) === "known" ? "known" : "unknown",
    cost_source: attempt.cost_source,
    latency_ms: attempt.latency_ms,
  };
  if (attempt.input_tokens !== undefined) safe.input_tokens = attempt.input_tokens;
  if (attempt.output_tokens !== undefined) safe.output_tokens = attempt.output_tokens;
  if (attempt.reasoning_tokens !== undefined) safe.reasoning_tokens = attempt.reasoning_tokens;
  if (attempt.cached_input_tokens !== undefined)
    safe.cached_input_tokens = attempt.cached_input_tokens;
  if (attempt.total_tokens !== undefined) safe.total_tokens = attempt.total_tokens;
  if (attempt.cost_usd !== undefined) safe.cost_usd = attempt.cost_usd;
  if (attempt.time_to_first_token_ms !== undefined)
    safe.time_to_first_token_ms = attempt.time_to_first_token_ms;
  if (attempt.prompt_name) safe.prompt_name = clampString(referenceSafeString(attempt.prompt_name));
  if (attempt.prompt_label)
    safe.prompt_label = clampString(referenceSafeString(attempt.prompt_label));
  if (attempt.prompt_version !== undefined) safe.prompt_version = attempt.prompt_version;
  if (attempt.prompt_is_fallback !== undefined)
    safe.prompt_is_fallback = attempt.prompt_is_fallback;
  if (attempt.prompt_fallback_digest) safe.prompt_fallback_digest = attempt.prompt_fallback_digest;
  return safe;
}

function toSafeErrorEvidence(error: unknown): SafeErrorEvidence {
  const safe: SafeErrorEvidence = {
    normalized_error_category: normalizeLlmErrorCategory(error),
  };
  const status = extractLlmErrorStatusCode(error);
  if (status !== undefined) safe.error_status_code = status;
  return safe;
}

function sanitizeForExport(value: unknown, canaryValues: readonly string[]): TelemetryJsonValue {
  return sanitizeUnknown(value, canaryValues, 0, new WeakSet<object>());
}

function sanitizeUnknown(
  value: unknown,
  canaryValues: readonly string[],
  depth: number,
  seen: WeakSet<object>,
): TelemetryJsonValue {
  if (value === null) return null;
  if (typeof value === "string") return sanitizeString(value, canaryValues);
  if (typeof value === "number") return Number.isFinite(value) ? value : "[NON_FINITE]";
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return clampString(value.toString());
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") {
    return "[OMITTED]";
  }
  if (depth >= MAX_SANITIZE_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: clampString(referenceSafeString(value.name)),
      normalized_error_category: normalizeLlmErrorCategory(value),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeUnknown(item, canaryValues, depth + 1, seen));
  }

  const sanitized: Record<string, TelemetryJsonValue> = {};
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const safeKey = clampString(referenceSafeString(key));
    sanitized[safeKey] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : sanitizeUnknown(item, canaryValues, depth + 1, seen);
  }
  return sanitized;
}

function sanitizeString(value: string, canaryValues: readonly string[]): string {
  let sanitized = value;
  for (const canary of canaryValues) {
    if (canary.length > 0) sanitized = sanitized.split(canary).join("[REDACTED]");
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return clampString(sanitized);
}

function referenceSafeString(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?");
}

function clampString(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH - 3)}...`;
}

function countCanaryMatches(value: unknown, canaryValues: readonly string[]): number {
  const serialized = unsafeSurfaceString(value, 0, new WeakSet<object>());
  return canaryValues.filter((canary) => canary.length > 0 && serialized.includes(canary)).length;
}

function unsafeSurfaceString(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol" || typeof value === "function") return "";
  if (depth >= MAX_SANITIZE_DEPTH) return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (value instanceof Error) return `${value.name} ${value.message}`;
  if (Array.isArray(value)) {
    return value.map((item) => unsafeSurfaceString(item, depth + 1, seen)).join(" ");
  }
  return Object.entries(value)
    .map(([key, item]) => `${key} ${unsafeSurfaceString(item, depth + 1, seen)}`)
    .join(" ");
}
