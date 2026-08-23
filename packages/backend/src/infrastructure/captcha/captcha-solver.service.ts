/**
 * Sprint O: Captcha Solver Service — 2Captcha API integration.
 *
 * Env-gated: only active when CAPTCHA_SOLVER_ENABLED=true and TWO_CAPTCHA_API_KEY is set.
 * Detects reCAPTCHA and hCaptcha on a page, submits to 2Captcha, polls for token, injects.
 *
 * @see https://2captcha.com/2captcha-api
 */
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Page } from "../../domain/ports/browser-primitives.js";
import { parseBool } from "../config/parse-bool.js";

@Injectable()
export class CaptchaSolverService {
  private readonly logger = new Logger(CaptchaSolverService.name);
  private readonly enabled: boolean;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;

  constructor(private readonly configService: ConfigService) {
    this.enabled = parseBool(this.configService.get<string>("CAPTCHA_SOLVER_ENABLED", "false"));
    this.apiKey = this.configService.get<string>("TWO_CAPTCHA_API_KEY", "");
    this.pollIntervalMs = this.configService.get<number>("CAPTCHA_POLL_INTERVAL_MS", 5000);
    this.maxPollAttempts = this.configService.get<number>("CAPTCHA_MAX_POLL_ATTEMPTS", 24); // 2 min total
  }

  /**
   * Attempt to solve a captcha on the page if one is detected.
   * Returns true if a captcha was found and solved, false if no captcha or solving disabled.
   */
  async solve(page: Page): Promise<boolean> {
    if (!this.enabled || !this.apiKey) {
      this.logger.debug("Captcha solver disabled — skipping");
      return false;
    }

    const hasRecaptcha = await this.countLocator(page, 'iframe[src*="recaptcha"]');
    const hasHcaptcha = await this.countLocator(page, 'iframe[src*="hcaptcha"]');

    if (hasRecaptcha > 0) {
      this.logger.log("Detected reCAPTCHA — attempting to solve");
      return this.solveRecaptcha(page);
    }

    if (hasHcaptcha > 0) {
      this.logger.log("Detected hCaptcha — attempting to solve");
      return this.solveHcaptcha(page);
    }

    return false;
  }

  private async countLocator(page: Page, selector: string): Promise<number> {
    try {
      return await page.locator(selector).count();
    } catch {
      return 0;
    }
  }

  /**
   * Solve reCAPTCHA v2 via 2Captcha API.
   */
  private async solveRecaptcha(page: Page): Promise<boolean> {
    try {
      const sitekey = await page
        .locator("[data-sitekey]")
        .first()
        .getAttribute("data-sitekey")
        .catch(() => null);
      if (!sitekey) {
        this.logger.warn("reCAPTCHA detected but sitekey not found");
        return false;
      }

      const pageUrl = page.url();
      const token = await this.submitAndPoll({
        method: "userrecaptcha",
        googlekey: sitekey,
        pageurl: pageUrl,
      });

      if (token) {
        // Inject the token into the page
        await page.evaluate((gToken) => {
          const textarea = document.getElementById(
            "g-recaptcha-response",
          ) as HTMLTextAreaElement | null;
          if (textarea) {
            textarea.style.display = "block";
            textarea.value = gToken;
          }
        }, token);
        this.logger.log("reCAPTCHA solved — token injected");
        return true;
      }
    } catch (err) {
      this.logger.error(`reCAPTCHA solving failed: ${(err as Error).message}`);
    }
    return false;
  }

  /**
   * Solve hCaptcha via 2Captcha API.
   */
  private async solveHcaptcha(page: Page): Promise<boolean> {
    try {
      const sitekey = await page
        .locator("[data-sitekey]")
        .first()
        .getAttribute("data-sitekey")
        .catch(() => null);
      if (!sitekey) {
        this.logger.warn("hCaptcha detected but sitekey not found");
        return false;
      }

      const pageUrl = page.url();
      const token = await this.submitAndPoll({
        method: "hcaptcha",
        sitekey,
        pageurl: pageUrl,
      });

      if (token) {
        await page.evaluate((hToken) => {
          const textarea = document.querySelector(
            'textarea[name="h-captcha-response"]',
          ) as HTMLTextAreaElement | null;
          if (textarea) {
            textarea.value = hToken;
          }
        }, token);
        this.logger.log("hCaptcha solved — token injected");
        return true;
      }
    } catch (err) {
      this.logger.error(`hCaptcha solving failed: ${(err as Error).message}`);
    }
    return false;
  }

  /**
   * Submit captcha to 2Captcha and poll for the solution.
   * Uses POST to keep the API key out of URLs (avoids leaking into proxy/access logs).
   */
  private async submitAndPoll(params: Record<string, string>): Promise<string | null> {
    // Step 1: Submit the captcha via POST (key in body, not URL)
    const submitRes = await fetch("https://2captcha.com/in.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: this.apiKey, json: 1, ...params }),
      signal: AbortSignal.timeout(30_000),
    });
    const submitData = (await submitRes.json()) as { status: number; request: string };

    if (submitData.status !== 1) {
      this.logger.error(`2Captcha submit failed: ${submitData.request}`);
      return null;
    }

    const captchaId = submitData.request;
    this.logger.debug(`2Captcha task submitted: ${captchaId}`);

    // Step 2: Poll for the result via POST
    for (let i = 0; i < this.maxPollAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));

      const resultRes = await fetch("https://2captcha.com/res.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: this.apiKey, action: "get", id: captchaId, json: 1 }),
        signal: AbortSignal.timeout(30_000),
      });
      const resultData = (await resultRes.json()) as { status: number; request: string };

      if (resultData.status === 1) {
        return resultData.request; // This is the token
      }

      if (resultData.request !== "CAPCHA_NOT_READY") {
        this.logger.error(`2Captcha error: ${resultData.request}`);
        return null;
      }
      // CAPCHA_NOT_READY — continue polling
    }

    this.logger.warn("2Captcha polling timed out");
    return null;
  }
}
