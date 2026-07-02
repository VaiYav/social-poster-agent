/**
 * MOD-03: Posting Engine Module — Poster class unit tests.
 *
 * Tests the individual poster classes (XPoster, ThreadsPoster, FacebookPoster)
 * that extend BasePoster and use multi-fallback selectors.
 *
 * Source files:
 *   - packages/backend/src/modules/posting/posters/base.poster.ts
 *   - packages/backend/src/modules/posting/posters/x.poster.ts
 *   - packages/backend/src/modules/posting/posters/threads.poster.ts
 *   - packages/backend/src/modules/posting/posters/facebook.poster.ts
 *
 * Mocked dependencies:
 *   - IBrowserPort (humanType, humanClick, screenshot, randomDelay, etc.)
 *   - Playwright BrowserContext + Page (via mock factories)
 *   - ConfigService (FacebookPoster page slug)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';

import { XPoster } from '../../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../../src/modules/posting/posters/facebook.poster';
import { SelectorNotFoundError } from '../../../src/domain/errors';
import {
  createMockBrowserPort,
  createMockPage,
  createMockContext,
} from '../../mocks/index';

/** ConfigService mock: returns values from a key→value map, else default. */
function createMockConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string, def?: string) => {
      if (key in values) return values[key];
      return def;
    }),
  } as unknown as ConfigService;
}

// ── XPoster Tests ────────────────────────────────────────────────────────────

describe('MOD-03: XPoster (BasePoster architecture)', () => {
  let poster: XPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    browserPort = createMockBrowserPort();
    poster = new XPoster(browserPort as unknown);
  });

  it('UTC-057: XPoster.post() navigates to compose, types content, captures post URL', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello from X!');

    // Navigated to compose page — X uses domcontentloaded (never reaches networkidle)
    expect(page.goto).toHaveBeenCalledWith('https://x.com/compose/post', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // URL matches /status/\d+/
    expect(result.url).toBe('https://x.com/myzodiacai/status/1234567890');
    expect(result.error).toBeUndefined();

    // Page closed in finally
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('BUG-6: postThreadReplies posts every reply and returns a per-reply result', async () => {
    const page = createMockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const postReplySpy = vi.spyOn(poster as any, 'postReply').mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (poster as any).postThreadReplies(page, 'https://x.com/u/status/1', ['r1', 'r2', 'r3']);

    expect(postReplySpy).toHaveBeenCalledTimes(3);
    expect(postReplySpy).toHaveBeenNthCalledWith(1, page, 'https://x.com/u/status/1', 'r1');
    expect(postReplySpy).toHaveBeenNthCalledWith(3, page, 'https://x.com/u/status/1', 'r3');
    expect(results).toEqual([
      { index: 0, success: true },
      { index: 1, success: true },
      { index: 2, success: true },
    ]);
  });

  it('BUG-6: home-page fallback posts the thread replies too (no silent content loss)', async () => {
    // Primary Post button never visible → post() takes the home-page fallback path.
    const page = createMockPage({ url: 'https://x.com/u/status/root' });
    page._locator.isVisible.mockResolvedValue(false);
    const context = createMockContext(page as unknown);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fbStub = vi.spyOn(poster as any, 'postViaHomePageCompose').mockResolvedValue({ url: 'https://x.com/u/status/root' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replyStub = vi.spyOn(poster as any, 'postThreadReplies').mockResolvedValue([
      { index: 0, success: true },
      { index: 1, success: true },
    ]);

    const result = await poster.post(context as unknown, browserPort as unknown, 'root tweet', ['reply A', 'reply B']);

    expect(fbStub).toHaveBeenCalledTimes(1);
    // The regression: the fallback used to return after the root only, dropping every reply.
    expect(replyStub).toHaveBeenCalledWith(page, 'https://x.com/u/status/root', ['reply A', 'reply B']);
    expect(result.url).toBe('https://x.com/u/status/root');
    expect(result.threadReplyResults).toHaveLength(2);
  });

  it('UTC-057: XPoster.post() returns error when redirected to login (session expired)', async () => {
    const page = createMockPage({
      url: 'https://x.com/i/flow/login',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    expect(result.error).toContain('Not logged in');
    expect(result.url).toBeUndefined();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-057: XPoster.post() returns error when URL does not match post URL pattern', async () => {
    const page = createMockPage({
      url: 'https://x.com/home',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    // URL doesn't match /\/status\/\d+/, and profile validation fails (mock page has
    // empty body text). No false-positive "likely success" — fail honestly.
    expect(result.error).toBeDefined();
    expect(result.url).toBeUndefined();
  });

  it('UTC-057: XPoster.post() applies human-like delays via browserPort.randomDelay', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    // randomDelay should be called multiple times for human-like behavior
    expect(browserPort.randomDelay).toHaveBeenCalled();
  });

  it('UTC-057: XPoster.post() uses fill() for typing content (twitter-mcp approach)', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    // X poster uses fill() for contenteditable input (not humanType — avoids typeahead timeout)
    // Reference: twitter-mcp approach
    expect(page.locator).toHaveBeenCalled();
  });

  it('UTC-057: XPoster.post() captures screenshots at multiple phases', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    // screenshot should be called for before-compose, after-type, after-submit
    expect(browserPort.screenshot).toHaveBeenCalled();
  });
});

// ── ThreadsPoster Tests ──────────────────────────────────────────────────────

describe('MOD-03: ThreadsPoster (BasePoster architecture)', () => {
  let poster: ThreadsPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    browserPort = createMockBrowserPort();
    poster = new ThreadsPoster(browserPort as unknown);
  });

  it('UTC-058: ThreadsPoster.post() navigates to threads.net, types, submits, captures URL', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello from Threads!');

    // Navigated to threads.com (not threads.net — updated URL)
    expect(page.goto).toHaveBeenCalledWith('https://www.threads.com/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Captured URL
    expect(result.url).toBe('https://www.threads.com/@myzodiacai/post/abc123');
    expect(result.error).toBeUndefined();

    // Page closed in finally
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('BUG-6 (Threads): postThreadReplies posts every reply and returns a per-reply result', async () => {
    const page = createMockPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const postReplySpy = vi.spyOn(poster as any, 'postReply').mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (poster as any).postThreadReplies(page, 'https://www.threads.com/@u/post/1', ['r1', 'r2']);

    expect(postReplySpy).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { index: 0, success: true },
      { index: 1, success: true },
    ]);
  });

  it('BUG-6 (Threads): degraded "cannot validate" path still posts thread replies (no silent loss)', async () => {
    // URL doesn't match the post pattern and isn't the home URL → unknown-state branch.
    const page = createMockPage({ url: 'https://www.threads.com/t/degraded' });
    const context = createMockContext(page as unknown);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(poster as any, 'extractProfileUrl').mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replyStub = vi.spyOn(poster as any, 'postThreadReplies').mockResolvedValue([{ index: 0, success: true }]);

    const result = await poster.post(context as unknown, browserPort as unknown, 'root', ['reply A']);

    expect(replyStub).toHaveBeenCalledWith(page, 'https://www.threads.com/t/degraded', ['reply A']);
    expect(result.threadReplyResults).toHaveLength(1);
  });

  it('UTC-058: ThreadsPoster.post() returns error when redirected to login', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/auth',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    expect(result.error).toContain('Not logged in');
    expect(result.url).toBeUndefined();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-058: ThreadsPoster.post() uses typeHuman for typing content (stealth typing)', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    // typeHuman is the stealth typing method (randomized per-key delay + thinking pauses)
    expect(browserPort.typeHuman).toHaveBeenCalled();
  });

  it('UTC-058: ThreadsPoster.post() captures screenshots at multiple phases', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    expect(browserPort.screenshot).toHaveBeenCalled();
  });
});

// ── FacebookPoster Tests ─────────────────────────────────────────────────────

describe('MOD-03: FacebookPoster (BasePoster architecture)', () => {
  let poster: FacebookPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;
  let mockConfigService: ConfigService;

  function buildFacebookPoster(configValues: Record<string, string> = {}) {
    browserPort = createMockBrowserPort();
    mockConfigService = createMockConfigService(configValues);
    return new FacebookPoster(browserPort as unknown, mockConfigService);
  }

  it('UTC-059: FacebookPoster.post() returns error when SOCIAL_FACEBOOK_PAGE_SLUG not configured', async () => {
    poster = buildFacebookPoster({});

    const page = createMockPage();
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello from FB!');

    expect(result.error).toContain('SOCIAL_FACEBOOK_PAGE_SLUG not configured');
    expect(result.url).toBeUndefined();
    // Browser not even opened (page NOT created)
    expect(context.newPage).not.toHaveBeenCalled();
  });

  it('UTC-059: FacebookPoster.post() navigates to business page, types, publishes, captures URL', async () => {
    poster = buildFacebookPoster({ SOCIAL_FACEBOOK_PAGE_SLUG: 'myzodiacai' });

    const page = createMockPage({
      url: 'https://www.facebook.com/myzodiacai/posts/123456',
      bodyText: 'Hello from Facebook!',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello from Facebook!');

    // Navigated to business page
    expect(page.goto).toHaveBeenCalledWith('https://www.facebook.com/myzodiacai/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Captured URL
    expect(result.url).toBe('https://www.facebook.com/myzodiacai/posts/123456');
    expect(result.error).toBeUndefined();

    // Page closed in finally
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-059: FacebookPoster.post() returns error when redirected to login', async () => {
    poster = buildFacebookPoster({ SOCIAL_FACEBOOK_PAGE_SLUG: 'myzodiacai' });

    const page = createMockPage({
      url: 'https://www.facebook.com/login.php',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    expect(result.error).toContain('Not logged in');
    expect(result.url).toBeUndefined();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-059: FacebookPoster.post() uses humanType for typing content', async () => {
    poster = buildFacebookPoster({ SOCIAL_FACEBOOK_PAGE_SLUG: 'myzodiacai' });

    const page = createMockPage({
      url: 'https://www.facebook.com/myzodiacai/posts/123456',
      bodyText: 'Hello!',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    expect(browserPort.humanType).toHaveBeenCalled();
  });

  it('UTC-059: FacebookPoster.getPageSlug() returns configured slug', () => {
    poster = buildFacebookPoster({ SOCIAL_FACEBOOK_PAGE_SLUG: 'myzodiacai' });
    expect(poster.getPageSlug()).toBe('myzodiacai');
  });

  it('UTC-059: FacebookPoster.getPageUrl() returns full URL', () => {
    poster = buildFacebookPoster({ SOCIAL_FACEBOOK_PAGE_SLUG: 'myzodiacai' });
    expect(poster.getPageUrl()).toBe('https://www.facebook.com/myzodiacai/');
  });
});

// ── XPoster Extended Tests ──────────────────────────────────────────────────

describe('MOD-03: XPoster (extended posting flow)', () => {
  let poster: XPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    browserPort = createMockBrowserPort();
    poster = new XPoster(browserPort as unknown);
  });

  it('UTC-060: XPoster.post() single tweet — navigates to /compose/post, types content, validates URL', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello from X!');

    // Navigated to compose page with domcontentloaded
    expect(page.goto).toHaveBeenCalledWith('https://x.com/compose/post', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // typeHuman was called for stealth typing
    expect(browserPort.typeHuman).toHaveBeenCalled();
    // Result has valid URL
    expect(result.url).toBe('https://x.com/myzodiacai/status/1234567890');
    expect(result.error).toBeUndefined();
  });

  it('UTC-061: XPoster.post() thread — root + 2 replies → threadReplyResults populated', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(
      context as unknown,
      browserPort as unknown,
      'Root tweet',
      ['Reply 1 content', 'Reply 2 content'],
    );

    // Root post URL captured
    expect(result.url).toBe('https://x.com/myzodiacai/status/1234567890');
    // Thread reply results populated (2 replies)
    expect(result.threadReplyResults).toBeDefined();
    expect(result.threadReplyResults).toHaveLength(2);
    // Both replies attempted
    expect(result.threadReplyResults![0].index).toBe(0);
    expect(result.threadReplyResults![1].index).toBe(1);
  });

  it('UTC-062: XPoster.post() fallback to home page compose when /compose/post button not visible', async () => {
    // Simulate: compose page loads but post button not visible
    // The poster falls back to home page compose dialog
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/9999999999',
    });
    // Make isVisible return false for post button to trigger fallback
    (page._locator as any).isVisible = vi.fn().mockResolvedValue(false);
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Fallback test!');

    // Should have navigated to home page as fallback
    const homeGotoCalls = (page.goto as any).mock.calls.filter(
      (c: unknown[]) => c[0] === 'https://x.com/home',
    );
    expect(homeGotoCalls.length).toBeGreaterThan(0);
    // Result should still have a URL (from the mock page URL)
    expect(result.url).toBeDefined();
  });

  it('UTC-063: XPoster.post() uses Cmd+Enter shortcut when humanClick fails', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    // Make humanClick throw to trigger Cmd+Enter fallback
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('click timeout'));
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Cmd+Enter test!');

    // keyboard.press called with Meta+Enter and Control+Enter
    const pressCalls = (page.keyboard.press as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(pressCalls).toContain('Meta+Enter');
    expect(pressCalls).toContain('Control+Enter');
  });

  it('UTC-064: XPoster.post() detects shadowban and returns error (AccountRestrictedError)', async () => {
    const page = createMockPage({
      url: 'https://x.com/compose/post',
      bodyText: 'Your account is temporarily limited',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Shadowbanned!');

    // detectShadowban throws AccountRestrictedError, caught by withErrorHandling
    expect(result.error).toBeDefined();
    expect(result.url).toBeUndefined();
  });

  it('UTC-065: XPoster.post() returns session_expired error when isOnLoginPage is true', async () => {
    const page = createMockPage({
      url: 'https://x.com/i/flow/login',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Session expired!');

    expect(result.error).toContain('Not logged in');
    expect(result.error).toContain('session expired');
    expect(result.url).toBeUndefined();
  });
});

// ── ThreadsPoster Extended Tests ─────────────────────────────────────────────

describe('MOD-03: ThreadsPoster (extended posting flow)', () => {
  let poster: ThreadsPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    browserPort = createMockBrowserPort();
    poster = new ThreadsPoster(browserPort as unknown);
  });

  it('UTC-066: ThreadsPoster.post() opens compose dialog via button click', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello Threads!');

    // Navigated to threads.com home
    expect(page.goto).toHaveBeenCalledWith('https://www.threads.com/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    // humanClick called for compose button
    expect(browserPort.humanClick).toHaveBeenCalled();
    // typeHuman called for stealth typing
    expect(browserPort.typeHuman).toHaveBeenCalled();
    // Result has valid URL
    expect(result.url).toBe('https://www.threads.com/@myzodiacai/post/abc123');
    expect(result.error).toBeUndefined();
  });

  it('UTC-067: ThreadsPoster.post() fallback to /compose URL when compose button not found', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as unknown);
    // Mock resolve to throw only on first call (compose button) — triggers fallback
    // Subsequent calls (textarea, submit) use real implementation
    vi.spyOn(poster as any, 'resolve').mockRejectedValueOnce(
      new SelectorNotFoundError('THREADS', 'compose button'),
    );

    const result = await poster.post(context as unknown, browserPort as unknown, 'Fallback!');

    // Should have navigated to /compose URL as fallback
    const composeGotoCalls = (page.goto as any).mock.calls.filter(
      (c: unknown[]) => c[0] === 'https://www.threads.com/compose',
    );
    expect(composeGotoCalls.length).toBeGreaterThan(0);
    // Result should still have a URL
    expect(result.url).toBeDefined();
  });

  it('UTC-068: ThreadsPoster.post() thread — root + 2 replies → threadReplyResults populated', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(
      context as unknown,
      browserPort as unknown,
      'Root thread post',
      ['Reply 1', 'Reply 2'],
    );

    // Root post URL captured
    expect(result.url).toBe('https://www.threads.com/@myzodiacai/post/abc123');
    // Thread reply results populated
    expect(result.threadReplyResults).toBeDefined();
    expect(result.threadReplyResults).toHaveLength(2);
  });

  it('UTC-069: ThreadsPoster.post() extracts profile URL for validation when post URL not immediate', async () => {
    // When URL doesn't match postUrlPattern, poster tries to extract profile URL
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/validated123',
      bodyText: 'Content that was posted',
    });
    // Make the locator return a profile href for extractProfileUrl
    (page._locator as any).getAttribute = vi.fn().mockResolvedValue('/@myzodiacai');
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Content that was posted');

    // Should have a valid result (either from post URL or profile validation)
    expect(result.url).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('UTC-070: ThreadsPoster.post() validates content on profile page and returns url', async () => {
    // When post URL doesn't match pattern, poster validates on profile
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai',
      bodyText: 'Profile page with the posted content visible here',
    });
    // extractProfileUrl returns a profile URL
    (page._locator as any).getAttribute = vi.fn().mockResolvedValue('/@myzodiacai');
    const context = createMockContext(page as unknown);

    const result = await poster.post(
      context as unknown,
      browserPort as unknown,
      'Profile page with the posted content visible here',
    );

    // Content found on profile → returns URL
    expect(result.url).toBeDefined();
    expect(result.error).toBeUndefined();
  });
});
