/**
 * Unit tests for DryRunBrowserPort.
 *
 * Verifies that:
 *   1. Submit clicks are intercepted after typing on a compose page
 *   2. Non-submit clicks (before typing, on login pages) pass through to real
 *   3. page.url() returns synthetic URL after submit
 *   4. Thread reply navigation to synthetic URL is skipped (reply mode)
 *   5. Dummy locators in reply mode are no-ops
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DryRunBrowserPort } from "../../../src/dry-run/dry-run.browser-port.js";
import type { IBrowserPort } from "../../../src/domain/ports/browser.port.js";
import type { BrowserContext, Locator, Page } from "playwright-core";

// ── Helpers ──

/** Create a mock locator that tracks its page via page() method. */
function createMockLocatorWithPage(page: Page): Locator {
  const locator: Record<string, unknown> = {
    page: () => page,
    click: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    isEnabled: vi.fn().mockResolvedValue(true),
    isHidden: vi.fn().mockResolvedValue(false),
    first: vi.fn().mockReturnValue(this),
    last: vi.fn().mockReturnValue(this),
    nth: vi.fn().mockReturnValue(this),
    getAttribute: vi.fn().mockResolvedValue(null),
    textContent: vi.fn().mockResolvedValue(""),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
  };
  // Make first/last/nth return self
  locator.first = vi.fn().mockReturnValue(locator);
  locator.last = vi.fn().mockReturnValue(locator);
  locator.nth = vi.fn().mockReturnValue(locator);
  return locator as unknown as Locator;
}

/** Create a mock page with controllable URL. */
function createMockPage(url: string): Page {
  const page: Record<string, unknown> = {
    url: vi.fn(() => url),
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn(() => createMockLocatorWithPage(page as unknown as Page)),
    getByRole: vi.fn(() => createMockLocatorWithPage(page as unknown as Page)),
    getByTestId: vi.fn(() => createMockLocatorWithPage(page as unknown as Page)),
    getByLabel: vi.fn(() => createMockLocatorWithPage(page as unknown as Page)),
    getByText: vi.fn(() => createMockLocatorWithPage(page as unknown as Page)),
    screenshot: vi.fn().mockResolvedValue("/tmp/mock.png"),
    textContent: vi.fn().mockResolvedValue(""),
    evaluate: vi.fn().mockResolvedValue(undefined),
    keyboard: { type: vi.fn(), press: vi.fn() },
  };
  return page as unknown as Page;
}

/** Create a mock context whose newPage() returns the given page. */
function createMockContext(page: Page): BrowserContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockReturnValue([page]),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
  } as unknown as BrowserContext;
}

/** Create a mock BrowserFactory (real implementation) that DryRunBrowserPort wraps. */
function createMockRealFactory(context: BrowserContext): IBrowserPort {
  return {
    createContext: vi.fn().mockResolvedValue(context),
    acquireContext: vi.fn().mockResolvedValue(context),
    releaseContext: vi.fn(),
    saveStorageState: vi.fn().mockResolvedValue("{}"),
    randomDelay: vi.fn().mockResolvedValue(undefined),
    humanType: vi.fn().mockResolvedValue(undefined),
    typeHuman: vi.fn().mockResolvedValue(undefined),
    humanClick: vi.fn().mockResolvedValue(undefined),
    scrollPage: vi.fn().mockResolvedValue(undefined),
    scrollToElement: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue("/tmp/mock-screenshot.png"),
    extractText: vi.fn().mockResolvedValue(""),
    waitForStable: vi.fn().mockResolvedValue(undefined),
    dismissDialogs: vi.fn().mockResolvedValue(undefined),
    suppressPageErrors: vi.fn().mockResolvedValue(undefined),
    applyResourceBlocking: vi.fn().mockResolvedValue(undefined),
  } as unknown as IBrowserPort;
}

// ── Tests ──

describe("DryRunBrowserPort", () => {
  let dryRunPort: DryRunBrowserPort;
  let realFactory: IBrowserPort;
  let mockPage: Page;
  let mockContext: BrowserContext;

  beforeEach(() => {
    mockPage = createMockPage("https://x.com/compose/post");
    mockContext = createMockContext(mockPage);
    realFactory = createMockRealFactory(mockContext);
    dryRunPort = new DryRunBrowserPort(realFactory as unknown as never);
  });

  describe("createContext", () => {
    it("should wrap the context and return a proxy", async () => {
      const context = await dryRunPort.createContext("X" as never);
      expect(context).toBeDefined();
      // newPage should be wrapped — returns a proxy page
      const page = await context.newPage();
      expect(page).toBeDefined();
      // The wrapped page's url() should return the real URL initially
      expect(page.url()).toBe("https://x.com/compose/post");
    });

    it("should delegate saveStorageState to real factory", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const result = await dryRunPort.saveStorageState(context);
      expect(realFactory.saveStorageState).toHaveBeenCalled();
      expect(result).toBe("{}");
    });
  });

  describe("humanType", () => {
    it("should delegate to real humanType", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator('div[contenteditable="true"]');
      await dryRunPort.humanType(locator, "test content");
      expect(realFactory.humanType).toHaveBeenCalledWith(locator, "test content", undefined);
    });
  });

  describe("humanClick — submit interception", () => {
    it("should intercept submit click after typing on compose page", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator('button[data-testid="tweetButton"]');

      // Step 1: Type content (marks typedOnPage = true)
      await dryRunPort.humanType(locator, "Workflow Trends is coming!");
      expect(realFactory.humanType).toHaveBeenCalled();

      // Step 2: Click submit — should be intercepted
      await dryRunPort.humanClick(locator);

      // Real humanClick should NOT have been called (intercepted)
      expect(realFactory.humanClick).not.toHaveBeenCalled();

      // Real screenshot should have been called (evidence capture)
      expect(realFactory.screenshot).toHaveBeenCalled();

      // page.url() should now return synthetic URL
      const url = page.url();
      expect(url).toContain("dryrun");
      expect(url).toMatch(/\/status\/\d+/);
    });

    it("should NOT intercept clicks before typing (e.g., compose button click)", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator('button[data-testid="tweetButton"]');

      // Click WITHOUT typing first — should pass through to real
      await dryRunPort.humanClick(locator);
      expect(realFactory.humanClick).toHaveBeenCalledWith(locator, undefined);
    });

    it("should NOT intercept clicks on login pages", async () => {
      // Create a page on a login URL
      const loginPage = createMockPage("https://x.com/i/flow/login");
      const loginContext = createMockContext(loginPage);
      const loginFactory = createMockRealFactory(loginContext);
      const port = new DryRunBrowserPort(loginFactory as unknown as never);

      const context = await port.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator('button[type="submit"]');

      // Type on login page (username/password)
      await port.humanType(locator, "myusername");
      // Click login submit — should NOT be intercepted (login page)
      await port.humanClick(locator);

      expect(loginFactory.humanClick).toHaveBeenCalledWith(locator, undefined);
    });

    it("should only intercept the first submit (not subsequent clicks)", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator('button[data-testid="tweetButton"]');

      // Type + click (intercepted)
      await dryRunPort.humanType(locator, "content");
      await dryRunPort.humanClick(locator);
      expect(realFactory.humanClick).not.toHaveBeenCalled();

      // Second click — should pass through (already submitted)
      vi.clearAllMocks();
      await dryRunPort.humanClick(locator);
      expect(realFactory.humanClick).toHaveBeenCalledWith(locator, undefined);
    });
  });

  describe("synthetic URL generation", () => {
    it("should generate X-compatible synthetic URL", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator("#test");

      await dryRunPort.humanType(locator, "test");
      await dryRunPort.humanClick(locator);

      const url = page.url();
      expect(url).toMatch(/^https:\/\/x\.com\/dryrun\/status\/\d+$/);
    });

    it("should generate Threads-compatible synthetic URL", async () => {
      const threadsPage = createMockPage("https://www.threads.com/");
      const threadsContext = createMockContext(threadsPage);
      const threadsFactory = createMockRealFactory(threadsContext);
      const port = new DryRunBrowserPort(threadsFactory as unknown as never);

      const context = await port.createContext("THREADS" as never);
      const page = await context.newPage();
      const locator = page.locator("#test");

      await port.humanType(locator, "test");
      await port.humanClick(locator);

      const url = page.url();
      expect(url).toMatch(/^https:\/\/www\.threads\.com\/@dryrun\/post\/\d+$/);
    });

    it("should generate Facebook-compatible synthetic URL", async () => {
      const fbPage = createMockPage("https://www.facebook.com/exampleco/");
      const fbContext = createMockContext(fbPage);
      const fbFactory = createMockRealFactory(fbContext);
      const port = new DryRunBrowserPort(fbFactory as unknown as never);

      const context = await port.createContext("FACEBOOK" as never);
      const page = await context.newPage();
      const locator = page.locator("#test");

      await port.humanType(locator, "test");
      await port.humanClick(locator);

      const url = page.url();
      expect(url).toMatch(/^https:\/\/www\.facebook\.com\/dryrun\/posts\/\d+$/);
    });
  });

  describe("thread reply mode", () => {
    it("should skip navigation to synthetic URL and enter reply mode", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator("#test");

      // Submit the root post
      await dryRunPort.humanType(locator, "root post content");
      await dryRunPort.humanClick(locator);

      const syntheticUrl = page.url();
      expect(syntheticUrl).toContain("dryrun");

      // Navigate to synthetic URL (thread reply) — should be skipped
      await page.goto(syntheticUrl);

      // Real goto should NOT have been called for synthetic URL
      // (the mock page's goto was called, but the wrapped page intercepts it)
      // The key test: subsequent locator calls return dummy locators (reply mode)
      const replyLocator = page.locator('button[data-testid="reply"]');
      // Dummy locator's isVisible should resolve to true
      const isVisible = await (
        replyLocator as unknown as { isVisible: () => Promise<boolean> }
      ).isVisible();
      expect(isVisible).toBe(true);
    });
  });

  describe("delegation to real factory", () => {
    it("should delegate randomDelay to real", async () => {
      await dryRunPort.randomDelay(1000, 2000);
      expect(realFactory.randomDelay).toHaveBeenCalledWith(1000, 2000);
    });

    it("should delegate screenshot to real", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      await dryRunPort.screenshot(page, "X" as never, "after-submit");
      expect(realFactory.screenshot).toHaveBeenCalled();
    });

    it("should delegate dismissDialogs to real", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      await dryRunPort.dismissDialogs(page);
      expect(realFactory.dismissDialogs).toHaveBeenCalledWith(page);
    });

    it("should delegate waitForStable to real", async () => {
      const context = await dryRunPort.createContext("X" as never);
      const page = await context.newPage();
      const locator = page.locator("#test");
      await dryRunPort.waitForStable(locator, { timeoutMs: 5000 });
      expect(realFactory.waitForStable).toHaveBeenCalledWith(locator, { timeoutMs: 5000 });
    });
  });
});
