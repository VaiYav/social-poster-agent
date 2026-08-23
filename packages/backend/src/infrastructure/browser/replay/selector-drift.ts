import {
  BrowserReplayFixtureSchema,
  ReplaySelectorObservationsSchema,
  selectorCandidateLabel,
  type ReplayAction,
  type ReplaySelectorObservation,
  type SelectorCandidate,
} from "./browser-replay-contract.js";

export type SelectorDriftIssueCode =
  | "MISSING_OBSERVATION"
  | "UNEXPECTED_OBSERVATION"
  | "CHAIN_LENGTH_CHANGED"
  | "SELECTOR_CHANGED"
  | "RESOLUTION_CHANGED"
  | "NO_SELECTOR_MATCHED";

export interface SelectorDriftIssue {
  readonly code: SelectorDriftIssueCode;
  readonly actionId: string;
  readonly message: string;
}

export interface SelectorDriftReport {
  readonly matches: boolean;
  readonly checkedActions: number;
  readonly issues: readonly SelectorDriftIssue[];
}

type SelectorReplayAction = Extract<ReplayAction, { selectorChain: unknown }>;

function isSelectorReplayAction(action: ReplayAction): action is SelectorReplayAction {
  return "selectorChain" in action;
}

function selectorIdentity(candidate: SelectorCandidate): string {
  switch (candidate.kind) {
    case "testId":
    case "css":
      return `${candidate.kind}:${candidate.value}`;
    case "role":
      return `${candidate.kind}:${candidate.role}:${candidate.name ?? ""}:${candidate.exact ?? false}`;
    case "label":
    case "text":
      return `${candidate.kind}:${candidate.value}:${candidate.exact ?? false}`;
  }
}

function resolvedCandidate(
  selectorChain: readonly SelectorCandidate[],
  index: number | null,
): SelectorCandidate | undefined {
  return index === null ? undefined : selectorChain[index];
}

function describeResolution(
  selectorChain: readonly SelectorCandidate[],
  index: number | null,
): string {
  const candidate = resolvedCandidate(selectorChain, index);
  return candidate && index !== null
    ? `#${index + 1} ${selectorCandidateLabel(candidate)}`
    : "no selector match";
}

function compareAction(
  expected: SelectorReplayAction,
  observed: ReplaySelectorObservation,
): SelectorDriftIssue[] {
  const issues: SelectorDriftIssue[] = [];
  const maxLength = Math.max(expected.selectorChain.length, observed.selectorChain.length);

  if (expected.selectorChain.length !== observed.selectorChain.length) {
    issues.push({
      code: "CHAIN_LENGTH_CHANGED",
      actionId: expected.actionId,
      message: `selector chain length changed from ${expected.selectorChain.length} to ${observed.selectorChain.length}; review fallback coverage for "${expected.actionId}"`,
    });
  }

  for (let index = 0; index < maxLength; index++) {
    const expectedCandidate = expected.selectorChain[index];
    const observedCandidate = observed.selectorChain[index];
    if (
      expectedCandidate &&
      observedCandidate &&
      selectorIdentity(expectedCandidate) === selectorIdentity(observedCandidate)
    ) {
      continue;
    }

    issues.push({
      code: "SELECTOR_CHANGED",
      actionId: expected.actionId,
      message: `fallback #${index + 1} changed from ${expectedCandidate ? selectorCandidateLabel(expectedCandidate) : "<missing>"} to ${observedCandidate ? selectorCandidateLabel(observedCandidate) : "<missing>"}; update the selector contract only after page review`,
    });
  }

  if (observed.resolvedSelectorIndex === null && expected.resolvedSelectorIndex !== null) {
    const errorSuffix = observed.error ? ` Recorded error: ${observed.error.message}` : "";
    issues.push({
      code: "NO_SELECTOR_MATCHED",
      actionId: expected.actionId,
      message: `expected ${describeResolution(expected.selectorChain, expected.resolvedSelectorIndex)}, but no current selector matched.${errorSuffix}`,
    });
    return issues;
  }

  const expectedResolved = resolvedCandidate(
    expected.selectorChain,
    expected.resolvedSelectorIndex,
  );
  const observedResolved = resolvedCandidate(
    observed.selectorChain,
    observed.resolvedSelectorIndex,
  );
  const sameResolution =
    (!expectedResolved && !observedResolved) ||
    (expectedResolved &&
      observedResolved &&
      selectorIdentity(expectedResolved) === selectorIdentity(observedResolved));

  if (!sameResolution) {
    issues.push({
      code: "RESOLUTION_CHANGED",
      actionId: expected.actionId,
      message: `resolved fallback changed from ${describeResolution(expected.selectorChain, expected.resolvedSelectorIndex)} to ${describeResolution(observed.selectorChain, observed.resolvedSelectorIndex)}; verify the element target before accepting the fixture`,
    });
  }

  return issues;
}

/**
 * Compare recorded selector chains with a replay observation without opening a
 * browser. Action IDs are sorted so observation order cannot change output.
 */
export function compareSelectorDrift(
  fixtureInput: unknown,
  observationsInput: unknown,
): SelectorDriftReport {
  const fixture = BrowserReplayFixtureSchema.parse(fixtureInput);
  const observations = ReplaySelectorObservationsSchema.parse(observationsInput);
  const expectedActions = fixture.pages
    .flatMap((page) => page.actions)
    .filter(isSelectorReplayAction);
  const expectedById = new Map(expectedActions.map((action) => [action.actionId, action]));
  const observedById = new Map(
    observations.map((observation) => [observation.actionId, observation]),
  );
  const issues: SelectorDriftIssue[] = [];

  for (const actionId of [...expectedById.keys()].sort()) {
    const expected = expectedById.get(actionId);
    if (!expected) continue;
    const observed = observedById.get(actionId);
    if (!observed) {
      issues.push({
        code: "MISSING_OBSERVATION",
        actionId,
        message: `no replay observation was provided; run the selector-only replay for "${actionId}"`,
      });
      continue;
    }
    issues.push(...compareAction(expected, observed));
  }

  for (const actionId of [...observedById.keys()].sort()) {
    if (expectedById.has(actionId)) continue;
    issues.push({
      code: "UNEXPECTED_OBSERVATION",
      actionId,
      message: `observation has no matching recorded action; remove it or record a versioned fixture action`,
    });
  }

  return {
    matches: issues.length === 0,
    checkedActions: expectedActions.length,
    issues,
  };
}

export function formatSelectorDriftReport(report: SelectorDriftReport): string {
  if (report.matches) {
    return `Selector replay matches ${report.checkedActions} action(s).`;
  }

  return [
    `Selector drift detected: ${report.issues.length} issue(s) across ${report.checkedActions} recorded action(s).`,
    ...report.issues.map((issue) => `- [${issue.code}] ${issue.actionId}: ${issue.message}`),
  ].join("\n");
}
