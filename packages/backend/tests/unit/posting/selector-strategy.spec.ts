/**
 * Selector Strategy unit tests.
 *
 * Tests the multi-fallback selector resolution logic:
 *   - resolveSelector: tries getByRole → getByLabel → getByText → CSS
 *   - waitForSelector: resolves with timeout
 *
 * Source: packages/backend/src/modules/posting/posters/selector-strategy.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveSelector, waitForSelector } from '../../../src/modules/posting/posters/selector-strategy';
import { createMockPage } from '../../mocks/index';

describe('Selector Strategy', () => {
  describe('resolveSelector', () => {
    it('resolves via getByRole when role is specified', async () => {
      const page = createMockPage();
      const strategy = { role: { role: 'button', name: 'Post' } };

      const result = await resolveSelector(page as any, strategy);

      expect(result.method).toBe('role');
      expect(result.locator).toBeDefined();
    });

    it('resolves via getByLabel when label is specified', async () => {
      const page = createMockPage();
      const strategy = { label: { label: 'Email' } };

      const result = await resolveSelector(page as any, strategy);

      expect(result.method).toBe('label');
      expect(result.locator).toBeDefined();
    });

    it('resolves via getByText when text is specified', async () => {
      const page = createMockPage();
      const strategy = { text: { text: 'Publish', exact: true } };

      const result = await resolveSelector(page as any, strategy);

      expect(result.method).toBe('text');
      expect(result.locator).toBeDefined();
    });

    it('resolves via CSS when css array is specified', async () => {
      const page = createMockPage();
      const strategy = { css: ['button:has-text("Post")', '[data-testid="tweetButton"]'] };

      const result = await resolveSelector(page as any, strategy);

      expect(result.method).toBe('css');
      expect(result.selector).toBe('button:has-text("Post")');
    });

    it('tries methods in order: role → label → text → css', async () => {
      const page = createMockPage();
      const strategy = {
        role: { role: 'button', name: 'Post' },
        label: { label: 'Post' },
        text: { text: 'Post' },
        css: ['button:has-text("Post")'],
      };

      const result = await resolveSelector(page as any, strategy);

      // Should use role first
      expect(result.method).toBe('role');
    });

    it('throws when no selector method is provided', async () => {
      const page = createMockPage();
      const strategy = {};

      await expect(resolveSelector(page as any, strategy)).rejects.toThrow();
    });
  });

  describe('waitForSelector', () => {
    it('resolves and waits for the locator to be visible', async () => {
      const page = createMockPage();
      const strategy = { role: { role: 'button', name: 'Post' } };

      const result = await waitForSelector(page as any, strategy, 5000);

      expect(result.locator).toBeDefined();
      expect(result.method).toBe('role');
    });

    it('throws on timeout if element not found', async () => {
      const page = createMockPage();
      // Make the locator's waitFor throw a timeout error AND isVisible return false
      page._locator.waitFor.mockRejectedValue(new Error('Timeout 1000ms exceeded'));
      page._locator.isVisible.mockResolvedValue(false);
      page._locator.count.mockResolvedValue(0);

      const strategy = { css: ['nonexistent'] };

      await expect(waitForSelector(page as any, strategy, 100)).rejects.toThrow();
    });
  });
});
