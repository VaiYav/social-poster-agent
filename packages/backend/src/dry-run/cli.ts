#!/usr/bin/env node
// CLI entry point for SPA dry-run verification.
//
// Usage:
//   pnpm dry-run                              # full pipeline: generate 1 post for X, then dry-run post it
//   pnpm dry-run -- --feature generation      # only generation (real LLM)
//   pnpm dry-run -- --feature posting         # only posting (requires --post-id or existing draft)
//   pnpm dry-run -- --feature posting --post-id <uuid>
//   pnpm dry-run -- --network threads         # target Threads instead of X
//   pnpm dry-run -- --count 3                 # generate 3 posts
//   pnpm dry-run -- --headed                  # show browser (CAMOUFOX_HEADLESS=false)
//   pnpm dry-run -- --cleanup                 # delete generated posts after verification

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import { AppModule } from '../app.module';
import { LlmService } from '../infrastructure/llm/llm.service';
import { DryRunReporter } from './dry-run.reporter';
import { DryRunRunner, type DryRunOptions } from './dry-run.runner';

interface ParsedArgs {
  feature: 'generation' | 'posting' | 'engagement' | 'trending' | 'replies' | 'all';
  network: SocialNetwork;
  count: number;
  postId?: string;
  postUrl?: string;
  targetHandle?: string;
  scrollDuration?: number;
  headed: boolean;
  cleanup: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    feature: 'all',
    network: SocialNetwork.X,
    count: 1,
    headed: false,
    cleanup: false,
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--feature':
        args.feature = argv[++i] as ParsedArgs['feature'] ?? args.feature;
        break;
      case '--network':
        args.network = (argv[++i] ?? 'X') as SocialNetwork;
        break;
      case '--count':
        args.count = parseInt(argv[++i] ?? '1', 10);
        break;
      case '--post-id':
        args.postId = argv[++i];
        break;
      case '--post-url':
        args.postUrl = argv[++i];
        break;
      case '--target-handle':
        args.targetHandle = argv[++i];
        break;
      case '--scroll-duration':
        args.scrollDuration = parseInt(argv[++i] ?? '15', 10);
        break;
      case '--headed':
        args.headed = true;
        break;
      case '--cleanup':
        args.cleanup = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('--')) {
          if (!args.postId) args.postId = arg;
        }
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
SPA Dry-Run Verification Tool
=============================

Verifies that Generation (LLM), Posting, Engagement, Trending, and Replies
features work against real systems — without publishing to social networks.

Usage:
  pnpm dry-run [options]

Options:
  --feature <name>     generation | posting | engagement | trending | replies | all (default: all)
  --network <name>     X | THREADS | FACEBOOK (default: X)
  --count <n>          Number of posts to generate (default: 1)
  --post-id <uuid>     Post ID to dry-run post (for --feature posting)
  --post-url <url>     Post URL to like/comment (for --feature engagement)
  --target-handle <h>  Handle to follow (for --feature engagement)
  --scroll-duration <s> Feed scroll duration in seconds (default: 15)
  --headed             Show browser window (CAMOUFOX_HEADLESS=false)
  --cleanup            Delete generated posts from DB after verification
  --yes, -y            Skip confirmation prompt
  --help, -h           Show this help

Features:
  generation   Real LLM call → save drafts to DB
  posting      Approve post → real browser → intercept submit
  engagement   Like, comment, follow, scroll feed (real browser, intercepts)
  trending     Scrape Google Trends + X trending topics
  replies      Monitor comments on posted content
  all          Run all features in sequence

Examples:
  pnpm dry-run                                          # full pipeline for X
  pnpm dry-run -- --feature generation --count 3        # generate 3 posts
  pnpm dry-run -- --feature posting --post-id abc-123
  pnpm dry-run -- --feature engagement --network X      # like/comment/follow on X
  pnpm dry-run -- --feature trending                    # scrape trending topics
  pnpm dry-run -- --feature replies --network X         # monitor replies
  pnpm dry-run -- --network threads --headed            # Threads, visible browser
`);
}

async function confirm(prompt: string): Promise<boolean> {
  if (process.stdout.isTTY === false) return true; // non-interactive — proceed

  process.stdout.write(`${prompt} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (data: string) => {
      process.stdin.pause();
      resolve(data.trim().toLowerCase().startsWith('y'));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reporter = new DryRunReporter();

  // Set dry-run env flag — BrowserModule checks this to wrap BrowserFactory
  process.env.SPA_DRY_RUN = 'true';
  if (args.headed) {
    process.env.CAMOUFOX_HEADLESS = 'false';
  }

  reporter.banner('SPA Dry-Run Verification');
  reporter.info(`Feature: ${args.feature} | Network: ${args.network} | Count: ${args.count}`);
  if (args.headed) reporter.info('Browser: HEADED (visible)');
  if (args.cleanup) reporter.info('Cleanup: enabled (generated posts will be deleted)');
  reporter.info('');

  // Warn about real LLM calls and browser
  if (args.feature === 'generation' || args.feature === 'all') {
    reporter.info('WARNING: Real LLM API calls will be made (may cost tokens).');
  }
  if (args.feature === 'posting' || args.feature === 'engagement' || args.feature === 'all') {
    reporter.info('WARNING: Real browser will open and navigate to social networks.');
    reporter.info('         Submit will be intercepted — NO posts/comments/likes will be published.');
  }
  if (args.feature === 'trending' || args.feature === 'all') {
    reporter.info('WARNING: Trending scraper will fetch Google Trends RSS and (for X) scrape X trends.');
  }
  if (args.feature === 'replies' || args.feature === 'all') {
    reporter.info('WARNING: Replies monitor will scrape comments on recent posts.');
  }
  reporter.info('');

  if (!args.yes) {
    const ok = await confirm('Proceed with dry-run?');
    if (!ok) {
      reporter.info('Dry-run cancelled.');
      process.exit(0);
    }
  }

  const logger = new Logger('DryRunCLI');

  try {
    logger.log('Bootstrapping NestJS application (SPA_DRY_RUN=true → DryRunBrowserPort active)...');

    // Bootstrap real app — BrowserModule checks SPA_DRY_RUN env var
    // and wraps BrowserFactory with DryRunBrowserPort automatically
    const app = await NestFactory.create(AppModule, {
      rawBody: true,
      logger: ['error', 'warn', 'log', 'debug'],
    });
    app.enableShutdownHooks();

    // NestFactory.create() does NOT call init() automatically.
    // onModuleInit() hooks (including LlmService.buildProviderChain) only run after init().
    await app.init();

    logger.log('Application bootstrapped — starting dry-run scenarios...');

    // Debug: check if ConfigService loaded env vars
    const configService = app.get(ConfigService);
    const groqKey = configService.get<string>('GROQ_API_KEY', '');
    logger.log(`ConfigService GROQ_API_KEY: ${groqKey ? `SET (${groqKey.slice(0, 10)}...)` : 'NOT SET'}`);

    // Debug: check LlmService directly
    const llm = app.get(LlmService);
    const status = llm.getProviderStatus();
    logger.log(`LlmService providers: ${status.length}, names: ${status.map((p) => p.name).join(', ')}`);

    const runner = new DryRunRunner(app, reporter);
    const opts: DryRunOptions = {
      feature: args.feature,
      network: args.network,
      count: args.count,
      postId: args.postId,
      postUrl: args.postUrl,
      targetHandle: args.targetHandle,
      scrollDuration: args.scrollDuration,
      cleanup: args.cleanup,
    };

    const result = await runner.run(opts);

    // Graceful shutdown
    await app.close();

    process.exit(result.failed > 0 ? 1 : 0);
  } catch (err) {
    logger.error(`Dry-run failed: ${(err as Error).message}`);
    if ((err as Error).stack) {
      logger.debug((err as Error).stack);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
