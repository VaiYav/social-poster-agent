import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import type { SocialNetwork } from '@prisma/client';
import { Camoufox, type LaunchOptions } from 'camoufox-js';
import type {
  IBrowserPort,
  ScrollDirection,
  ScreenshotPhase,
} from '../../domain/ports/browser.port.js';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
  private browser: Browser | null = null;

  constructor(private readonly configService: ConfigService) {
    this.headless = this.configService.get<string>('CAMOUFOX_HEADLESS', 'true') === 'true';
    this.humanize = this.configService.get<string>('CAMOUFOX_HUMANIZE', 'true') === 'true';
    this.geoip = this.configService.get<string>('CAMOUFOX_GEOIP', 'true') === 'true';
    this.locale = this.configService.get<string>('CAMOUFOX_LOCALE', 'en-US');
    this.targetOs = this.configService.get<string>('CAMOUFOX_OS', 'windows') as
      | 'windows'
      | 'macos'
      | 'linux';
    this.proxyUrl = this.configService.get<string | undefined>('CAMOUFOX_PROXY_URL');
    this.screenshotDir = this.configService.get<string>('SPA_SCREENSHOT_DIR', '/tmp/spa-screenshots');
  }

  /**
   * Get or create the shared Camoufox browser instance.
   * One browser, multi-context per network (CONSTITUTION §9).
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

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
    this.browser = (await Camoufox(launchOpts)) as unknown as Browser;

    this.logger.log(
      `Camoufox launched (headless=${this.headless}, os=${this.targetOs}, humanize=${this.humanize}, geoip=${this.geoip}, proxy=${!!this.proxyUrl})`,
    );
    return this.browser;
  }

  /**
   * Create a browser context with optional saved storageState (cookies, localStorage).
   * Used for persistent sessions — restores login state between runs.
   *
   * Camoufox handles fingerprint/UA/viewport automatically via C++ level spoofing,
   * so we don't set them manually (would conflict with Camoufox's identity).
   */
  async createContext(
    network: SocialNetwork,
    storageState?: string,
  ): Promise<BrowserContext> {
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
   * Human-like typing — focuses element, types with per-key delay.
   * Uses pressSequentially for React-controlled inputs (fill() doesn't trigger onChange).
   */
  async humanType(locator: Locator, text: string, opts?: { delayMs?: number }): Promise<void> {
    const delay = opts?.delayMs ?? 50; // 50ms per key — human-like
    await locator.focus();
    await this.randomDelay(300, 800);
    await locator.pressSequentially(text, { delay });
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
    const networkDir = join(this.screenshotDir, network.toLowerCase());
    if (!existsSync(networkDir)) {
      mkdirSync(networkDir, { recursive: true });
    }
    const filename = `${phase}-${Date.now()}.png`;
    const filepath = join(networkDir, filename);
    try {
      await page.screenshot({ path: filepath, fullPage: true });
      this.logger.debug(`Screenshot saved: ${filepath}`);
    } catch (err) {
      this.logger.warn(`Screenshot failed: ${(err as Error).message}`);
    }
    return filepath;
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
    if (this.browser) {
      await this.browser.close();
      this.logger.log('Camoufox browser closed');
    }
  }
}
