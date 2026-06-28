/**
 * X Poster Cmd+Enter fallback unit tests.
 *
 * Tests the keyboard shortcut fallback that triggers when the Post/Reply
 * button click fails. This is the native X shortcut — works even when
 * the button is not clickable due to DraftJS state issues, overlay
 * blocking, or UI changes.
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

describe('XPoster — Cmd+Enter Keyboard Shortcut Fallback', () => {
  let poster: XPoster;
  let browserPort: ReturnType<typeof createMockBrowserPort>;

  beforeEach(() => {
    browserPort = createMockBrowserPort();
    poster = new XPoster(browserPort as unknown);
  });

  // ── Main compose: Cmd+Enter fallback when humanClick fails ──

  it('CE-001: sends Cmd+Enter when humanClick on Post button fails', async () => {
    // Make humanClick throw — simulates button not clickable
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Button not clickable'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello from X!');

    // Cmd+Enter (Meta+Enter) should have been pressed as fallback
    expect(page.keyboard.press).toHaveBeenCalledWith('Meta+Enter');
    // Ctrl+Enter should also have been pressed (Windows/Linux fallback)
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+Enter');
  });

  it('CE-002: does NOT send Cmd+Enter when humanClick succeeds', async () => {
    // humanClick succeeds (default mock resolves)
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello from X!');

    // Cmd+Enter should NOT have been pressed — button click worked
    expect(page.keyboard.press).not.toHaveBeenCalledWith('Meta+Enter');
    expect(page.keyboard.press).not.toHaveBeenCalledWith('Control+Enter');
  });

  it('CE-003: does not crash when humanClick fails before Cmd+Enter fallback', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Timeout 10000ms exceeded'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    // Should not throw — the error is caught and fallback is attempted
    const result = await poster.post(context as unknown, browserPort as unknown, 'Hello!');
    expect(result.error).toBeUndefined();
  });

  it('CE-004: Cmd+Enter fallback re-focuses textbox before pressing', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Click failed'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Hello!');

    // The mock locator's click should have been called for re-focus
    // (textbox.click is called before keyboard.press in the fallback)
    const locator = page._locator as { click: ReturnType<typeof vi.fn> };
    expect(locator.click).toHaveBeenCalled();
  });

  it('CE-005: Cmd+Enter fallback does not crash the posting flow', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Button not found'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    // Should complete without throwing
    const result = await poster.post(context as unknown, browserPort as unknown, 'Test post');
    // The post should still be considered posted (URL matches pattern)
    expect(result.url).toBe('https://x.com/myzodiacai/status/1234567890');
  });

  it('CE-006: both Meta+Enter and Control+Enter are sent (cross-platform)', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Failed'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Cross-platform test');

    // Both shortcuts should be sent to cover Mac (Meta) and Windows/Linux (Control)
    const pressCalls = page.keyboard.press.mock.calls.map((c: unknown[]) => c[0]);
    expect(pressCalls).toContain('Meta+Enter');
    expect(pressCalls).toContain('Control+Enter');
  });

  it('CE-007: keyboard.press errors are caught (does not crash)', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Click failed'));
    // Make keyboard.press also fail
    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    page.keyboard.press = vi.fn().mockRejectedValue(new Error('Keyboard error')) as any;

    const context = createMockContext(page as unknown);

    // Should not throw even if keyboard.press fails
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

  it('CE-009: screenshot is captured after submit (even with fallback)', async () => {
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Failed'));

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
    });
    const context = createMockContext(page as unknown);

    await poster.post(context as unknown, browserPort as unknown, 'Screenshot test');

    // Screenshot should still be called after the fallback
    expect(browserPort.screenshot).toHaveBeenCalled();
  });

  // ── Reply posting: Cmd+Enter fallback ──

  it('CE-010: postReply sends Cmd+Enter when reply button click fails', async () => {
    // postReply is called internally by post() when threadItems are provided
    browserPort.humanClick = vi.fn().mockRejectedValue(new Error('Reply button not clickable'));
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
      bodyText: 'This is a reply text that was entered',
    });
    // Make innerText return enough text so the "text not entered" check passes
    const locator = page._locator as { innerText: ReturnType<typeof vi.fn> };
    locator.innerText = vi.fn().mockResolvedValue('This is a reply text that was entered');

    const context = createMockContext(page as unknown);

    // post() with threadItems triggers postReply internally
    await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet text',
      ['Reply text here that is long enough'],
    );

    // The reply flow should have attempted keyboard shortcut
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
    const locator = page._locator as { innerText: ReturnType<typeof vi.fn> };
    locator.innerText = vi.fn().mockResolvedValue('Reply text entered');

    const context = createMockContext(page as unknown);

    await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet',
      ['Reply text here'],
    );

    // Cmd+Enter should NOT be sent for reply — button click worked
    // Note: Meta+Enter may have been called for the main tweet if its humanClick
    // also failed, but with default mock humanClick resolves, so it shouldn't fire.
    // We check that keyboard.press was NOT called with Meta+Enter at all.
    const pressCalls = page.keyboard.press.mock.calls.map((c: unknown[]) => c[0]);
    expect(pressCalls).not.toContain('Meta+Enter');
  });

  it('CE-012: postReply falls back to keyboard.type when typeHuman fails to enter text', async () => {
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);
    // typeHuman succeeds but doesn't enter text (innerText returns empty)
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
      bodyText: '',
    });
    // innerText returns empty — triggers keyboard.type fallback in postReply
    const locator = page._locator as { innerText: ReturnType<typeof vi.fn> };
    locator.innerText = vi.fn().mockResolvedValue('');

    const context = createMockContext(page as unknown);

    await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet',
      ['Reply text here'],
    );

    // keyboard.type should have been called as fallback for text entry in postReply
    expect(page.keyboard.type).toHaveBeenCalled();
  });

  it('CE-013: postReply uses multiple selectors for reply button (data-testid + aria-label)', async () => {
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
      bodyText: 'Reply entered',
    });
    const locator = page._locator as { innerText: ReturnType<typeof vi.fn> };
    locator.innerText = vi.fn().mockResolvedValue('Reply entered');

    const context = createMockContext(page as unknown);

    await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet',
      ['Reply text'],
    );

    // page.locator should have been called (for reply button selector)
    expect(page.locator).toHaveBeenCalled();
  });

  // ── Error suppression in postReply ──

  it('CE-014: postReply suppresses page errors via addInitScript', async () => {
    browserPort.humanClick = vi.fn().mockResolvedValue(undefined);
    browserPort.typeHuman = vi.fn().mockResolvedValue(undefined);

    const page = createMockPage({
      url: 'https://x.com/myzodiacai/status/1234567890',
      bodyText: 'Reply text entered',
    });
    const locator = page._locator as { innerText: ReturnType<typeof vi.fn> };
    locator.innerText = vi.fn().mockResolvedValue('Reply text entered');

    const context = createMockContext(page as unknown);

    await poster.post(
      context as unknown,
      browserPort as unknown,
      'Main tweet',
      ['Reply text'],
    );

    // addInitScript should have been called (once for main compose, once for reply)
    expect(page.addInitScript).toHaveBeenCalled();
  });
});
