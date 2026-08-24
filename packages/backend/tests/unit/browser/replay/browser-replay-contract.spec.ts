import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserReplayFixtureSchema,
  parseBrowserReplayFixture,
  serializeBrowserReplayFixture,
} from "../../../../src/infrastructure/browser/replay/browser-replay-contract.js";
import { createReplayFixture } from "./replay-fixture.js";

describe("browser replay fixture contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a versioned redacted dry-run fixture with action and page errors", () => {
    const fixture = parseBrowserReplayFixture(createReplayFixture());

    expect(fixture.schemaVersion).toBe("1");
    expect(fixture.network).toBe("X");
    expect(fixture.captureMode).toBe("dry-run");
    expect(fixture.liveSubmit).toBe(false);
    expect(fixture.pages[0]?.navigation.toUrl).toBe("https://x.com/compose/post");
    expect(fixture.pages[0]?.errors[0]?.source).toBe("network");
    expect(fixture.pages[0]?.uncaughtErrors[0]?.line).toBe(42);
    expect(fixture.pages[0]?.actions[1]).toMatchObject({
      type: "fill",
      input: { sanitized: true },
      resolvedSelectorIndex: 0,
    });
  });

  it("rejects invalid versions and malformed actions", () => {
    const fixture = createReplayFixture();
    expect(BrowserReplayFixtureSchema.safeParse({ ...fixture, schemaVersion: "2" }).success).toBe(
      false,
    );
    const { network: _network, ...missingRequiredNetwork } = fixture;
    expect(BrowserReplayFixtureSchema.safeParse(missingRequiredNetwork).success).toBe(false);

    const malformedType = createReplayFixture();
    malformedType.pages[0]!.actions[1] = {
      actionId: "compose.hover",
      type: "hover",
      expectedResult: { kind: "success" },
      error: null,
    } as never;
    expect(BrowserReplayFixtureSchema.safeParse(malformedType).success).toBe(false);

    const missingSelectorChain = createReplayFixture();
    missingSelectorChain.pages[0]!.actions[1] = {
      actionId: "compose.fill",
      type: "fill",
      input: { text: "sanitized", sanitized: true },
      expectedResult: { kind: "success" },
      error: null,
    } as never;
    expect(BrowserReplayFixtureSchema.safeParse(missingSelectorChain).success).toBe(false);

    const invalidResolution = createReplayFixture();
    const fill = invalidResolution.pages[0]!.actions[1];
    if (fill?.type !== "fill") throw new Error("fixture must contain the fill action");
    fill.resolvedSelectorIndex = fill.selectorChain.length;
    const invalidResolutionResult = BrowserReplayFixtureSchema.safeParse(invalidResolution);
    expect(invalidResolutionResult.success).toBe(false);
    if (!invalidResolutionResult.success) {
      expect(
        invalidResolutionResult.error.issues.map((issue) => issue.message).join("\n"),
      ).toContain("outside selectorChain length");
    }
  });

  it("requires fill values to be explicitly sanitized", () => {
    const fixture = createReplayFixture();
    const fill = fixture.pages[0]!.actions[1];
    if (fill?.type !== "fill") throw new Error("fixture must contain the fill action");
    fill.input.sanitized = false as never;

    expect(BrowserReplayFixtureSchema.safeParse(fixture).success).toBe(false);
  });

  it.each([
    [
      "storageState",
      () => ({
        ...createReplayFixture(),
        storageState: { origins: [], cookies: [] },
      }),
    ],
    [
      "cookie field",
      () => {
        const fixture = createReplayFixture();
        return {
          ...fixture,
          pages: [{ ...fixture.pages[0]!, cookie: "session=value" }],
        };
      },
    ],
    [
      "password field",
      () => ({
        ...createReplayFixture(),
        password: "not-safe-for-a-fixture",
      }),
    ],
    [
      "bearer value",
      () => {
        const fixture = createReplayFixture();
        const fill = fixture.pages[0]!.actions[1];
        if (fill?.type !== "fill") throw new Error("fixture must contain the fill action");
        fill.input.text = "Authorization: Bearer abcdefghijklmnop";
        return fixture;
      },
    ],
    [
      "token-like URL parameter",
      () => {
        const fixture = createReplayFixture();
        fixture.pages[0]!.navigation.toUrl = "https://x.com/compose/post?access_token=abcdef";
        return fixture;
      },
    ],
    [
      "embedded URL credentials",
      () => {
        const fixture = createReplayFixture();
        fixture.pages[0]!.navigation.toUrl = "https://user:pass@x.com/compose/post";
        return fixture;
      },
    ],
  ])("rejects secret-bearing data: %s", (_caseName, buildInput) => {
    const result = BrowserReplayFixtureSchema.safeParse(buildInput());
    expect(result.success).toBe(false);
  });

  it("preserves canonical fallback order and rejects an inverted selector chain", () => {
    const parsed = parseBrowserReplayFixture(createReplayFixture());
    const fill = parsed.pages[0]?.actions[1];
    if (fill?.type !== "fill") throw new Error("fixture must contain the fill action");
    expect(fill.selectorChain.map((selector) => selector.kind)).toEqual([
      "testId",
      "role",
      "css",
      "text",
    ]);

    const inverted = createReplayFixture();
    const invertedFill = inverted.pages[0]!.actions[1];
    if (invertedFill?.type !== "fill") throw new Error("fixture must contain the fill action");
    invertedFill.selectorChain = [
      { kind: "text", value: "Post" },
      { kind: "css", value: "button[type='submit']" },
    ];
    invertedFill.resolvedSelectorIndex = 0;
    const result = BrowserReplayFixtureSchema.safeParse(inverted);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(
        "testId -> role -> label -> css -> text",
      );
    }
  });

  it("serializes deterministically regardless of object insertion order", () => {
    const fixture = createReplayFixture();
    const page = fixture.pages[0]!;
    const reordered = {
      expectedResult: fixture.expectedResult,
      pages: [
        {
          uncaughtErrors: page.uncaughtErrors,
          errors: page.errors,
          actions: page.actions,
          title: page.title,
          navigation: {
            toUrl: page.navigation.toUrl,
            fromUrl: page.navigation.fromUrl,
            trigger: page.navigation.trigger,
          },
          pageId: page.pageId,
        },
      ],
      recordedAt: fixture.recordedAt,
      network: fixture.network,
      liveSubmit: fixture.liveSubmit,
      captureMode: fixture.captureMode,
      scenarioId: fixture.scenarioId,
      schemaVersion: fixture.schemaVersion,
    };

    expect(serializeBrowserReplayFixture(reordered)).toBe(serializeBrowserReplayFixture(fixture));
  });

  it("parses and serializes without browser, fetch, or live credential access", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(() => serializeBrowserReplayFixture(createReplayFixture())).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
