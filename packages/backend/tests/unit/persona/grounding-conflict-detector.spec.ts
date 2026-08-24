import { describe, expect, it } from "vitest";
import { detectGroundingConflicts } from "../../../src/modules/persona/grounding-conflict-detector.js";

describe("GROUND-101 grounding conflict detector", () => {
  it("flags opposing polarity for the same subject without deciding truth", () => {
    const conflicts = detectGroundingConflicts([
      { id: "memory-1", sourceType: "MEMORY", text: "Morning movement helps energy and focus." },
      {
        id: "evidence-1",
        sourceType: "EVIDENCE",
        text: "Morning movement does not reduce energy and focus.",
      },
    ]);

    expect(conflicts).toEqual([
      expect.objectContaining({
        leftId: "memory-1",
        rightId: "evidence-1",
        reason: "OPPOSING_POLARITY_REVIEW_REQUIRED",
      }),
    ]);
  });

  it("ignores unrelated or same-polarity items", () => {
    expect(
      detectGroundingConflicts([
        { id: "a", sourceType: "MEMORY", text: "Astrology uses symbolic language." },
        { id: "b", sourceType: "EVIDENCE", text: "Astrology uses symbolic language." },
        { id: "c", sourceType: "EVIDENCE", text: "A separate topic about sleep." },
      ]),
    ).toEqual([]);
  });
});
