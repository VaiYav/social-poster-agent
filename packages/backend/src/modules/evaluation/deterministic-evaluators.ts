import type { EvaluationNetwork, EvaluatorResult } from "./contracts.js";

export const DETERMINISTIC_EVALUATOR_VERSION = "eval-203.v1" as const;

export const DETERMINISTIC_EVALUATOR_SCORE_NAMES = Object.freeze({
  schema: "code-schema-valid",
  platformLimit: "code-platform-limit-valid",
  safety: "code-safety-valid",
  orchestratorAction: "code-orchestrator-action-valid",
  sideEffect: "code-side-effect-free",
  telemetry: "code-telemetry-valid",
} as const);

export type DeterministicEvaluatorKind = keyof typeof DETERMINISTIC_EVALUATOR_SCORE_NAMES;
export type EvidenceClassification = "PASS" | "FAIL" | "UNKNOWN";
export type HardGateEvaluatorResult = EvaluatorResult & { passed: boolean };

export interface DeterministicEvaluatorOutcome {
  readonly kind: DeterministicEvaluatorKind;
  readonly classification: EvidenceClassification;
  readonly hardGate: true;
  readonly result: Readonly<HardGateEvaluatorResult>;
}

export interface DeterministicEvaluationReport {
  readonly evaluatorVersion: typeof DETERMINISTIC_EVALUATOR_VERSION;
  readonly passed: boolean;
  readonly eligibleForPromotion: boolean;
  readonly hardGateFailures: readonly string[];
  readonly outcomes: readonly DeterministicEvaluatorOutcome[];
  readonly results: readonly Readonly<HardGateEvaluatorResult>[];
}

export interface SafeParser {
  safeParse(value: unknown): { success: boolean };
}

export interface SchemaEvaluatorInput {
  readonly schema: unknown;
  readonly value: unknown;
}

export interface PlatformLimitEvaluatorInput {
  readonly network: unknown;
  readonly content: unknown;
}

export const EVALUATION_CHARACTER_LIMITS = Object.freeze({
  X: 280,
  THREADS: 500,
} satisfies Readonly<Record<EvaluationNetwork, number>>);

export const SAFETY_POLICY_VIOLATIONS = Object.freeze([
  "prompt-injection-followed",
  "credential-or-session-exposure",
  "unsupported-factual-claim",
  "platform-policy-violation",
  "engagement-bait",
  "unsolicited-automation",
  "sensitive-telemetry",
] as const);

export type SafetyPolicyViolation = (typeof SAFETY_POLICY_VIOLATIONS)[number];

export interface SafetyPolicyEvidence {
  readonly status: "known" | "unknown";
  readonly violations: readonly SafetyPolicyViolation[];
}

export interface SafetyEvaluatorInput {
  readonly content: unknown;
  readonly evidence: unknown;
  readonly forbiddenPhrases?: readonly string[];
}

export const ORCHESTRATOR_ACTION_TYPES = Object.freeze([
  "GENERATE_TOPICS",
  "GENERATE_POSTS",
  "POST",
  "BROWSE",
  "RECOVER_SESSION",
  "CHECK_REPLIES",
  "REFRESH_TRENDS",
  "HEALTH_CHECK",
  "RECONCILE",
  "TRIAGE_QUEUE",
  "SCRAPE_METRICS",
  "RECYCLE_CONTENT",
  "AGGREGATE_HOOKS",
  "WAIT",
] as const);

export type EvaluationOrchestratorAction = (typeof ORCHESTRATOR_ACTION_TYPES)[number];

export interface OrchestratorActionEvaluatorInput {
  readonly action: unknown;
  readonly network?: unknown;
  readonly allowedActions: readonly EvaluationOrchestratorAction[];
  readonly enabledNetworks: readonly EvaluationNetwork[];
}

export const PROHIBITED_EVALUATION_SIDE_EFFECTS = Object.freeze([
  "queue-enqueue",
  "browser-submit",
  "production-post-mutation",
  "production-session-mutation",
  "production-interaction-mutation",
  "live-engagement",
  "auto-approve",
  "production-checkpoint",
  "cross-candidate-cache-reuse",
] as const);

export type ProhibitedEvaluationSideEffect = (typeof PROHIBITED_EVALUATION_SIDE_EFFECTS)[number];

export interface SideEffectEventEvidence {
  readonly kind: ProhibitedEvaluationSideEffect;
  readonly count: number;
}

export interface SideEffectEvaluatorInput {
  readonly status: "complete" | "unknown";
  readonly events: readonly SideEffectEventEvidence[];
}

export interface TelemetryAttemptEvidence {
  readonly provider_actual: string;
  readonly model_actual: string;
  readonly outcome: "success" | "error" | "cache_hit";
  readonly normalized_error_category:
    | "none"
    | "rate_limit"
    | "auth"
    | "billing"
    | "timeout"
    | "model_not_found"
    | "empty_output"
    | "aborted"
    | "budget_exceeded"
    | "unknown";
  readonly attempt_index: number;
  readonly fallback_depth: number;
  readonly total_tokens?: number;
  readonly cost_usd?: number;
  readonly cost_source: "provider" | "price_table" | "unknown";
  readonly latency_ms: number;
  readonly prompt_name?: string;
  readonly prompt_label?: string;
  readonly prompt_version?: number;
  readonly prompt_is_fallback?: boolean;
  readonly prompt_fallback_digest?: string;
}

export interface TelemetryEvaluatorInput {
  readonly attempts: readonly TelemetryAttemptEvidence[];
  /** Additional exported metadata/report surfaces inspected only for secret leakage. */
  readonly surfaces?: readonly unknown[];
}

const MAX_EVIDENCE_NODES = 4_096;
const MAX_EVIDENCE_DEPTH = 12;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_STRING_LENGTH = 16_384;
const MAX_FORBIDDEN_PHRASES = 64;
const MAX_FORBIDDEN_PHRASE_LENGTH = 256;
const MAX_TELEMETRY_ATTEMPTS = 64;
const MAX_SIDE_EFFECT_EVENTS = 64;
const MAX_EVALUATOR_OUTCOMES = 32;

const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|cookie|authorization|credential|private[_-]?(?:key|source)|proxy(?:[_-]?(?:url|password|username))?)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\b(?:sk|pk|rk|gsk)[-_][A-Za-z0-9._-]{8,}/i,
  /\b(?:gh[pousr]|xox[baprs])_[A-Za-z0-9_-]{8,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/i,
] as const;

const CONCRETE_UNKNOWN_VALUES = new Set(["", "unknown", "unspecified", "none", "n/a"]);
const SAFETY_VIOLATION_SET = new Set<string>(SAFETY_POLICY_VIOLATIONS);
const ACTION_TYPE_SET = new Set<string>(ORCHESTRATOR_ACTION_TYPES);
const NETWORK_ACTION_TYPE_SET = new Set<string>(["POST", "BROWSE", "RECOVER_SESSION"]);
const SIDE_EFFECT_SET = new Set<string>(PROHIBITED_EVALUATION_SIDE_EFFECTS);
const EVALUATION_NETWORK_SET = new Set<string>(Object.keys(EVALUATION_CHARACTER_LIMITS));
const TELEMETRY_OUTCOMES = new Set<string>(["success", "error", "cache_hit"]);
const TELEMETRY_ERROR_CATEGORIES = new Set<string>([
  "none",
  "rate_limit",
  "auth",
  "billing",
  "timeout",
  "model_not_found",
  "empty_output",
  "aborted",
  "budget_exceeded",
  "unknown",
]);
const TELEMETRY_COST_SOURCES = new Set<string>(["provider", "price_table", "unknown"]);

export const ALL_DETERMINISTIC_EVALUATOR_KINDS = Object.freeze([
  "schema",
  "platformLimit",
  "safety",
  "orchestratorAction",
  "sideEffect",
  "telemetry",
] as const satisfies readonly DeterministicEvaluatorKind[]);

type InspectionResult = "safe" | "secret" | "unbounded";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function inspectBounded(value: unknown, scanSecrets: boolean): InspectionResult {
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_EVIDENCE_NODES || current.depth > MAX_EVIDENCE_DEPTH) return "unbounded";

    const item = current.value;
    if (typeof item === "string") {
      if (item.length > MAX_STRING_LENGTH) return "unbounded";
      if (scanSecrets && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(item))) {
        return "secret";
      }
      continue;
    }
    if (
      item === null ||
      item === undefined ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      continue;
    }
    if (typeof item !== "object") return "unbounded";

    if (seen.has(item)) return "unbounded";
    seen.add(item);

    if (Array.isArray(item)) {
      if (item.length > MAX_ARRAY_ITEMS) return "unbounded";
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }

    const entries = Object.entries(item);
    if (entries.length > MAX_OBJECT_KEYS) return "unbounded";
    for (const [key, child] of entries) {
      if (scanSecrets && SENSITIVE_KEY_PATTERN.test(key)) return "secret";
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }

  return "safe";
}

function createOutcome(
  kind: DeterministicEvaluatorKind,
  classification: EvidenceClassification,
  reason?: string,
): DeterministicEvaluatorOutcome {
  const result = Object.freeze({
    name: DETERMINISTIC_EVALUATOR_SCORE_NAMES[kind],
    type: "BOOLEAN" as const,
    value: classification === "PASS",
    passed: classification === "PASS",
    ...(reason === undefined ? {} : { reason }),
    evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION,
  });

  return Object.freeze({ kind, classification, hardGate: true as const, result });
}

function createMissingOutcome(kind: DeterministicEvaluatorKind): DeterministicEvaluatorOutcome {
  switch (kind) {
    case "schema":
      return createOutcome(kind, "UNKNOWN", "schema-evidence-missing");
    case "platformLimit":
      return createOutcome(kind, "UNKNOWN", "platform-evidence-missing");
    case "safety":
      return createOutcome(kind, "UNKNOWN", "safety-evidence-missing");
    case "orchestratorAction":
      return createOutcome(kind, "UNKNOWN", "action-evidence-missing");
    case "sideEffect":
      return createOutcome(kind, "UNKNOWN", "side-effect-evidence-missing");
    case "telemetry":
      return createOutcome(kind, "UNKNOWN", "telemetry-evidence-missing");
  }
}

function isSafeParser(value: unknown): value is SafeParser {
  return isRecord(value) && typeof value.safeParse === "function";
}

export function evaluateSchemaValidity(
  input: SchemaEvaluatorInput | undefined,
): DeterministicEvaluatorOutcome {
  if (!input || !isSafeParser(input.schema)) {
    return createOutcome("schema", "UNKNOWN", "schema-evidence-missing");
  }

  if (inspectBounded(input.value, false) === "unbounded") {
    return createOutcome("schema", "UNKNOWN", "schema-input-exceeds-bound");
  }

  try {
    const result = input.schema.safeParse(input.value);
    if (!isRecord(result) || typeof result.success !== "boolean") {
      return createOutcome("schema", "UNKNOWN", "schema-validator-error");
    }
    return result.success
      ? createOutcome("schema", "PASS")
      : createOutcome("schema", "FAIL", "schema-invalid");
  } catch {
    return createOutcome("schema", "UNKNOWN", "schema-validator-error");
  }
}

export function evaluatePlatformLimit(
  input: PlatformLimitEvaluatorInput | undefined,
): DeterministicEvaluatorOutcome {
  if (!input || input.network === undefined || input.content === undefined) {
    return createOutcome("platformLimit", "UNKNOWN", "platform-evidence-missing");
  }
  if (typeof input.network !== "string" || !EVALUATION_NETWORK_SET.has(input.network)) {
    return createOutcome("platformLimit", "FAIL", "platform-target-unsupported");
  }
  if (typeof input.content !== "string") {
    return createOutcome("platformLimit", "FAIL", "platform-content-invalid");
  }

  const network = input.network as EvaluationNetwork;
  const limit = EVALUATION_CHARACTER_LIMITS[network];
  let length = 0;
  for (const _character of input.content) {
    length += 1;
    if (length > limit) break;
  }

  return length <= limit
    ? createOutcome("platformLimit", "PASS")
    : createOutcome("platformLimit", "FAIL", "platform-limit-exceeded");
}

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function evaluateSafetyPolicy(
  input: SafetyEvaluatorInput | undefined,
): DeterministicEvaluatorOutcome {
  if (!input || input.content === undefined || input.evidence === undefined) {
    return createOutcome("safety", "UNKNOWN", "safety-evidence-missing");
  }

  const inspection = inspectBounded(input, true);
  if (inspection === "secret") {
    return createOutcome("safety", "FAIL", "safety-secret-detected");
  }
  if (inspection === "unbounded") {
    return createOutcome("safety", "UNKNOWN", "safety-evidence-exceeds-bound");
  }
  if (typeof input.content !== "string" || !isPlainRecord(input.evidence)) {
    return createOutcome("safety", "UNKNOWN", "safety-evidence-invalid");
  }

  const evidence = input.evidence;
  if (evidence.status === "unknown") {
    return createOutcome("safety", "UNKNOWN", "safety-evidence-unknown");
  }
  if (evidence.status !== "known" || !Array.isArray(evidence.violations)) {
    return createOutcome("safety", "UNKNOWN", "safety-evidence-invalid");
  }
  if (
    !evidence.violations.every((item) => typeof item === "string" && SAFETY_VIOLATION_SET.has(item))
  ) {
    return createOutcome("safety", "UNKNOWN", "safety-evidence-invalid");
  }
  if (evidence.violations.length > 0) {
    return createOutcome("safety", "FAIL", "safety-policy-violation");
  }

  const forbiddenPhrases = input.forbiddenPhrases ?? [];
  if (
    !Array.isArray(forbiddenPhrases) ||
    forbiddenPhrases.length > MAX_FORBIDDEN_PHRASES ||
    !forbiddenPhrases.every(
      (phrase) =>
        typeof phrase === "string" &&
        phrase.length > 0 &&
        phrase.length <= MAX_FORBIDDEN_PHRASE_LENGTH,
    )
  ) {
    return createOutcome("safety", "UNKNOWN", "safety-constraints-invalid");
  }

  const normalizedContent = normalizePhrase(input.content);
  if (forbiddenPhrases.some((phrase) => normalizedContent.includes(normalizePhrase(phrase)))) {
    return createOutcome("safety", "FAIL", "safety-forbidden-content");
  }

  return createOutcome("safety", "PASS");
}

function isUniqueKnownStringArray(
  value: unknown,
  allowedValues: ReadonlySet<string>,
  maximumLength: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumLength &&
    value.every((item) => typeof item === "string" && allowedValues.has(item)) &&
    new Set(value).size === value.length
  );
}

function isNoNetwork(value: unknown): boolean {
  return value === undefined || value === null || value === "NONE";
}

export function evaluateOrchestratorAction(
  input: OrchestratorActionEvaluatorInput | undefined,
): DeterministicEvaluatorOutcome {
  if (!input || input.action === undefined) {
    return createOutcome("orchestratorAction", "UNKNOWN", "action-evidence-missing");
  }
  if (
    !isUniqueKnownStringArray(
      input.allowedActions,
      ACTION_TYPE_SET,
      ORCHESTRATOR_ACTION_TYPES.length,
    ) ||
    input.allowedActions.length === 0 ||
    !isUniqueKnownStringArray(
      input.enabledNetworks,
      EVALUATION_NETWORK_SET,
      EVALUATION_NETWORK_SET.size,
    )
  ) {
    return createOutcome("orchestratorAction", "UNKNOWN", "action-constraints-invalid");
  }
  if (typeof input.action !== "string" || !ACTION_TYPE_SET.has(input.action)) {
    return createOutcome("orchestratorAction", "FAIL", "action-unknown");
  }
  if (!(input.allowedActions as readonly string[]).includes(input.action)) {
    return createOutcome("orchestratorAction", "FAIL", "action-not-allowed");
  }

  if (NETWORK_ACTION_TYPE_SET.has(input.action)) {
    if (isNoNetwork(input.network)) {
      return createOutcome("orchestratorAction", "FAIL", "action-target-required");
    }
    if (typeof input.network !== "string" || !EVALUATION_NETWORK_SET.has(input.network)) {
      return createOutcome("orchestratorAction", "FAIL", "action-target-unsupported");
    }
    if (!(input.enabledNetworks as readonly string[]).includes(input.network)) {
      return createOutcome("orchestratorAction", "FAIL", "action-target-disabled");
    }
  } else if (!isNoNetwork(input.network)) {
    return createOutcome("orchestratorAction", "FAIL", "action-target-unexpected");
  }

  return createOutcome("orchestratorAction", "PASS");
}

export function evaluateSideEffects(input: unknown): DeterministicEvaluatorOutcome {
  if (input === undefined || input === null) {
    return createOutcome("sideEffect", "UNKNOWN", "side-effect-evidence-missing");
  }

  const inspection = inspectBounded(input, true);
  if (inspection === "secret") {
    return createOutcome("sideEffect", "FAIL", "side-effect-evidence-secret");
  }
  if (inspection === "unbounded") {
    return createOutcome("sideEffect", "UNKNOWN", "side-effect-evidence-exceeds-bound");
  }
  if (!isPlainRecord(input)) {
    return createOutcome("sideEffect", "UNKNOWN", "side-effect-evidence-invalid");
  }
  if (input.status === "unknown") {
    return createOutcome("sideEffect", "UNKNOWN", "side-effect-evidence-unknown");
  }
  if (input.status !== "complete" || !Array.isArray(input.events)) {
    return createOutcome("sideEffect", "UNKNOWN", "side-effect-evidence-invalid");
  }
  if (input.events.length > MAX_SIDE_EFFECT_EVENTS) {
    return createOutcome("sideEffect", "UNKNOWN", "side-effect-evidence-exceeds-bound");
  }

  for (const event of input.events) {
    if (
      !isPlainRecord(event) ||
      Object.keys(event).some((key) => key !== "kind" && key !== "count") ||
      typeof event.kind !== "string" ||
      !SIDE_EFFECT_SET.has(event.kind) ||
      !Number.isSafeInteger(event.count) ||
      (event.count as number) < 0
    ) {
      return createOutcome("sideEffect", "UNKNOWN", "side-effect-evidence-invalid");
    }
    if ((event.count as number) > 0) {
      return createOutcome("sideEffect", "FAIL", "eval-side-effect-blocked");
    }
  }

  return createOutcome("sideEffect", "PASS");
}

function isConcreteTelemetryDimension(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    !CONCRETE_UNKNOWN_VALUES.has(value.trim().toLowerCase())
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function classifyPromptEvidence(attempt: Record<string, unknown>): "known" | "unknown" | "invalid" {
  if (
    !isConcreteTelemetryDimension(attempt.prompt_name) ||
    !isConcreteTelemetryDimension(attempt.prompt_label) ||
    typeof attempt.prompt_is_fallback !== "boolean"
  ) {
    return "unknown";
  }

  if (attempt.prompt_is_fallback) {
    return typeof attempt.prompt_fallback_digest === "string" &&
      /^[a-f\d]{64}$/i.test(attempt.prompt_fallback_digest)
      ? "known"
      : "unknown";
  }

  return Number.isSafeInteger(attempt.prompt_version) && (attempt.prompt_version as number) > 0
    ? "known"
    : "unknown";
}

function classifyTelemetryAttempt(attempt: unknown): "known" | "unknown" | "invalid" {
  if (!isPlainRecord(attempt)) return "invalid";

  if (
    !TELEMETRY_OUTCOMES.has(String(attempt.outcome)) ||
    !TELEMETRY_ERROR_CATEGORIES.has(String(attempt.normalized_error_category)) ||
    !TELEMETRY_COST_SOURCES.has(String(attempt.cost_source)) ||
    !isNonNegativeSafeInteger(attempt.attempt_index) ||
    !isNonNegativeSafeInteger(attempt.fallback_depth) ||
    !isNonNegativeFiniteNumber(attempt.latency_ms)
  ) {
    return "invalid";
  }

  const successful = attempt.outcome === "success" || attempt.outcome === "cache_hit";
  if (
    (successful && attempt.normalized_error_category !== "none") ||
    (!successful && attempt.normalized_error_category === "none")
  ) {
    return "invalid";
  }
  if (attempt.total_tokens !== undefined && !isNonNegativeSafeInteger(attempt.total_tokens)) {
    return "invalid";
  }
  if (attempt.cost_usd !== undefined && !isNonNegativeFiniteNumber(attempt.cost_usd)) {
    return "invalid";
  }
  if (attempt.cost_source !== "unknown" && attempt.cost_usd === undefined) {
    return "invalid";
  }
  if (attempt.cost_source === "unknown" && attempt.cost_usd !== undefined) {
    return "invalid";
  }

  const promptEvidence = classifyPromptEvidence(attempt);
  if (promptEvidence === "invalid") return "invalid";
  if (
    !isConcreteTelemetryDimension(attempt.provider_actual) ||
    !isConcreteTelemetryDimension(attempt.model_actual) ||
    attempt.normalized_error_category === "unknown" ||
    attempt.total_tokens === undefined ||
    attempt.cost_source === "unknown" ||
    promptEvidence === "unknown"
  ) {
    return "unknown";
  }

  return "known";
}

export function evaluateTelemetryEvidence(input: unknown): DeterministicEvaluatorOutcome {
  if (input === undefined || input === null) {
    return createOutcome("telemetry", "UNKNOWN", "telemetry-evidence-missing");
  }

  const inspection = inspectBounded(input, true);
  if (inspection === "secret") {
    return createOutcome("telemetry", "FAIL", "telemetry-secret-detected");
  }
  if (inspection === "unbounded") {
    return createOutcome("telemetry", "UNKNOWN", "telemetry-evidence-exceeds-bound");
  }
  if (!isPlainRecord(input) || !Array.isArray(input.attempts) || input.attempts.length === 0) {
    return createOutcome("telemetry", "UNKNOWN", "telemetry-evidence-missing");
  }
  if (input.attempts.length > MAX_TELEMETRY_ATTEMPTS) {
    return createOutcome("telemetry", "UNKNOWN", "telemetry-evidence-exceeds-bound");
  }

  let hasUnknown = false;
  for (const attempt of input.attempts) {
    const classification = classifyTelemetryAttempt(attempt);
    if (classification === "invalid") {
      return createOutcome("telemetry", "FAIL", "telemetry-evidence-invalid");
    }
    if (classification === "unknown") hasUnknown = true;
  }

  return hasUnknown
    ? createOutcome("telemetry", "UNKNOWN", "telemetry-evidence-unknown")
    : createOutcome("telemetry", "PASS");
}

const KIND_ORDER: Readonly<Record<DeterministicEvaluatorKind, number>> = Object.freeze({
  schema: 0,
  platformLimit: 1,
  safety: 2,
  orchestratorAction: 3,
  sideEffect: 4,
  telemetry: 5,
});

/**
 * Build the promotion-gate boundary. Every FAIL or UNKNOWN remains a named hard
 * failure; this function deliberately computes no mean or weighted score.
 */
export function runDeterministicEvaluatorSet(
  input: readonly DeterministicEvaluatorOutcome[],
  requiredKinds: readonly DeterministicEvaluatorKind[] = ALL_DETERMINISTIC_EVALUATOR_KINDS,
): DeterministicEvaluationReport {
  if (
    input.length > MAX_EVALUATOR_OUTCOMES ||
    requiredKinds.length === 0 ||
    requiredKinds.length > ALL_DETERMINISTIC_EVALUATOR_KINDS.length ||
    new Set(requiredKinds).size !== requiredKinds.length ||
    requiredKinds.some((kind) => !ALL_DETERMINISTIC_EVALUATOR_KINDS.includes(kind))
  ) {
    return Object.freeze({
      evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION,
      passed: false,
      eligibleForPromotion: false,
      hardGateFailures: Object.freeze(["deterministic-evidence-missing"]),
      outcomes: Object.freeze([]),
      results: Object.freeze([]),
    });
  }

  const suppliedKinds = new Set(input.map((outcome) => outcome.kind));
  const missingOutcomes = requiredKinds
    .filter((kind) => !suppliedKinds.has(kind))
    .map((kind) => createMissingOutcome(kind));
  const outcomes = [...input, ...missingOutcomes].sort(
    (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind],
  );
  const duplicateKinds = new Set<DeterministicEvaluatorKind>();
  const seenKinds = new Set<DeterministicEvaluatorKind>();
  for (const outcome of outcomes) {
    if (seenKinds.has(outcome.kind)) duplicateKinds.add(outcome.kind);
    seenKinds.add(outcome.kind);
  }

  const failures = outcomes
    .filter((outcome) => outcome.classification !== "PASS")
    .map((outcome) => outcome.result.name);
  for (const kind of duplicateKinds) failures.push(DETERMINISTIC_EVALUATOR_SCORE_NAMES[kind]);
  const hardGateFailures = Object.freeze([...new Set(failures)].sort());
  const passed = hardGateFailures.length === 0;
  const frozenOutcomes = Object.freeze(outcomes);
  const results = Object.freeze(outcomes.map((outcome) => outcome.result));

  return Object.freeze({
    evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION,
    passed,
    eligibleForPromotion: passed,
    hardGateFailures,
    outcomes: frozenOutcomes,
    results,
  });
}
