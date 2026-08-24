import { describe, expect, it } from "vitest";
import {
  createDatasetManifest,
  datasetManifestDigest,
  type DatasetCase,
} from "../../../src/modules/evaluation/dataset-manifest.js";

function fixture(): DatasetCase[] {
  const families = [
    ...Array(60).fill("generation"),
    ...Array(30).fill("orchestrator"),
    ...Array(20).fill("runtime"),
    ...Array(10).fill("safety"),
  ] as DatasetCase["metadata"]["family"][];
  const splitPlan = {
    generation: [10, 20],
    orchestrator: [5, 10],
    runtime: [3, 7],
    safety: [2, 3],
  };
  return families.map((family, index) => ({
    id: `case-${String(index).padStart(3, "0")}`,
    schemaVersion: "1" as const,
    task:
      family === "generation"
        ? "generation"
        : family === "orchestrator"
          ? "orchestrator"
          : "runtime",
    split: (() => {
      const familyIndex = families.slice(0, index + 1).filter((item) => item === family).length - 1;
      const [train, dev] = splitPlan[family];
      return (
        familyIndex < train ? "train" : familyIndex < train + dev ? "dev" : "test"
      ) as DatasetCase["split"];
    })(),
    input: { prompt: `synthetic input ${index}` },
    expectedOutput: { allowed: ["EDIT"] },
    metadata: {
      datasetVersion: "v1",
      family,
      archetype: `fixture-${index % 6}`,
      riskTags: [family === "safety" ? "safety" : "factuality"],
      provenance: "LOCAL_SYNTHETIC",
      language: ["en", "ru", "uk", "es", "it"][index % 5] as DatasetCase["metadata"]["language"],
      network: index % 2 ? "X" : "THREADS",
    },
  }));
}

describe("dataset manifest boundary", () => {
  it("builds the deterministic 120-case local manifest", () => {
    const first = createDatasetManifest({ datasetVersion: "v1", cases: fixture() });
    const second = createDatasetManifest({ datasetVersion: "v1", cases: [...fixture()].reverse() });
    expect(first.counts).toEqual({ train: 20, dev: 40, test: 60 });
    expect(first.digest).toBe(second.digest);
    expect(datasetManifestDigest(first)).toBe(first.digest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.cases.map(({ id }) => id)).toEqual(
      [...first.cases].map(({ id }) => id).sort((a, b) => a.localeCompare(b)),
    );
    expect(first.cases.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it("does not mutate caller input and freezes nested manifest data", () => {
    const cases = fixture();
    const before = structuredClone(cases);
    const manifest = createDatasetManifest({ datasetVersion: "v1", cases });

    expect(cases).toEqual(before);
    expect(Object.isFrozen(manifest.cases)).toBe(true);
    expect(Object.isFrozen(manifest.cases[0].input)).toBe(true);
    expect(() => {
      (manifest.cases[0].input as Record<string, unknown>).prompt = "changed";
    }).toThrow();
  });

  it.each([
    ["wrong size", fixture().slice(0, 119)],
    [
      "duplicate id",
      fixture().map((item, index) => (index === 1 ? { ...item, id: fixture()[0].id } : item)),
    ],
    [
      "duplicate content",
      fixture().map((item, index) => (index === 1 ? { ...item, input: fixture()[0].input } : item)),
    ],
    [
      "expected output leakage",
      fixture().map((item, index) =>
        index === 1 ? { ...item, input: { expectedOutput: true } } : item,
      ),
    ],
  ])("rejects %s", (_name, cases) => {
    expect(() => createDatasetManifest({ datasetVersion: "v1", cases })).toThrow();
  });

  it("rejects a datasetVersion mismatch", () => {
    const cases = fixture().map((item, index) =>
      index === 0 ? { ...item, metadata: { ...item.metadata, datasetVersion: "v2" } } : item,
    );
    expect(() => createDatasetManifest({ datasetVersion: "v1", cases })).toThrow(
      "mismatched datasetVersion",
    );
  });

  it("rejects malformed, secret-bearing, and invalid risk/provenance records", () => {
    const cases = fixture();
    expect(() =>
      createDatasetManifest({
        datasetVersion: "v1",
        cases: cases.map((item, index) => (index === 0 ? { ...item, schemaVersion: "2" } : item)),
      }),
    ).toThrow();
    expect(() =>
      createDatasetManifest({
        datasetVersion: "v1",
        cases: cases.map((item, index) =>
          index === 0
            ? { ...item, metadata: { ...item.metadata, riskTags: ["not-a-risk"] } }
            : item,
        ),
      }),
    ).toThrow();
    expect(() =>
      createDatasetManifest({
        datasetVersion: "v1",
        cases: cases.map((item, index) =>
          index === 0
            ? { ...item, metadata: { ...item.metadata, provenance: "Bearer sk-secret12345678" } }
            : item,
        ),
      }),
    ).toThrow();
  });

  it("keeps serialized output deterministic and excludes no validated secrets", () => {
    const manifest = createDatasetManifest({ datasetVersion: "v1", cases: fixture() });
    expect(datasetManifestDigest(manifest)).toBe(manifest.digest);
    expect(JSON.stringify(manifest)).not.toContain("Bearer");
  });
});
