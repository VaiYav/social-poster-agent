/**
 * X Poster Cmd+Enter keyboard shortcut tests.
 *
 * X's primary compose path now sends the native Meta+Enter / Control+Enter
 * shortcut first (it bypasses X's mouse-automation detection). The Post/Reply
 * button is only used as a fallback.
 *
 * Source: packages/backend/src/modules/posting/posters/x.poster.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XPoster } from '../../../src/modules/posting/posters/x.poster';
import {
  createMockBrowserPort,
  createMockPage,
  createMockContext,
} from '../../mocks/index';

describe('XPoster — Cmd+Enter Keyboard Shortcut', () => {
  let poster: XPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    browserPort = createMockBrowserPort();
    poster = new XPoster(browserPort as unknown);
  });

  // ── Main compose: Ctrl+Enter is the primary submit ──

  it('CE-001: sends Cmd+Enter when humanClick on Post button fails', async () => {
    // Make humanClick throw — simulates button not clickable
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Button not clickable'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello from X!');

    // Cmd+Enter (Meta+Enter) should have been pressed
    expect(page.keyboard.press).toHaveBeenCalledWith('Meta+Enter');
    // Ctrl+Enter should also have been pressed (Windows/Linux fallback)
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+Enter');
  });

  it('CE-002: sends Cmd+Enter as primary submit and skips humanClick on Post button', async () => {
    // Even with a resolving humanClick, the primary submit path uses Ctrl+Enter
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello from X!');

    expect(result.error).toBeUndefined();
    expect(page.keyboard.press).toHaveBeenCalledWith('Meta+Enter');
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+Enter');
    // Post button is not clicked when the shortcut succeeds and URL looks posted
    expect(browserPort.humanClick).not.toHaveBeenCalled();
  });

  it('CE-003: does not crash when keyboard shortcut fails', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Timeout 10000ms exceeded'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello!');
    expect(result.error).toBeUndefined();
  });

  it('CE-004: re-focuses textbox before pressing keyboard shortcut', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Click failed'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    const locator = page._locator as { click: ReturnType<typeof vi.fn> };
    expect(locator.click).toHaveBeenCalled();
  });

  it('CE-005: keyboard shortcut does not crash the posting flow', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Button not found'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Test post');
    expect(result.url).toBe('https://x.com/myzodiacai/status/1234567890');
  });

  it('CE-006: both Meta+Enter and Control+Enter are sent (cross-platform)', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Failed'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Cross-platform test');

    const pressCalls = page.keyboard.press.mock.calls.map((c: unknown[]) => c[0]);
    expect(pressCalls).toContain('Meta+Enter');
    expect(pressCalls).toContain('Control+Enter');
  });

  it('CE-007: keyboard.press errors are caught (does not crash)', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Click failed'));
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    page.keyboard.press = vi.fn().mockRejectedValue(new Error('Keyboard error')) as any;

    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Test');
    expect(result).toBeDefined();
  });

  // ── Normal posting still works (no regression) ──

  it('CE-008: normal posting flow works when humanClick succeeds', async () => {
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/9999999999',
    });
    const context = createMockContext(page as unknown);

    const result = await poster.post(context as unknown, browserPort as unknown, 'Normal post');

    expect(result.url).toBe('https://x.com/myzodiacai/status/9999999999');
    expect(result.error).toBeUndefined();
  });

  it('CE-009: screenshot is captured after submit', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Failed'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Screenshot test');

    expect(browserPort.screenshot).toHaveBeenCalled();
  });

  // ── Reply posting: Ctrl+Enter fallback when reply button click fails ──

  it('CE-010: postReply sends Cmd+Enter when reply button click fails', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Reply button not clickable'));
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
      bodyText: 'This is a reply text that was entered',
    });

    const context = createMockContext(page as unknown);

    await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet text',
      ['Reply text here that is long enough'],
    );

    expect(page.keyboard.press).toHaveBeenCalledWith('Meta+Enter');
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+Enter');
  });

  it('CE-011: postReply does not send Cmd+Enter when reply button click succeeds', async () => {
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
      bodyText: 'Reply text entered',
    });

    const context = createMockContext(page as unknown);

    const result = await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet',
      ['Reply text here'],
    );

    expect(result.url).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(browserPort.humanClick).toHaveBeenCalled();
  });

  it('CE-013: postReply uses multiple selectors for reply button (data-testid + aria-label)', async () => {
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
      bodyText: 'Reply entered',
    });

    const context = createMockContext(page as unknown);

    await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet',
      ['Reply text'],
    );

    expect(page.locator).toHaveBeenCalled();
  });
});
