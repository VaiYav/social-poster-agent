export function createFillSelectorChain() {
  return [
    { kind: "testId" as const, value: "tweetTextarea_0" },
    { kind: "role" as const, role: "textbox", name: "Post text" },
    { kind: "css" as const, value: "div[contenteditable='true']" },
    { kind: "text" as const, value: "What is happening?!" },
  ];
}

export function createSubmitSelectorChain() {
  return [
    { kind: "testId" as const, value: "tweetButtonInline" },
    { kind: "role" as const, role: "button", name: "Post", exact: true },
    { kind: "css" as const, value: "button[data-testid='tweetButtonInline']" },
    { kind: "text" as const, value: "Post", exact: true },
  ];
}

export function createReplayFixture() {
  return {
    schemaVersion: "1" as const,
    scenarioId: "x-compose-redacted-v1",
    captureMode: "dry-run" as const,
    liveSubmit: false as const,
    network: "X" as const,
    recordedAt: "2026-08-22T12:00:00.000Z",
    pages: [
      {
        pageId: "compose",
        navigation: {
          trigger: "initial" as const,
          fromUrl: null,
          toUrl: "https://x.com/compose/post",
        },
        title: "Compose / X",
        actions: [
          {
            actionId: "compose.navigate",
            type: "navigate" as const,
            url: "https://x.com/compose/post",
            expectedResult: {
              kind: "url" as const,
              pattern: "https://x.com/compose/post",
            },
            error: null,
          },
          {
            actionId: "compose.fill",
            type: "fill" as const,
            selectorChain: createFillSelectorChain(),
            resolvedSelectorIndex: 0,
            input: {
              text: "Fixture-only post text. No account data.",
              sanitized: true as const,
            },
            expectedResult: { kind: "element-visible" as const },
            error: null,
          },
          {
            actionId: "compose.submit",
            type: "click" as const,
            selectorChain: createSubmitSelectorChain(),
            resolvedSelectorIndex: 0,
            expectedResult: {
              kind: "intercepted" as const,
              urlPattern: "https://x.com/*/status/*",
              httpStatus: 200,
            },
            error: null,
          },
        ],
        errors: [
          {
            source: "network" as const,
            name: "NetworkError",
            message: "Analytics request was blocked in the captured dry-run.",
            url: "https://analytics.example.invalid/beacon",
            httpStatus: 503,
            fatal: false,
          },
        ],
        uncaughtErrors: [
          {
            message: "Third-party widget failed during the captured dry-run.",
            sourceUrl: "https://x.com/assets/client.js",
            line: 42,
            column: 7,
          },
        ],
      },
    ],
    expectedResult: {
      kind: "intercepted" as const,
      urlPattern: "https://x.com/*/status/*",
      httpStatus: 200,
    },
  };
}
