import { z } from "zod";

const SensitiveFieldNamePattern =
  /(?:api[-_]?key|authorization|cookie|credential|password|passwd|secret|storage[-_]?state|token)/i;
const SecretLikeValuePattern =
  /(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|Basic\s+[A-Za-z0-9+/=]{8,}|(?:sk|rk|pk)-(?:live|test)?_?[A-Za-z0-9_-]{8,}|(?:gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:password|passwd|access[-_]?token|refresh[-_]?token|cookie|authorization|api[-_]?key|secret)\s*[:=]\s*[^\s,;]+)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addSecretIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number> = [],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      addSecretIssues(item, ctx, [...path, index]);
    }
    return;
  }

  if (!isRecord(value)) {
    if (typeof value === "string" && SecretLikeValuePattern.test(value)) {
      ctx.addIssue({
        code: "custom",
        path: [...path],
        message: "secret-like values are not allowed in browser replay fixtures",
      });
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (SensitiveFieldNamePattern.test(key)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: `secret-bearing field "${key}" is not allowed in browser replay fixtures`,
      });
    }
    addSecretIssues(item, ctx, [...path, key]);
  }
}

const SecretFreeInputSchema = z.unknown().superRefine(addSecretIssues);

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a stable identifier");

const NonEmptyTextSchema = z.string().min(1).max(10_000);

function isSafeReplayUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username || parsed.password) return false;

    for (const key of parsed.searchParams.keys()) {
      if (SensitiveFieldNamePattern.test(key)) return false;
    }
    return !SecretLikeValuePattern.test(parsed.hash);
  } catch {
    return false;
  }
}

export const ReplayUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    isSafeReplayUrl,
    "must be an http(s) URL without embedded credentials or secret-bearing query parameters",
  );

export const ReplayUrlPatternSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => /^https?:\/\//i.test(value), "must start with http:// or https://")
  .refine((value) => !/^https?:\/\/[^/\s]*@/i.test(value), "must not contain credentials")
  .refine(
    (value) => !SecretLikeValuePattern.test(value),
    "must not contain secret-bearing URL parameters",
  );

export const BrowserReplayNetworkSchema = z.enum(["X", "THREADS", "FACEBOOK"]);

export const SelectorCandidateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("testId"),
    value: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("role"),
    role: z.string().min(1).max(64),
    name: z.string().min(1).max(512).optional(),
    exact: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("label"),
    value: z.string().min(1).max(512),
    exact: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("css"),
    value: z.string().min(1).max(2_048),
  }),
  z.strictObject({
    kind: z.literal("text"),
    value: z.string().min(1).max(2_048),
    exact: z.boolean().optional(),
  }),
]);

export type SelectorCandidate = z.infer<typeof SelectorCandidateSchema>;

const SelectorKindRank: Readonly<Record<SelectorCandidate["kind"], number>> = {
  testId: 0,
  role: 1,
  label: 2,
  css: 3,
  text: 4,
};

export function selectorCandidateLabel(candidate: SelectorCandidate): string {
  switch (candidate.kind) {
    case "testId":
      return `testId(${JSON.stringify(candidate.value)})`;
    case "role":
      return `role(${JSON.stringify(candidate.role)}, name=${JSON.stringify(candidate.name ?? "*")})`;
    case "label":
      return `label(${JSON.stringify(candidate.value)})`;
    case "css":
      return `css(${JSON.stringify(candidate.value)})`;
    case "text":
      return `text(${JSON.stringify(candidate.value)})`;
  }
}

function selectorCandidateIdentity(candidate: SelectorCandidate): string {
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

export const SelectorChainSchema = z
  .array(SelectorCandidateSchema)
  .min(1)
  .max(25)
  .superRefine((chain, ctx) => {
    let previousRank = -1;
    const seen = new Set<string>();

    for (const [index, candidate] of chain.entries()) {
      const rank = SelectorKindRank[candidate.kind];
      if (rank < previousRank) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message:
            "selector chain must follow fallback order: testId -> role -> label -> css -> text",
        });
      }
      previousRank = Math.max(previousRank, rank);

      const identity = selectorCandidateIdentity(candidate);
      if (seen.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate selector candidate ${selectorCandidateLabel(candidate)}`,
        });
      }
      seen.add(identity);
    }
  });

export type SelectorChain = z.infer<typeof SelectorChainSchema>;

export const ReplayErrorSchema = z.strictObject({
  source: z.enum(["action", "navigation", "network", "page"]),
  name: z.string().min(1).max(256),
  message: NonEmptyTextSchema,
  code: z.string().min(1).max(256).optional(),
  url: ReplayUrlSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  fatal: z.boolean(),
});

export const UncaughtPageErrorSchema = z.strictObject({
  message: NonEmptyTextSchema,
  sourceUrl: ReplayUrlSchema.optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  stack: z.string().min(1).max(16_000).optional(),
});

export const ReplayExpectedResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success") }),
  z.strictObject({
    kind: z.literal("url"),
    pattern: ReplayUrlPatternSchema,
  }),
  z.strictObject({ kind: z.literal("element-visible") }),
  z.strictObject({
    kind: z.literal("intercepted"),
    urlPattern: ReplayUrlPatternSchema,
    httpStatus: z.number().int().min(100).max(599).optional(),
  }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.string().min(1).max(256).optional(),
  }),
]);

const CommonActionFields = {
  actionId: IdentifierSchema,
  expectedResult: ReplayExpectedResultSchema,
  error: ReplayErrorSchema.nullable(),
};

const SelectorActionFields = {
  ...CommonActionFields,
  selectorChain: SelectorChainSchema,
  resolvedSelectorIndex: z.number().int().nonnegative().nullable(),
};

export const ReplayActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...CommonActionFields,
    type: z.literal("navigate"),
    url: ReplayUrlSchema,
  }),
  z.strictObject({
    ...SelectorActionFields,
    type: z.literal("click"),
  }),
  z.strictObject({
    ...SelectorActionFields,
    type: z.literal("fill"),
    input: z.strictObject({
      text: NonEmptyTextSchema,
      sanitized: z.literal(true),
    }),
  }),
  z.strictObject({
    ...SelectorActionFields,
    type: z.literal("press"),
    key: z.string().min(1).max(64),
  }),
  z.strictObject({
    ...SelectorActionFields,
    type: z.literal("waitFor"),
    state: z.enum(["attached", "detached", "visible", "hidden"]),
    timeoutMs: z.number().int().positive().max(120_000),
  }),
]);

export type ReplayAction = z.infer<typeof ReplayActionSchema>;

export const ReplayNavigationSchema = z.strictObject({
  trigger: z.enum(["initial", "action", "redirect", "history", "same-document"]),
  fromUrl: ReplayUrlSchema.nullable(),
  toUrl: ReplayUrlSchema,
});

export const ReplayPageSchema = z.strictObject({
  pageId: IdentifierSchema,
  navigation: ReplayNavigationSchema,
  title: z.string().min(1).max(1_024).optional(),
  actions: z.array(ReplayActionSchema).max(500),
  errors: z.array(ReplayErrorSchema).max(500),
  uncaughtErrors: z.array(UncaughtPageErrorSchema).max(500),
});

const BrowserReplayFixtureShapeSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    scenarioId: IdentifierSchema,
    captureMode: z.literal("dry-run"),
    liveSubmit: z.literal(false),
    network: BrowserReplayNetworkSchema,
    recordedAt: z.string().datetime({ offset: true }),
    pages: z.array(ReplayPageSchema).min(1).max(100),
    expectedResult: ReplayExpectedResultSchema,
  })
  .superRefine((fixture, ctx) => {
    const pageIds = new Set<string>();
    const actionIds = new Set<string>();

    for (const [pageIndex, page] of fixture.pages.entries()) {
      if (pageIds.has(page.pageId)) {
        ctx.addIssue({
          code: "custom",
          path: ["pages", pageIndex, "pageId"],
          message: `duplicate pageId "${page.pageId}"`,
        });
      }
      pageIds.add(page.pageId);

      for (const [actionIndex, action] of page.actions.entries()) {
        if (actionIds.has(action.actionId)) {
          ctx.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "actions", actionIndex, "actionId"],
            message: `duplicate actionId "${action.actionId}"`,
          });
        }
        actionIds.add(action.actionId);

        if (!("selectorChain" in action)) continue;

        if (
          action.resolvedSelectorIndex !== null &&
          action.resolvedSelectorIndex >= action.selectorChain.length
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "actions", actionIndex, "resolvedSelectorIndex"],
            message: `resolvedSelectorIndex ${action.resolvedSelectorIndex} is outside selectorChain length ${action.selectorChain.length}`,
          });
        }

        if (action.resolvedSelectorIndex === null && action.error === null) {
          ctx.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "actions", actionIndex, "error"],
            message: "an unresolved selector action must include an error",
          });
        }
      }
    }
  });

/**
 * V1 is a committed, redacted dry-run artifact only. It cannot represent a
 * live submit, and the secret-free boundary runs before strict shape parsing.
 */
export const BrowserReplayFixtureSchema = SecretFreeInputSchema.pipe(
  BrowserReplayFixtureShapeSchema,
);

export type BrowserReplayFixture = z.infer<typeof BrowserReplayFixtureSchema>;

const ReplaySelectorObservationShapeSchema = z
  .strictObject({
    actionId: IdentifierSchema,
    selectorChain: SelectorChainSchema,
    resolvedSelectorIndex: z.number().int().nonnegative().nullable(),
    error: ReplayErrorSchema.nullable(),
  })
  .superRefine((observation, ctx) => {
    if (
      observation.resolvedSelectorIndex !== null &&
      observation.resolvedSelectorIndex >= observation.selectorChain.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedSelectorIndex"],
        message: `resolvedSelectorIndex ${observation.resolvedSelectorIndex} is outside selectorChain length ${observation.selectorChain.length}`,
      });
    }
    if (observation.resolvedSelectorIndex === null && observation.error === null) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "an observation with no selector match must include an error",
      });
    }
  });

const ReplaySelectorObservationsShapeSchema = z
  .array(ReplaySelectorObservationShapeSchema)
  .max(5_000)
  .superRefine((observations, ctx) => {
    const seen = new Set<string>();
    for (const [index, observation] of observations.entries()) {
      if (seen.has(observation.actionId)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "actionId"],
          message: `duplicate selector observation for actionId "${observation.actionId}"`,
        });
      }
      seen.add(observation.actionId);
    }
  });

export const ReplaySelectorObservationsSchema = SecretFreeInputSchema.pipe(
  ReplaySelectorObservationsShapeSchema,
);

export type ReplaySelectorObservation = z.infer<typeof ReplaySelectorObservationShapeSchema>;

export function parseBrowserReplayFixture(input: unknown): BrowserReplayFixture {
  return BrowserReplayFixtureSchema.parse(input);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (!isRecord(value)) {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }

  const entries = Object.entries(value)
    .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/** Serialize a validated fixture with recursively sorted object keys. */
export function serializeBrowserReplayFixture(input: unknown): string {
  return canonicalJson(parseBrowserReplayFixture(input));
}
