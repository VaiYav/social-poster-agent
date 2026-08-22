/**
 * MOD-03: Posting Engine Module — BasePoster unit tests.
 *
 * Tests the abstract BasePoster class via a concrete TestPoster subclass
 * that exposes all protected methods. Covers selector resolution, human-like
 * actions, post validation, error classification, navigation, session
 * detection, shadowban detection, and retry-with-backoff.
 *
 * Source: packages/backend/src/modules/posting/posters/base.poster.ts
 * Spec:   CONSTITUTION.md §14 (Testing) — test case IDs UTC-300..322
 *
 * Mocked dependencies:
 *   - IBrowserPort (humanType, humanClick, typeHuman, screenshot, randomDelay, etc.)
 *   - Playwright Page (via createMockPage)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "@nestjs/common";

import { BasePoster } from "../../../src/modules/posting/posters/base.poster";
import {
  SelectorNotFoundError,
  ValidationError,
  AccountRestrictedError,
  NetworkError,
  SpaError,
} from "../../../src/domain/errors.js";
import { createMockBrowserPort, createMockPage, createMockLocator } from "../../mocks/index.js";

// ── Concrete Test Subclass ───────────────────────────────────────────────────
// BasePoster is abstract — create a concrete subclass that exposes protected methods.

class TestPoster extends BasePoster {
  protected readonly logger = new Logger("TestPoster");
  protected readonly network = "X" as const;

  // Expose protected methods for testing
  async resolvePublic(page: any, strategy: any, context: string, timeoutMs?: number) {
    return this.resolve(page, strategy, context, timeoutMs);
  }
  async tryResolvePublic(page: any, strategy: any, timeoutMs?: number) {
    return this.tryResolve(page, strategy, timeoutMs);
  }
  async humanTypePublic(locator: any, text: string, delayMs = 50) {
    return this.humanType(locator, text, delayMs);
  }
  async typeHumanPublic(page: any, text: string, locator?: any) {
    return this.typeHuman(page, text, locator);
  }
  async humanClickPublic(locator: any, timeoutMs = 15000) {
    return this.humanClick(locator, timeoutMs);
  }
  async humanPreActionPublic(page: any, locator: any) {
    return this.humanPreAction(page, locator);
  }
  async validatePostOnProfilePublic(
    page: any,
    profileUrl: string,
    content: string,
    postUrlPattern: RegExp,
  ) {
    return this.validatePostOnProfile(page, profileUrl, content, postUrlPattern);
  }
  validatePostUrlPublic(currentUrl: string, pattern: RegExp) {
    return this.validatePostUrl(currentUrl, pattern);
  }
  async classifyErrorPublic(err: unknown, page: any, context: string) {
    return this.classifyError(err, page, context);
  }
  async withErrorHandlingPublic(
    page: any,
    operation: () => Promise<string | undefined>,
    context: string,
  ) {
    return this.withErrorHandling(page, operation, context);
  }
  async navigatePublic(page: any, url: string, waitUntil?: "networkidle" | "domcontentloaded") {
    return this.navigate(page, url, waitUntil);
  }
  async isOnLoginPagePublic(page: any) {
    return this.isOnLoginPage(page);
  }
  isOnChallengePagePublic(page: any) {
    return this.isOnChallengePage(page);
  }
  async detectShadowbanPublic(page: any) {
    return this.detectShadowban(page);
  }
  async retryWithBackoffPublic<T>(
    operation: () => Promise<T>,
    maxRetries = 2,
    baseDelayMs = 5000,
  ): Promise<T> {
    return this.retryWithBackoff(operation, maxRetries, baseDelayMs);
  }
  async screenshotPublic(page: any, phase: any) {
    return this.screenshot(page, phase);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MOD-03: BasePoster", () => {
  let poster: TestPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    browserPort = createMockBrowserPort();
    poster = new TestPoster(browserPort as unknown);
  });

  // ── resolve() ──────────────────────────────────────────────────────────────

  it("UTC-300: resolve() returns SelectorResolution when first selector strategy matches", async () => {
    const page = createMockPage({ url: "https://x.com/compose/post" });
    const strategy = { testId: "tweetButton", css: ['button[type="submit"]'] };

    const result = await poster.resolvePublic(page, strategy, "post button");

    expect(result).toBeDefined();
    expect(result.method).toBe("testId");
    expect(result.selector).toBe('[data-testid="tweetButton"]');
    expect(result.locator).toBeDefined();
  });

  it("UTC-301: resolve() throws SelectorNotFoundError when all selectors fail", async () => {
    vi.useFakeTimers();
    const page = createMockPage({ url: "https://x.com/compose/post" });
    // Override isVisible to return false — no selector will match
    (page._locator as any).isVisible = vi.fn().mockResolvedValue(false);
    const strategy = { testId: "nonexistent", css: ["button.nonexistent"] };

    const promise = poster.resolvePublic(page, strategy, "missing element", 100);
    promise.catch(() => {}); // prevent unhandled rejection during timer advance
    await vi.advanceTimersByTimeAsync(700);
    await expect(promise).rejects.toThrow(SelectorNotFoundError);
    vi.useRealTimers();
  });

  // ── tryResolve() ───────────────────────────────────────────────────────────

  it("UTC-302: tryResolve() returns null when no selector matches (no throw)", async () => {
    vi.useFakeTimers();
    const page = createMockPage({ url: "https://x.com/compose/post" });
    (page._locator as any).isVisible = vi.fn().mockResolvedValue(false);
    const strategy = { testId: "nonexistent" };

    const promise = poster.tryResolvePublic(page, strategy, 100);
    promise.catch(() => {}); // prevent unhandled rejection during timer advance
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;

    expect(result).toBeNull();
    vi.useRealTimers();
  });

  // ── humanType() ────────────────────────────────────────────────────────────

  it("UTC-303: humanType() delegates to browser.humanType with locator, text, and delayMs", async () => {
    const locator = createMockLocator();

    await poster.humanTypePublic(locator, "Hello world", 75);

    expect(browserPort.humanType).toHaveBeenCalledWith(locator, "Hello world", { delayMs: 75 });
  });

  // ── typeHuman() ────────────────────────────────────────────────────────────

  it("UTC-304: typeHuman() delegates to browser.typeHuman with page, text, and locator", async () => {
    const page = createMockPage();
    const locator = createMockLocator();

    await poster.typeHumanPublic(page, "Stealth typing", locator);

    expect(browserPort.typeHuman).toHaveBeenCalledWith(page, "Stealth typing", locator);
  });

  // ── humanClick() ───────────────────────────────────────────────────────────

  it("UTC-305: humanClick() delegates to browser.humanClick with locator and timeoutMs", async () => {
    const locator = createMockLocator();

    await poster.humanClickPublic(locator, 10000);

    expect(browserPort.humanClick).toHaveBeenCalledWith(locator, { timeoutMs: 10000 });
  });

  // ── humanPreAction() ───────────────────────────────────────────────────────

  it("UTC-306: humanPreAction() scrolls into view, hovers, and pauses with randomDelay", async () => {
    const page = createMockPage();
    const locator = createMockLocator();

    await poster.humanPreActionPublic(page, locator);

    // scrollIntoViewIfNeeded called
    expect((locator as any).scrollIntoViewIfNeeded).toHaveBeenCalledWith({ timeout: 5000 });
    // randomDelay called twice: once after scroll, once after hover
    expect(browserPort.randomDelay).toHaveBeenCalledTimes(2);
    // First delay: (200, 600) — after scroll
    expect(browserPort.randomDelay).toHaveBeenNthCalledWith(1, 200, 600);
    // Second delay: (100, 300) — after hover
    expect(browserPort.randomDelay).toHaveBeenNthCalledWith(2, 100, 300);
  });

  // ── validatePostOnProfile() ────────────────────────────────────────────────

  it("UTC-307: validatePostOnProfile() returns postUrl when content found on profile page", async () => {
    const content = "Hello from X!";
    const page = createMockPage({
      url: "https://x.com/exampleco",
      bodyText: `Some text before ${content} and after`,
    });

    const result = await poster.validatePostOnProfilePublic(
      page,
      "https://x.com/exampleco",
      content,
      /\/status\/[A-Za-z0-9]+/,
    );

    // Content found on page → returns page.url() (no link matched the pattern)
    expect(result).toBe("https://x.com/exampleco");
    // Navigated to profile
    expect(page.goto).toHaveBeenCalledWith("https://x.com/exampleco", {
      waitUntil: "domcontentloaded",
    });
    // Screenshot taken for debugging
    expect(browserPort.screenshot).toHaveBeenCalled();
  });

  it("UTC-308: validatePostOnProfile() throws ValidationError when content not found on profile", async () => {
    const content = "This content was never posted";
    const page = createMockPage({
      url: "https://x.com/exampleco",
      bodyText: "Completely different content here",
    });
    // allInnerTexts returns empty array by default

    await expect(
      poster.validatePostOnProfilePublic(
        page,
        "https://x.com/exampleco",
        content,
        /\/status\/[A-Za-z0-9]+/,
      ),
    ).rejects.toThrow(ValidationError);
  });

  // ── validatePostUrl() ──────────────────────────────────────────────────────

  it("UTC-309: validatePostUrl() returns url when URL matches post pattern", () => {
    const url = "https://x.com/exampleco/status/1234567890";
    const pattern = /\/status\/([A-Za-z0-9]+)$/;

    const result = poster.validatePostUrlPublic(url, pattern);

    expect(result).toBe(url);
  });

  it("UTC-310: validatePostUrl() throws ValidationError when URL is homepage (no match)", () => {
    const url = "https://x.com/home";
    const pattern = /\/status\/([A-Za-z0-9]+)$/;

    expect(() => poster.validatePostUrlPublic(url, pattern)).toThrow(ValidationError);
  });

  // ── classifyError() ────────────────────────────────────────────────────────

  it("UTC-311: classifyError() classifies TimeoutError as SelectorNotFoundError with screenshot", async () => {
    const page = createMockPage({ url: "https://x.com/compose/post" });
    const err = new Error('Timeout 30000ms exceeded waiting for locator("button")');

    const classified = await poster.classifyErrorPublic(err, page, "post button");

    expect(classified).toBeInstanceOf(SelectorNotFoundError);
    expect(classified.retryable).toBe(false);
    expect(classified.screenshotPath).toBeDefined();
  });

  it("UTC-312: classifyError() classifies NavigationError (net::ERR) as NetworkError", async () => {
    const page = createMockPage({ url: "https://x.com/compose/post" });
    const err = new Error("net::ERR_CONNECTION_REFUSED");

    const classified = await poster.classifyErrorPublic(err, page, "navigation");

    expect(classified).toBeInstanceOf(NetworkError);
    expect(classified.retryable).toBe(true);
  });

  // ── withErrorHandling() ────────────────────────────────────────────────────

  it("UTC-313: withErrorHandling() returns {url} on success", async () => {
    const page = createMockPage();

    const result = await poster.withErrorHandlingPublic(
      page,
      async () => "https://x.com/user/status/123",
      "test operation",
    );

    expect(result.url).toBe("https://x.com/user/status/123");
    expect(result.error).toBeUndefined();
  });

  it("UTC-314: withErrorHandling() returns {error} on failure", async () => {
    const page = createMockPage({ url: "https://x.com/compose/post" });

    const result = await poster.withErrorHandlingPublic(
      page,
      async () => {
        throw new Error('Timeout 30000ms exceeded waiting for locator("button")');
      },
      "test operation",
    );

    expect(result.error).toBeDefined();
    expect(result.url).toBeUndefined();
  });

  // ── navigate() ─────────────────────────────────────────────────────────────

  it("UTC-315: navigate() calls page.goto and dismissDialogs on success", async () => {
    const page = createMockPage({ url: "https://x.com/compose/post" });

    await poster.navigatePublic(page, "https://x.com/compose/post", "domcontentloaded");

    expect(page.goto).toHaveBeenCalledWith("https://x.com/compose/post", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    expect(browserPort.dismissDialogs).toHaveBeenCalledWith(page);
    expect(browserPort.randomDelay).toHaveBeenCalled();
  });

  it("UTC-316: navigate() retries on timeout then dismisses dialogs", async () => {
    vi.useFakeTimers();
    const page = createMockPage({ url: "https://x.com/compose/post" });
    // First goto throws (timeout), second succeeds
    page.goto = vi
      .fn()
      .mockRejectedValueOnce(new Error("Timeout 30000ms exceeded"))
      .mockResolvedValueOnce(undefined);

    const promise = poster.navigatePublic(page, "https://x.com/compose/post", "domcontentloaded");
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    // goto called twice (retry happened)
    expect(page.goto).toHaveBeenCalledTimes(2);
    // dismissDialogs called after successful navigation
    expect(browserPort.dismissDialogs).toHaveBeenCalledWith(page);
    vi.useRealTimers();
  });

  // ── isOnLoginPage() ────────────────────────────────────────────────────────

  it("UTC-317: isOnLoginPage() returns true when URL contains /login", async () => {
    const page = createMockPage({ url: "https://x.com/i/flow/login" });

    const result = await poster.isOnLoginPagePublic(page);

    expect(result).toBe(true);
  });

  it("UTC-318: isOnLoginPage() returns true when login form is visible in DOM", async () => {
    const page = createMockPage({ url: "https://x.com/home" });
    // Override locator to simulate login form visible (locator returns a mock
    // whose count() is 1 for any login indicator).
    const loginLocator = { ...page._locator, count: vi.fn().mockResolvedValue(1) };
    (page.locator as any) = vi.fn().mockReturnValue(loginLocator);

    const result = await poster.isOnLoginPagePublic(page);

    expect(result).toBe(true);
  });

  // ── isOnChallengePage() ────────────────────────────────────────────────────

  it("UTC-319: isOnChallengePage() returns true when URL contains captcha", () => {
    const page = createMockPage({ url: "https://x.com/i/challenge/captcha" });

    const result = poster.isOnChallengePagePublic(page);

    expect(result).toBe(true);
  });

  // ── detectShadowban() ──────────────────────────────────────────────────────

  it("UTC-320: detectShadowban() throws AccountRestrictedError when restriction text found", async () => {
    const page = createMockPage({
      url: "https://x.com/compose/post",
      bodyText: "Your account is temporarily limited from posting",
    });

    await expect(poster.detectShadowbanPublic(page)).rejects.toThrow(AccountRestrictedError);
  });

  // ── retryWithBackoff() ─────────────────────────────────────────────────────

  it("UTC-321: retryWithBackoff() returns result when operation succeeds on 3rd attempt", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("success");

    const promise = poster.retryWithBackoffPublic(operation, 2, 100);
    // Advance timers for backoff delays
    await vi.advanceTimersByTimeAsync(10000);
    const result = await promise;

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("UTC-322: retryWithBackoff() throws last error when all attempts fail", async () => {
    vi.useFakeTimers();
    const lastError = new Error("final failure");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValueOnce(lastError);

    const promise = poster.retryWithBackoffPublic(operation, 2, 100);
    promise.catch(() => {}); // prevent unhandled rejection during timer advance
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).rejects.toThrow("final failure");

    expect(operation).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
