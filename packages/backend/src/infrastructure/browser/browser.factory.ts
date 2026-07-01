import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser, BrowserContext, Locator, Page } from '../../domain/ports/browser-primitives';
import type { SocialNetwork } from '@prisma/client';
import { Camoufox, type LaunchOptions } from 'camoufox-js';
import type {
  IBrowserPort,
  ScrollDirection,
  ScreenshotPhase,
} from '../../domain/ports/browser.port.js';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parseBool } from '../config/parse-bool.js';

/**
 * Browser factory — creates Camoufox (stealth Firefox fork) browser contexts.
 *
 * Camoufox provides stealth at the C++ level (not JS injection):
 * - Fingerprint rotation: every launch gets a fresh identity from real-world
 *   device distribution (navigator, WebGL, screen, fonts, WebRTC — all spoofed
 *   at C++ level, undetectable through JS inspection)
 * - Humanize: human-like mouse movement (built-in)
 * - Geoip: geolocation, timezone, locale spoofing at protocol level
 * - Playwright Page Agent runs in sandboxed world — websites cannot detect
 *   Playwright through JavaScript inspection
 *
 * Playwright-compatible API: returns standard Playwright Browser/Page instances.
 *
 * @see https://camoufox.com/stealth/ — stealth overview
 * @see OQ-25 in CONSTITUTION.md — decision rationale
 */
@Injectable()
export class BrowserFactory implements IBrowserPort, OnModuleDestroy {
  private readonly logger = new Logger(BrowserFactory.name);
  private readonly headless: boolean;
  private readonly humanize: boolean;
  private readonly geoip: boolean;
  private readonly locale: string;
  private readonly targetOs: 'windows' | 'macos' | 'linux';
  private readonly proxyUrl: string | undefined;
  private readonly screenshotDir: string;
  private readonly screenshotsEnabled: boolean;
  private readonly screenshotFullPage: boolean;
  private browser: Browser | null = null;
  // P5: in-flight browser launch promise — concurrent callers share a single
  // Camoufox launch (which downloads the binary + UBO addon on first run).
  // Without this, multiple concurrent getBrowser() calls race to download/extract
  // the addon to the same path → "manifest.json is missing" from confirmPaths().
  private browserLaunchPromise: Promise<Browser> | null = null;
  // Persistent context for Facebook — stores fingerprint + cookies on disk
  // to avoid "suspicious login" challenges on every run.
  // Key: network → persistent BrowserContext
  private readonly persistentContexts = new Map<SocialNetwork, BrowserContext>();
  // P5: key network → in-flight launch promise, so concurrent callers share a
  // single Camoufox launch instead of racing two processes onto one user_data_dir.
  private readonly persistentContextPromises = new Map<SocialNetwork, Promise<BrowserContext>>();
  private readonly profileDir: string;

  // Sprint K: Context pool — reuse contexts per network to avoid repeated creation overhead.
  // Each network gets up to `poolSize` contexts. Idle contexts are returned to the pool.
  private readonly poolSize: number;
  private readonly poolAcquireTimeoutMs: number;
  private readonly idleContexts = new Map<SocialNetwork, BrowserContext[]>();
  private readonly inUseContexts = new Map<SocialNetwork, Set<BrowserContext>>();
  private readonly contextWaiters = new Map<SocialNetwork, Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>>();

  constructor(private readonly configService: ConfigService) {
    this.headless = parseBool(this.configService.get<string>('CAMOUFOX_HEADLESS', 'true'));
    this.humanize = parseBool(this.configService.get<string>('CAMOUFOX_HUMANIZE', 'true'));
    this.geoip = parseBool(this.configService.get<string>('CAMOUFOX_GEOIP', 'true'));
    this.locale = this.configService.get<string>('CAMOUFOX_LOCALE', 'en-US');
    this.targetOs = this.configService.get<string>('CAMOUFOX_OS', 'windows') as
      | 'windows'
      | 'macos'
      | 'linux';
    this.proxyUrl = this.configService.get<string | undefined>('CAMOUFOX_PROXY_URL');
    this.screenshotDir = this.configService.get<string>('SPA_SCREENSHOT_DIR', '/tmp/spa-screenshots');
    // P7: screenshots OFF by default — they were written on every posting phase and
    // every engagement scroll tick (fullPage) with no cleanup → unbounded disk leak.
    // Enable for debugging via SPA_SCREENSHOTS=true; fullPage via SPA_SCREENSHOT_FULLPAGE=true.
    this.screenshotsEnabled = parseBool(this.configService.get<string>('SPA_SCREENSHOTS', 'false'));
    this.screenshotFullPage = parseBool(this.configService.get<string>('SPA_SCREENSHOT_FULLPAGE', 'false'));
    this.poolSize = Math.max(1, this.configService.get<number>('BROWSER_POOL_SIZE', 3));
    this.poolAcquireTimeoutMs = Math.max(1000, this.configService.get<number>('BROWSER_POOL_ACQUIRE_TIMEOUT_MS', 60000));
    // Persistent browser profiles directory — stores fingerprint + cookies per network
    // Facebook requires this to avoid "suspicious login" challenges on every run
    this.profileDir = this.configService.get<string>('CAMOUFOX_PROFILE_DIR', '/tmp/spa-profiles');
    // SEC2: the persistent profile stores plaintext auth cookies outside the DB encryption.
    // /tmp is broadly accessible; in production it must live on a restricted/encrypted volume.
    if (this.configService.get<string>('NODE_ENV') === 'production' && this.profileDir.startsWith('/tmp/')) {
      this.logger.warn(
        `SEC2: CAMOUFOX_PROFILE_DIR is under /tmp (${this.profileDir}) — FB/Threads cookies are stored there in plaintext. ` +
          'Point it at a restricted, encrypted volume in production.',
      );
    }
  }

  /**
   * Get or create the shared Camoufox browser instance.
   * One browser, multi-context per network (CONSTITUTION §9).
   *
   * P5: uses an in-flight launch promise so concurrent callers share a single
   * Camoufox launch. Without this, multiple browsing jobs that start before the
   * binary/addon is fully downloaded race to extract the UBO addon to the same
   * path → "manifest.json is missing" from confirmPaths().
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    // Share an in-flight launch so concurrent callers don't race.
    if (this.browserLaunchPromise) {
      return this.browserLaunchPromise;
    }

    this.browserLaunchPromise = this.launchBrowser();
    try {
      this.browser = await this.browserLaunchPromise;
      return this.browser;
    } finally {
      // Clear the promise so a failed launch can be retried on the next call.
      // If successful, the fast-path `this.browser` check at the top handles reuse.
      this.browserLaunchPromise = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const launchOpts: LaunchOptions = {
      headless: this.headless,
      humanize: this.humanize,
      geoip: this.geoip,
      locale: this.locale,
      os: this.targetOs,
    };

    // Proxy support for IP rotation (anti-detection)
    if (this.proxyUrl) {
      launchOpts.proxy = { server: this.proxyUrl };
      this.logger.log(`Using proxy: ${this.proxyUrl.replace(/\/\/.*@/, '//***@')}`);
    }

    // Camoufox() returns a Playwright-compatible Browser instance.
    // The Camoufox binary is downloaded via `npx camoufox-js fetch` (postinstall).
    const browser = (await Camoufox(launchOpts)) as unknown as Browser;

    this.logger.log(
      `Camoufox launched (headless=${this.headless}, os=${this.targetOs}, humanize=${this.humanize}, geoip=${this.geoip}, proxy=${!!this.proxyUrl})`,
    );
    return browser;
  }

  /**
   * Get or create a persistent browser context for a network.
   *
   * Persistent contexts use `user_data_dir` — Camoufox stores the fingerprint,
   * cookies, localStorage, and session data on disk. This means:
   * - Same fingerprint between runs (no "new device" detection)
   * - Cookies persist (no re-login needed if session is still valid)
   * - Facebook "suspicious login" challenge only appears on first run
   *
   * Reference: tas33n/fb-login-bot (cookie persistence),
   *            camofox-browser (session isolation + cookie import),
   *            Camoufox `user_data_dir` option.
   */
  private getOrCreatePersistentContext(network: SocialNetwork): Promise<BrowserContext> {
    // Fast path: an already-resolved context.
    const cached = this.persistentContexts.get(network);
    if (cached) return Promise.resolve(cached);

    // P5: share an in-flight launch. Without this, two concurrent callers (e.g.
    // a posting job and a warmup/engagement task — createContext() and
    // acquireContext() both funnel here) both miss the cache and launch two
    // Camoufox processes on the SAME user_data_dir, a Firefox profile-lock
    // conflict that corrupts the persistent session.
    const inFlight = this.persistentContextPromises.get(network);
    if (inFlight) return inFlight;

    const launch = this.launchPersistentContext(network);
    this.persistentContextPromises.set(network, launch);
    // Clear the in-flight slot once settled; the resolved context is cached
    // inside launchPersistentContext(). Errors still reach awaiters of `launch`;
    // the trailing no-op .catch only keeps this bookkeeping chain from surfacing
    // as an unhandled rejection.
    void launch.finally(() => this.persistentContextPromises.delete(network)).catch(() => {});
    return launch;
  }

  private async launchPersistentContext(network: SocialNetwork): Promise<BrowserContext> {
    // Create profile directory if it doesn't exist
    const profilePath = join(this.profileDir, network.toLowerCase());
    try {
      // SEC2: the persistent profile holds plaintext auth cookies (esp. Facebook c_user+xs,
      // which bypass the DB storageState encryption entirely). Restrict the profile tree to
      // owner-only (0700) so it isn't exposed via a world-readable /tmp. Real at-rest
      // encryption still requires an encrypted volume in prod (see CAMOUFOX_PROFILE_DIR doc).
      mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
      mkdirSync(profilePath, { recursive: true, mode: 0o700 });
      // mkdir mode is masked by umask, so set the perms explicitly (best-effort).
      try {
        chmodSync(this.profileDir, 0o700);
        chmodSync(profilePath, 0o700);
      } catch {
        // chmod may fail on some filesystems — non-fatal
      }
    } catch {
      // directory may already exist
    }

    const launchOpts: LaunchOptions = {
      headless: this.headless,
      humanize: this.humanize,
      geoip: this.geoip,
      locale: this.locale,
      os: this.targetOs,
    };

    // Proxy support
    if (this.proxyUrl) {
      launchOpts.proxy = { server: this.proxyUrl };
    }

    // Camoufox with user_data_dir returns a BrowserContext (persistent)
    // instead of a Browser. The fingerprint and cookies are stored on disk.
    // viewport: null tells Playwright not to call Browser.setDefaultViewport
    // (Camoufox doesn't support this method — it manages viewport at C++ level)
    const context = (await Camoufox({
      ...launchOpts,
      user_data_dir: profilePath,
      viewport: null,
    })) as unknown as BrowserContext;

    this.persistentContexts.set(network, context);
    this.logger.log(
      `Persistent context created for ${network} (profile: ${profilePath})`,
    );
    return context;
  }

  /**
   * Create a browser context with optional saved storageState (cookies, localStorage).
   * Used for persistent sessions — restores login state between runs.
   *
   * For Facebook: uses persistent context (user_data_dir) to avoid repeated
   * "suspicious login" challenges. The fingerprint and cookies are stored on disk.
   * The storageState parameter is ignored for Facebook (cookies come from disk).
   *
   * For X/Threads: creates a fresh context with storageState (existing behavior).
   *
   * Each call creates a fresh context — callers are responsible for closing it
   * (P0-H1: PostingService tracks and closes in finally block to prevent leaks).
   * Note: For Facebook persistent context, the context is NOT closed — it's reused.
   *
   * Camoufox handles fingerprint/UA/viewport automatically via C++ level spoofing,
   * so we don't set them manually (would conflict with Camoufox's identity).
   */
  async createContext(
    network: SocialNetwork,
    storageState?: string,
  ): Promise<BrowserContext> {
    // Facebook: use persistent context to avoid repeated challenges
    if (network === 'FACEBOOK') {
      const persistentContext = await this.getOrCreatePersistentContext(network);
      // Create a new page within the persistent context
      // The persistent context itself is shared — callers get a new page
      return persistentContext;
    }

    // X/Threads: fresh context with storageState (existing behavior)
    const browser = await this.getBrowser();

    const contextOptions: Parameters<Browser['newContext']>[0] = {
      // Camoufox doesn't support isMobile in viewport — disable viewport entirely.
      // Camoufox handles window size at C++ level via its fingerprint spoofing.
      viewport: null,
    };

    if (storageState) {
      contextOptions.storageState = JSON.parse(storageState) as never;
    }

    const context = await browser.newContext(contextOptions);

    this.logger.debug(`Context created for ${network}`);
    return context;
  }

  /**
   * Sprint K: Acquire a context from the pool, or create a new one if pool is empty.
   *
   * If the pool is at capacity (all contexts in use), waits until one is released.
   * Pooled contexts are reused across posting runs — avoids the overhead of
   * creating a new browser context (which spawns a new process in Camoufox).
   *
   * @param network Target social network
   * @param storageState Optional saved storage state (cookies, localStorage)
   * @returns A BrowserContext — caller MUST call releaseContext() when done
   */
  async acquireContext(
    network: SocialNetwork,
    storageState?: string,
  ): Promise<BrowserContext> {
    // Facebook: persistent context is shared (not pooled) — return it directly
    if (network === 'FACEBOOK') {
      return this.getOrCreatePersistentContext(network);
    }

    // Try to get an idle context — loop to handle race between check and pop
    // (Node is single-threaded but async createContext can yield between check and add)
    for (;;) {
      const idle = this.idleContexts.get(network) ?? [];
      if (idle.length > 0) {
        const context = idle.pop()!;
        this.idleContexts.set(network, idle);

        const inUse = this.inUseContexts.get(network) ?? new Set();
        inUse.add(context);
        this.inUseContexts.set(network, inUse);

        this.logger.debug(`Context pool: reused idle context for ${network}`);
        return context;
      }

      // Check if we're at pool capacity
      const inUse = this.inUseContexts.get(network) ?? new Set();
      if (inUse.size < this.poolSize) {
        // Create a new context (within pool capacity)
        const context = await this.createContext(network, storageState);
        // Re-fetch inUse set — createContext is async and another caller may have added
        const inUseNow = this.inUseContexts.get(network) ?? new Set();
        // If we exceeded capacity during await (rare), still return — we already created it
        inUseNow.add(context);
        this.inUseContexts.set(network, inUseNow);
        return context;
      }

      // At capacity — wait for a release. The release will put the context
      // into idle and resolve our promise. We then loop back to grab it.
      this.logger.debug(`Context pool: at capacity (${this.poolSize}) for ${network}, waiting…`);
      await new Promise<void>((resolve, reject) => {
        const waiters = this.contextWaiters.get(network) ?? [];
        const timer = setTimeout(() => {
          // Remove this waiter from the queue (it timed out)
          const current = this.contextWaiters.get(network) ?? [];
          const idx = current.indexOf(entry);
          if (idx >= 0) current.splice(idx, 1);
          reject(new Error(`Context pool acquire timeout (${this.poolAcquireTimeoutMs}ms) for ${network}`));
        }, this.poolAcquireTimeoutMs);
        const entry = { resolve, reject, timer };
        waiters.push(entry);
        this.contextWaiters.set(network, waiters);
      });
      // Loop back — releaseContext put a context into idle for us
    }
  }

  /**
   * Sprint K: Release a context back to the pool for reuse.
   *
   * The context is NOT closed — it stays alive for the next acquireContext() call.
   * Callers MUST ensure they've finished all page interactions before releasing.
   *
   * @param network Target social network
   * @param context The context to release
   */
  releaseContext(network: SocialNetwork, context: BrowserContext): void {
    // Facebook: persistent context is not pooled — just return (context stays alive)
    if (network === 'FACEBOOK') {
      return;
    }

    const inUse = this.inUseContexts.get(network);
    if (inUse) {
      inUse.delete(context);
    }

    // Always put the context back into the idle pool first.
    // If a waiter is pending, resolve it — the waiter will loop back in
    // acquireContext and grab this context from idle. This avoids the
    // hand-off bug where the context was placed directly into inUse,
    // causing the waiter's recursive call to see capacity still full.
    const idle = this.idleContexts.get(network) ?? [];
    idle.push(context);
    this.idleContexts.set(network, idle);

    // Wake up one waiter if any — they'll grab the context from idle
    const waiters = this.contextWaiters.get(network);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      clearTimeout(waiter.timer);
      this.contextWaiters.set(network, waiters);
      waiter.resolve();
      this.logger.debug(`Context pool: released context for ${network}, woke waiter (idle: ${idle.length})`);
    } else {
      this.logger.debug(`Context pool: released context for ${network} (idle: ${idle.length})`);
    }
  }

  /**
   * Save storageState from a context to persist session (cookies, localStorage).
   * Returns JSON string to store in DB Session.storageState.
   */
  async saveStorageState(context: BrowserContext): Promise<string> {
    const state = await context.storageState();
    return JSON.stringify(state);
  }

  /**
   * Human-like delay — random pause between actions (CONSTITUTION §9).
   * Complements Camoufox's built-in humanize (mouse movement).
   * Call sites use this between navigation, typing, clicking.
   */
  randomDelay(minMs = 5000, maxMs = 30000): Promise<void> {
    const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Sprint K: Adaptive delay — adjusts pause based on page load performance.
   * Slow network → longer pause (human reads slower too).
   * Fast network → normal pause.
   */
  async adaptiveDelay(page: Page): Promise<void> {
    try {
      const navTiming = await page.evaluate(() => {
        const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        return entries[0] ? { loadEventEnd: entries[0].loadEventEnd, startTime: entries[0].startTime } : null;
      });
      const responseTime = navTiming ? navTiming.loadEventEnd - navTiming.startTime : 3000;
      if (responseTime > 5000) {
        // Slow network — longer pause
        await this.randomDelay(15000, 45000);
      } else {
        // Fast network — normal pause
        await this.randomDelay(5000, 20000);
      }
    } catch {
      // Fallback to standard delay
      await this.randomDelay();
    }
  }

  /**
   * Human-like typing — focuses element, types with per-key delay.
   * Uses pressSequentially for React-controlled inputs (fill() doesn't trigger onChange).
   */
  async humanType(locator: Locator, text: string, opts?: { delayMs?: number }): Promise<void> {
    const delay = opts?.delayMs ?? 50; // 50ms per key — human-like
    try {
      await locator.focus({ timeout: 5000 });
    } catch {
      // Focus failed (overlay/animation) — try force-click to focus
      await locator.click({ force: true, timeout: 5000 }).catch(() => {});
    }
    await this.randomDelay(300, 800);
    // Try pressSequentially first (triggers React onChange) with short timeout
    try {
      await locator.pressSequentially(text, { delay, timeout: 15000 });
    } catch {
      // pressSequentially failed (typeahead/autocomplete intercepting) — use fill() fallback
      // fill() sets the value directly without per-key events
      try {
        await locator.fill(text, { timeout: 10000 });
      } catch {
        // fill() also failed — last resort: set content via evaluate + dispatch input event
        await locator.evaluate((el: HTMLElement, value: string) => {
          el.focus();
          // For contenteditable: set textContent and dispatch input event
          el.textContent = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, text);
      }
    }
  }

  /**
   * Stealth human-like typing — types character by character via page.keyboard.type
   * with randomized per-key delay (40-120ms) and 5% chance of a "thinking" pause
   * (200-600ms). More human-like than humanType (pressSequentially with fixed delay).
   *
   * Reference: stealth-x (Youhai020616/stealth-x) typeHuman() — used for X login
   * where X's anti-bot detects uniform typing patterns.
   *
   * Caller is responsible for focusing the element first (click/focus before calling).
   */
  async typeHuman(page: Page, text: string, locator?: Locator): Promise<void> {
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      // Random per-key delay 40-120ms (stealth-x: 40 + Math.random() * 80)
      const delay = 40 + Math.random() * 80;
      if (locator) {
        // Per-locator typing — ensures focus stays on the element (React-controlled inputs)
        await locator.pressSequentially(char, { delay });
      } else {
        // Keyboard typing — caller must have focused the element first
        await page.keyboard.type(char, { delay });
      }
      // 5% chance of a longer "thinking" pause (stealth-x)
      if (Math.random() < 0.05) {
        await this.randomDelay(200, 600);
      }
    }
  }

  /**
   * Human-like click — tries normal click first, falls back to force: true
   * if Camoufox humanize blocks the action (element visible/enabled/stable but click times out).
   *
   * The humanize feature in Camoufox moves the mouse human-like, but sometimes
   * the movement path is blocked by overlays or animations, causing click to time out
   * even though the element is visible and enabled. force: true bypasses the mouse
   * movement and dispatches the click event directly.
   */
  async humanClick(locator: Locator, opts?: { timeoutMs?: number }): Promise<void> {
    const timeout = opts?.timeoutMs ?? 15000;
    try {
      // Try normal click first (with humanize mouse movement)
      await locator.click({ timeout });
    } catch (err) {
      const message = (err as Error).message;
      // If it's a timeout (humanize blocked the click), retry with force
      if (message.includes('Timeout') && message.includes('click')) {
        this.logger.debug('Normal click timed out (humanize?), retrying with force: true');
        await locator.click({ force: true, timeout: 5000 });
      } else {
        throw err;
      }
    }
  }

  /**
   * Human-like hover — moves mouse to an element and pauses.
   * Simulates reading/considering before clicking (engagement sessions).
   */
  async hover(locator: Locator): Promise<void> {
    await locator.hover({ timeout: 5000 }).catch(() => {
      // Hover is non-critical — ignore failures (element may have scrolled away)
    });
    await this.randomDelay(500, 1500);
  }

  /**
   * Scroll the page in a direction by a given amount (in pixels).
   * Used for feed browsing and engagement sessions.
   */
  async scrollPage(page: Page, direction: ScrollDirection, amountPx = 600): Promise<void> {
    const scrollY = direction === 'down' ? amountPx : -amountPx;
    await page.mouse.wheel(0, scrollY);
    // Wait for scroll to settle and new content to load
    await this.randomDelay(800, 2000);
  }

  /**
   * Scroll to a specific element — useful for bringing posts into view before liking/commenting.
   */
  async scrollToElement(page: Page, locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {
      // Fallback: manual scroll via page.evaluate
      void page.evaluate(() => {
        const el = document.activeElement;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });
    await this.randomDelay(500, 1500);
  }

  /**
   * Capture a screenshot and save to /tmp/spa-screenshots/{network}/{phase}-{timestamp}.png
   * for debugging and post validation.
   */
  async screenshot(
    page: Page,
    network: SocialNetwork,
    phase: ScreenshotPhase,
  ): Promise<string> {
    // P7: disabled by default — return empty path without writing to disk.
    if (!this.screenshotsEnabled) return '';
    const networkDir = join(this.screenshotDir, network.toLowerCase());
    const filename = `${phase}-${Date.now()}.png`;
    const filepath = join(networkDir, filename);
    try {
      if (!existsSync(networkDir)) {
        mkdirSync(networkDir, { recursive: true });
      }
      await page.screenshot({ path: filepath, fullPage: this.screenshotFullPage });
      this.logger.debug(`Screenshot saved: ${filepath}`);
      return filepath;
    } catch (err) {
      this.logger.warn(`Screenshot failed: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * Extract visible text from an element — used for post validation
   * (checking if posted content actually appeared on profile page).
   */
  async extractText(page: Page, selector: string): Promise<string | null> {
    try {
      const element = page.locator(selector).first();
      const isVisible = await element.isVisible().catch(() => false);
      if (!isVisible) return null;
      return (await element.textContent())?.trim() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Wait for an element to be stable (no animations/movement) before interacting.
   * Camoufox humanize can interfere with clicks on animating elements.
   */
  async waitForStable(locator: Locator, opts?: { timeoutMs?: number }): Promise<void> {
    const timeout = opts?.timeoutMs ?? 10000;
    await locator.waitFor({ state: 'visible', timeout });
    // Extra wait for animations to settle
    await this.randomDelay(500, 1500);
  }

  /**
   * Suppress uncaught page-side JS errors and unhandled rejections. Social feeds
   * (X, Threads, Facebook) routinely throw uncaught errors that crash Playwright
   * 1.61.1's Firefox implementation (FFPage._onUncaughtError → addPageError →
   * "Cannot read properties of undefined (reading 'url')"). addInitScript runs
   * before page JS — it intercepts window.onerror/unhandledrejection before the
   * site's own error can propagate up into Playwright and break the page/context
   * connection.
   */
  async suppressPageErrors(page: Page): Promise<void> {
    await page.addInitScript(() => {
      window.addEventListener('error', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    });
    page.on('pageerror', () => {});
  }

  /**
   * Dismiss any dialogs, popups, or cookie banners that might block interactions.
   * Tries common close button selectors used by social networks.
   */
  async dismissDialogs(page: Page): Promise<void> {
    const dismissSelectors = [
      // Generic close buttons
      '[aria-label="Close"]',
      '[aria-label="Dismiss"]',
      'button:has-text("Not now")',
      'button:has-text("No thanks")',
      'button:has-text("Maybe later")',
      // Cookie banners
      'button:has-text("Accept all")',
      'button:has-text("Allow all cookies")',
      'button:has-text("Got it")',
      // X.com specific
      '[data-testid="app-bar-close"]',
      '[data-testid="sheetDialogCloseButton"]',
      // Threads/Instagram specific
      'div[role="dialog"] [aria-label="Close"]',
    ];

    for (const selector of dismissSelectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          await el.click({ force: true, timeout: 2000 }).catch(() => {});
          await this.randomDelay(300, 800);
        }
      } catch {
        // Ignore — not all selectors will match on all networks
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Close all pooled contexts — guard against undefined entries (defensive)
    for (const [, contexts] of this.idleContexts) {
      for (const ctx of contexts) {
        if (ctx) await ctx.close().catch(() => {});
      }
    }
    this.idleContexts.clear();

    for (const [, contexts] of this.inUseContexts) {
      for (const ctx of contexts) {
        if (ctx) await ctx.close().catch(() => {});
      }
    }
    this.inUseContexts.clear();

    // Close persistent contexts (Facebook) — saves cookies/fingerprint to disk
    for (const [, ctx] of this.persistentContexts) {
      if (ctx) await ctx.close().catch(() => {});
    }
    this.persistentContexts.clear();

    // Reject any pending waiters so they don't hang forever
    for (const [, waiters] of this.contextWaiters) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error('Browser factory shutting down'));
      }
    }
    this.contextWaiters.clear();

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.logger.log('Camoufox browser closed');
    }
    this.browserLaunchPromise = null;
  }
}
