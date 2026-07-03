import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
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
import { withTimeout } from '../util/with-timeout.js';

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
export class BrowserFactory implements IBrowserPort, OnModuleInit, OnModuleDestroy {
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
  // MEM: track when each persistent context was last used so the idle sweep can
  // close it during idle stretches (Facebook posts infrequently — keeping a Firefox
  // process alive 24/7 for 1-2 posts/day wastes ~200 MB).
  private readonly persistentContextLastUsed = new Map<SocialNetwork, number>();
  private readonly persistentContextIdleTtlMs: number;
  private readonly profileDir: string;

  // Sprint K: Context pool — reuse contexts per network to avoid repeated creation overhead.
  // Each network gets up to `poolSize` contexts. Idle contexts are returned to the pool.
  private readonly poolSize: number;
  private readonly poolAcquireTimeoutMs: number;
  // Idle contexts carry a releasedAt timestamp so the pool can evict ones that have
  // sat unused past contextIdleTtlMs — each is a real Camoufox (Firefox) process,
  // and without eviction a warm pool of up to `poolSize` contexts per network sits
  // in memory indefinitely even when nothing is running.
  private readonly idleContexts = new Map<SocialNetwork, Array<{ context: BrowserContext; releasedAt: number }>>();
  // MEM: tracks acquiredAt per context so sweepIdleContexts can also reap
  // orphaned in-use contexts (releaseContext never called due to exception).
  private readonly inUseContexts = new Map<SocialNetwork, Map<BrowserContext, number>>();
  // Reserves pool capacity for an in-flight createContext() call. Without this, two
  // concurrent acquirers can both read inUse.size before either awaits createContext(),
  // both pass the capacity check, and both create a context — pushing the pool above
  // poolSize with no further cap (the excess context then persists as idle inventory
  // until the TTL sweep closes it).
  private readonly pendingCreates = new Map<SocialNetwork, number>();
  private readonly contextWaiters = new Map<SocialNetwork, Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>>();
  // Tracks contexts that have been closed (by us, by the browser, or by a page crash).
  // Prevents the pool from reusing dead contexts after a failed session or sweep.
  private readonly closedContexts = new WeakSet<BrowserContext>();
  private readonly contextIdleTtlMs: number;
  private orphanGraceMs: number;
  private idleSweepInterval: ReturnType<typeof setInterval> | null = null;

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
    // MEM: pool default lowered from 3 → 1. Each pooled context is a real Firefox
    // process (~150-300 MB RSS). With 2 pooled networks (X + Threads) the old default
    // kept up to 6 Firefox processes resident for 10 min after last use = ~1.2 GB.
    // Concurrency=1 per queue means only one post runs at a time per network anyway,
    // so poolSize=1 is sufficient; raise via env only if you run parallel engagement.
    this.poolSize = Math.max(1, this.configService.get<number>('BROWSER_POOL_SIZE', 1));
    this.poolAcquireTimeoutMs = Math.max(1000, this.configService.get<number>('BROWSER_POOL_ACQUIRE_TIMEOUT_MS', 60000));
    // MEM: idle TTL lowered from 10 min → 3 min. Idle Firefox processes are pure
    // memory overhead — re-creating a context takes ~2-4s, acceptable vs 200 MB saved.
    this.contextIdleTtlMs = Math.max(60000, this.configService.get<number>('BROWSER_CONTEXT_IDLE_TTL_MS', 3 * 60 * 1000));
    // MEM: orphan grace period — how long an in-use context can be held before the
    // sweep closes it as leaked. Must be longer than the max browsing session duration
    // (F1_BROWSING_SESSION_MINUTES, default 15 min) plus buffer, otherwise the sweep
    // closes contexts mid-session. Default: max(3 × idle TTL, 25 min).
    const browsingMinutes = this.configService.get<number>('F1_BROWSING_SESSION_MINUTES', 15);
    const minOrphanGrace = (browsingMinutes + 10) * 60 * 1000; // browsing + 10 min buffer
    const defaultOrphanGrace = Math.max(this.contextIdleTtlMs * 3, minOrphanGrace);
    this.orphanGraceMs = Math.max(60000, this.configService.get<number>('BROWSER_ORPHAN_GRACE_MS', defaultOrphanGrace));
    // MEM: persistent (Facebook) context idle TTL — defaults to 15 min. FB posts
    // infrequently, so the persistent Firefox process is closed when idle >15 min
    // and re-opened on demand (cookies/fingerprint persist on disk via user_data_dir).
    this.persistentContextIdleTtlMs = Math.max(60000, this.configService.get<number>('PERSISTENT_CONTEXT_IDLE_TTL_MS', 15 * 60 * 1000));
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

    // When the browser process crashes (e.g. Camoufox/Playwright uncaughtError bug),
    // mark all pooled contexts as closed so the next acquire creates a fresh browser
    // instead of reusing dead contexts.
    if (typeof browser.on === 'function') {
      browser.on('disconnected', () => {
        this.logger.warn('Camoufox browser disconnected (process likely crashed)');
        for (const [, entries] of this.idleContexts) {
          for (const entry of entries) {
            this.closedContexts.add(entry.context);
          }
        }
        for (const [, contexts] of this.inUseContexts) {
          for (const ctx of contexts.keys()) {
            this.closedContexts.add(ctx);
          }
        }
        this.browser = null;
        this.browserLaunchPromise = null;
      });
    }

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
      this.persistentContextLastUsed.set(network, Date.now());
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

    // Mark the context as closed if it closes itself (browser crash, page crash, etc.)
    // so the pool never reuses a dead context.
    if (typeof context.on === 'function') {
      context.on('close', () => {
        this.closedContexts.add(context);
      });
    }

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
      const ctx = await this.getOrCreatePersistentContext(network);
      this.persistentContextLastUsed.set(network, Date.now());
      return ctx;
    }

    // Try to get an idle context — loop to handle race between check and pop
    // (Node is single-threaded but async createContext can yield between check and add)
    for (;;) {
      const idle = this.idleContexts.get(network) ?? [];
      if (idle.length > 0) {
        const entry = idle.pop()!;
        this.idleContexts.set(network, idle);

        if (Date.now() - entry.releasedAt > this.contextIdleTtlMs) {
          // Stale — discard and loop back (creates fresh if still within pool capacity)
          void entry.context.close().catch(() => {});
          this.logger.debug(`Context pool: discarded stale idle context for ${network} (past ${this.contextIdleTtlMs}ms TTL)`);
          continue;
        }

        // A reused context keeps whatever cookies it had from its LAST use — createContext()
        // applies storageState only at Playwright context-creation time, so a caller passing
        // a freshly-saved storageState here was previously silently ignored on the reuse path.
        // Confirmed in production: a health check right after a successful login reused a
        // stale pooled context (no valid auth cookies yet), saw the auth cookies "missing",
        // and marked the brand-new session EXPIRED — triggering an unnecessary relogin loop.
        // Cookies are re-applied here; localStorage/origins from storageState are NOT (no
        // post-creation Playwright API for that) — acceptable since AUTH_COOKIES-based health
        // checks and cookie-based auth are what actually gate session validity in this app.
        if (this.closedContexts.has(entry.context)) {
          this.logger.debug(`Context pool: discarded closed idle context for ${network}`);
          continue;
        }

        if (storageState) {
          try {
            const parsed = JSON.parse(storageState) as { cookies?: Parameters<BrowserContext['addCookies']>[0] };
            if (parsed.cookies?.length) {
              await entry.context.clearCookies();
              await entry.context.addCookies(parsed.cookies);
            }
          } catch (err) {
            this.logger.warn(
              `Failed to re-apply storageState cookies to reused context for ${network}: ${(err as Error).message}`,
            );
          }
        }

        const inUse = this.inUseContexts.get(network) ?? new Map();
        inUse.set(entry.context, Date.now());
        this.inUseContexts.set(network, inUse);

        this.logger.debug(`Context pool: reused idle context for ${network}`);
        return entry.context;
      }

      // Check if we're at pool capacity — reserve the slot synchronously (before
      // the createContext() await) so two concurrent callers can't both pass this
      // check for the same free slot.
      const inUse = this.inUseContexts.get(network) ?? new Map();
      const pending = this.pendingCreates.get(network) ?? 0;
      if (inUse.size + pending < this.poolSize) {
        this.pendingCreates.set(network, pending + 1);
        try {
          const context = await this.createContext(network, storageState);
          const inUseNow = this.inUseContexts.get(network) ?? new Map();
          inUseNow.set(context, Date.now());
          this.inUseContexts.set(network, inUseNow);
          return context;
        } finally {
          const current = this.pendingCreates.get(network) ?? 1;
          this.pendingCreates.set(network, Math.max(0, current - 1));
        }
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

    // Dead contexts must not return to the pool, otherwise the next acquire
    // reuses them and immediately fails with "Target page, context or browser has been closed".
    if (this.closedContexts.has(context)) {
      this.logger.debug(`Context pool: not returning closed context for ${network} to idle pool`);
      // Wake up a waiter so they can create/reuse a fresh context instead of hanging
      const waiters = this.contextWaiters.get(network);
      if (waiters && waiters.length > 0) {
        const waiter = waiters.shift()!;
        clearTimeout(waiter.timer);
        this.contextWaiters.set(network, waiters);
        waiter.resolve();
      }
      return;
    }

    // Always put the context back into the idle pool first.
    // If a waiter is pending, resolve it — the waiter will loop back in
    // acquireContext and grab this context from idle. This avoids the
    // hand-off bug where the context was placed directly into inUse,
    // causing the waiter's recursive call to see capacity still full.
    const idle = this.idleContexts.get(network) ?? [];
    idle.push({ context, releasedAt: Date.now() });
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
    // Move the cursor to the center of the viewport so the wheel event is delivered
    // to the main scrollable area (X/Threads use custom scrollable divs, not body).
    const viewport = (page.viewportSize?.() as { width: number; height: number } | undefined) ?? { width: 1280, height: 720 };
    try {
      // Guard mouse operations with a short timeout. If the browser/page becomes
      // unresponsive (e.g. after a Camoufox/Playwright crash), mouse.wheel can hang
      // indefinitely and block the whole browsing session.
      await withTimeout(
        (async () => {
          await page.mouse.move(viewport.width / 2, viewport.height / 2);
          await page.mouse.wheel(0, scrollY);
        })(),
        15000,
        'scrollPage mouse wheel',
      );
    } catch (err) {
      this.logger.warn(`scrollPage mouse wheel timed out, falling back to JS scroll: ${(err as Error).message}`);
      // Fallback: try to scroll via evaluate. Works for body scroll; for custom
      // scrollable divs it may be a no-op, but it unblocks the loop.
      await page
        .evaluate((y) => {
          window.scrollBy(0, y);
          // Try common custom scrollable containers as well
          const scrollables = Array.from(document.querySelectorAll('[data-testid="primaryColumn"], [role="main"], main, [data-pagelet="root"], .scrollable'));
          for (const el of scrollables) {
            if (el.scrollHeight > el.clientHeight) {
              el.scrollBy(0, y);
              break;
            }
          }
        }, scrollY)
        .catch(() => {});
    }
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

  /**
   * Sprint K+: evict pooled contexts that have sat idle past contextIdleTtlMs.
   * Runs on a timer so memory drops back down during idle stretches, not just
   * lazily on the next acquireContext() call for that network.
   */
  private sweepIdleContexts(): void {
    const now = Date.now();

    // MEM: sweep idle contexts past TTL (existing behavior)
    for (const [network, entries] of this.idleContexts) {
      const fresh = entries.filter((entry) => now - entry.releasedAt <= this.contextIdleTtlMs);
      const evicted = entries.length - fresh.length;
      if (evicted > 0) {
        for (const entry of entries) {
          if (now - entry.releasedAt > this.contextIdleTtlMs) {
            this.closedContexts.add(entry.context);
            void entry.context.close().catch(() => {});
          }
        }
        this.idleContexts.set(network, fresh);
        this.logger.debug(`Context pool: swept ${evicted} idle context(s) for ${network} past ${this.contextIdleTtlMs}ms TTL`);
      }
    }

    // MEM: sweep orphaned in-use contexts — releaseContext() was never called
    // (exception in posting/engagement). Without this, a leaked context holds a
    // Firefox process (~200 MB) forever AND blocks pool capacity (inUse.size never
    // drops to 0), so new acquires hang until the acquire timeout.
    // Grace period: configurable via BROWSER_ORPHAN_GRACE_MS, defaults to
    // max(3 × idle TTL, browsing session duration + 10 min) so legitimate
    // browsing sessions (up to 15 min) are not swept mid-session.
    const orphanGraceMs = this.orphanGraceMs;
    for (const [network, contexts] of this.inUseContexts) {
      const orphans: BrowserContext[] = [];
      for (const [ctx, acquiredAt] of contexts) {
        if (now - acquiredAt > orphanGraceMs) {
          orphans.push(ctx);
        }
      }
      if (orphans.length > 0) {
        for (const ctx of orphans) {
          contexts.delete(ctx);
          this.closedContexts.add(ctx);
          void ctx.close().catch(() => {});
        }
        this.logger.warn(
          `Context pool: reaped ${orphans.length} orphaned in-use context(s) for ${network} ` +
            `(held > ${Math.round(orphanGraceMs / 1000)}s without release — likely an uncaught exception in the caller)`,
        );
        // Wake up a waiter if any — capacity just freed up
        const waiters = this.contextWaiters.get(network);
        if (waiters && waiters.length > 0) {
          const waiter = waiters.shift()!;
          clearTimeout(waiter.timer);
          this.contextWaiters.set(network, waiters);
          waiter.resolve();
        }
      }
    }

    // MEM: close idle persistent (Facebook) contexts — the FB persistent context
    // holds a Firefox process alive 24/7 for infrequent posts. Close it when idle
    // > persistentContextIdleTtlMs; cookies/fingerprint persist on disk and it will
    // be re-opened on the next acquireContext/createContext call.
    for (const [network, ctx] of this.persistentContexts) {
      const lastUsed = this.persistentContextLastUsed.get(network) ?? now;
      if (now - lastUsed > this.persistentContextIdleTtlMs) {
        this.logger.log(
          `Persistent context for ${network} idle > ${Math.round(this.persistentContextIdleTtlMs / 1000)}s — closing to free memory (will re-open on next use)`,
        );
        this.closedContexts.add(ctx);
        void ctx.close().catch(() => {});
        this.persistentContexts.delete(network);
        this.persistentContextLastUsed.delete(network);
      }
    }
  }

  onModuleInit(): void {
    const sweepIntervalMs = Math.min(this.contextIdleTtlMs, 60000);
    this.idleSweepInterval = setInterval(() => this.sweepIdleContexts(), sweepIntervalMs);
    this.idleSweepInterval.unref?.();
    this.verifyCamoufoxPatch();
  }

  /**
   * Runtime check that the Camoufox/Playwright uncaughtError patch is present.
   * If the patch is missing, browsing sessions will crash with
   * "Target page, context or browser has been closed" when X/Threads feeds throw
   * uncaught JS errors. Logs the result so production issues can be diagnosed.
   */
  private verifyCamoufoxPatch(): void {
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      let pwDir: string | undefined;
      try {
        pwDir = path.dirname(require.resolve('playwright-core/package.json'));
      } catch {
        this.logger.warn('Camoufox patch check: playwright-core not resolvable');
        return;
      }
      const coreBundle = path.join(pwDir, 'lib', 'coreBundle.js');
      if (!fs.existsSync(coreBundle)) {
        this.logger.warn(`Camoufox patch check: coreBundle.js not found at ${coreBundle}`);
        return;
      }
      const src = fs.readFileSync(coreBundle, 'utf8');
      const patched = src.includes('params2.location ?? { url:');
      if (patched) {
        this.logger.log('Camoufox patch verified: coreBundle.js is patched for uncaughtError crash');
      } else {
        this.logger.error(
          'Camoufox patch MISSING: coreBundle.js is not patched. Browsing sessions will likely crash with "Target page, context or browser has been closed" on X/Threads feeds.',
        );
      }
    } catch (err) {
      this.logger.warn(`Camoufox patch check failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.idleSweepInterval) {
      clearInterval(this.idleSweepInterval);
      this.idleSweepInterval = null;
    }

    // Close all pooled contexts — guard against undefined entries (defensive)
    for (const [, entries] of this.idleContexts) {
      for (const entry of entries) {
        if (entry.context) {
          this.closedContexts.add(entry.context);
          await entry.context.close().catch(() => {});
        }
      }
    }
    this.idleContexts.clear();

    for (const [, contexts] of this.inUseContexts) {
      for (const ctx of contexts.keys()) {
        if (ctx) {
          this.closedContexts.add(ctx);
          await ctx.close().catch(() => {});
        }
      }
    }
    this.inUseContexts.clear();

    // Close persistent contexts (Facebook) — saves cookies/fingerprint to disk
    for (const [, ctx] of this.persistentContexts) {
      if (ctx) {
        this.closedContexts.add(ctx);
        await ctx.close().catch(() => {});
      }
    }
    this.persistentContexts.clear();
    this.persistentContextLastUsed.clear();

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
