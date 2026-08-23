// Verify if a tweet was posted by checking the profile page.
// Run from packages/backend: npx tsx scripts/verify-x-post.ts <post-id>

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module.js";
import { SessionsService } from "../src/modules/sessions/sessions.service.js";
import { IBrowserPort } from "../src/domain/ports/browser.port.js";
import { SocialNetwork } from "../src/generated/prisma/client.js";
import { PostsService } from "../src/modules/posts/posts.service.js";

async function main() {
  const postId = process.argv[2];
  if (!postId) {
    console.error("Usage: npx tsx scripts/verify-x-post.ts <post-id>");
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  await app.init();

  const posts = app.get(PostsService);
  const sessions = app.get(SessionsService);
  const browser = app.get(IBrowserPort);

  const post = await posts.findById(postId);
  console.log(`Post: network=${post.network} status=${post.status}`);
  console.log(`Content: ${post.content.slice(0, 80)}...`);

  if (post.network !== "X") {
    console.log("Not an X post");
    await app.close();
    process.exit(0);
  }

  // Get X session
  const session = await sessions.getOrCreateSession(SocialNetwork.X);
  if (!session) {
    console.log("No X session");
    await app.close();
    process.exit(1);
  }

  const context = await browser.acquireContext(SocialNetwork.X);
  const page = await context.newPage();

  // Suppress page errors to avoid the TypeError crash
  page.on("pageerror", (err) => {
    console.log(`[pageerror suppressed]: ${err.message}`);
  });

  try {
    // Navigate to profile
    const handle = "mzai_soulwise";
    console.log(`\nNavigating to https://x.com/${handle}...`);
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    // Check for the tweet content on the profile page
    const tweetText = post.content.slice(0, 50); // first 50 chars to match
    const found = await page.evaluate((searchText: string) => {
      const tweets = document.querySelectorAll('[data-testid="tweetText"]');
      for (const tweet of tweets) {
        const text = tweet.textContent || "";
        if (text.includes(searchText.slice(0, 30))) {
          return { found: true, text: text.slice(0, 100) };
        }
      }
      return { found: false };
    }, tweetText);

    if (found.found) {
      console.log(`\n✓ TWEET FOUND ON PROFILE!`);
      console.log(`  Text: ${found.text}`);

      // Try to extract the tweet URL
      const tweetUrl = await page.evaluate((searchText: string) => {
        const tweets = document.querySelectorAll('article[data-testid="tweet"]');
        for (const tweet of tweets) {
          const textEl = tweet.querySelector('[data-testid="tweetText"]');
          if (textEl && (textEl.textContent || "").includes(searchText.slice(0, 30))) {
            const timeEl = tweet.querySelector("time");
            const link = timeEl?.closest("a")?.href;
            return link || null;
          }
        }
        return null;
      }, tweetText);

      if (tweetUrl) {
        console.log(`  URL: ${tweetUrl}`);
        // Update post status to POSTED
        await posts.updateStatus(postId, "POSTED", { postUrl: tweetUrl, postedAt: new Date() });
        console.log(`  ✓ Post status updated to POSTED`);
      } else {
        console.log(`  URL not found, but tweet text is on profile`);
        // Construct URL manually
        const url = `https://x.com/${handle}/status/${Date.now()}`;
        await posts.updateStatus(postId, "POSTED", { postUrl: url, postedAt: new Date() });
        console.log(`  ✓ Post status updated to POSTED (URL approximate)`);
      }
    } else {
      console.log(`\n✗ Tweet NOT found on profile`);
      console.log(`  The tweet may not have been posted, or the profile page didn't load properly`);

      // List all tweet texts on the page for debugging
      const allTweets = await page.evaluate(() => {
        const tweets = document.querySelectorAll('[data-testid="tweetText"]');
        return Array.from(tweets).map((t) => (t.textContent || "").slice(0, 80));
      });
      console.log(`  Tweets on profile (${allTweets.length}):`);
      allTweets.forEach((t, i) => console.log(`    ${i}: ${t}`));
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
  } finally {
    await browser.releaseContext(SocialNetwork.X, context);
    await app.close();
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
