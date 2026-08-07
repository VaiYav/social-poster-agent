/**
 * MOD-03b: Bluesky Poster unit tests (P2-01).
 *
 * Tests:
 *   BP-001: post() rejects content over 300 chars
 *   BP-002: post() logs in when session expired, then publishes and extracts URL
 *   BP-003: post() falls back to page.url() when extract returns null
 *   BP-004: post() returns error when publish fails (act click returns false)
 *   BP-005: verifyPosted() returns the post URL from the profile page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlueskyPoster } from '../../../src/modules/posting/posters/bluesky.poster.js';
import {
  createMockBrowserPort,
  createMockConfigService,
  createMockContext,
  createMockPage,
} from '../../mocks/index.js';
import type { IBrowserPort } from '../../../src/domain/ports/browser.port.js';
import type { ConfigService } from '@nestjs/config';

type MockBrowser = ReturnType<typeof createMockBrowserPort>;

function buildPoster(browser: MockBrowser, config: ConfigService): BlueskyPoster {
  // BlueskyPoster only uses browser and config services; context is passed in.
  return new BlueskyPoster(browser as unknown as IBrowserPort, config);
}

describe('BlueskyPoster (P2-01)', () => {
  const BLUESKY_URL = 'https://bsky.app/profile/handle.bsky.social/post/3k2jexample';

  let browser: MockBrowser;
  let config: ConfigService;

  beforeEach(() => {
    browser = createMockBrowserPort();
    config = createMockConfigService({
      BLUESKY_HANDLE: 'handle.bsky.social',
      BLUESKY_APP_PASSWORD: 'app-password-123',
    });
  });

  it('BP-001: post() rejects content over 300 chars', async () => {
    const poster = buildPoster(browser, config);
    const content = 'a'.repeat(301);
    const context = createMockContext(createMockPage());

    const result = await poster.post(context, browser as unknown as IBrowserPort, content);

    expect(result.success).toBeUndefined();
    expect(result.error).toContain('exceeds Bluesky limit');
    expect(result.url).toBeUndefined();
  });

  it('BP-002: post() logs in when session expired, then publishes', async () => {
    const poster = buildPoster(browser, config);
    const page = createMockPage({
      url: BLUESKY_URL,
      urlSequence: [
        'https://bsky.app/login',        // 1. first navigate lands on login
        BLUESKY_URL,                     // 2. login check after submit (not /login)
        BLUESKY_URL,                     // 3. re-navigated to compose check (not /login)
        BLUESKY_URL,                     // 4. detectShadowban / other page.url() call
        BLUESKY_URL,                     // 5. safety margin
        BLUESKY_URL,                     // 6. final post URL
      ],
    });
    const context = createMockContext(page);

    const result = await poster.post(context, browser as unknown as IBrowserPort, 'Hello Bluesky!');

    expect(result.url).toBe(BLUESKY_URL);
    expect(result.error).toBeUndefined();

    // Login flow filled handle and app password then clicked submit.
    expect(page._locator.fill).toHaveBeenCalledWith('handle.bsky.social');
    expect(page._locator.fill).toHaveBeenCalledWith('app-password-123');
    expect(page._locator.click).toHaveBeenCalled();

    // After login we navigated back to /compose/post.
    expect(page.goto).toHaveBeenCalledWith('https://bsky.app/compose/post', expect.any(Object));
  });

  it('BP-003: post() falls back to page.url() when extract returns null', async () => {
    const poster = buildPoster(browser, config);
    const page = createMockPage({
      url: BLUESKY_URL,
      urlSequence: [
        'https://bsky.app/compose/post', // 1. isOnLoginPage
        'https://bsky.app/compose/post', // 2. detectShadowban
        BLUESKY_URL,                     // 3. final post URL (safety margin)
        BLUESKY_URL,
      ],
    });
    const context = createMockContext(page);

    // extract returns null so the poster should fall back to page.url().
    browser.extract = vi.fn().mockResolvedValue(null);

    const result = await poster.post(context, browser as unknown as IBrowserPort, 'Fallback test');

    expect(result.url).toBe(BLUESKY_URL);
  });

  it('BP-004: post() returns error when publishing fails', async () => {
    const poster = buildPoster(browser, config);
    const page = createMockPage({
      url: 'https://bsky.app/compose/post',
      urlSequence: ['https://bsky.app/compose/post', 'https://bsky.app/compose/post'],
    });
    const context = createMockContext(page);

    // Type succeeds, but the Post button click fails.
    browser.act = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
      success: false,
      error: 'Post button not found',
    });

    const result = await poster.post(context, browser as unknown as IBrowserPort, 'Will fail');

    expect(result.url).toBeUndefined();
    expect(result.error).toContain('Failed to submit Bluesky post');
    expect(result.retryable).toBe(true);
  });

  it('BP-005: verifyPosted() returns the post URL from profile page', async () => {
    const poster = buildPoster(browser, config);
    const page = createMockPage({
      urlSequence: ['https://bsky.app/profile/handle.bsky.social'],
    });
    const context = createMockContext(page);

    browser.extract = vi.fn().mockResolvedValue({ postUrl: BLUESKY_URL });

    const url = await poster.verifyPosted(context, 'Hello Bluesky!');

    expect(url).toBe(BLUESKY_URL);
    expect(page.goto).toHaveBeenCalledWith(
      'https://bsky.app/profile/handle.bsky.social',
      expect.any(Object),
    );
  });

  it('BP-006: verifyPosted() returns null when profile has no matching post', async () => {
    const poster = buildPoster(browser, config);
    const page = createMockPage({
      urlSequence: ['https://bsky.app/profile/handle.bsky.social'],
    });
    const context = createMockContext(page);

    browser.extract = vi.fn().mockResolvedValue(null);

    const url = await poster.verifyPosted(context, 'Not found');

    expect(url).toBeNull();
  });
});
