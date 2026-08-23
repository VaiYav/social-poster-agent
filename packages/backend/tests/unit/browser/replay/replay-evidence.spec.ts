import { describe, expect, it } from "vitest";
import {
  evaluateReplayEvidence,
  serializeReplayEvidence,
} from "../../../../src/infrastructure/browser/replay/replay-evidence.js";
import {
  createFillSelectorChain,
  createReplayFixture,
  createSubmitSelectorChain,
} from "./replay-fixture.js";

const observations = [
  {
    actionId: "compose.fill",
    selectorChain: createFillSelectorChain(),
    resolvedSelectorIndex: 0,
    error: null,
  },
  {
    actionId: "compose.submit",
    selectorChain: createSubmitSelectorChain(),
    resolvedSelectorIndex: 0,
    error: null,
  },
];

describe("replay evidence boundary", () => {
  it("classifies a clean local replay as blocked external, never live pass", () => {
    const report = evaluateReplayEvidence({
      fixture: createReplayFixture(),
      selectorObservations: observations,
      sourceSha: "abcdef1234567",
      version: "test-1",
    });
    expect(report).toMatchObject({
      evidenceClass: "LOCAL_REPLAY",
      status: "BLOCKED_EXTERNAL",
      nextGate: "EXTERNAL_LIVE",
    });
  });
  it("fails deterministically on selector drift and fatal replay errors", () => {
    const fixture = createReplayFixture();
    fixture.pages[0]!.errors.push({
      source: "page",
      name: "Fatal",
      message: "replay failed",
      fatal: true,
    });
    const report = evaluateReplayEvidence({
      fixture,
      selectorObservations: [],
      sourceSha: "abcdef1234567",
      version: "test-1",
    });
    expect(report.status).toBe("FAIL");
    expect(report.issues[0]).toContain("FATAL_REPLAY_ERROR");
  });
  it("rejects external proof attached to local evidence and requires matching proof", () => {
    const base = {
      fixture: createReplayFixture(),
      selectorObservations: observations,
      sourceSha: "abcdef1234567",
      version: "test-1",
    };
    expect(() =>
      evaluateReplayEvidence({ ...base, externalProof: { kind: "EXTERNAL_LIVE", reference: "x" } }),
    ).toThrow("downgraded");
    expect(() => evaluateReplayEvidence({ ...base, evidenceClass: "EXTERNAL_LIVE" })).toThrow(
      "matching external proof",
    );
    expect(
      evaluateReplayEvidence({
        ...base,
        evidenceClass: "EXTERNAL_LIVE",
        externalProof: { kind: "EXTERNAL_LIVE", reference: "x" },
      }).status,
    ).toBe("PASS");
  });

  it("fails closed for unknown evidence classes and empty proof references", () => {
    const base = {
      fixture: createReplayFixture(),
      selectorObservations: observations,
      sourceSha: "abcdef1234567",
      version: "test-1",
    };
    expect(() => evaluateReplayEvidence({ ...base, evidenceClass: "UNKNOWN" as never })).toThrow();
    expect(() =>
      evaluateReplayEvidence({
        ...base,
        evidenceClass: "EXTERNAL_LIVE",
        externalProof: { kind: "EXTERNAL_LIVE", reference: "   " },
      }),
    ).toThrow();
  });
  it("serializes with stable ordering and does not mutate caller data", () => {
    const fixture = createReplayFixture();
    const before = JSON.stringify(fixture);
    const report = evaluateReplayEvidence({
      fixture,
      selectorObservations: observations,
      sourceSha: "abcdef1234567",
      version: "test-1",
    });
    expect(serializeReplayEvidence(report)).toBe(serializeReplayEvidence({ ...report }));
    expect(JSON.stringify(fixture)).toBe(before);
  });
});
