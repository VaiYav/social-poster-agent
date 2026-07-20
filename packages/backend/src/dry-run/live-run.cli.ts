#!/usr/bin/env node
// LIVE RUN — real posts, real likes, real comments. NO dry-run interception.
//
// Usage:
//   node dist/dry-run/live-run.cli.js --feature all --network X --yes
//   node dist/dry-run/live-run.cli.js --feature posting --network X --yes
//   node dist/dry-run/live-run.cli.js --feature engagement --network X --scroll-duration 20 --yes

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SocialNetwork, PostStatus, GenerationTrigger } from '@prisma/client';
import { AppModule } from '../app.module';
import { GenerationService } from '../modules/generation/generation.service';
import { PostingService } from '../modules/posting/posting.service';
import { PostsService } from '../modules/posts/posts.service';
import { SessionsService } from '../modules/sessions/sessions.service';
import { AccountsService } from '../modules/accounts/accounts.service';
import { TrendingScraperService } from '../modules/trending/trending-scraper.service';
import { TrendingService } from '../modules/trending/trending.service';
import { RepliesMonitorService } from '../modules/replies/replies-monitor.service';
import { XEngager } from '../modules/engagement/engagers/x.engager';
import { ThreadsEngager } from '../modules/engagement/engagers/threads.engager';
import { IBrowserPort } from '../domain/ports/browser.port';

interface Args {
  feature: 'posting' | 'engagement' | 'trending' | 'replies' | 'all';
  network: SocialNetwork;
  count: number;
  scrollDuration: number;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    feature: 'all',
    network: SocialNetwork.X,
    count: 1,
    scrollDuration: 20,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--feature': args.feature = argv[++i] as Args['feature']; break;
      case '--network': args.network = argv[++i] as SocialNetwork; break;
      case '--count': args.count = parseInt(argv[++i] ?? '1', 10); break;
      case '--scroll-duration': args.scrollDuration = parseInt(argv[++i] ?? '20', 10); break;
      case '--yes': case '-y': args.yes = true; break;
    }
  }
  return args;
}

// ── POSTING ──────────────────────────────────────────────────────
async function runPosting(app: any, args: Args): Promise<void> {
  console.log('\n▶ POSTING (real)');

  const generationService = app.get(GenerationService);
  const postingService = app.get(PostingService);
  const postsService = app.get(PostsService);

  console.log('  Generating post via LLM...');
  const runId = await generationService.generate(
    args.count, [args.network], GenerationTrigger.MANUAL, false, false,
  );
  const run = await generationService.getRun(runId);
  const posts = run?.posts ?? [];
  if (posts.length === 0) {
    console.log('  ✗ No posts generated');
    return;
  }

  for (const post of posts) {
    const preview = post.content.slice(0, 80).replace(/\n/g, ' ');
    console.log(`  ✓ Generated: "${preview}..." (id=${post.id})`);
  }

  const post = posts[0]!;
  if (post.status !== PostStatus.APPROVED) {
    await postsService.approve(post.id);
    console.log('  ✓ Approved');
  }

  console.log('  Posting to ' + args.network + ' (REAL)...');
  const result = await postingService.postById(post.id);
  if (result.success) {
    console.log('  ✓ POSTED! URL:', result.url);
  } else {
    console.log('  ✗ Posting failed:', result.error);
  }
}

// ── ENGAGEMENT ───────────────────────────────────────────────────
async function runEngagement(app: any, args: Args): Promise<void> {
  console.log('\n▶ ENGAGEMENT (real)');

  const sessionsService = app.get(SessionsService);
  const browser = app.get(IBrowserPort);
  const accountsService = app.get(AccountsService);

  console.log('  Logging in to ' + args.network + '...');
  const account = await accountsService.getNextAccountForNetwork(args.network);
  if (!account) {
    console.log('  ✗ No account configured for ' + args.network);
    return;
  }
  const session = await sessionsService.getOrCreateSession(account.id, args.network);
  if (!session) {
    console.log('  ✗ Login failed');
    return;
  }
  console.log('  ✓ Logged in (session=' + session.id.slice(0, 8) + ')');

  // Get engager
  let engager: any = null;
  try {
    engager = args.network === SocialNetwork.X
      ? app.get(XEngager)
      : args.network === SocialNetwork.THREADS
        ? app.get(ThreadsEngager)
        : null;
  } catch { /* fall through */ }

  if (!engager) {
    console.log('  ✗ No engager for ' + args.network);
    return;
  }

  // Acquire context with session
  const storageState = session.storageState
    ? sessionsService.decryptStorageState(session)
    : undefined;
  let context: any = null;
  let page: any = null;

  try {
    context = await browser.acquireContext(args.network, storageState, account.id);
    page = await context.newPage();

    // Scroll feed — collect real post URLs
    console.log('  Scrolling feed for ' + args.scrollDuration + 's...');
    const postUrls: string[] = await engager.scrollFeed(page, args.scrollDuration);
    console.log('  ✓ Found ' + postUrls.length + ' posts in feed');
    if (postUrls.length > 0) {
      console.log('  First 3:', postUrls.slice(0, 3));
    }

    // LIKE the first real post
    if (postUrls[0]) {
      console.log('  Liking: ' + postUrls[0]);
      const likeResult = await engager.like(page, postUrls[0]);
      console.log('  ' + (likeResult.success ? '✓ Liked' : '✗ Like failed: ' + likeResult.error));
    }

    // COMMENT on the first real post
    if (postUrls[0]) {
      const commentText = 'Great insights! Thanks for sharing.';
      console.log('  Commenting on: ' + postUrls[0]);
      const commentResult = await engager.comment(page, postUrls[0], commentText);
      console.log('  ' + (commentResult.success ? '✓ Commented' : '✗ Comment failed: ' + commentResult.error));
    }

    // FOLLOW — extract handle from first post or use default
    const handle = postUrls[0]?.match(/\/([^/]+)\/status\//)?.[1] ?? 'elonmusk';
    console.log('  Following: ' + handle);
    const followResult = await engager.follow(page, handle);
    console.log('  ' + (followResult.success ? '✓ Followed' : '✗ Follow failed: ' + followResult.error));

    // EXTRACT TEXT from first post
    if (postUrls[0]) {
      console.log('  Extracting text from: ' + postUrls[0]);
      const extracted = await engager.extractPostText(page, postUrls[0]);
      console.log('  ✓ Text: "' + extracted.text.slice(0, 80) + '..." media=' + extracted.hasMedia + ' author=' + extracted.authorHandle);
    }
  } finally {
    // Best-effort cleanup — page and context may be null if acquisition failed.
    // Use try/catch (not .catch()) because page/context could be undefined,
    // which would throw a synchronous TypeError before .catch() can run.
    try {
      if (context) {
        const updated = await browser.saveStorageState(context);
        await sessionsService.updateStorageState(session.id, updated);
      }
    } catch { /* best-effort */ }
    try { if (page?.close) await page.close(); } catch { /* best-effort */ }
    try { if (context) await browser.releaseContext(args.network, context, account.id); } catch { /* best-effort */ }
  }
}

// ── TRENDING ─────────────────────────────────────────────────────
async function runTrending(app: any, args: Args): Promise<void> {
  console.log('\n▶ TRENDING (real)');
  const scraper = app.get(TrendingScraperService);
  const trendingService = app.get(TrendingService);

  console.log('  Fetching Google Trends...');
  const google = await scraper.getGoogleTrends(10);
  console.log('  ✓ Google Trends: ' + google.length + ' topics');
  google.slice(0, 5).forEach((t: any, i: number) => console.log('    ' + (i + 1) + '. ' + t.topic));

  if (args.network === SocialNetwork.X) {
    console.log('  Scraping X trends (needs session)...');
    try {
      const xTrends = await scraper.getXTrends(10);
      console.log('  ✓ X Trends: ' + xTrends.length + ' topics');
      xTrends.slice(0, 5).forEach((t: any, i: number) => console.log('    ' + (i + 1) + '. ' + t.topic));
    } catch (e) {
      console.log('  ⚠ X Trends failed: ' + (e as Error).message.slice(0, 80));
    }
  }

  console.log('  Merging with astro trending...');
  const astro = trendingService.getActiveTrending().map((t: any) => ({ topic: t.topic, networks: t.networks }));
  const merged = await scraper.getMergedTrending(astro);
  console.log('  ✓ Merged: ' + merged.length + ' topics');
}

// ── REPLIES ──────────────────────────────────────────────────────
async function runReplies(app: any, args: Args): Promise<void> {
  console.log('\n▶ REPLIES MONITOR (real)');
  const sessionsService = app.get(SessionsService);
  const accountsService = app.get(AccountsService);
  const repliesMonitor = app.get(RepliesMonitorService);

  console.log('  Ensuring session for ' + args.network + '...');
  const account = await accountsService.getNextAccountForNetwork(args.network);
  if (!account) {
    console.log('  ✗ No account configured for ' + args.network);
    return;
  }
  const session = await sessionsService.getOrCreateSession(account.id, args.network);
  if (!session) {
    console.log('  ✗ Login failed');
    return;
  }
  console.log('  ✓ Session active');

  console.log('  Running monitoring cycle...');
  try {
    const result = await repliesMonitor.runMonitoringCycle();
    console.log('  ✓ Cycle done:', {
      postsChecked: result.postsChecked,
      commentsScraped: result.commentsScraped,
      repliesPosted: result.repliesPosted,
      humanReview: result.humanReview,
    });
  } catch (e) {
    console.log('  ⚠ Monitor failed: ' + (e as Error).message.slice(0, 100));
  }
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('\n⚠️  LIVE RUN — real posts, real likes, real comments ⚠️');
  console.log(`   Feature: ${args.feature} | Network: ${args.network} | Count: ${args.count}`);
  console.log('');

  // Real runs must stay headless to minimize Camoufox memory consumption.
  process.env.CAMOUFOX_HEADLESS = 'true';

  if (!args.yes) {
    process.stdout.write('Type "yes" to proceed with REAL actions: ');
    const answer = await new Promise<string>(r => {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.once('data', d => { process.stdin.pause(); r(String(d).trim()); });
    });
    if (answer !== 'yes') {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  // DO NOT set SPA_DRY_RUN — real browser, real posts
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: ['error', 'warn', 'log', 'debug'],
  });
  await app.init();

  try {
    if (args.feature === 'posting' || args.feature === 'all') {
      await runPosting(app, args);
    }
    if (args.feature === 'engagement' || args.feature === 'all') {
      await runEngagement(app, args);
    }
    if (args.feature === 'trending' || args.feature === 'all') {
      await runTrending(app, args);
    }
    if (args.feature === 'replies' || args.feature === 'all') {
      await runReplies(app, args);
    }
    console.log('\n✅ Live run complete\n');
  } finally {
    await app.close();
    process.exit(0);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
