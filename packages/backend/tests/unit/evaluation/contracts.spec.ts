import { describe, expect, it } from "vitest";
import {
  CandidateInputSchema,
  CandidateManifestSchema,
  EvaluationCaseSchema,
  EvaluatorResultSchema,
  candidateManifestDigest,
  createCandidateManifestArtifact,
  createImmutableCandidateManifest,
  serializeCandidateManifest,
  toCandidateInput,
} from "../../../src/modules/evaluation/contracts.js";

const sourceSha = "a".repeat(40);

function manifestFixture() {
  return {
    schemaVersion: "1" as const,
    candidateId: "candidate-baseline",
    sourceSha,
    datasetName: "spa-agent-eval-v1",
    datasetVersion: "2026-08-22.1",
    promptLabels: {
      draftPost: "production",
      hookGeneration: "production",
    },
    roles: {
      generation: {
        provider: "openai",
        model: "gpt-5-nano",
        snapshot: "2026-08-07",
        reasoningEffort: "low" as const,
        temperature: 0.2,
      },
    },
    fallbackPolicy: "strict" as const,
    repeats: 2,
    maxConcurrency: 3,
    costBudgetUsd: 25,
  };
}

function caseFixture() {
  return {
    id: "gen-x-uk-fact-001",
    schemaVersion: "1" as const,
    task: "generation" as const,
    split: "test" as const,
    input: {
      topic: "Mercury retrograde and planning",
      sourceFacts: ["fixture fact"],
    },
    expectedOutput: {
      allowedDecision: ["PUBLISHABLE", "EDIT"],
    },
    metadata: {
      datasetVersion: "2026-08-22.1",
      network: "X" as const,
      language: "uk" as const,
      archetype: "fact-led",
      riskTags: ["factuality", "multilingual"] as const,
    },
  };
}

describe("evaluation contracts", () => {
  it("accepts the documented case, manifest and evaluator result shapes", () => {
    expect(EvaluationCaseSchema.parse(caseFixture()).id).toBe("gen-x-uk-fact-001");
    expect(CandidateManifestSchema.parse(manifestFixture()).fallbackPolicy).toBe("strict");
    expect(
      EvaluatorResultSchema.parse({
        name: "schema-valid",
        type: "BOOLEAN",
        value: true,
        passed: true,
        evaluatorVersion: "v1",
      }).value,
    ).toBe(true);
  });

  it.each([
    ["schemaVersion", { schemaVersion: "2" }],
    ["task", { task: "unknown" }],
    ["split", { split: "holdout" }],
    ["risk tag", { metadata: { ...caseFixture().metadata, riskTags: ["not-a-risk"] } }],
  ])("rejects invalid %s values", (_field, override) => {
    expect(() => EvaluationCaseSchema.parse({ ...caseFixture(), ...override })).toThrow();
  });

  it("rejects invalid manifest configuration and secret-bearing fields", () => {
    expect(() => CandidateManifestSchema.parse({ ...manifestFixture(), repeats: 0 })).toThrow();
    expect(() =>
      CandidateManifestSchema.parse({ ...manifestFixture(), maxConcurrency: 65 }),
    ).toThrow();
    expect(() =>
      CandidateManifestSchema.parse({ ...manifestFixture(), costBudgetUsd: -1 }),
    ).toThrow();
    expect(() =>
      CandidateManifestSchema.parse({ ...manifestFixture(), apiKey: "sk-test-secret-value" }),
    ).toThrow();
  });

  it("keeps the canonical digest stable when record insertion order changes", () => {
    const first = manifestFixture();
    const second = {
      ...first,
      promptLabels: {
        hookGeneration: "production",
        draftPost: "production",
      },
      roles: {
        ...first.roles,
      },
    };
    expect(candidateManifestDigest(first)).toBe(candidateManifestDigest(second));
    expect(serializeCandidateManifest(first)).toBe(serializeCandidateManifest(second));
  });

  it.each([
    ["sourceSha", { sourceSha: "b".repeat(40) }],
    ["dataset", { datasetVersion: "2026-08-23.1" }],
    ["prompt", { promptLabels: { ...manifestFixture().promptLabels, draftPost: "candidate" } }],
    [
      "role",
      {
        roles: {
          ...manifestFixture().roles,
          generation: { ...manifestFixture().roles.generation, model: "gpt-5" },
        },
      },
    ],
    ["fallback", { fallbackPolicy: "recorded" }],
    ["repeats", { repeats: 3 }],
    ["concurrency", { maxConcurrency: 4 }],
    ["budget", { costBudgetUsd: 26 }],
  ])("changes the digest when %s changes", (_field, override) => {
    expect(candidateManifestDigest(manifestFixture())).not.toBe(
      candidateManifestDigest({ ...manifestFixture(), ...override }),
    );
  });

  it("returns an immutable manifest without mutating the caller", () => {
    const input = manifestFixture();
    const manifest = createImmutableCandidateManifest(input);

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.roles)).toBe(true);
    expect(input.roles.generation.model).toBe("gpt-5-nano");
    expect(() => {
      (manifest.roles.generation as { readonly model: string }).model = "changed";
    }).toThrow();
  });

  it("isolates expected output from the candidate input boundary", () => {
    const candidateInput = toCandidateInput(caseFixture());
    expect(candidateInput).not.toHaveProperty("expectedOutput");
    expect(() => CandidateInputSchema.parse({ ...candidateInput, expectedOutput: {} })).toThrow();
    expect(candidateInput.input).toEqual(caseFixture().input);
    expect(Object.isFrozen(candidateInput)).toBe(true);
    expect(() =>
      EvaluationCaseSchema.parse({
        ...caseFixture(),
        input: { ...caseFixture().input, expectedOutput: { leaked: true } },
      }),
    ).toThrow();
  });

  it("keeps serialization secret-safe and returns a bound artifact", () => {
    const artifact = createCandidateManifestArtifact(manifestFixture());
    expect(() =>
      serializeCandidateManifest({
        ...manifestFixture(),
        roles: {
          generation: {
            ...manifestFixture().roles.generation,
            model: "sk-secret-value-that-must-not-serialize",
          },
        },
      }),
    ).toThrow();
    expect(artifact.serialized).not.toMatch(/password|token|secret|api[-_]?key/i);
    expect(artifact.serialized).toContain("sourceSha");
    expect(artifact.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.manifest)).toBe(true);
  });
});
