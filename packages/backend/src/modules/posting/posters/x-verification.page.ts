import { Logger } from "@nestjs/common";
import fs from "node:fs";
import type { Page } from "../../../domain/ports/browser-primitives.js";
import type { ScreenshotPhase } from "../../../domain/ports/browser.port.js";
import type { ConfigService } from "@nestjs/config";

export interface XVerificationDependencies {
  readonly logger: Pick<Logger, "debug" | "error" | "log" | "warn">;
  readonly configService: ConfigService;
  readonly screenshot: (page: Page, phase: ScreenshotPhase) => Promise<string>;
}

/** X verification page object: permalink discovery, account handle and diagnostics. */
export class XVerification {
  private readonly logger: Pick<Logger, "debug" | "error" | "log" | "warn">;
  private readonly configService: ConfigService;
  private readonly screenshot: XVerificationDependencies["screenshot"];

  constructor(deps: XVerificationDependencies) {
    this.logger = deps.logger;
    this.configService = deps.configService;
    this.screenshot = deps.screenshot;
  }
  async dumpPageForDiagnostics(page: Page, label: string): Promise<void> {
    try {
      const debugDir =
        this.configService.get<string>("SPA_DEBUG_DIR", "/tmp/spa-debug") || "/tmp/spa-debug";
      fs.mkdirSync(debugDir, { recursive: true });
      const timestamp = Date.now();
      const base = `${debugDir}/x-${label}-${timestamp}`;
      const html = await page.content().catch(() => "");
      const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
      const title = await page.title().catch(() => "");
      fs.writeFileSync(`${base}.html`, html);
      fs.writeFileSync(
        `${base}.txt`,
        `url: ${page.url()}\n\ntitle: ${title}\n\n${bodyText.slice(0, 5000)}`,
      );
      await this.screenshot(page, "on-error");
      this.logger.warn(`X diagnostic dump saved: ${base}.html`);
    } catch (dumpErr) {
      this.logger.warn(`X diagnostic dump failed: ${(dumpErr as Error).message}`);
    }
  }

  /**
   * Search the page DOM for a tweet link matching our account handle.
   * Returns the full URL if found, null otherwise.
   */
  async findTweetUrlOnPage(page: Page, accountHandle: string | null): Promise<string | null> {
    try {
      const tweetLinks = await page.locator('a[href*="/status/"]').all();
      for (const link of tweetLinks) {
        const href = await link.getAttribute("href").catch(() => null);
        if (!href) continue;
        const full = href.startsWith("http") ? href : `https://x.com${href}`;
        // If we know our handle, only accept links matching it
        if (accountHandle && full.includes(`/${accountHandle}/status/`)) {
          this.logger.log(`X found our tweet link in DOM: ${full}`);
          return full;
        }
      }
      // No handle filter — accept first tweet link as fallback
      if (!accountHandle && tweetLinks.length > 0) {
        const href = await tweetLinks[0]!.getAttribute("href").catch(() => null);
        if (href) {
          const full = href.startsWith("http") ? href : `https://x.com${href}`;
          this.logger.log(`X found tweet link in DOM (no handle filter): ${full}`);
          return full;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Extract the current account handle from the page.
   * X shows the handle in the side nav profile link: a[href="/{handle}"]
   * or via data-testid="AppTabBar_Profile_Link".
   */
  async getAccountHandle(page: Page): Promise<string | null> {
    try {
      // Profile link in side nav: <a href="/{handle}"> with aria-label containing "Profile"
      const profileLink = page.locator('a[aria-label*="Profile"][href^="/"]').first();
      const href = await profileLink.getAttribute("href").catch(() => null);
      if (href) {
        const handle = href.replace(/^\//, "").split("/")[0];
        if (handle && handle !== "home" && handle !== "explore" && handle !== "notifications") {
          this.logger.debug(`X account handle from profile link: @${handle}`);
          return handle;
        }
      }
      // Fallback: look for data-testid="AppTabBar_Profile_Link"
      const tabProfile = page.locator('[data-testid="AppTabBar_Profile_Link"]').first();
      const tabHref = await tabProfile.getAttribute("href").catch(() => null);
      if (tabHref) {
        const handle = tabHref.replace(/^\//, "").split("/")[0];
        if (handle) {
          this.logger.debug(`X account handle from tab bar: @${handle}`);
          return handle;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get account handle from config (SOCIAL_X_USERNAME) as fallback.
   */
  async getAccountHandleFromConfig(): Promise<string | null> {
    try {
      const username = this.configService.get<string>("SOCIAL_X_USERNAME", "");
      if (username) {
        this.logger.debug(`X account handle from config: @${username}`);
        return username;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Post a reply in a thread — navigates to the root tweet, clicks reply,
   * types in the reply dialog, and submits.
   *
   * Uses typeHuman for stealth typing (randomized per-key delay + thinking pauses).
   * Falls back to Cmd+Enter keyboard shortcut if the Reply button is not clickable.
   * Verifies the reply was posted by checking page content after submit.
   */
}
