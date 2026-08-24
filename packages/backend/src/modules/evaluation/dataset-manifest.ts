import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EvaluationCaseSchema,
  EvaluationLanguageSchema,
  EvaluationNetworkSchema,
  EvaluationRiskTagSchema,
  type JsonValue,
} from "./contracts.js";

export const DATASET_NAME = "spa-agent-eval-v1" as const;
export const DATASET_SCHEMA_VERSION = "1" as const;

const FamilySchema = z.enum(["generation", "orchestrator", "runtime", "safety"]);
export type DatasetFamily = z.infer<typeof FamilySchema>;

const DatasetMetadataSchema = z
  .object({
    datasetVersion: z.string().trim().min(1),
    family: FamilySchema,
    archetype: z.string().trim().min(1),
    riskTags: z.array(EvaluationRiskTagSchema).min(1),
    provenance: z.string().trim().min(1),
    network: EvaluationNetworkSchema.optional(),
    language: EvaluationLanguageSchema.optional(),
    sourceCapturedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const DatasetCaseSchema = EvaluationCaseSchema.safeExtend({
  metadata: DatasetMetadataSchema,
}).strict();
export type DatasetCase = z.infer<typeof DatasetCaseSchema>;

export interface DatasetManifest {
  readonly schemaVersion: typeof DATASET_SCHEMA_VERSION;
  readonly datasetName: typeof DATASET_NAME;
  readonly datasetVersion: string;
  readonly cases: readonly DatasetCase[];
  readonly counts: Readonly<Record<"train" | "dev" | "test", number>>;
  readonly digest: string;
}

export interface DatasetManifestOptions {
  readonly datasetVersion: string;
  readonly cases: readonly unknown[];
}

function canonical(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

function contentKey(item: DatasetCase): string {
  return canonical(item.input);
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>))
      immutable(child);
  }
  return value;
}

export function createDatasetManifest(options: DatasetManifestOptions): DatasetManifest {
  const expected = { train: 20, dev: 40, test: 60 } as const;
  if (options.datasetVersion.trim() === "") throw new Error("datasetVersion is required");
  if (options.cases.length !== 120) throw new Error("spa-agent-eval-v1 requires exactly 120 cases");
  const parsed = options.cases.map((item) => DatasetCaseSchema.parse(item));
  const ids = new Set<string>();
  const contents = new Map<string, string>();
  for (const item of parsed) {
    if (item.metadata.datasetVersion !== options.datasetVersion)
      throw new Error(`case ${item.id} has a mismatched datasetVersion`);
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    const key = contentKey(item);
    const previous = contents.get(key);
    if (previous) throw new Error(`duplicate case content: ${previous} and ${item.id}`);
    contents.set(key, item.id);
  }
  const counts = { train: 0, dev: 0, test: 0 };
  for (const item of parsed) counts[item.split]++;
  for (const split of ["train", "dev", "test"] as const)
    if (counts[split] !== expected[split])
      throw new Error(`invalid ${split} count: expected ${expected[split]}, got ${counts[split]}`);
  const familyCounts = Object.fromEntries(
    FamilySchema.options.map((family) => [
      family,
      parsed.filter((item) => item.metadata.family === family).length,
    ]),
  );
  for (const [family, expectedCount] of Object.entries({
    generation: 60,
    orchestrator: 30,
    runtime: 20,
    safety: 10,
  })) {
    if (familyCounts[family] !== expectedCount)
      throw new Error(
        `invalid ${family} count: expected ${expectedCount}, got ${familyCounts[family]}`,
      );
  }
  const devTest = parsed.filter((item) => item.split !== "train");
  for (const family of FamilySchema.options)
    for (const split of ["dev", "test"] as const) {
      if (!parsed.some((item) => item.metadata.family === family && item.split === split))
        throw new Error(`missing ${family} coverage in ${split}`);
    }
  for (const language of EvaluationLanguageSchema.options)
    for (const split of ["dev", "test"] as const) {
      if (!devTest.some((item) => item.metadata.language === language && item.split === split))
        throw new Error(`missing ${language} coverage in ${split}`);
    }
  for (const network of EvaluationNetworkSchema.options)
    for (const split of ["dev", "test"] as const) {
      if (!devTest.some((item) => item.metadata.network === network && item.split === split))
        throw new Error(`missing ${network} coverage in ${split}`);
    }
  const ordered = [...parsed].sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    schemaVersion: DATASET_SCHEMA_VERSION,
    datasetName: DATASET_NAME,
    datasetVersion: options.datasetVersion,
    cases: ordered,
  };
  const digest = createHash("sha256")
    .update(canonical(payload as unknown as JsonValue), "utf8")
    .digest("hex");
  return immutable({
    schemaVersion: DATASET_SCHEMA_VERSION,
    datasetName: DATASET_NAME,
    datasetVersion: options.datasetVersion,
    cases: ordered,
    counts,
    digest,
  });
}

export function serializeDatasetManifest(manifest: DatasetManifest): string {
  return canonical({
    schemaVersion: manifest.schemaVersion,
    datasetName: manifest.datasetName,
    datasetVersion: manifest.datasetVersion,
    cases: manifest.cases,
  } as unknown as JsonValue);
}

export function datasetManifestDigest(manifest: DatasetManifest): string {
  return createHash("sha256").update(serializeDatasetManifest(manifest), "utf8").digest("hex");
}
