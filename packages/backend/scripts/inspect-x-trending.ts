// Inspect X trending page — find current selectors.
// Run from packages/backend: npx tsx scripts/inspect-x-trending.ts

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module.js";
import { SessionsService } from "../src/modules/sessions/sessions.service.js";
import { IBrowserPort } from "../src/domain/ports/browser.port.js";
import { SocialNetwork } from "../src/generated/prisma/client.js";

async function main() {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  await app.init();

  const sessions = app.get(SessionsService);
  const browser = app.get(IBrowserPort);

  // Get X session
  const session = await sessions.getOrCreateSession(SocialNetwork.X);
  if (!session) {
    console.log("No X session available");
    await app.close();
    return;
  }

  const context = await browser.acquireContext(SocialNetwork.X);
  const page = await context.newPage();

  const urls = [
    "https://x.com/explore/tabs/trending",
    "https://x.com/explore",
    "https://x.com/home",
  ];

  for (const url of urls) {
    console.log(`\n=== Navigating to ${url} ===`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000); // longer wait

    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);

    // Check for trend selectors
    const trendCount = await page.evaluate(() => {
      return document.querySelectorAll('[data-testid="trend"]').length;
    });
    console.log(`[data-testid="trend"] count: ${trendCount}`);

    // Check for other potential trend selectors
    const altCounts = await page.evaluate(() => {
      const selectors = [
        'div[data-testid="trend"]',
        '[data-testid*="trend"]',
        '[role="link"] span',
        'aside [data-testid="trend"]',
        'section [data-testid="trend"]',
        '[data-testid="trend"] span',
      ];
      const results: Record<string, number> = {};
      for (const s of selectors) {
        results[s] = document.querySelectorAll(s).length;
      }
      return results;
    });
    console.log("Alternative selectors:", JSON.stringify(altCounts, null, 2));

    // List all data-testid attributes on the page (first 30)
    const testIds = await page.evaluate(() => {
      const els = document.querySelectorAll("[data-testid]");
      const ids: string[] = [];
      els.forEach((el) => {
        const id = el.getAttribute("data-testid");
        if (id && !ids.includes(id)) ids.push(id);
      });
      return ids.slice(0, 50);
    });
    console.log(`All data-testid values (${testIds.length}):`, testIds.join(", "));

    if (trendCount > 0) {
      // Extract trend text
      const trends = await page.evaluate(() => {
        const els = document.querySelectorAll('[data-testid="trend"]');
        const results: string[] = [];
        els.forEach((el, i) => {
          if (i >= 10) return;
          const text = el.textContent?.trim()?.split("\n")[0]?.trim();
          if (text) results.push(text);
        });
        return results;
      });
      console.log("Trend texts:", trends);
      break; // Found trends, no need to try other URLs
    }
  }

  await browser.releaseContext(SocialNetwork.X, context);
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
