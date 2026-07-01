// DryRunBrowserPort — wraps the real BrowserFactory to intercept submit clicks.
//
// The browser REALLY opens, navigates to compose pages, and types content.
// But the final "Post"/"Publish" click is intercepted: a screenshot is taken
// and a synthetic post URL is returned, so the poster thinks the post succeeded.
//
// Submit detection heuristic:
//   1. humanType() called on a non-login page → typedOnPage = true
//   2. humanClick() called after typing + not on login page + not yet submitted
//      → INTERCEPT: screenshot, set synthetic URL, don't click
//
// Thread replies: after submit, page.url() returns a synthetic URL.
// When the poster navigates to that synthetic URL (for thread replies),
// the wrapped page skips navigation and enters "reply mode" — all subsequent
// locator interactions return a dummy locator (no-ops).

import { Logger } from '@nestjs/common';
import type { BrowserContext, Locator, Page } from '../domain/ports/browser-primitives';
import type { SocialNetwork } from '@prisma/client';
import type {
  IBrowserPort,
  ScrollDirection,
  ScreenshotPhase,
} from '../domain/ports/browser.port';
import { BrowserFactory } from '../infrastructure/browser/browser.factory';

/** Sentinel symbol used to unwrap a proxied Page to its real Page. */
const REAL_PAGE = Symbol('realPage');

/** Per-page dry-run state. */
interface DryRunPageState {
  /** Content was typed on this page (non-login). */
  typedOnPage: boolean;
  /** Submit was intercepted — page.url() now returns syntheticUrl. */
  submitted: boolean;
  /** Synthetic post URL returned after dry-run submit. */
  syntheticUrl: string;
  /** Social network for this context. */
  network: SocialNetwork;
  /** Reply mode — all locator interactions are no-ops (thread replies). */
  replyMode: boolean;
  /** Engagement mode — intercept ALL clicks on non-login pages (likes, comments, follows). */
  engagementMode: boolean;
  /** Count of intercepted engagement actions (likes, comments, follows). */
  interceptedActions: number;
  /** Last intercepted action type (for logging). */
  lastInterceptedAction: string;
}

/** Login URL patterns — clicks on these pages are NEVER intercepted. */
const LOGIN_URL_PATTERNS = [
  /\/login/,
  /\/auth/,
  /\/i\/flow\/login/,
  /\/login\.php/,
];

function isLoginUrl(url: string): boolean {
  return LOGIN_URL_PATTERNS.some((p) => p.test(url));
}

/** Generate a synthetic post URL that matches the network's postUrlPattern. */
function generateSyntheticUrl(network: SocialNetwork): string {
  const ts = Date.now();
  switch (network) {
    case 'X':
      return `https://x.com/dryrun/status/${ts}`;
    case 'THREADS':
      return `https://www.threads.com/@dryrun/post/${ts}`;
    case 'FACEBOOK':
      return `https://www.facebook.com/dryrun/posts/${ts}`;
    default:
      return `https://dryrun.example.com/post/${ts}`;
  }
}

/** Extract the real Page object from a Playwright Locator. */
function getPageFromLocator(locator: Locator): Page | null {
  try {
    // Playwright Locator has a page() method (since Playwright 1.34)
    const page = (locator as unknown as { page?: () => Page }).page?.();
    return page ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the real (unwrapped) Page from a potentially-proxied Page.
 * wrapPage() stores realPage on the REAL_PAGE symbol, accessible through
 * the proxy's get handler. If page is not a proxy (already real), returns page.
 */
function extractRealPage(page: Page): Page {
  const real = (page as unknown as Record<symbol, Page>)[REAL_PAGE];
  return real ?? page;
}

/** Create a dummy locator for reply mode — all methods are no-ops. */
function createDummyLocator(): Locator {
  const noop = () => Promise.resolve(undefined);
  const noopStr = () => Promise.resolve('');
  const noopBool = () => Promise.resolve(true);
  const noopNum = () => Promise.resolve(1);
  const noopStrOpt = () => Promise.resolve(null);
  const self = {} as Record<string, unknown>;
  // Chainable methods that return self
  self.first = () => createDummyLocator();
  self.last = () => createDummyLocator();
  self.nth = () => createDummyLocator();
  self.locator = () => createDummyLocator();
  self.filter = () => createDummyLocator();
  self.within = () => createDummyLocator();
  // Action methods
  self.click = noop;
  self.fill = noop;
  self.focus = noop;
  self.press = noop;
  self.type = noop;
  self.pressSequentially = noop;
  self.check = noop;
  self.uncheck = noop;
  self.hover = noop;
  self.tap = noop;
  self.selectOption = noop;
  self.scrollIntoViewIfNeeded = noop;
  // Wait methods
  self.waitFor = noop;
  // Query methods
  self.isVisible = noopBool;
  self.isEnabled = noopBool;
  self.isHidden = () => Promise.resolve(false);
  self.count = noopNum;
  self.getAttribute = noopStrOpt;
  self.textContent = noopStr;
  self.innerText = noopStr;
  self.innerHTML = noopStr;
  self.allTextContents = () => Promise.resolve([]);
  self.all = () => Promise.resolve([createDummyLocator()]);
  self.boundingBox = () => Promise.resolve(null);
  // page() returns null — DryRunBrowserPort.humanClick will fall through to real
  self.page = () => null;
  return self as unknown as Locator;
}

/** Wrap a real Page with dry-run interception. */
function wrapPage(realPage: Page, state: DryRunPageState): Page {
  const locatorMethods = new Set([
    'locator',
    'getByRole',
    'getByTestId',
    'getByLabel',
    'getByText',
    'getByPlaceholder',
    'getByAltText',
    'getByTitle',
  ]);

  return new Proxy(realPage, {
    get(target, prop, _receiver) {
      // REAL_PAGE symbol — return the unwrapped real page (for extractRealPage)
      if (prop === REAL_PAGE) {
        return target;
      }

      // url() — return synthetic URL after submit
      if (prop === 'url') {
        return () => (state.submitted ? state.syntheticUrl : target.url());
      }

      // goto() — skip navigation to synthetic URL (thread replies)
      if (prop === 'goto') {
        return async (url: string, ...args: unknown[]) => {
          if (state.submitted && typeof url === 'string' && url === state.syntheticUrl) {
            state.replyMode = true;
            return undefined;
          }
          return target.goto(url, ...(args as Parameters<Page['goto']>[1][]));
        };
      }

      // Locator methods — return dummy in reply mode
      if (locatorMethods.has(prop as string)) {
        return (...args: unknown[]) => {
          if (state.replyMode) {
            return createDummyLocator();
          }
          const method = (target as unknown as Record<string, ((...a: unknown[]) => Locator) | undefined>)[
            prop as string
          ];
          if (typeof method !== 'function') {
            throw new Error(`Page method ${String(prop)} not found`);
          }
          // Bind to target so Playwright internal this is correct
          return method.bind(target)(...args);
        };
      }

      // All other properties — delegate to real page (bind methods)
      // Use target (not receiver) as 3rd arg so getters like mainFrame
      // are called with this=realPage, not this=Proxy
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Wrap a real BrowserContext with dry-run page wrapping. */
function wrapContext(
  realContext: BrowserContext,
  network: SocialNetwork,
  pageStates: WeakMap<object, DryRunPageState>,
): BrowserContext {
  return new Proxy(realContext, {
    get(target, prop, _receiver) {
      if (prop === 'newPage') {
        return async () => {
          const realPage = await target.newPage();
          const state: DryRunPageState = {
            typedOnPage: false,
            submitted: false,
            syntheticUrl: '',
            network,
            replyMode: false,
            engagementMode: false,
            interceptedActions: 0,
            lastInterceptedAction: '',
          };
          pageStates.set(realPage, state);
          return wrapPage(realPage, state);
        };
      }

      // All other properties — delegate to real context (bind methods)
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * DryRunBrowserPort — intercepts submit clicks to prevent real posting.
 *
 * Wraps the real BrowserFactory. All browser actions (navigation, typing,
 * screenshots) happen for real. Only the final submit click is intercepted.
 */
export class DryRunBrowserPort implements IBrowserPort {
  private readonly logger = new Logger('DryRunBrowserPort');

  /** Per-page state, keyed by the real Page object. */
  private readonly pageStates = new WeakMap<object, DryRunPageState>();

  /** Track which proxy contexts map to real contexts (for releaseContext). */
  private readonly proxyToRealContext = new WeakMap<object, BrowserContext>();

  constructor(private readonly real: BrowserFactory) {}

  async createContext(
    network: SocialNetwork,
    storageState?: string,
  ): Promise<BrowserContext> {
    const realContext = await this.real.createContext(network, storageState);
    const wrapped = wrapContext(realContext, network, this.pageStates);
    this.proxyToRealContext.set(wrapped, realContext);
    return wrapped;
  }

  acquireContext(
    network: SocialNetwork,
    storageState?: string,
  ): Promise<BrowserContext> {
    // In dry-run, bypass the context pool — create a fresh context each time
    // with the correct storageState. The pool may reuse a context that was
    // created without storageState (e.g. from auto-login), causing
    // "Error reading storage state" when Playwright tries to use it.
    return this.real.createContext(network, storageState).then((realContext) => {
      const wrapped = wrapContext(realContext, network, this.pageStates);
      this.proxyToRealContext.set(wrapped, realContext);
      return wrapped;
    });
  }

  releaseContext(network: SocialNetwork, context: BrowserContext): void {
    // In dry-run, close the context instead of returning it to the pool.
    // We bypass the pool in acquireContext (createContext), so we must
    // also bypass it in releaseContext — otherwise the pool loses track.
    const realContext = this.proxyToRealContext.get(context) ?? context;
    this.proxyToRealContext.delete(context);
    // Close the context directly — don't return to pool
    realContext.close().catch(() => void 0);
  }

  saveStorageState(context: BrowserContext): Promise<string> {
    // Unwrap the context before passing to real — real expects a real BrowserContext
    const realContext = this.proxyToRealContext.get(context) ?? context;
    return this.real.saveStorageState(realContext);
  }

  randomDelay(minMs?: number, maxMs?: number): Promise<void> {
    return this.real.randomDelay(minMs, maxMs);
  }

  async humanType(
    locator: Locator,
    text: string,
    opts?: { delayMs?: number },
  ): Promise<void> {
    // Track typing on non-login pages
    const page = getPageFromLocator(locator);
    if (page) {
      const state = this.pageStates.get(page);
      if (state && !isLoginUrl(page.url())) {
        state.typedOnPage = true;
      }
    }
    return this.real.humanType(locator, text, opts);
  }

  // typeHuman is used for X login AND X compose (stealth-x approach).
  // Track typing on non-login pages so humanClick can intercept the submit.
  async typeHuman(page: Page, text: string, locator?: Locator): Promise<void> {
    // Track typing on non-login pages (same as humanType)
    // page may be a proxy wrapping realPage — extract real page for state lookup
    const realPage = extractRealPage(page);
    const state = this.pageStates.get(realPage);
    if (state && !isLoginUrl(page.url())) {
      state.typedOnPage = true;
    }
    return this.real.typeHuman(page, text, locator);
  }

  async humanClick(locator: Locator, opts?: { timeoutMs?: number }): Promise<void> {
    const page = getPageFromLocator(locator);

    // If we can't get the page from the locator (e.g., dummy locator in reply mode),
    // fall through to real humanClick — the dummy's click() is a no-op
    if (!page) {
      return this.real.humanClick(locator, opts);
    }

    const state = this.pageStates.get(page);
    if (!state) {
      // Unknown page — delegate to real
      return this.real.humanClick(locator, opts);
    }

    // Reply mode — all clicks are no-ops
    if (state.replyMode) {
      return;
    }

    const url = page.url();
    const onLoginPage = isLoginUrl(url);

    // ── Engagement mode: intercept ALL clicks on non-login pages ──
    // This catches likes, follows, and comment submits — none of these
    // should reach the real social network in dry-run mode.
    if (state.engagementMode && !onLoginPage) {
      // Determine action type from context:
      // - If typing happened on this page → it's a comment/reply submit
      // - Otherwise → it's a like/follow/reaction
      const actionType = state.typedOnPage ? 'comment' : 'like';
      state.interceptedActions++;
      state.lastInterceptedAction = actionType;
      state.typedOnPage = false; // reset for next action

      // Take screenshot as evidence
      try {
        await this.real.screenshot(page, state.network, `dry-run-${actionType}-${state.interceptedActions}` as ScreenshotPhase);
      } catch (err) {
        this.logger.warn(`Dry-run screenshot failed: ${(err as Error).message}`);
      }

      this.logger.log(
        `⊙ DRY-RUN: ${actionType.toUpperCase()} click #${state.interceptedActions} intercepted for ${state.network}. ` +
          `Action NOT executed on real network.`,
      );
      // Don't actually click — pretend success
      return;
    }

    // ── Posting mode: submit detection (typing happened + not on login + not yet submitted) ──
    if (state.typedOnPage && !state.submitted && !onLoginPage) {
      state.submitted = true;
      state.syntheticUrl = generateSyntheticUrl(state.network);

      // Take screenshot as evidence of what would have been posted
      try {
        await this.real.screenshot(page, state.network, 'after-submit');
      } catch (err) {
        this.logger.warn(`Dry-run screenshot failed: ${(err as Error).message}`);
      }

      this.logger.log(
        `⊙ DRY-RUN: Submit intercepted for ${state.network}. ` +
          `Post NOT published. Synthetic URL: ${state.syntheticUrl}`,
      );
      // Don't actually click — pretend success
      return;
    }

    // Normal click — delegate to real
    return this.real.humanClick(locator, opts);
  }

  scrollPage(
    page: Page,
    direction: ScrollDirection,
    amountPx?: number,
  ): Promise<void> {
    return this.real.scrollPage(page, direction, amountPx);
  }

  hover(locator: Locator): Promise<void> {
    return this.real.hover(locator);
  }

  scrollToElement(page: Page, locator: Locator): Promise<void> {
    return this.real.scrollToElement(page, locator);
  }

  screenshot(
    page: Page,
    network: SocialNetwork,
    phase: ScreenshotPhase,
  ): Promise<string> {
    return this.real.screenshot(page, network, phase);
  }

  extractText(page: Page, selector: string): Promise<string | null> {
    return this.real.extractText(page, selector);
  }

  waitForStable(locator: Locator, opts?: { timeoutMs?: number }): Promise<void> {
    return this.real.waitForStable(locator, opts);
  }

  dismissDialogs(page: Page): Promise<void> {
    return this.real.dismissDialogs(page);
  }

  suppressPageErrors(page: Page): Promise<void> {
    return this.real.suppressPageErrors(page);
  }
}
