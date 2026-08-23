import { describe, expect, it } from "vitest";
import {
  compareSelectorDrift,
  formatSelectorDriftReport,
} from "../../../../src/infrastructure/browser/replay/selector-drift.js";
import {
  createFillSelectorChain,
  createReplayFixture,
  createSubmitSelectorChain,
} from "./replay-fixture.js";

function matchingObservations() {
  return [
    {
      actionId: "compose.submit",
      selectorChain: createSubmitSelectorChain(),
      resolvedSelectorIndex: 0,
      error: null,
    },
    {
      actionId: "compose.fill",
      selectorChain: createFillSelectorChain(),
      resolvedSelectorIndex: 0,
      error: null,
    },
  ];
}

describe("selector drift comparison", () => {
  it("reports a deterministic match when fallback chains and resolutions are unchanged", () => {
    const report = compareSelectorDrift(createReplayFixture(), matchingObservations());

    expect(report).toEqual({ matches: true, checkedActions: 2, issues: [] });
    expect(formatSelectorDriftReport(report)).toBe("Selector replay matches 2 action(s).");
  });

  it("detects changed selectors, fallback resolution, and no-match failures", () => {
    const observations = [
      {
        actionId: "compose.submit",
        selectorChain: createSubmitSelectorChain(),
        resolvedSelectorIndex: null,
        error: {
          source: "action" as const,
          name: "SelectorNotFoundError",
          message: "No submit control was visible.",
          fatal: true,
        },
      },
      {
        actionId: "compose.fill",
        selectorChain: [
          { kind: "testId" as const, value: "tweetTextarea_1" },
          { kind: "role" as const, role: "textbox", name: "Post text" },
          { kind: "css" as const, value: "div[contenteditable='true']" },
          { kind: "text" as const, value: "What is happening?!" },
        ],
        resolvedSelectorIndex: 1,
        error: null,
      },
    ];

    const report = compareSelectorDrift(createReplayFixture(), observations);
    const reportWithReorderedInput = compareSelectorDrift(
      createReplayFixture(),
      [...observations].reverse(),
    );

    expect(report).toEqual(reportWithReorderedInput);
    expect(report.matches).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual([
      "SELECTOR_CHANGED",
      "RESOLUTION_CHANGED",
      "NO_SELECTOR_MATCHED",
    ]);

    const formatted = formatSelectorDriftReport(report);
    expect(formatted).toContain(
      '[SELECTOR_CHANGED] compose.fill: fallback #1 changed from testId("tweetTextarea_0") to testId("tweetTextarea_1")',
    );
    expect(formatted).toContain(
      '[RESOLUTION_CHANGED] compose.fill: resolved fallback changed from #1 testId("tweetTextarea_0") to #2 role("textbox", name="Post text")',
    );
    expect(formatted).toContain(
      '[NO_SELECTOR_MATCHED] compose.submit: expected #1 testId("tweetButtonInline"), but no current selector matched. Recorded error: No submit control was visible.',
    );
  });

  it("reports missing and unexpected observations with stable actionable ordering", () => {
    const report = compareSelectorDrift(createReplayFixture(), [
      {
        actionId: "compose.unknown",
        selectorChain: [{ kind: "css", value: "button.unknown" }],
        resolvedSelectorIndex: 0,
        error: null,
      },
    ]);

    expect(report.issues.map((issue) => [issue.code, issue.actionId])).toEqual([
      ["MISSING_OBSERVATION", "compose.fill"],
      ["MISSING_OBSERVATION", "compose.submit"],
      ["UNEXPECTED_OBSERVATION", "compose.unknown"],
    ]);
    expect(formatSelectorDriftReport(report)).toContain(
      'run the selector-only replay for "compose.fill"',
    );
  });
});
