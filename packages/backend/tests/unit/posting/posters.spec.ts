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
    poster = new XPoster(browserPort as any);
  });

  it('UTC-057: XPoster.post() navigates to compose, types content, captures post URL', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello from X!');

    // Navigated to compose page
    expect(page.goto).toHaveBeenCalledWith('https://x.com/compose/post', {
      waitUntil: 'networkidle',
    });

    // URL matches /status/\d+/
    expect(result.url).toBe('https://x.com/myzodiacai/status/1234567890');
    expect(result.error).toBeUndefined();

    // Page closed in finally
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-057: XPoster.post() returns error when redirected to login (session expired)', async () => {
    const page = createMockPage({
      url: 'https://x.com/i/flow/login',
    });
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello!');

    expect(result.error).toContain('Not logged in');
    expect(result.url).toBeUndefined();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-057: XPoster.post() returns error when URL does not match post URL pattern', async () => {
    const page = createMockPage({
      url: 'https://x.com/home',
    });
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello!');

    // URL doesn't match /\/status\/\d+/, so validation fails
    expect(result.error).toBeDefined();
    expect(result.url).toBeUndefined();
  });

  it('UTC-057: XPoster.post() applies human-like delays via browserPort.randomDelay', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as any);

    await poster.post(context as any, browserPort as any, 'Hello!');

    // randomDelay should be called multiple times for human-like behavior
    expect(browserPort.randomDelay).toHaveBeenCalled();
  });

  it('UTC-057: XPoster.post() uses humanType for typing content', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as any);

    await poster.post(context as any, browserPort as any, 'Hello!');

    // humanType should be called (BasePoster uses it instead of keyboard.type)
    expect(browserPort.humanType).toHaveBeenCalled();
  });

  it('UTC-057: XPoster.post() captures screenshots at multiple phases', async () => {
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as any);

    await poster.post(context as any, browserPort as any, 'Hello!');

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
    poster = new ThreadsPoster(browserPort as any);
  });

  it('UTC-058: ThreadsPoster.post() navigates to threads.net, types, submits, captures URL', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello from Threads!');

    // Navigated to threads.com (not threads.net — updated URL)
    expect(page.goto).toHaveBeenCalledWith('https://www.threads.com/', {
      waitUntil: 'networkidle',
    });

    // Captured URL
    expect(result.url).toBe('https://www.threads.com/@myzodiacai/post/abc123');
    expect(result.error).toBeUndefined();

    // Page closed in finally
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-058: ThreadsPoster.post() returns error when redirected to login', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/auth',
    });
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello!');

    expect(result.error).toContain('Not logged in');
    expect(result.url).toBeUndefined();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('UTC-058: ThreadsPoster.post() uses humanType for typing content', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as any);

    await poster.post(context as any, browserPort as any, 'Hello!');

    expect(browserPort.humanType).toHaveBeenCalled();
  });

  it('UTC-058: ThreadsPoster.post() captures screenshots at multiple phases', async () => {
    const page = createMockPage({
      url: 'https://www.threads.com/@myzodiacai/post/abc123',
    });
    const context = createMockContext(page as any);

    await poster.post(context as any, browserPort as any, 'Hello!');

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
    return new FacebookPoster(browserPort as any, mockConfigService);
  }

  it('UTC-059: FacebookPoster.post() returns error when SOCIAL_FACEBOOK_PAGE_SLUG not configured', async () => {
    poster = buildFacebookPoster({});

    const page = createMockPage();
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello from FB!');

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
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello from Facebook!');

    // Navigated to business page
    expect(page.goto).toHaveBeenCalledWith('https://www.facebook.com/myzodiacai/', {
      waitUntil: 'networkidle',
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
    const context = createMockContext(page as any);

    const result = await poster.post(context as any, browserPort as any, 'Hello!');

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
    const context = createMockContext(page as any);

    await poster.post(context as any, browserPort as any, 'Hello!');

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
