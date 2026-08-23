import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Evaluation contracts deliberately live outside NestJS, Prisma and provider
 * adapters.  They are the boundary shared by local unit tests and future
 * evaluation runners.
 */

export const EvaluationTaskSchema = z.enum(["generation", "orchestrator", "runtime", "browser"]);

export type EvaluationTask = z.infer<typeof EvaluationTaskSchema>;

export const EvaluationSplitSchema = z.enum(["train", "dev", "test"]);

export type EvaluationSplit = z.infer<typeof EvaluationSplitSchema>;

/**
 * V1 risk taxonomy.  Adding a new tag is a versioned contract change rather
 * than silently accepting a typo that would create an untracked slice.
 */
export const EvaluationRiskTagSchema = z.enum([
  "budget",
  "data-leakage",
  "duplicate",
  "engagement-bait",
  "fallback",
  "factuality",
  "language-quality",
  "multilingual",
  "platform-policy",
  "prompt-injection",
  "provider",
  "reliability",
  "runtime",
  "safety",
  "schema",
  "source-quality",
  "unsupported-claim",
]);

export type EvaluationRiskTag = z.infer<typeof EvaluationRiskTagSchema>;

export const EvaluationNetworkSchema = z.enum(["X", "THREADS"]);
export type EvaluationNetwork = z.infer<typeof EvaluationNetworkSchema>;

export const EvaluationLanguageSchema = z.enum(["en", "ru", "uk", "es", "it"]);
export type EvaluationLanguage = z.infer<typeof EvaluationLanguageSchema>;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a stable identifier");

const FreeTextLabelSchema = z.string().trim().min(1).max(256);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const SensitiveNamePattern =
  /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;
const SecretValuePattern =
  /(?:Bearer\s+[A-Za-z0-9._~+/=-]+|(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}|(?:gh[pousr]|xox[baprs])_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsExpectedOutput(
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): ReadonlyArray<string | number> | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = containsExpectedOutput(item, [...path, index]);
      if (found) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const [key, item] of Object.entries(value)) {
    if (key === "expectedOutput") return [...path, key];
    const found = containsExpectedOutput(item, [...path, key]);
    if (found) return found;
  }

  return undefined;
}

function addSecretIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number> = [],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) addSecretIssues(item, ctx, [...path, index]);
    return;
  }

  if (!isRecord(value)) {
    if (typeof value === "string" && SecretValuePattern.test(value)) {
      ctx.addIssue({
        code: "custom",
        path: [...path],
        message: "secret-like values are not allowed",
      });
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (SensitiveNamePattern.test(key)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: "secret-bearing fields are not allowed",
      });
    }
    addSecretIssues(item, ctx, [...path, key]);
  }
}

const EvaluationMetadataSchema = z
  .strictObject({
    datasetVersion: IdentifierSchema,
    network: EvaluationNetworkSchema.optional(),
    language: EvaluationLanguageSchema.optional(),
    archetype: FreeTextLabelSchema,
    riskTags: z
      .array(EvaluationRiskTagSchema)
      .max(32)
      .refine((tags) => new Set(tags).size === tags.length, "riskTags must not contain duplicates"),
    provenance: FreeTextLabelSchema.optional(),
    sourceCapturedAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((metadata, ctx) => addSecretIssues(metadata, ctx));

const CandidateInputFields = {
  id: IdentifierSchema,
  schemaVersion: z.literal("1"),
  task: EvaluationTaskSchema,
  split: EvaluationSplitSchema,
  input: JsonValueSchema,
  metadata: EvaluationMetadataSchema,
};

function validateCandidateInputBoundary(
  candidateInput: { input: JsonValue; metadata: unknown },
  ctx: z.RefinementCtx,
): void {
  const path = containsExpectedOutput(candidateInput.input);
  if (path) {
    ctx.addIssue({
      code: "custom",
      path: ["input", ...path],
      message: "expectedOutput must not be embedded in candidate input",
    });
  }
  addSecretIssues(candidateInput.metadata, ctx, ["metadata"]);
}

export const CandidateInputSchema = z
  .strictObject(CandidateInputFields)
  .superRefine(validateCandidateInputBoundary);

export const EvaluationCaseSchema = z
  .strictObject({
    ...CandidateInputFields,
    expectedOutput: JsonValueSchema.optional(),
  })
  .superRefine((evaluationCase, ctx) => validateCandidateInputBoundary(evaluationCase, ctx));

export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;

/** Candidate-facing case shape; expectedOutput is not a valid field here. */
export const EvaluationCaseInputSchema = CandidateInputSchema;

const RoleConfigSchema = z
  .strictObject({
    provider: IdentifierSchema,
    model: IdentifierSchema,
    snapshot: IdentifierSchema.optional(),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
  })
  .superRefine((role, ctx) => addSecretIssues(role, ctx));

const SafeRecordKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a stable identifier")
  .refine((key) => !SensitiveNamePattern.test(key), "secret-bearing keys are not allowed");

const PromptLabelsSchema = z
  .record(SafeRecordKeySchema, IdentifierSchema)
  .superRefine((labels, ctx) => addSecretIssues(labels, ctx));

const RolesSchema = z
  .record(SafeRecordKeySchema, RoleConfigSchema)
  .superRefine((roles, ctx) => addSecretIssues(roles, ctx));

export const CandidateManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    candidateId: IdentifierSchema,
    sourceSha: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i, "must be a full Git SHA"),
    datasetName: IdentifierSchema,
    datasetVersion: IdentifierSchema,
    promptLabels: PromptLabelsSchema,
    roles: RolesSchema,
    fallbackPolicy: z.enum(["strict", "recorded"]),
    repeats: z.number().int().min(1).max(1000),
    maxConcurrency: z.number().int().min(1).max(64),
    costBudgetUsd: z.number().finite().positive().max(1_000_000),
  })
  .superRefine((manifest, ctx) => addSecretIssues(manifest, ctx));

export type CandidateManifest = z.infer<typeof CandidateManifestSchema>;

export const EvaluatorResultTypeSchema = z.enum(["BOOLEAN", "NUMERIC", "CATEGORICAL"]);
export type EvaluatorResultType = z.infer<typeof EvaluatorResultTypeSchema>;

export const EvaluatorResultSchema = z
  .strictObject({
    name: IdentifierSchema,
    type: EvaluatorResultTypeSchema,
    value: z.union([z.boolean(), z.number().finite(), FreeTextLabelSchema]),
    passed: z.boolean().optional(),
    reason: FreeTextLabelSchema.optional(),
    evaluatorVersion: IdentifierSchema,
  })
  .superRefine((result, ctx) => addSecretIssues(result, ctx));

export type EvaluatorResult = z.infer<typeof EvaluatorResultSchema>;

export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type CandidateInput = z.infer<typeof CandidateInputSchema>;

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (!isRecord(value)) return value;

  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) clone[key] = cloneJson(item);
  return clone as T;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
  }

  return value as DeepReadonly<T>;
}

/** Parse and clone a manifest before freezing it, so the caller's object is never frozen or mutated. */
export function createImmutableCandidateManifest(input: unknown): DeepReadonly<CandidateManifest> {
  const parsed = CandidateManifestSchema.parse(input);
  return deepFreeze(cloneJson(parsed));
}

/** Extract the case boundary presented to a candidate; ground truth is intentionally omitted. */
export function toCandidateInput(input: unknown): DeepReadonly<CandidateInput> {
  const parsed = EvaluationCaseSchema.parse(input);
  const { expectedOutput: _expectedOutput, ...candidateInput } = parsed;
  const cloned = cloneJson(candidateInput) as CandidateInput;
  return deepFreeze<CandidateInput>(cloned);
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Project only the documented, secret-free manifest fields before serializing.
 * This makes digest coverage explicit and prevents future input metadata from
 * becoming an accidental part of candidate identity.
 */
function canonicalManifestPayload(manifest: CandidateManifest): JsonValue {
  return {
    schemaVersion: manifest.schemaVersion,
    candidateId: manifest.candidateId,
    sourceSha: manifest.sourceSha,
    datasetName: manifest.datasetName,
    datasetVersion: manifest.datasetVersion,
    promptLabels: manifest.promptLabels,
    roles: manifest.roles,
    fallbackPolicy: manifest.fallbackPolicy,
    repeats: manifest.repeats,
    maxConcurrency: manifest.maxConcurrency,
    costBudgetUsd: manifest.costBudgetUsd,
  };
}

export function serializeCandidateManifest(input: unknown): string {
  const manifest = CandidateManifestSchema.parse(input);
  return canonicalJson(canonicalManifestPayload(manifest));
}

export function candidateManifestDigest(input: unknown): string {
  return createHash("sha256").update(serializeCandidateManifest(input), "utf8").digest("hex");
}

export const getCandidateManifestDigest = candidateManifestDigest;

export interface CandidateManifestArtifact {
  readonly manifest: DeepReadonly<CandidateManifest>;
  readonly serialized: string;
  readonly digest: string;
}

export function createCandidateManifestArtifact(input: unknown): CandidateManifestArtifact {
  const manifest = createImmutableCandidateManifest(input);
  const serialized = serializeCandidateManifest(manifest);
  return Object.freeze({
    manifest,
    serialized,
    digest: createHash("sha256").update(serialized, "utf8").digest("hex"),
  });
}
