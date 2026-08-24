#!/usr/bin/env node
// Live post a single existing post by ID — real browser, real submit.
//
// Usage: node dist/dry-run/live-post-one.cli.js <post-id> [--yes]

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { PostingService } from "../modules/posting/posting.service.js";
import { PostsService } from "../modules/posts/posts.service.js";

async function main(): Promise<void> {
  const postId = process.argv[2];
  const yes = process.argv.includes("--yes");

  if (!postId) {
    console.error("Usage: node dist/dry-run/live-post-one.cli.js <post-id> [--yes]");
    process.exit(1);
  }

  console.log(`\n⚠️  LIVE POST — real browser, real submit for post ${postId} ⚠️\n`);

  if (!yes) {
    process.stdout.write('Type "yes" to proceed with REAL post: ');
    const answer = await new Promise<string>((r) => {
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.once("data", (d) => {
        process.stdin.pause();
        r(String(d).trim());
      });
    });
    if (answer !== "yes") {
      console.log("Cancelled.");
      process.exit(0);
    }
  }

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: ["error", "warn", "log", "debug"],
  });
  await app.init();

  try {
    const postsService = app.get(PostsService);
    const postingService = app.get(PostingService);

    const post = await postsService.findById(postId);
    console.log(`Post: network=${post.network} status=${post.status}`);
    console.log(`Content: ${post.content.slice(0, 100)}...`);

    if (post.status !== "APPROVED") {
      console.log("Post is not APPROVED — approving first...");
      await postsService.approve(postId);
    }

    console.log(`\nPosting to ${post.network} (REAL)...\n`);
    const result = await postingService.postById(postId);

    if (result.success) {
      console.log(`\n✓ POSTED! URL: ${result.url}\n`);
    } else {
      console.log(`\n✗ Posting failed: ${result.error}\n`);
    }
  } catch (err) {
    console.error(`\n✗ Error: ${(err as Error).message}\n`);
    if ((err as Error).stack) console.error((err as Error).stack);
  } finally {
    await app.close();
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
