// DryRunRunner — orchestrates dry-run verification scenarios.
//
// Scenarios:
//   1. Generation: real LLM call → save drafts to DB
//   2. Posting: approve post → real browser → DryRunBrowserPort intercepts submit
//   3. Engagement: like, comment, scroll feed (real browser, intercepts submit)
//   4. Trending: scrape Google Trends + X trending topics
//   5. Replies: monitor comments on posted content
//   6. All: generation → posting (end-to-end pipeline)

import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { SocialNetwork, PostStatus, GenerationTrigger } from '@prisma/client';
import { GenerationService } from '../modules/generation/generation.service';
import { PostingService } from '../modules/posting/posting.service';
import { PostsService } from '../modules/posts/posts.service';
import { AccountsService } from '../modules/accounts/accounts.service';
import { SessionsService } from '../modules/sessions/sessions.service';
import { LlmService } from '../infrastructure/llm/llm.service';
import { EngagementService } from '../modules/engagement/engagement.service.js';
import { BrowsingSessionService } from '../modules/engagement/browsing-session.service.js';
import { TrendingScraperService } from '../modules/trending/trending-scraper.service.js';
import { RepliesMonitorService } from '../modules/replies/replies-monitor.service.js';
import { DryRunReporter } from './dry-run.reporter';

export interface DryRunOptions {
  feature: 'generation' | 'posting' | 'engagement' | 'trending' | 'replies' | 'all';
  network: SocialNetwork;
  count: number;
  postId?: string;
  postUrl?: string;
  targetHandle?: string;
  scrollDuration?: number;
  cleanup: boolean;
}

export interface DryRunResult {
  total: number;
  passed: number;
  failed: number;
  generatedPostIds: string[];
}

export class DryRunRunner {
  private readonly logger = new Logger('DryRunRunner');

  constructor(
    private readonly app: INestApplication,
    private readonly reporter: DryRunReporter,
  ) {}

  async run(opts: DryRunOptions): Promise<DryRunResult> {
    const generatedPostIds: string[] = [];
    let postIdToPost = opts.postId;

    // ── Generation scenario ──
    if (opts.feature === 'generation' || opts.feature === 'all') {
      const genResult = await this.runGeneration(opts);
      if (genResult.postIds.length > 0) {
        generatedPostIds.push(...genResult.postIds);
        if (opts.feature === 'all' && !postIdToPost) {
          postIdToPost = genResult.postIds[0];
        }
      }
    }

    // ── Posting scenario ──
    if (opts.feature === 'posting' || opts.feature === 'all') {
      if (!postIdToPost) {
        postIdToPost = await this.findDraftForNetwork(opts.network);
      }
      if (postIdToPost) {
        await this.runPosting(postIdToPost, opts);
      } else {
        this.reporter.startFeature('Posting (Browser)');
        this.reporter.step('fail', `No post to dry-run post — provide --post-id or run generation first`);
        this.reporter.endFeature();
      }
    }

    // ── Engagement scenario (like, comment, scroll) ──
    if (opts.feature === 'engagement' || opts.feature === 'all') {
      await this.runEngagement(opts);
    }

    // ── Trending scenario (Google Trends + X trends scraping) ──
    if (opts.feature === 'trending' || opts.feature === 'all') {
      await this.runTrending(opts);
    }

    // ── Replies monitoring scenario ──
    if (opts.feature === 'replies' || opts.feature === 'all') {
      await this.runReplies(opts);
    }

    // ── Cleanup ──
    if (opts.cleanup && generatedPostIds.length > 0) {
      await this.cleanupPosts(generatedPostIds);
    }

    return { ...this.reporter.summary(), generatedPostIds };
  }

  /** Generation scenario — real LLM call, save drafts to DB. */
  private async runGeneration(opts: DryRunOptions): Promise<{ postIds: string[] }> {
    this.reporter.startFeature(`Generation (LLM \u2014 ${opts.network})`);

    const generationService = this.app.get(GenerationService);
    const llmService = this.app.get(LlmService);
    const postIds: string[] = [];

    try {
      // Report LLM provider chain
      const providers = llmService.getProviderStatus();
      const chain = providers.map((p) => `${p.name}/${p.model}`).join(' \u2192 ');
      this.reporter.step('ok', `Provider chain: ${chain}`);

      if (providers.length === 0) {
        this.reporter.step('fail', 'No LLM providers configured');
        this.reporter.endFeature();
        return { postIds };
      }

      // Report circuit breaker status
      const tripped = providers.filter((p) => p.circuitOpen);
      if (tripped.length > 0) {
        this.reporter.step('warn', `${tripped.length} provider(s) have open circuit breakers`, {
          tripped: tripped.map((p) => p.name),
        });
      }

      // Run generation — real LLM call
      this.reporter.step('ok', `Starting generation: ${opts.count} topic(s) \u2192 ${opts.network}`);
      const runId = await generationService.generate(
        opts.count,
        [opts.network],
        GenerationTrigger.MANUAL,
        false, // multiStage
        false, // humanReview
      );
      this.reporter.step('ok', `Generation run created`, { runId });

      // Fetch the generated posts from the run
      const run = await generationService.getRun(runId);
      if (!run) {
        this.reporter.step('fail', `Generation run ${runId} not found after creation`);
        this.reporter.endFeature();
        return { postIds };
      }

      const posts = run.posts ?? [];
      if (posts.length === 0) {
        this.reporter.step('warn', 'No posts generated (topics may be empty or LLM returned empty)');
        this.reporter.endFeature();
        return { postIds };
      }

      for (const post of posts) {
        postIds.push(post.id);
        const contentPreview = post.content.slice(0, 80).replace(/\n/g, ' ');
        this.reporter.step('ok', `Post generated`, {
          id: post.id,
          network: post.network,
          content: `${contentPreview}...`,
          status: post.status,
        });
      }

      this.reporter.step('ok', `${posts.length} draft(s) saved to PostgreSQL`);
      this.reporter.endFeature();
    } catch (err) {
      this.reporter.step('fail', `Generation failed: ${(err as Error).message}`);
      this.reporter.endFeature();
    }

    return { postIds };
  }

  /** Posting scenario — real browser, DryRunBrowserPort intercepts submit. */
  private async runPosting(postId: string, opts: DryRunOptions): Promise<void> {
    this.reporter.startFeature(`Posting (Browser \u2014 ${opts.network})`);

    const postsService = this.app.get(PostsService);
    const postingService = this.app.get(PostingService);
    const sessionsService = this.app.get(SessionsService);
    const accountsService = this.app.get(AccountsService);

    try {
      // 1. Verify the post exists
      let post;
      try {
        post = await postsService.findById(postId);
      } catch {
        this.reporter.step('fail', `Post ${postId} not found`);
        this.reporter.endFeature();
        return;
      }
      this.reporter.step('ok', `Post loaded`, {
        id: post.id,
        network: post.network,
        status: post.status,
        contentLength: post.content.length,
      });

      // 2. Approve the post (if not already approved)
      if (post.status !== PostStatus.APPROVED) {
        await postsService.approve(postId);
        this.reporter.step('ok', `Post approved (DRAFT \u2192 APPROVED)`);
      } else {
        this.reporter.step('ok', `Post already APPROVED`);
      }

      // 3. Check account exists
      const account = await accountsService.findByNetwork(post.network);
      if (!account) {
        this.reporter.step('fail', `No account configured for ${post.network}`);
        this.reporter.endFeature();
        return;
      }
      this.reporter.step('ok', `Account found`, { handle: account.handle });

      // 4. Check session (will trigger auto-login if needed)
      const session = await sessionsService.getOrCreateSession(post.network);
      if (!session) {
        this.reporter.step('fail', `No active session for ${post.network} \u2014 auto-login failed or credentials missing`);
        this.reporter.endFeature();
        return;
      }
      this.reporter.step('ok', `Session active`, {
        sessionId: session.id,
        lastHealthCheck: session.lastHealthCheck,
      });

      // 5. Run posting — real browser opens, DryRunBrowserPort intercepts submit
      this.reporter.step('ok', `Calling PostingService.postById(${postId}) \u2014 browser will open...`);
      const result = await postingService.postById(postId);

      if (result.success) {
        this.reporter.step('dry-run', `Submit intercepted \u2014 post NOT published to ${post.network}`, {
          syntheticUrl: result.url,
          screenshotDir: '/tmp/spa-screenshots/' + post.network.toLowerCase(),
        });

        // Verify post was marked as POSTED in DB (with synthetic URL)
        const updatedPost = await postsService.findById(postId);
        this.reporter.step('ok', `Post status updated in DB`, {
          status: updatedPost.status,
          postUrl: updatedPost.postUrl,
        });
      } else {
        this.reporter.step('fail', `Posting failed: ${result.error}`);
      }

      this.reporter.endFeature();
    } catch (err) {
      this.reporter.step('fail', `Posting scenario error: ${(err as Error).message}`);
      this.reporter.endFeature();
    }
  }

  /** Find an existing DRAFT post for the given network. */
  private async findDraftForNetwork(network: SocialNetwork): Promise<string | undefined> {
    try {
      const postsService = this.app.get(PostsService);
      const drafts = await postsService.findDrafts(network);
      return drafts[0]?.id;
    } catch {
      return undefined;
    }
  }

  // ── Engagement scenario ──────────────────────────────────────────

  /** Engagement scenario — login first, then scroll feed, like/comment/follow real posts. */
  private async runEngagement(opts: DryRunOptions): Promise<void> {
    this.reporter.startFeature(`Engagement (Browser \u2014 ${opts.network})`);

    try {
      const sessionsService = this.app.get(SessionsService);
      const { IBrowserPort } = await import('../domain/ports/browser.port.js');
      const browser = this.app.get(IBrowserPort);

      // 1. LOGIN FIRST — getOrCreateSession triggers auto-login if no session exists
      this.reporter.step('ok', `Logging in to ${opts.network}...`);
      const session = await sessionsService.getOrCreateSession(opts.network);
      if (!session) {
        this.reporter.step('fail', `Login failed for ${opts.network} \u2014 no session`);
        this.reporter.endFeature();
        return;
      }
      this.reporter.step('ok', `Login successful`, { sessionId: session.id });

      // 2. Acquire ONE browser context with the saved session storage state
      const storageState = session.storageState
        ? sessionsService.decryptStorageState(session)
        : undefined;
      let context: any = null;
      let page: any = null;

      try {
        context = await browser.acquireContext(opts.network, storageState);
        page = await context.newPage();

        if (typeof browser.setEngagementMode === 'function') {
          browser.setEngagementMode(page, true);
        }

        // 3. Get the engager for this network
        const engager = this.getEngagerForNetwork(opts.network);
        if (!engager) {
          this.reporter.step('fail', `No engager available for ${opts.network}`);
          return;
        }

        // 4. SCROLL FEED — collect real post URLs
        const scrollDuration = opts.scrollDuration ?? 15;
        this.reporter.step('ok', `Scrolling ${opts.network} feed for ${scrollDuration}s...`);
        let postUrls: string[] = [];
        try {
          postUrls = await engager.scrollFeed(page, scrollDuration);
          this.reporter.step('ok', `Feed scrolled: ${postUrls.length} posts discovered`, {
            urls: postUrls.slice(0, 3),
          });
        } catch (err) {
          this.reporter.step('warn', `Scroll failed: ${(err as Error).message.substring(0, 100)}`);
        }

        // 5. LIKE — use first real post from feed, or fall back to provided URL
        const likeTargetUrl = opts.postUrl ?? postUrls[0];
        if (likeTargetUrl) {
          this.reporter.step('ok', `Attempting like on: ${likeTargetUrl}`);
          try {
            const likeResult = await engager.like(page, likeTargetUrl);
            if (likeResult.success) {
              this.reporter.step('dry-run', `Like intercepted \u2014 NOT actually liked on ${opts.network}`, {
                screenshotPath: likeResult.screenshotPath,
              });
            } else {
              this.reporter.step('warn', `Like failed: ${likeResult.error}`);
            }
          } catch (err) {
            this.reporter.step('warn', `Like error: ${(err as Error).message.substring(0, 120)}`);
          }
        } else {
          this.reporter.step('warn', `No post URL to like (feed scroll returned 0 posts)`);
        }

        // 6. COMMENT — use same post
        const commentTargetUrl = opts.postUrl ?? postUrls[0];
        if (commentTargetUrl) {
          const commentText = 'Dry-run comment \u2014 not actually posted';
          this.reporter.step('ok', `Attempting comment on: ${commentTargetUrl}`);
          try {
            const commentResult = await engager.comment(page, commentTargetUrl, commentText);
            if (commentResult.success) {
              this.reporter.step('dry-run', `Comment intercepted \u2014 NOT actually posted to ${opts.network}`, {
                screenshotPath: commentResult.screenshotPath,
              });
            } else {
              this.reporter.step('warn', `Comment failed: ${commentResult.error}`);
            }
          } catch (err) {
            this.reporter.step('warn', `Comment error: ${(err as Error).message.substring(0, 120)}`);
          }
        }

        // 7. FOLLOW — use target handle or extract from first post
        const targetHandle = opts.targetHandle ?? this.extractHandleFromUrl(postUrls[0]) ?? this.getDefaultFollowHandle(opts.network);
        this.reporter.step('ok', `Attempting follow: ${targetHandle}`);
        try {
          const followResult = await engager.follow(page, targetHandle);
          if (followResult.success) {
            this.reporter.step('dry-run', `Follow intercepted \u2014 NOT actually followed on ${opts.network}`, {
              screenshotPath: followResult.screenshotPath,
            });
          } else {
            this.reporter.step('warn', `Follow failed: ${followResult.error}`);
          }
        } catch (err) {
          this.reporter.step('warn', `Follow error: ${(err as Error).message.substring(0, 120)}`);
        }

        // 8. EXTRACT POST TEXT — test text extraction on first post
        if (postUrls[0]) {
          this.reporter.step('ok', `Extracting text from: ${postUrls[0]}`);
          try {
            const extracted = await engager.extractPostText(page, postUrls[0]);
            this.reporter.step('ok', `Text extracted`, {
              text: extracted.text.substring(0, 80),
              hasMedia: extracted.hasMedia,
              author: extracted.authorHandle,
            });
          } catch (err) {
            this.reporter.step('warn', `Text extraction failed: ${(err as Error).message.substring(0, 100)}`);
          }
        }
      } finally {
        // Save updated session state and close context.
        // page/context may be null if acquisition failed — guard with null checks.
        try {
          if (context) {
            const updatedState = await browser.saveStorageState(context);
            await sessionsService.updateStorageState(session.id, updatedState);
          }
        } catch {
          // best-effort
        }
        try { if (page?.close) await page.close(); } catch { /* best-effort */ }
        try { if (context) await browser.releaseContext(opts.network, context); } catch { /* best-effort */ }
      }

      this.reporter.endFeature();
    } catch (err) {
      this.reporter.step('fail', `Engagement scenario error: ${(err as Error).message}`);
      this.reporter.endFeature();
    }
  }

  /** Get the engager for a network — uses app.get to resolve from DI. */
  private getEngagerForNetwork(network: SocialNetwork): import('../modules/engagement/engagers/base.engager.js').BaseEngager | null {
    try {
      const { XEngager } = require('../modules/engagement/engagers/x.engager.js');
      const { ThreadsEngager } = require('../modules/engagement/engagers/threads.engager.js');
      const { FacebookEngager } = require('../modules/engagement/engagers/facebook.engager.js');
      switch (network) {
        case SocialNetwork.X:
          return this.app.get(XEngager);
        case SocialNetwork.THREADS:
          return this.app.get(ThreadsEngager);
        case SocialNetwork.FACEBOOK:
          return this.app.get(FacebookEngager);
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /** Extract a handle from a post URL like https://x.com/handle/status/123 */
  private extractHandleFromUrl(url?: string): string | undefined {
    if (!url) return undefined;
    const match = url.match(/\/([^/]+)\/status\//);
    return match?.[1];
  }

  /** Default follow handle per network. */
  private getDefaultFollowHandle(network: SocialNetwork): string {
    switch (network) {
      case SocialNetwork.X:
        return 'elonmusk';
      case SocialNetwork.THREADS:
        return 'zuck';
      case SocialNetwork.FACEBOOK:
        return 'https://www.facebook.com/astrology';
      default:
        return 'testuser';
    }
  }

  // ── Trending scenario ────────────────────────────────────────────

  /** Trending scenario — scrape Google Trends + X trending topics. */
  private async runTrending(opts: DryRunOptions): Promise<void> {
    this.reporter.startFeature(`Trending (Scraper \u2014 ${opts.network})`);

    try {
      const trendingScraper = this.app.get(TrendingScraperService);

      // 1. Google Trends (no browser needed — RSS feed)
      this.reporter.step('ok', 'Fetching Google Trends (RSS)...');
      try {
        const googleTrends = await trendingScraper.getGoogleTrends(10);
        if (googleTrends.length > 0) {
          this.reporter.step('ok', `Google Trends: ${googleTrends.length} topics scraped`, {
            top5: googleTrends.slice(0, 5).map((t) => t.topic),
          });
        } else {
          this.reporter.step('warn', 'Google Trends returned 0 topics (RSS may be blocked)');
        }
      } catch (err) {
        this.reporter.step('warn', `Google Trends failed: ${(err as Error).message.substring(0, 100)}`);
      }

      // 2. X Trends (browser scraping — only for X network)
      if (opts.network === SocialNetwork.X) {
        this.reporter.step('ok', 'Scraping X trending topics (browser)...');
        try {
          const xTrends = await trendingScraper.getXTrends(10);
          if (xTrends.length > 0) {
            this.reporter.step('ok', `X Trends: ${xTrends.length} topics scraped`, {
              top5: xTrends.slice(0, 5).map((t) => t.topic),
            });
          } else {
            this.reporter.step('warn', 'X Trends returned 0 topics (session may be needed)');
          }
        } catch (err) {
          this.reporter.step('warn', `X Trends scraping failed: ${(err as Error).message.substring(0, 100)}`);
        }
      }

      // 3. Merged trending (astro + google + x) — requires astro topics input
      this.reporter.step('ok', 'Fetching merged trending topics...');
      try {
        const { TrendingService } = await import('../modules/trending/trending.service.js');
        const trendingService = this.app.get(TrendingService);
        const astroTopics = trendingService.getActiveTrending().map((t) => ({
          topic: t.topic,
          networks: t.networks,
        }));
        const merged = await trendingScraper.getMergedTrending(astroTopics);
        this.reporter.step('ok', `Merged trending: ${merged.length} topics`, {
          topics: merged.slice(0, 5).map((t) => ({
            topic: t.topic,
            sources: t.sources,
            priority: t.priority,
          })),
        });
      } catch (err) {
        this.reporter.step('warn', `Merged trending failed: ${(err as Error).message.substring(0, 100)}`);
      }

      this.reporter.endFeature();
    } catch (err) {
      this.reporter.step('fail', `Trending scenario error: ${(err as Error).message}`);
      this.reporter.endFeature();
    }
  }

  // ── Replies monitoring scenario ──────────────────────────────────

  /** Replies monitoring scenario — login first, then scrape comments on posted content. */
  private async runReplies(opts: DryRunOptions): Promise<void> {
    this.reporter.startFeature(`Replies Monitor \u2014 ${opts.network}`);

    try {
      const sessionsService = this.app.get(SessionsService);
      const repliesMonitor = this.app.get(RepliesMonitorService);

      // 1. LOGIN FIRST — replies monitor needs a session to scrape comments
      this.reporter.step('ok', `Logging in to ${opts.network}...`);
      const session = await sessionsService.getOrCreateSession(opts.network);
      if (!session) {
        this.reporter.step('fail', `Login failed for ${opts.network} \u2014 no session`);
        this.reporter.endFeature();
        return;
      }
      this.reporter.step('ok', `Login successful`, { sessionId: session.id });

      // 2. Run a monitoring cycle — scrapes comments on recent posts
      this.reporter.step('ok', 'Running monitoring cycle (scrape comments on recent posts)...');
      try {
        const result = await repliesMonitor.runMonitoringCycle();
        this.reporter.step('ok', `Monitoring cycle completed`, {
          postsChecked: result.postsChecked,
          commentsScraped: result.commentsScraped,
          repliesPosted: result.repliesPosted,
          humanReview: result.humanReview,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('not enabled') || msg.includes('REPLIES_ENABLED')) {
          this.reporter.step('warn', `Replies monitoring not enabled (set REPLIES_ENABLED=true to test)`);
        } else {
          this.reporter.step('warn', `Monitoring cycle failed: ${msg.substring(0, 120)}`);
        }
      }

      this.reporter.endFeature();
    } catch (err) {
      this.reporter.step('fail', `Replies scenario error: ${(err as Error).message}`);
      this.reporter.endFeature();
    }
  }

  /** Delete dry-run generated posts from DB. */
  private async cleanupPosts(postIds: string[]): Promise<void> {
    this.reporter.startFeature('Cleanup');
    try {
      const postsService = this.app.get(PostsService);
      const prisma = (postsService as unknown as { prisma: { post: { delete: (args: { where: { id: string } }) => Promise<unknown> } } }).prisma;
      for (const id of postIds) {
        await prisma.post.delete({ where: { id } });
      }
      this.reporter.step('ok', `Deleted ${postIds.length} dry-run post(s) from DB`);
    } catch (err) {
      this.reporter.step('warn', `Cleanup failed: ${(err as Error).message}`);
    }
    this.reporter.endFeature();
  }
}
