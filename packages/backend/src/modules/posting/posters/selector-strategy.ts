// Multi-fallback selector strategy for resilient browser automation.
//
// Social networks frequently change their UI. This strategy tries multiple
// selector approaches in priority order:
//   1. data-testid (most stable — used for testing, rarely changes)
//   2. getByRole (accessibility tree — based on ARIA roles, stable)
//   3. getByLabel (form labels — stable for login forms)
//   4. CSS selectors with aria-label (semi-stable)
//   5. Text-based :has-text() (least stable — last resort)
//
// Usage:
//   const strategy = {
//     testId: 'tweetButton',
//     role: { role: 'button', name: 'Post' },
//     css: ['button[type="submit"]', 'button[data-action="post"]'],
//     text: 'Post',
//   };
//   const locator = await resolveSelector(page, strategy);

import type { Locator, Page } from 'playwright-core';
import type { SocialNetwork } from '@spa/shared';
import type { SelectorHealthService } from '../../../infrastructure/browser/selector-health.service.js';

/** Selector strategy — multiple approaches to find the same element. */
export interface SelectorStrategy {
  /** data-testid attribute (most stable). */
  testId?: string;
  /** getByRole — accessibility tree lookup. */
  role?: { role: string; name?: string; exact?: boolean };
  /** getByLabel — form label lookup. */
  label?: { label: string; exact?: boolean };
  /** CSS selectors — tried in order as fallbacks. */
  css?: string[];
  /** Text content — getByText or :has-text() as last resort. */
  text?: { text: string; exact?: boolean };
}

/** Result of selector resolution. */
export interface SelectorResolution {
  locator: Locator;
  method: 'testId' | 'role' | 'label' | 'css' | 'text';
  selector: string;
}

/**
 * Resolve a selector strategy to a Locator on the page.
 * Tries each approach in priority order, returns the first match.
 *
 * @param page Playwright page
 * @param strategy Multi-fallback selector strategy
 * @param healthTracking Optional — (network, selectorKey, success) for health monitoring
 * @throws if no selector matches (caller should catch and create SelectorNotFoundError)
 */
export async function resolveSelector(
  page: Page,
  strategy: SelectorStrategy,
  healthTracking?: { network: SocialNetwork; selectorKey: string; healthService: SelectorHealthService },
): Promise<SelectorResolution> {
  let result: SelectorResolution | null = null;
  try {
    result = await resolveSelectorInner(page, strategy);
    return result;
  } finally {
    if (healthTracking) {
      if (result) {
        healthTracking.healthService.recordSuccess(healthTracking.network, healthTracking.selectorKey);
      } else {
        healthTracking.healthService.recordFailure(healthTracking.network, healthTracking.selectorKey);
      }
    }
  }
}

/** Internal resolver — does the actual selector matching. */
async function resolveSelectorInner(
  page: Page,
  strategy: SelectorStrategy,
): Promise<SelectorResolution> {
  // 1. data-testid (most stable)
  if (strategy.testId) {
    const locator = page.locator(`[data-testid="${strategy.testId}"]`).first();
    if (await isVisible(locator)) {
      return { locator, method: 'testId', selector: `[data-testid="${strategy.testId}"]` };
    }
  }

  // 2. getByRole (accessibility tree)
  if (strategy.role) {
    const locator = page
      .getByRole(strategy.role.role as never, {
        name: strategy.role.name,
        exact: strategy.role.exact,
      })
      .first();
    if (await isVisible(locator)) {
      return {
        locator,
        method: 'role',
        selector: `getByRole(${strategy.role.role}, name=${strategy.role.name ?? '*'})`,
      };
    }
  }

  // 3. getByLabel (form labels)
  if (strategy.label) {
    const locator = page
      .getByLabel(strategy.label.label, { exact: strategy.label.exact ?? false })
      .first();
    if (await isVisible(locator)) {
      return {
        locator,
        method: 'label',
        selector: `getByLabel(${strategy.label.label})`,
      };
    }
  }

  // 4. CSS selectors (fallbacks in order)
  if (strategy.css && strategy.css.length > 0) {
    for (const css of strategy.css) {
      const locator = page.locator(css).first();
      if (await isVisible(locator)) {
        return { locator, method: 'css', selector: css };
      }
    }
  }

  // 5. Text-based (last resort)
  if (strategy.text) {
    const locator = page
      .getByText(strategy.text.text, { exact: strategy.text.exact ?? false })
      .first();
    if (await isVisible(locator)) {
      return {
        locator,
        method: 'text',
        selector: `getByText(${strategy.text.text})`,
      };
    }
  }

  // Nothing found — throw with details for debugging
  const tried: string[] = [];
  if (strategy.testId) tried.push(`testId=${strategy.testId}`);
  if (strategy.role) tried.push(`role=${strategy.role.role}/${strategy.role.name ?? '*'}`);
  if (strategy.label) tried.push(`label=${strategy.label.label}`);
  if (strategy.css) tried.push(`css=${strategy.css.join(' | ')}`);
  if (strategy.text) tried.push(`text=${strategy.text.text}`);
  throw new Error(`No selector matched. Tried: ${tried.join(', ')}`);
}

/**
 * Wait for a selector strategy to resolve, with timeout.
 * Useful when the element hasn't loaded yet (SPA hydration, lazy loading).
 */
export async function waitForSelector(
  page: Page,
  strategy: SelectorStrategy,
  timeoutMs = 15000,
  healthTracking?: { network: SocialNetwork; selectorKey: string; healthService: SelectorHealthService },
): Promise<SelectorResolution> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await resolveSelector(page, strategy, healthTracking);
      return result;
    } catch {
      // Not found yet — wait and retry
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // Final attempt — will throw if still not found
  return resolveSelector(page, strategy, healthTracking);
}

/** Check if a locator is visible (with short timeout to avoid blocking). */
async function isVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: 200 });
  } catch {
    return false;
  }
}
