/**
 * BrowserFactory unit tests — covers context creation, pooling, human-like
 * actions, screenshots, and dialog dismissal.
 *
 * Source: packages/backend/src/infrastructure/browser/browser.factory.ts
 * Test IDs: UTC-400 through UTC-419
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';

// ── Mock camoufox-js ──
// Camoufox() returns a Playwright-compatible Browser or BrowserContext.
// We control which one via the mock so we can test both code paths.

const mocks = vi.hoisted(() => ({
  camoufoxLaunch: vi.fn(),
  browserNewContext: vi.fn(),
  browserIsConnected: vi.fn().mockReturnValue(true),
  browserClose: vi.fn().mockResolvedValue(undefined),
  contextStorageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
  contextClose: vi.fn().mockResolvedValue(undefined),
  contextNewPage: vi.fn().mockResolvedValue({}),
  contextClearCookies: vi.fn().mockResolvedValue(undefined),
  contextAddCookies: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('camoufox-js', () => ({
  Camoufox: mocks.camoufoxLaunch,
}));

import { BrowserFactory } from '../../../src/infrastructure/browser/browser.factory';

// ── Helpers ──

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    CAMOUFOX_HEADLESS: 'true',
    CAMOUFOX_HUMANIZE: 'true',
    CAMOUFOX_GEOIP: 'true',
    CAMOUFOX_LOCALE: 'en-US',
    CAMOUFOX_OS: 'windows',
    CAMOUFOX_PROXY_URL: undefined,
    SPA_SCREENSHOT_DIR: '/tmp/spa-screenshots-test',
    BROWSER_POOL_SIZE: 2,
    CAMOUFOX_PROFILE_DIR: '/tmp/spa-profiles-test',
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue),
  } as unknown as ConfigService;
}

function makeMockBrowser() {
  return {
    newContext: mocks.browserNewContext,
    isConnected: mocks.browserIsConnected,
    close: mocks.browserClose,
  };
}

function makeMockContext() {
  return {
    newPage: mocks.contextNewPage,
    storageState: mocks.contextStorageState,
    close: mocks.contextClose,
    clearCookies: mocks.contextClearCookies,
    addCookies: mocks.contextAddCookies,
  };
}

function makeMockPage(opts: { loadEventEnd?: number; startTime?: number } = {}) {
  const loadEventEnd = opts.loadEventEnd ?? 1000;
  const startTime = opts.startTime ?? 0;
  return {
    evaluate: vi.fn().mockResolvedValue({ loadEventEnd, startTime }),
    mouse: { wheel: vi.fn().mockResolvedValue(undefined), move: vi.fn().mockResolvedValue(undefined) },
    keyboard: { type: vi.fn().mockResolvedValue(undefined), press: vi.fn().mockResolvedValue(undefined) },
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    locator: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnThis(),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      focus: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      pressSequentially: vi.fn().mockResolvedValue(undefined),
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      waitFor: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
      textContent: vi.fn().mockResolvedValue(''),
    }),
  } as unknown;
}

// ── Tests ──

describe('BrowserFactory', () => {
  let factory: BrowserFactory;
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    configService = createMockConfigService();
    factory = new BrowserFactory(configService);

    // Default: Camoufox launch returns a Browser (for non-Facebook)
    mocks.camoufoxLaunch.mockImplementation(async (opts: Record<string, unknown>) => {
      // If user_data_dir is present → persistent context
      if (opts && 'user_data_dir' in opts) {
        return makeMockContext();
      }
      return makeMockBrowser();
    });
    mocks.browserNewContext.mockResolvedValue(makeMockContext());
    mocks.browserIsConnected.mockReturnValue(true);
    mocks.contextStorageState.mockResolvedValue({ cookies: [], origins: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── createContext ──

  it('UTC-400: createContext(X, storageState) → launch → newContext with storageState → return context', async () => {
    // Arrange
    const storageState = JSON.stringify({ cookies: [{ name: 'c1', value: 'v1' }], origins: [] });

    // Act
    const ctx = await factory.createContext('X', storageState);

    // Assert
    expect(ctx).toBeDefined();
    expect(mocks.camoufoxLaunch).toHaveBeenCalledOnce();
    expect(mocks.browserNewContext).toHaveBeenCalledOnce();
    const ctxOpts = mocks.browserNewContext.mock.calls[0]![0];
    expect(ctxOpts.storageState).toEqual({ cookies: [{ name: 'c1', value: 'v1' }], origins: [] });
  });

  it('UTC-401: createContext(FACEBOOK) → persistent context with user_data_dir', async () => {
    // Act
    const ctx = await factory.createContext('FACEBOOK');

    // Assert — Camoufox called with user_data_dir, returns a context (not browser)
    expect(mocks.camoufoxLaunch).toHaveBeenCalledOnce();
    const launchOpts = mocks.camoufoxLaunch.mock.calls[0]![0];
    expect(launchOpts.user_data_dir).toContain('facebook');
    expect(ctx).toBeDefined();
    // newContext should NOT be called for Facebook (persistent context)
    expect(mocks.browserNewContext).not.toHaveBeenCalled();
  });

  it('UTC-401b: concurrent createContext(FACEBOOK) → single Camoufox launch, shared context (P5 race)', async () => {
    // Two callers hit the cold cache at the same time (e.g. a posting job and a
    // warmup task). Without in-flight memoization each would launch its own
    // Camoufox process on the SAME user_data_dir (Firefox profile-lock conflict).
    const [a, b] = await Promise.all([
      factory.createContext('FACEBOOK'),
      factory.createContext('FACEBOOK'),
    ]);

    expect(mocks.camoufoxLaunch).toHaveBeenCalledOnce();
    expect(a).toBe(b); // both share the one launched persistent context
  });

  it('SEC2: persistent profile directory is created owner-only (0700) — plaintext cookies not world-readable', async () => {
    const { statSync } = await import('node:fs');
    await factory.createContext('FACEBOOK');
    // CAMOUFOX_PROFILE_DIR is /tmp/spa-profiles-test in the mock config.
    const mode = statSync('/tmp/spa-profiles-test/facebook').mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('UTC-402: createContext(THREADS, storageState) → standard context (not persistent)', async () => {
    // Act
    const ctx = await factory.createContext('THREADS', JSON.stringify({ cookies: [], origins: [] }));

    // Assert
    expect(ctx).toBeDefined();
    expect(mocks.browserNewContext).toHaveBeenCalledOnce();
    const launchOpts = mocks.camoufoxLaunch.mock.calls[0]![0];
    expect(launchOpts.user_data_dir).toBeUndefined();
  });

  it('UTC-403: createContext reuses browser instance on subsequent calls (no relaunch)', async () => {
    // Act
    await factory.createContext('X');
    await factory.createContext('THREADS');

    // Assert — Camoufox launched only once (browser reused)
    expect(mocks.camoufoxLaunch).toHaveBeenCalledOnce();
    expect(mocks.browserNewContext).toHaveBeenCalledTimes(2);
  });

  // ── acquireContext / releaseContext (pool) ──

  it('UTC-404: acquireContext reuses idle context from pool', async () => {
    // Arrange — acquire then release to populate the idle pool
    const ctx1 = await factory.acquireContext('X');
    factory.releaseContext('X', ctx1);

    // Act — second acquire should reuse the idle context (no new context created)
    const ctx2 = await factory.acquireContext('X');

    // Assert
    expect(ctx2).toBe(ctx1);
    // browser.newContext called only once (first acquire), not again for reuse
    expect(mocks.browserNewContext).toHaveBeenCalledOnce();
  });

  it('UTC-405: acquireContext at capacity → waits → acquires when released', async () => {
    // Arrange — pool size is 2 (from config); fill both slots
    const ctx1 = await factory.acquireContext('X');
    const ctx2 = await factory.acquireContext('X');

    // Act — third acquire should wait; release ctx1 to unblock
    const acquirePromise = factory.acquireContext('X');
    // Release after a short tick to resolve the waiter
    setTimeout(() => factory.releaseContext('X', ctx1), 10);
    const ctx3 = await acquirePromise;

    // Assert — ctx3 should be the released ctx1 (handed directly to waiter)
    expect(ctx3).toBe(ctx1);
  });

  it('UTC-406: releaseContext returns context to idle pool', async () => {
    // Arrange
    const ctx = await factory.acquireContext('X');

    // Act
    factory.releaseContext('X', ctx);

    // Assert — next acquire reuses without creating new
    const reused = await factory.acquireContext('X');
    expect(reused).toBe(ctx);
    expect(mocks.browserNewContext).toHaveBeenCalledOnce();
  });

  it('UTC-406d: acquireContext re-applies storageState cookies to a reused idle context', async () => {
    // Arrange — acquire and release a context (no storageState), then re-acquire WITH
    // storageState. Regression for: the reuse path previously ignored the storageState
    // argument entirely (only createContext() applied it), so a caller passing a
    // freshly-saved session's cookies onto a reused context silently got the OLD
    // context's cookies instead — this is what let a health check see a brand-new
    // session as having no auth cookies and mark it EXPIRED.
    const ctx = await factory.acquireContext('X');
    factory.releaseContext('X', ctx);

    const storageState = JSON.stringify({
      cookies: [{ name: 'auth_token', value: 'fresh-token', domain: '.x.com', path: '/' }],
      origins: [],
    });
    const reused = await factory.acquireContext('X', storageState);

    expect(reused).toBe(ctx);
    expect(mocks.contextClearCookies).toHaveBeenCalledOnce();
    expect(mocks.contextAddCookies).toHaveBeenCalledWith([
      { name: 'auth_token', value: 'fresh-token', domain: '.x.com', path: '/' },
    ]);
  });

  it('UTC-406e: acquireContext skips cookie re-apply on reuse when no storageState is passed', async () => {
    const ctx = await factory.acquireContext('X');
    factory.releaseContext('X', ctx);

    const reused = await factory.acquireContext('X');

    expect(reused).toBe(ctx);
    expect(mocks.contextClearCookies).not.toHaveBeenCalled();
    expect(mocks.contextAddCookies).not.toHaveBeenCalled();
  });

  it('UTC-406b: acquireContext discards an idle context past the TTL and creates a fresh one', async () => {
    vi.useFakeTimers();
    try {
      mocks.browserNewContext
        .mockResolvedValueOnce(makeMockContext())
        .mockResolvedValueOnce(makeMockContext());

      const ctx1 = await factory.acquireContext('X');
      factory.releaseContext('X', ctx1);

      // Advance past the default 10-minute idle TTL
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      const ctx2 = await factory.acquireContext('X');

      expect(ctx2).not.toBe(ctx1);
      expect(mocks.contextClose).toHaveBeenCalledOnce(); // stale ctx1 was closed
      expect(mocks.browserNewContext).toHaveBeenCalledTimes(2); // fresh context created
    } finally {
      vi.useRealTimers();
    }
  });

  it('UTC-406c: sweepIdleContexts (private, invoked via timer) closes contexts past the TTL', async () => {
    vi.useFakeTimers();
    try {
      const ctx1 = await factory.acquireContext('X');
      factory.releaseContext('X', ctx1);

      factory.onModuleInit();
      vi.advanceTimersByTime(11 * 60 * 1000);

      expect(mocks.contextClose).toHaveBeenCalledOnce();
      expect((factory as any).idleContexts.get('X')).toEqual([]);

      await factory.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── saveStorageState ──

  it('UTC-407: saveStorageState → JSON string with cookies + origins', async () => {
    // Arrange
    const mockCtx = makeMockContext();
    mocks.contextStorageState.mockResolvedValue({
      cookies: [{ name: 'session', value: 'abc' }],
      origins: [{ origin: 'https://x.com', localStorage: [] }],
    });

    // Act
    const result = await factory.saveStorageState(mockCtx as never);

    // Assert
    const parsed = JSON.parse(result);
    expect(parsed.cookies).toHaveLength(1);
    expect(parsed.cookies[0].name).toBe('session');
    expect(parsed.origins).toHaveLength(1);
    expect(parsed.origins[0].origin).toBe('https://x.com');
  });

  // ── randomDelay ──

  it('UTC-408: randomDelay(100, 500) → resolves after a delay within range', async () => {
    // Arrange — use fake timers to observe the setTimeout delay
    vi.useFakeTimers();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // Act
    const p = factory.randomDelay(100, 500);
    // delay = floor(0.5 * (500-100)) + 100 = 300
    vi.advanceTimersByTime(300);
    await p;

    // Assert — no throw, delay was in range [100, 500)
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ── adaptiveDelay ──

  it('UTC-409: adaptiveDelay — slow page (loadEventEnd > 5s) → longer delay (15-45s range)', async () => {
    // Arrange
    const page = makeMockPage({ loadEventEnd: 8000, startTime: 0 }); // 8s → slow
    const delaySpy = vi.spyOn(factory, 'randomDelay').mockResolvedValue(undefined);

    // Act
    await factory.adaptiveDelay(page as never);

    // Assert — page.evaluate was called to read nav timing; slow → longer delay range
    expect((page as { evaluate: ReturnType<typeof vi.fn> }).evaluate).toHaveBeenCalled();
    expect(delaySpy).toHaveBeenCalledWith(15000, 45000);
  });

  it('UTC-410: adaptiveDelay — fast page → normal delay (5-20s range)', async () => {
    // Arrange
    const page = makeMockPage({ loadEventEnd: 1000, startTime: 0 }); // 1s → fast
    const delaySpy = vi.spyOn(factory, 'randomDelay').mockResolvedValue(undefined);

    // Act
    await factory.adaptiveDelay(page as never);

    // Assert — fast → normal delay range
    expect((page as { evaluate: ReturnType<typeof vi.fn> }).evaluate).toHaveBeenCalled();
    expect(delaySpy).toHaveBeenCalledWith(5000, 20000);
  });

  // ── humanType ──

  it('UTC-411: humanType → locator.pressSequentially with delay', async () => {
    // Arrange
    const locator = {
      focus: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      pressSequentially: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    // Act
    await factory.humanType(locator as never, 'hello', { delayMs: 30 });

    // Assert
    expect(locator.focus).toHaveBeenCalled();
    expect(locator.pressSequentially).toHaveBeenCalledWith('hello', expect.objectContaining({ delay: 30 }));
  });

  // ── typeHuman ──

  it('UTC-412: typeHuman → randomized 40-120ms delay + 5% thinking pauses', async () => {
    // Arrange — use fake timers so randomDelay resolves instantly
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const page = makeMockPage();
    const locator = { pressSequentially: vi.fn().mockResolvedValue(undefined) };
    // Force thinking pause (Math.random < 0.05)
    let call = 0;
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      call++;
      // First call (per-key delay) returns 0.5 → 80ms; second call (5% check) returns 0.01 → pause
      return call % 2 === 1 ? 0.5 : 0.01;
    });

    // Act — type "ab" (2 chars), each triggers a thinking pause
    const p = factory.typeHuman(page as never, 'ab', locator as never);
    // Advance timers to resolve all internal setTimeouts (randomDelay 200-600ms each)
    await vi.runAllTimersAsync();
    await p;

    // Assert — pressSequentially called once per character
    expect(locator.pressSequentially).toHaveBeenCalledTimes(2);
    expect(locator.pressSequentially).toHaveBeenNthCalledWith(1, 'a', expect.objectContaining({ delay: expect.any(Number) }));
    expect(locator.pressSequentially).toHaveBeenNthCalledWith(2, 'b', expect.objectContaining({ delay: expect.any(Number) }));
    spy.mockRestore();
  });

  // ── humanClick ──

  it('UTC-413: humanClick → normal click succeeds (no fallback)', async () => {
    // Arrange
    const locator = { click: vi.fn().mockResolvedValue(undefined) };

    // Act
    await factory.humanClick(locator as never);

    // Assert
    expect(locator.click).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15000 }));
    expect(locator.click).toHaveBeenCalledTimes(1);
  });

  it('UTC-414: humanClick → timeout → fallback force:true', async () => {
    // Arrange — first click throws a timeout error, second (force) succeeds
    const timeoutErr = new Error('Timeout 15000ms exceeded: click');
    const locator = {
      click: vi.fn()
        .mockRejectedValueOnce(timeoutErr)
        .mockResolvedValueOnce(undefined),
    };

    // Act
    await factory.humanClick(locator as never);

    // Assert — second call used force: true
    expect(locator.click).toHaveBeenCalledTimes(2);
    expect(locator.click).toHaveBeenNthCalledWith(2, expect.objectContaining({ force: true }));
  });

  // ── scrollPage ──

  it('UTC-415: scrollPage down 500px → mouse.wheel deltaY', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const page = makeMockPage();

    // Act
    const p = factory.scrollPage(page as never, 'down', 500);
    await vi.runAllTimersAsync();
    await p;

    // Assert
    expect((page as { mouse: { wheel: ReturnType<typeof vi.fn> } }).mouse.wheel).toHaveBeenCalledWith(0, 500);
  });

  // ── scrollToElement ──

  it('UTC-416: scrollToElement → locator.scrollIntoViewIfNeeded', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const locator = { scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined) };
    const page = makeMockPage();

    // Act
    const p = factory.scrollToElement(page as never, locator as never);
    await vi.runAllTimersAsync();
    await p;

    // Assert
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  // ── screenshot ──

  it('UTC-417: screenshot (enabled) → page.screenshot → write file → return path', async () => {
    // P7: screenshots are disabled by default — enable them to exercise the write path.
    const enabled = new BrowserFactory(
      createMockConfigService({ SPA_SCREENSHOTS: 'true', SPA_SCREENSHOT_FULLPAGE: 'true' }),
    );
    const page = makeMockPage();

    // Act
    const path = await enabled.screenshot(page as never, 'X', 'after-submit');

    // Assert
    expect(path).toContain('x');
    expect(path).toContain('after-submit');
    expect(path).toMatch(/\.png$/);
    expect((page as { screenshot: ReturnType<typeof vi.fn> }).screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true, path }),
    );
  });

  it('UTC-417b: screenshot is disabled by default → returns empty path, no write (P7 disk-leak guard)', async () => {
    const page = makeMockPage();

    const path = await factory.screenshot(page as never, 'X', 'after-submit');

    expect(path).toBe('');
    expect((page as { screenshot: ReturnType<typeof vi.fn> }).screenshot).not.toHaveBeenCalled();
  });

  // ── dismissDialogs ──

  it('UTC-418: dismissDialogs → cookie consent dialog dismissed', async () => {
    // Arrange — a locator for "Accept all" is visible and clickable
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const visibleLocator = {
      first: vi.fn().mockReturnThis(),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      locator: vi.fn().mockReturnValue(visibleLocator),
    };

    // Act
    const p = factory.dismissDialogs(page as never);
    await vi.runAllTimersAsync();
    await p;

    // Assert — at least one selector was clicked (cookie consent)
    expect(page.locator).toHaveBeenCalled();
    expect(visibleLocator.click).toHaveBeenCalled();
  });
});
