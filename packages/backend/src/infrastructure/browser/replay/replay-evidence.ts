import { z } from "zod";
import {
  BrowserReplayFixtureSchema,
  type BrowserReplayFixture,
} from "./browser-replay-contract.js";
import { compareSelectorDrift, type SelectorDriftReport } from "./selector-drift.js";

export const ReplayEvidenceClassSchema = z.enum([
  "LOCAL_FIXTURE",
  "LOCAL_REPLAY",
  "LOCAL_DRY_RUN",
  "EXTERNAL_LIVE",
  "MANUAL_ACCEPTANCE",
]);
export type ReplayEvidenceClass = z.infer<typeof ReplayEvidenceClassSchema>;
export const ReplayEvidenceStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "BLOCKED_EXTERNAL",
  "NO_CONCLUSION",
]);
export type ReplayEvidenceStatus = z.infer<typeof ReplayEvidenceStatusSchema>;

const ExternalProofSchema = z.strictObject({
  kind: z.enum(["EXTERNAL_LIVE", "MANUAL_ACCEPTANCE"]),
  reference: z.string().trim().min(1).max(2_048),
});

export interface ReplayEvidenceInput {
  readonly fixture: unknown;
  readonly selectorObservations?: unknown;
  readonly sourceSha: string;
  readonly version: string;
  readonly evidenceClass?: ReplayEvidenceClass;
  readonly externalProof?: {
    readonly kind: "EXTERNAL_LIVE" | "MANUAL_ACCEPTANCE";
    readonly reference: string;
  };
}
export interface ReplayEvidenceReport {
  readonly schemaVersion: "1";
  readonly scenarioId: string;
  readonly network: BrowserReplayFixture["network"];
  readonly version: string;
  readonly sourceSha: string;
  readonly evidenceClass: ReplayEvidenceClass;
  readonly status: ReplayEvidenceStatus;
  readonly selector: Pick<SelectorDriftReport, "matches" | "checkedActions" | "issues">;
  readonly issues: readonly string[];
  readonly nextGate: "EXTERNAL_LIVE" | "MANUAL_ACCEPTANCE" | null;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("unsupported report value");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export function evaluateReplayEvidence(input: ReplayEvidenceInput): ReplayEvidenceReport {
  const fixture = BrowserReplayFixtureSchema.parse(input.fixture);
  const evidenceClass = ReplayEvidenceClassSchema.parse(input.evidenceClass ?? "LOCAL_REPLAY");
  const externalProof =
    input.externalProof === undefined ? undefined : ExternalProofSchema.parse(input.externalProof);
  if (evidenceClass === "EXTERNAL_LIVE" || evidenceClass === "MANUAL_ACCEPTANCE") {
    if (!externalProof || externalProof.kind !== evidenceClass)
      throw new Error(`explicit ${evidenceClass} evidence requires matching external proof`);
  } else if (externalProof)
    throw new Error("external proof cannot be downgraded to local evidence");
  if (!/^[0-9a-f]{7,128}$/i.test(input.sourceSha)) throw new Error("sourceSha must be a git SHA");
  if (!input.version.trim()) throw new Error("version is required");
  const selector = compareSelectorDrift(fixture, input.selectorObservations ?? []);
  const fatalErrors = fixture.pages.flatMap((page) => [
    ...page.errors.filter((error) => error.fatal),
    ...page.actions.flatMap((action) => (action.error?.fatal ? [action.error] : [])),
  ]);
  const issues = [
    ...selector.issues.map((issue) => `[${issue.code}] ${issue.actionId}: ${issue.message}`),
    ...fatalErrors.map((error) => `[FATAL_REPLAY_ERROR] ${error.name}: ${error.message}`),
  ].sort();
  const local = evidenceClass.startsWith("LOCAL_");
  const status: ReplayEvidenceStatus =
    issues.length > 0 ? "FAIL" : local ? "BLOCKED_EXTERNAL" : "PASS";
  return Object.freeze({
    schemaVersion: "1" as const,
    scenarioId: fixture.scenarioId,
    network: fixture.network,
    version: input.version,
    sourceSha: input.sourceSha,
    evidenceClass,
    status,
    selector,
    issues: Object.freeze(issues),
    nextGate: local ? "EXTERNAL_LIVE" : null,
  });
}
export function serializeReplayEvidence(report: ReplayEvidenceReport): string {
  return canonicalJson(report);
}
