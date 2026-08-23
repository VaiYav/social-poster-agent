/**
 * ENGAGE-101 / F4: Replies Monitor Service — automated comment monitoring and reply posting.
 *
 * This service runs on a cron (default: every 4 hours) and:
 *   1. Finds posts posted in the last 24h that have a postUrl
 *   2. Scrapes comments from each post using browser automation
 *   3. Saves new comments as IncomingComment records (dedup by commentId)
 *   4. For each NEW comment, decides whether to reply:
 *      - Skip: spam/troll, self-reply, already replied
 *      - Auto-reply: simple positive comments, questions (LLM-generated)
 *      - Human review: complex/sensitive/negative comments
 *   5. Posts auto-replies via the engagement module's engagers
 *   6. Sends Discord alerts for human-review items
 *
 * Env-gated: only active when REPLIES_ENABLED=true.
 *
 * Config:
 *   REPLIES_ENABLED=true/false
 *   REPLIES_CRON_SCHEDULE=0 STAR/4 STAR STAR STAR  (every 4 hours, see .env)
 *   REPLIES_MAX_PER_POST=3
 *   REPLIES_DELAY_MIN_MS=300000  (5 min delay between replies to same post)
 *   REPLIES_AUTO_REPLY_COMPLEXITY=medium  (low/medium/high — threshold for human review)
 *
 * ALL reply content is LLM-generated. No template fallback.
 * When all LLM providers fail, comments are skipped (stay NEW) and retried
 * in the next monitoring cycle when providers may have recovered.
 */
import { Injectable, Logger, Optional, Inject, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import IORedis from "ioredis";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { AccountsService } from "../accounts/accounts.service.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { IBrowserPort } from "../../domain/ports/browser.port.js";
import { buildCommentId } from "./comment-id.js";
import { detectSensitive, isLikelyTroll, isLowValueComment } from "./sensitive-filter.js";
import { ILlmPort } from "../../domain/ports/llm.port.js";
import { sanitizeUntrustedInput } from "../../infrastructure/llm/sanitize-untrusted-input.js";
import { DiscordNotificationService } from "../../infrastructure/notifications/discord-notification.service.js";
import { SseService } from "../../infrastructure/sse/sse.service.js";
import { EngagementService } from "../engagement/engagement.service.js";
import { QueueFactory } from "../../infrastructure/queue/queue.factory.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";
import { PostStatus, SocialNetwork, CommentStatus } from "../../generated/prisma/client.js";
import type { IncomingComment } from "../../generated/prisma/client.js";
import type { Locator, Page } from "../../domain/ports/browser-primitives.js";
import { IPromptPort } from "../../domain/ports/prompt.port.js";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import { isOrchestratorEnabled } from "../../domain/feature-flags.js";
import { matchesScript, normalizeLanguage } from "../../infrastructure/util/script-check.js";
import { detectLanguage } from "../../infrastructure/util/language-detector.js";
import { getEnabledNetworks } from "../../domain/enabled-networks.js";
import { DialogueService, type DialogueDecision } from "./dialogue.service.js";
import { QuestionClassifierService } from "./question-classifier.service.js";
import {
  CommentSafetyClassifierService,
  type CommentSafetyClassification,
} from "./comment-safety-classifier.service.js";

const DAILY_REPLY_TTL_SECONDS = 2 * 24 * 60 * 60; // 2 days

/**
 * Atomically reserve a daily reply slot. Returns {1, newCount} if within the
 * limit, or {0, currentCount} if the budget has been reached.
 *
 * Keeps the check-and-increment in a single Redis EVAL to avoid TOCTOU races
 * when multiple workers or instances reserve concurrently.
 */
const RESERVE_REPLY_SLOT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local current = tonumber(redis.call('get', key) or '0')
if limit > 0 and current >= limit then
  return {0, current}
end

local new = redis.call('incr', key)
if new == 1 then
  redis.call('expire', key, ttl)
end
return {1, new}
`;

/**
 * Atomically release a previously reserved slot, but never below zero.
 */
const RELEASE_REPLY_SLOT_SCRIPT = `
local key = KEYS[1]
local current = tonumber(redis.call('get', key) or '0')
if current > 0 then
  redis.call('decr', key)
end
return current
`;

export interface ScrapedComment {
  commentId: string; // platform native id or h:hash
  author: string;
  text: string;
  authorProfileUrl?: string | null;
  commentUrl?: string | null; // absolute platform permalink of this comment
  nativeId?: string | null; // platform-native id (status id / post id / comment id)
}

export type ReplyDecision = DialogueDecision;

@Injectable()
export class RepliesMonitorService implements OnModuleInit {
  private readonly logger = new Logger(RepliesMonitorService.name);
  private readonly enabled: boolean;
  private readonly cronSchedule: string;
  private readonly maxRepliesPerPost: number;
  private readonly maxConversationDepth: number;
  private readonly autoReplyComplexity: "low" | "medium" | "high";
  private readonly repliesTemperature: number;
  private readonly maxRepliesPerDay: number;
  private readonly failClosed: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly accountsService: AccountsService,
    private readonly sessionsService: SessionsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly discord: DiscordNotificationService,
    private readonly sseService: SseService,
    private readonly dialogueService: DialogueService,
    @Optional() @Inject(ILlmPort) private readonly llmService?: ILlmPort,
    @Optional() @Inject(IBrowserPort) private readonly browser?: IBrowserPort,
    @Optional() private readonly engagementService?: EngagementService,
    // RP1: when present, auto-replies are scheduled as delayed BullMQ jobs instead of
    // blocking the cron with an inline setTimeout. Absent in unit tests (inline fallback).
    @Optional() private readonly queueFactory?: QueueFactory,
    @Optional() private readonly flowControl?: FlowControlService,
    // EVAL-103: versioned reply-decision prompt via PromptRegistry; absent in unit tests.
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
    @Optional() private readonly commentSafetyClassifier?: CommentSafetyClassifierService,
    @Optional() @Inject(SHARED_REDIS) private readonly redis?: IORedis,
  ) {
    this.enabled = parseBool(this.configService.get<string>("REPLIES_ENABLED", "false"));
    this.cronSchedule = this.configService.get<string>("REPLIES_CRON_SCHEDULE", "0 */4 * * *");
    const rawMax = Number(this.configService.get<string>("REPLIES_MAX_PER_POST", "3"));
    this.maxRepliesPerPost = Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : 3;
    const rawDepth = Number(this.configService.get<string>("REPLIES_MAX_CONVERSATION_DEPTH", "3"));
    this.maxConversationDepth =
      Number.isFinite(rawDepth) && rawDepth > 0 ? Math.floor(rawDepth) : 3;
    const rawComplexity = this.configService.get<string>("REPLIES_AUTO_REPLY_COMPLEXITY", "medium");
    this.autoReplyComplexity =
      rawComplexity === "low" || rawComplexity === "medium" || rawComplexity === "high"
        ? rawComplexity
        : "medium";
    // B1: read temperature from ConfigService (validated by Joi) instead of process.env at import time.
    const rawTemp = Number(this.configService.get<string>("REPLIES_TEMPERATURE", "0.6"));
    this.repliesTemperature =
      Number.isFinite(rawTemp) && rawTemp >= 0 && rawTemp <= 2 ? rawTemp : 0.6;

    // F4: daily per-network reply budget. 0 means unlimited.
    const rawDaily = Number(this.configService.get<string>("REPLIES_MAX_PER_DAY", "10"));
    this.maxRepliesPerDay = Number.isFinite(rawDaily) && rawDaily >= 0 ? Math.floor(rawDaily) : 10;

    this.failClosed = parseBool(this.configService.get<string>("RATE_LIMIT_FAIL_CLOSED", "false"));
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log("Replies monitor disabled (REPLIES_ENABLED=false)");
      return;
    }

    // Orchestrator mode: CHECK_REPLIES is handled by the orchestrator decision loop.
    if (isOrchestratorEnabled()) {
      this.logger.log("Orchestrator is enabled — replies monitor cron NOT registered");
      return;
    }

    const job = new CronJob(this.cronSchedule, async () => {
      await this.runMonitoringCycle();
    });

    try {
      this.schedulerRegistry?.addCronJob("replies-monitor", job);
      job.start();
      this.logger.log(`Replies monitor cron registered: ${this.cronSchedule}`);
    } catch {
      this.logger.warn("SchedulerRegistry not available — replies monitor cron will not run");
    }
  }

  /**
   * Main monitoring cycle — called by cron.
   * 1. Get monitorable posts (posted in last 24h)
   * 2. Scrape comments from each post
   * 3. Process new comments (decide + reply/flag)
   */
  async runMonitoringCycle(): Promise<{
    postsChecked: number;
    commentsScraped: number;
    repliesPosted: number;
    repliesScheduled: number;
    humanReview: number;
  }> {
    this.logger.log("Replies monitoring cycle started");
    const stats = {
      postsChecked: 0,
      commentsScraped: 0,
      repliesPosted: 0,
      repliesScheduled: 0,
      humanReview: 0,
    };

    // 2.9.3: Respect flow control — skip cycle if replies flow is paused.
    if (this.flowControl && (await this.flowControl.isPaused("replies"))) {
      this.logger.warn("Replies flow is paused — skipping monitoring cycle");
      return stats;
    }

    try {
      const posts = await this.getMonitorablePosts();
      this.logger.log(`Found ${posts.length} posts to monitor for comments`);

      for (const post of posts) {
        try {
          if (!post.postUrl) continue;

          // 1. Scrape top-level comments on the post page
          const comments = await this.scrapeCommentsFromUrl(
            post.accountId,
            post.network as SocialNetwork,
            post.postUrl,
            [post.content],
          );
          stats.postsChecked++;
          stats.commentsScraped += comments.length;

          // Save new comments to DB (dedup by commentId)
          let newComments = await this.saveNewComments(
            post.id,
            post.network as SocialNetwork,
            comments,
          );

          // 2. Scrape nested replies to already-posted agent replies. This opens the
          // reply permalink and looks for follow-up comments in the thread.
          const nested = await this.scrapeNestedReplies(post);
          newComments = newComments.concat(nested);

          // Process each new comment
          for (const comment of newComments) {
            // RP1 re-entrancy guard: a reply may already be scheduled (a delayed BullMQ
            // job) from an earlier cycle. The comment stays NEW until the job posts it,
            // so without this guard we would re-run the (costly) LLM decision every cycle.
            // jobId=commentId; the lookup is Redis-backed, so it survives restarts.
            if (
              this.queueFactory &&
              (await this.queueFactory.getEngagementJob(comment.commentId, post.network))
            ) {
              this.logger.debug(
                `Reply already scheduled for comment ${comment.commentId} — skipping re-decision`,
              );
              continue;
            }
            const decision = await this.decideReply(post, comment);
            await this.executeDecision(post, comment, decision, stats);
          }
        } catch (err) {
          this.logger.warn(`Failed to monitor post ${post.id}: ${(err as Error).message}`);
        }
      }

      this.logger.log(
        `Replies monitoring cycle complete: ${stats.postsChecked} posts, ${stats.commentsScraped} comments, ${stats.repliesPosted} replies posted, ${stats.repliesScheduled} scheduled, ${stats.humanReview} human review`,
      );

      // SSE event for UI
      await this.sseService.publish({
        type: "replies_monitor",
        ...stats,
      });

      // Discord summary if there are human review items
      if (stats.humanReview > 0) {
        await this.discord.warning(
          "Comments Need Human Review",
          `${stats.humanReview} comment(s) require human review. Check the UI for details.`,
        );
      }

      return stats;
    } catch (err) {
      this.logger.error(`Replies monitoring cycle failed: ${(err as Error).message}`);
      return stats;
    }
  }

  /**
   * Get posts that are eligible for reply monitoring (posted in last 24h).
   */
  private async getMonitorablePosts(): Promise<
    { id: string; accountId: string; network: string; postUrl: string | null; content: string }[]
  > {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.prisma.post.findMany({
      where: {
        status: PostStatus.POSTED,
        postedAt: { gte: twentyFourHoursAgo },
        postUrl: { not: null },
        network: { in: getEnabledNetworks() },
      },
      select: {
        id: true,
        accountId: true,
        network: true,
        postUrl: true,
        content: true,
      },
    });
  }

  /**
   * Scrape nested replies to any agent replies already posted on this post.
   * Only parents with depth < maxConversationDepth are eligible (the hard limit
   * protects against infinite reply loops). Returns all newly discovered nested comments.
   */
  private async scrapeNestedReplies(post: {
    id: string;
    accountId: string;
    network: string;
    postUrl: string | null;
    content: string;
  }): Promise<IncomingComment[]> {
    const allNested: IncomingComment[] = [];
    if (!this.browser || !post.postUrl) return allNested;

    const parents = await this.prisma.incomingComment.findMany({
      where: {
        postId: post.id,
        status: { in: [CommentStatus.REPLIED, CommentStatus.REPLIED_MANUAL] },
        replyPostedAt: { not: null },
        depth: { lt: this.maxConversationDepth },
        OR: [{ replyUrl: { not: null } }, { commentUrl: { not: null } }],
      },
      take: 10,
      orderBy: { replyPostedAt: "desc" },
    });

    for (const parent of parents) {
      try {
        const targetUrl = parent.replyUrl ?? parent.commentUrl;
        if (!targetUrl) continue;

        const skipTexts = [post.content, parent.text, parent.replyText ?? ""];
        const scraped = await this.scrapeCommentsFromUrl(
          post.accountId,
          post.network as SocialNetwork,
          targetUrl,
          skipTexts,
        );

        const nested = await this.saveNewComments(
          post.id,
          post.network as SocialNetwork,
          scraped,
          parent,
        );
        allNested.push(...nested);
      } catch (err) {
        this.logger.warn(
          `Failed to scrape nested replies for parent ${parent.id}: ${(err as Error).message}`,
        );
      }
    }

    return allNested;
  }

  /**
   * Scrape comments from a URL using browser automation.
   * Used for both root posts and nested reply pages.
   */
  private async scrapeCommentsFromUrl(
    accountId: string,
    network: SocialNetwork,
    url: string,
    skipTexts: string[],
  ): Promise<ScrapedComment[]> {
    if (!this.browser) {
      this.logger.warn("Browser port not available — cannot scrape comments");
      return [];
    }

    let context: Awaited<ReturnType<typeof this.browser.acquireContext>> | null = null;
    let page: Page | null = null;

    try {
      // Get or create a session for this account
      const session = await this.sessionsService.getOrCreateSession(accountId, network);
      if (!session) {
        this.logger.warn(`No active session for ${network} — cannot scrape comments`);
        return [];
      }

      // Decrypt storage state and acquire browser context
      const sessionWithData = await this.prisma.session.findUnique({
        where: { id: session.id },
        select: { storageState: true },
      });
      if (!sessionWithData) {
        this.logger.warn(`Session ${session.id} not found in DB`);
        return [];
      }
      const storageState = this.sessionsService.decryptStorageState(sessionWithData);
      context = await this.browser.acquireContext(network, storageState, accountId);
      page = await context.newPage();

      // Suppress uncaught page-side JS errors (social feeds throw many) that can
      // crash the Playwright/Camoufox Firefox driver (see browser.factory.ts doc).
      await this.browser.suppressPageErrors(page);
      // MEM: block images/media/fonts — comment scraping only needs text. The
      // scrollForComments loop scrolls media-heavy feeds, which is the exact OOM
      // scenario from camoufox#87. Blocking images prevents renderer memory blowup.
      await this.browser.applyResourceBlocking(page, { blockImages: true });

      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(3000); // Let comments load

      // Scroll to load more comments
      await this.scrollForComments(page);

      // Extract comments using network-specific selectors
      const comments = await this.extractComments(page, network, skipTexts);

      this.logger.debug(`Scraped ${comments.length} comments from ${network} URL ${url}`);
      return comments;
    } catch (err) {
      this.logger.warn(`Comment scraping failed for ${url}: ${(err as Error).message}`);
      return [];
    } finally {
      if (page) await page.close().catch(() => void 0);
      if (context && this.browser) {
        try {
          this.browser.releaseContext(network, context, accountId);
        } catch {
          // Ignore release errors
        }
      }
    }
  }

  /**
   * Scroll the page to load more comments (lazy loading).
   */
  private async scrollForComments(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(1500);
    }
  }

  /**
   * Extract comments from the page using network-specific selectors.
   * Each network has a different DOM structure for comments.
   *
   * `skipTexts` lets callers skip the root post text, the parent reply text, etc.
   */
  private async extractComments(
    page: Page,
    network: SocialNetwork,
    skipTexts: string[],
  ): Promise<ScrapedComment[]> {
    const selectors = this.getCommentSelectors(network);
    const comments: ScrapedComment[] = [];

    const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedSkipTexts = skipTexts.map((s) => normalize(s)).filter(Boolean);

    try {
      const commentElements = await page.locator(selectors.commentContainer).all();

      for (const el of commentElements.slice(0, 20)) {
        // Limit to 20 comments per post
        try {
          const text =
            (await el.locator(selectors.commentText).first().textContent())?.trim() ?? "";
          const author =
            (await el.locator(selectors.author).first().textContent())?.trim() ?? "unknown";

          if (!text || text.length < 2) continue;

          // 2.9.2: The original post or parent reply is often included in the same container list.
          // Skip any element whose text matches one of the skipTexts (root post content, parent reply, etc.).
          const normalizedText = normalize(text);
          if (normalizedSkipTexts.includes(normalizedText)) {
            continue;
          }

          // 2.9.1: Extract a profile URL for the author so self-reply detection
          // uses the handle, not the display name (which can match other users).
          const authorProfileUrl = await this.extractAuthorProfileUrl(el, network);

          // Extract platform-native id and permalink where possible. This is required
          // for nested reply scraping and replying directly to a specific comment.
          const { nativeId, commentUrl } = await this.extractNativeIdAndUrl(
            el,
            network,
            authorProfileUrl,
          );

          // RP2: stable, script-safe commentId — prefer the platform native id when available.
          const commentId = buildCommentId(author, text, nativeId);

          comments.push({ commentId, author, text, authorProfileUrl, nativeId, commentUrl });
        } catch {
          // Skip individual comment extraction errors
        }
      }
    } catch (err) {
      this.logger.debug(`Comment extraction failed for ${network}: ${(err as Error).message}`);
    }

    return comments;
  }

  /**
   * Try to extract the platform-native comment id and absolute permalink from a
   * comment element. Used to reply directly to a comment and to scrape nested replies.
   */
  private async extractNativeIdAndUrl(
    el: Locator,
    network: SocialNetwork,
    authorProfileUrl: string | null,
  ): Promise<{ nativeId: string | null; commentUrl: string | null }> {
    try {
      if (network === SocialNetwork.X) {
        const href = await el.locator('a[href*="/status/"]').first().getAttribute("href");
        const match = href?.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/);
        if (match?.[2]) {
          const nativeId = match[2];
          const handle = match[1];
          return { nativeId, commentUrl: `https://x.com/${handle}/status/${nativeId}` };
        }
        return { nativeId: null, commentUrl: null };
      }

      if (network === SocialNetwork.THREADS) {
        const href = await el.locator('a[href*="/post/"]').first().getAttribute("href");
        const match = href?.match(/^\/(@[^/]+)\/post\/(\d+)(?:\/|$)/);
        if (match?.[2] && authorProfileUrl) {
          const nativeId = match[2];
          return {
            nativeId,
            commentUrl: `https://www.threads.com${authorProfileUrl}/post/${nativeId}`,
          };
        }
        return { nativeId: null, commentUrl: null };
      }

      if (network === SocialNetwork.FACEBOOK) {
        const nativeId = await el.getAttribute("data-commentid");
        if (nativeId) {
          // Facebook comment permalinks need a page/post slug; we cannot build a full
          // URL from the element alone. Leave commentUrl null for the parent-post reply path.
          return { nativeId, commentUrl: null };
        }
        return { nativeId: null, commentUrl: null };
      }
    } catch {
      // ignore extraction failures
    }
    return { nativeId: null, commentUrl: null };
  }

  /**
   * 2.9.1: Extract the author's profile URL from a comment element.
   * This is more reliable than the display name for self-reply detection.
   */
  private async extractAuthorProfileUrl(
    el: Locator,
    network: SocialNetwork,
  ): Promise<string | null> {
    try {
      switch (network) {
        case SocialNetwork.X:
          return await el
            .locator('[data-testid="User-Name"] a[href^="/"]')
            .first()
            .getAttribute("href");
        case SocialNetwork.THREADS:
          return await el.locator('a[href^="/@"]').first().getAttribute("href");
        case SocialNetwork.FACEBOOK:
          return await el.locator('a[href*="/user/"]').first().getAttribute("href");
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Network-specific CSS selectors for comment elements.
   */
  private getCommentSelectors(network: SocialNetwork): {
    commentContainer: string;
    commentText: string;
    author: string;
  } {
    switch (network) {
      case SocialNetwork.X:
        return {
          commentContainer: '[data-testid="cellInnerDiv"] article',
          commentText: '[data-testid="tweetText"]',
          author: '[data-testid="User-Name"]',
        };
      case SocialNetwork.THREADS:
        return {
          commentContainer: 'div[role="article"]',
          commentText: 'div[dir="auto"] > span',
          author: 'a[href*="/@"] span',
        };
      case SocialNetwork.FACEBOOK:
        return {
          commentContainer: 'div[aria-label*="Comment"]',
          commentText: 'div[dir="auto"]',
          author: 'span a[href*="/user/"]',
        };
      default:
        return { commentContainer: "", commentText: "", author: "" };
    }
  }

  /**
   * Save new comments to DB. Returns only the NEW comments (not already seen).
   *
   * When a `parent` is provided, comments are saved as nested replies to that parent,
   * inheriting the conversation root id and depth.
   */
  private async saveNewComments(
    postId: string,
    network: SocialNetwork,
    comments: ScrapedComment[],
    parent?: IncomingComment | null,
  ): Promise<IncomingComment[]> {
    const newComments: IncomingComment[] = [];

    for (const comment of comments) {
      try {
        const conversationId = parent?.conversationId ?? comment.commentId;
        const depth = parent ? parent.depth + 1 : 0;

        const created = await this.prisma.incomingComment.upsert({
          where: { postId_commentId: { postId, commentId: comment.commentId } },
          update: {}, // Don't update existing — we only want NEW comments
          create: {
            postId,
            network,
            commentId: comment.commentId,
            author: comment.author,
            text: comment.text,
            authorProfileUrl: comment.authorProfileUrl ?? null,
            commentUrl: comment.commentUrl ?? null,
            parentId: parent?.id ?? null,
            conversationId,
            depth,
            status: CommentStatus.NEW,
          },
        });

        // Only process comments that are NEW (just created)
        if (created.status === CommentStatus.NEW) {
          newComments.push(created);
        }
      } catch {
        // Skip duplicates or errors
      }
    }

    return newComments;
  }

  /**
   * Decide whether to auto-reply, flag for human review, or skip.
   * ALL reply content is LLM-generated — no template fallback.
   * When LLM is unavailable, the comment is skipped (stays NEW for retry next cycle).
   */
  async decideReply(
    post: { id: string; network: string; content: string },
    comment: Partial<IncomingComment>,
  ): Promise<ReplyDecision> {
    const text = comment.text ?? "";

    // 1. Skip spam/trolls (deterministic check first — free; word-boundary so "about" ≠ "bot")
    if (isLikelyTroll(text)) {
      return { action: "skip", reason: "Potential troll/spam — skipped" };
    }

    // 2. Don't reply to our own comments — compare against the handles of ALL
    // active accounts on this network (M1.1 multi-account: a comment authored
    // by our second account must also be recognized as self-reply).
    // 2.9.1: Prefer the author profile URL because display names can match other users.
    try {
      const accounts = await this.accountsService.findByNetwork(post.network as SocialNetwork);
      const commentHandle = comment.authorProfileUrl
        ? extractHandleFromProfileUrl(comment.authorProfileUrl)
        : normalizeHandle(comment.author ?? "");
      if (commentHandle) {
        const normalized = commentHandle.toLowerCase().trim();
        const ownAccount = accounts.find((a) => a.handle.toLowerCase().trim() === normalized);
        if (ownAccount) {
          return { action: "skip", reason: "Self-reply skipped (own account)" };
        }
      }
    } catch {
      // Account lookup failed — continue
    }

    // 3. Check max replies per post
    const existingRepliesCount = await this.prisma.incomingComment.count({
      where: {
        postId: post.id,
        status: { in: [CommentStatus.REPLIED, CommentStatus.REPLIED_MANUAL] },
      },
    });
    if (existingRepliesCount >= this.maxRepliesPerPost) {
      return { action: "skip", reason: `Max replies per post reached (${this.maxRepliesPerPost})` };
    }

    // RP3: deterministic sensitive-topic backstop — runs BEFORE the LLM so a misclassification
    // can never auto-reply to grief/crisis/complaint.
    const sensitive = detectSensitive(text);
    if (sensitive.sensitive) {
      return {
        action: "human_review",
        reason: `Sensitive topic (${sensitive.kind}) — requires human review`,
        reviewReason: sensitive.reason,
      };
    }

    // 4. Low-value comment pre-filter — deterministic check for comments that don't warrant
    // a reply (emoji-only, generic reactions, follow-bait, pure hashtags). Saves an LLM call.
    // Runs AFTER sensitive check so crisis/complaint comments still go to human_review.
    const lowValue = isLowValueComment(text);
    if (lowValue.lowValue) {
      return { action: "skip", reason: lowValue.reason ?? "Low-value comment — skipped" };
    }

    // 5. F4: LLM safety gate — detect prompt injection, spam, toxicity, and sensitive topics.
    // Runs before the reply-generation LLM so we never generate a reply for an unsafe comment.
    const safety = await this.runSafetyCheck(text);
    if (safety) {
      return safety;
    }

    // 6. F4: daily per-network reply budget. Exceeding the budget short-circuits
    // before the reply LLM, saving tokens and preventing bot-like over-replying.
    const dailyBudgetAvailable = await this.checkDailyReplyBudget(post.network as SocialNetwork);
    if (!dailyBudgetAvailable) {
      return {
        action: "skip",
        reason: `Daily reply budget reached for ${post.network} (${this.maxRepliesPerDay}/day)`,
      };
    }

    // 7. Dialogue graph: classify the comment as a question, build conversation
    // context, and decide whether to reply / skip / escalate. The graph enforces
    // the hard depth limit and language/script validation.
    if (!this.llmService) {
      this.logger.warn("LlmService not available — skipping comment (will retry next cycle)");
      return { action: "skip", reason: "LLM service not available — will retry next cycle" };
    }
    if (!this.dialogueService) {
      return { action: "skip", reason: "Dialogue service not available" };
    }

    // Rehydrate a full IncomingComment from the passed projection. In production
    // this comes from saveNewComments; in tests it may be a partial stub.
    const fullComment: IncomingComment = {
      id: comment.id ?? "unknown",
      postId: comment.postId ?? post.id,
      network: (comment.network ?? post.network) as SocialNetwork,
      commentId: comment.commentId ?? "unknown",
      author: comment.author ?? "unknown",
      text,
      authorProfileUrl: comment.authorProfileUrl ?? null,
      commentUrl: comment.commentUrl ?? null,
      parentId: comment.parentId ?? null,
      conversationId: comment.conversationId ?? comment.commentId ?? "unknown",
      depth: comment.depth ?? 0,
      isQuestion: comment.isQuestion ?? false,
      questionConfidence: comment.questionConfidence ?? null,
      questionType: comment.questionType ?? null,
      replyUrl: comment.replyUrl ?? null,
      status: comment.status ?? CommentStatus.NEW,
      replyText: comment.replyText ?? null,
      replyPostedAt: comment.replyPostedAt ?? null,
      needsHumanReview: comment.needsHumanReview ?? false,
      humanReviewReason: comment.humanReviewReason ?? null,
      scrapedAt: comment.scrapedAt ?? new Date(),
      createdAt: comment.createdAt ?? new Date(),
    };

    return this.dialogueService.processComment(fullComment, post.content);
  }

  /**
   * F4: run the LLM-based safety classifier and convert the result into a reply decision.
   * Returns a decision if the comment should be skipped or escalated; null if it is safe
   * to continue down the reply pipeline.
   */
  private async runSafetyCheck(text: string): Promise<DialogueDecision | null> {
    if (!this.commentSafetyClassifier) {
      // No classifier wired (e.g. unit tests) — continue to the next filter.
      return null;
    }

    const detectedLanguage = detectLanguage(text);
    const classification = await this.commentSafetyClassifier.classify(text, detectedLanguage);

    if (classification.risk === "none") {
      return null;
    }

    this.logger.log(
      `Safety gate: comment classified as ${classification.risk} (${classification.confidence.toFixed(2)}). ${classification.reason}`,
    );

    // Spam/injection are silently skipped. Toxic/sensitive are escalated for human review.
    if (classification.risk === "injection" || classification.risk === "spam") {
      return {
        action: "skip",
        reason: `Safety gate: ${classification.risk} (${classification.reason})`,
      };
    }

    return {
      action: "human_review",
      reason: `Safety gate: ${classification.risk} — escalated to human review`,
      reviewReason: classification.reason,
    };
  }

  /**
   * Execute the reply decision — post reply, flag for review, or skip.
   */
  private async executeDecision(
    post: { id: string; network: string; postUrl: string | null; content: string },
    comment: Partial<IncomingComment>,
    decision: ReplyDecision,
    stats: {
      postsChecked: number;
      commentsScraped: number;
      repliesPosted: number;
      repliesScheduled: number;
      humanReview: number;
    },
  ): Promise<void> {
    switch (decision.action) {
      case "skip": {
        await this.prisma.incomingComment.update({
          where: { id: comment.id! },
          data: { status: CommentStatus.SKIPPED },
        });
        this.logger.debug(`Skipped comment ${comment.commentId}: ${decision.reason}`);
        break;
      }

      case "human_review": {
        await this.prisma.incomingComment.update({
          where: { id: comment.id! },
          data: {
            status: CommentStatus.HUMAN_REVIEW,
            needsHumanReview: true,
            humanReviewReason: decision.reviewReason ?? decision.reason,
            replyText: decision.replyText ?? null,
          },
        });
        stats.humanReview++;
        this.logger.log(
          `Comment ${comment.commentId} flagged for human review: ${decision.reviewReason ?? decision.reason}`,
        );
        break;
      }

      case "auto_reply": {
        if (!decision.replyText) {
          this.logger.warn(`Auto-reply decision has no replyText — skipping`);
          return;
        }

        // Reply directly to the comment's permalink when available; fall back to the post URL.
        // This enables nested conversation threads (reply-to-reply) on X/Threads.
        const targetCommentUrl = comment.commentUrl ?? post.postUrl ?? "";
        if (!targetCommentUrl) {
          this.logger.warn(
            `Auto-reply for comment ${comment.commentId} has no target URL — cannot reply`,
          );
          return;
        }

        // Human-like delay before posting (5-30 min random). Instant replies look
        // bot-like and can trigger platform detection.
        const delay = this.computeReplyDelayMs();

        // RP1: schedule the reply as a BullMQ *delayed* job instead of blocking the cron
        // with an inline `await setTimeout(5-30min)`. jobId=commentId makes it idempotent
        // (no duplicate replies even across restarts) and the cron stays responsive.
        if (this.queueFactory) {
          await this.queueFactory.enqueueEngagement(
            comment.commentId!,
            post.network,
            "reply",
            {
              commentDbId: comment.id!,
              commentId: comment.commentId!,
              postId: post.id,
              postUrl: post.postUrl,
              targetCommentUrl,
              replyText: decision.replyText,
            },
            { delay },
          );
          // Persist the decided reply text so the UI can show it while the job waits.
          // Status stays NEW until the worker posts it; the re-entrancy guard (an
          // existing engagement job for this commentId) prevents re-deciding it.
          await this.prisma.incomingComment.update({
            where: { id: comment.id! },
            data: { replyText: decision.replyText },
          });
          this.logger.log(
            `Auto-reply scheduled for comment ${comment.commentId} on post ${post.id} (~${Math.round(delay / 60000)}min)`,
          );
          stats.repliesScheduled++;
          break;
        }

        // Fallback when no queue is wired (e.g. unit tests): post immediately. This path
        // no longer blocks on a 5-30 min timer — production always has the queue.
        if (this.engagementService) {
          try {
            await this.postScheduledReply({
              commentDbId: comment.id!,
              commentId: comment.commentId!,
              postId: post.id,
              network: post.network,
              postUrl: post.postUrl,
              targetCommentUrl,
              replyText: decision.replyText,
            });
            stats.repliesPosted++;
          } catch (err) {
            this.logger.warn(
              `Reply posting error for comment ${comment.commentId}: ${(err as Error).message}`,
            );
            // Comment stays NEW for a future cycle to retry.
          }
        } else {
          this.logger.warn(`EngagementService not available — cannot post reply`);
        }
        break;
      }

      default: {
        // Exhaustiveness check — if a new action type is added to ReplyDecision
        // but not handled here, TypeScript will flag this assignment as an error.
        const _exhaustive: never = decision.action;
        this.logger.error(`Unhandled reply action: ${_exhaustive}`);
      }
    }
  }

  /**
   * Random human-like delay (ms) before an auto-reply is posted.
   * Defaults: 5 min … 30 min. Robust against malformed env values.
   */
  private computeReplyDelayMs(): number {
    const rawMin = Number(this.configService.get<string>("REPLIES_AUTO_DELAY_MIN_MS", "300000"));
    const rawMax = Number(this.configService.get<string>("REPLIES_AUTO_DELAY_MAX_MS", "1800000"));
    const min = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : 300000;
    const max = Number.isFinite(rawMax) && rawMax > min ? rawMax : min + 1;
    return min + Math.floor(Math.random() * (max - min));
  }

  /**
   * F4: check the daily per-network reply budget.
   * Returns true when the budget has not been reached (or no Redis/max is 0).
   * When RATE_LIMIT_FAIL_CLOSED=true and Redis is unreachable, returns false so
   * we do not burn LLM calls on replies we cannot reliably gate.
   */
  private async checkDailyReplyBudget(network: SocialNetwork): Promise<boolean> {
    if (this.maxRepliesPerDay <= 0) {
      return true;
    }
    if (!this.redis) {
      return !this.failClosed;
    }
    const count = await this.getDailyReplyCount(network);
    return count < this.maxRepliesPerDay;
  }

  /**
   * F4: reserve a daily reply slot. Returns true if the slot was within budget.
   * The counter is set with a 2-day TTL so it cleans itself up.
   *
   * Uses a Redis Lua script (EVAL) so the check+incr is atomic and safe for
   * concurrent workers or multi-instance deployments.
   */
  private async reserveDailyReplySlot(network: SocialNetwork): Promise<boolean> {
    if (this.maxRepliesPerDay <= 0) {
      return true;
    }
    if (!this.redis) {
      return !this.failClosed;
    }
    try {
      const result = (await this.redis.eval(
        RESERVE_REPLY_SLOT_SCRIPT,
        1,
        this.dailyReplyKey(network),
        this.maxRepliesPerDay,
        DAILY_REPLY_TTL_SECONDS,
      )) as [number, number];
      const allowed = result[0];
      const newCount = result[1];
      this.logger.debug(`Reply budget ${network}: ${newCount}/${this.maxRepliesPerDay}`);
      return allowed === 1;
    } catch (err) {
      this.logger.warn(`Redis eval failed during reserveDailyReplySlot: ${(err as Error).message}`);
      return !this.failClosed;
    }
  }

  /**
   * F4: release a previously reserved daily reply slot (e.g. the job was dropped).
   * Uses a Lua script so the decr is guarded against negative counts.
   */
  private async releaseDailyReplySlot(network: SocialNetwork): Promise<void> {
    if (this.maxRepliesPerDay <= 0 || !this.redis) {
      return;
    }
    try {
      await this.redis.eval(RELEASE_REPLY_SLOT_SCRIPT, 1, this.dailyReplyKey(network));
    } catch (err) {
      this.logger.warn(`Redis eval failed during releaseDailyReplySlot: ${(err as Error).message}`);
    }
  }

  private async getDailyReplyCount(network: SocialNetwork): Promise<number> {
    if (!this.redis) return this.failClosed ? this.maxRepliesPerDay : 0;
    try {
      const raw = await this.redis.get(this.dailyReplyKey(network));
      return raw ? Number(raw) : 0;
    } catch {
      return this.failClosed ? this.maxRepliesPerDay : 0;
    }
  }

  private dailyReplyKey(network: string): string {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `spa:replies:daily:${network}:${today}`;
  }

  /**
   * RP1: post a scheduled auto-reply. Invoked by the engagement BullMQ worker after the
   * delay elapses (or inline as a fallback when no queue is wired). Throws on failure so
   * BullMQ retries and ultimately DLQ-alerts; the comment then stays NEW for a retry.
   */
  async postScheduledReply(data: {
    commentDbId: string;
    commentId: string;
    postId: string;
    network: string;
    postUrl: string | null;
    targetCommentUrl?: string | null;
    replyText: string;
  }): Promise<void> {
    if (!this.engagementService) {
      throw new Error("EngagementService not available — cannot post reply");
    }

    // Re-check the per-post cap at execution time: multiple replies can be scheduled in
    // one cycle before any is posted, so the live count may now exceed the limit.
    const alreadyReplied = await this.prisma.incomingComment.count({
      where: {
        postId: data.postId,
        status: { in: [CommentStatus.REPLIED, CommentStatus.REPLIED_MANUAL] },
      },
    });
    if (alreadyReplied >= this.maxRepliesPerPost) {
      this.logger.warn(
        `Max replies per post reached (${this.maxRepliesPerPost}) — dropping scheduled reply for ${data.commentId}`,
      );
      await this.prisma.incomingComment.update({
        where: { id: data.commentDbId },
        data: { status: CommentStatus.SKIPPED },
      });
      return;
    }

    // F4: reserve the daily per-network reply budget slot before posting.
    const slotReserved = await this.reserveDailyReplySlot(data.network as SocialNetwork);
    if (!slotReserved) {
      this.logger.warn(`Daily reply budget reached for ${data.network} — dropping scheduled reply`);
      await this.prisma.incomingComment.update({
        where: { id: data.commentDbId },
        data: { status: CommentStatus.SKIPPED },
      });
      return;
    }

    const targetUrl = data.targetCommentUrl ?? data.postUrl ?? "";
    if (!targetUrl) {
      await this.releaseDailyReplySlot(data.network as SocialNetwork);
      throw new Error("No target URL for reply");
    }

    let result: Awaited<ReturnType<typeof this.engagementService.reply>>;
    try {
      result = await this.engagementService.reply(
        data.network as SocialNetwork,
        targetUrl,
        data.replyText,
      );
    } catch (err) {
      await this.releaseDailyReplySlot(data.network as SocialNetwork);
      throw err;
    }

    if (!result.success) {
      // Throw → BullMQ retries (and DLQ-alerts on exhaustion). Comment stays NEW.
      await this.releaseDailyReplySlot(data.network as SocialNetwork);
      throw new Error(result.error ?? "Reply posting failed");
    }

    await this.prisma.incomingComment.update({
      where: { id: data.commentDbId },
      data: {
        status: CommentStatus.REPLIED,
        replyText: data.replyText,
        replyUrl: result.postUrl ?? null,
        replyPostedAt: new Date(),
      },
    });
    this.logger.log(`Auto-replied to comment ${data.commentId} on post ${data.postId}`);

    await this.sseService.publish({
      type: "reply_posted",
      postId: data.postId,
      commentId: data.commentId,
      network: data.network,
    });
  }

  /**
   * Get comments pending human review (for UI).
   */
  async getPendingHumanReview(): Promise<
    {
      id: string;
      postId: string;
      network: string;
      author: string;
      text: string;
      humanReviewReason: string | null;
      replyText: string | null;
      scrapedAt: Date;
    }[]
  > {
    return this.prisma.incomingComment.findMany({
      where: { status: CommentStatus.HUMAN_REVIEW },
      select: {
        id: true,
        postId: true,
        network: true,
        author: true,
        text: true,
        humanReviewReason: true,
        replyText: true,
        scrapedAt: true,
      },
      orderBy: { scrapedAt: "desc" },
    });
  }

  /**
   * Manually approve and post a reply for a human-review comment (from UI).
   */
  async manualReply(
    commentId: string,
    replyText: string,
  ): Promise<{ success: boolean; error?: string }> {
    const comment = await this.prisma.incomingComment.findUnique({
      where: { id: commentId },
      include: { post: { select: { postUrl: true, network: true } } },
    });

    if (!comment) {
      return { success: false, error: "Comment not found" };
    }

    if (!comment.post || !comment.post.postUrl) {
      return { success: false, error: "Post has no URL" };
    }

    if (!this.engagementService) {
      return { success: false, error: "Engagement service not available" };
    }

    const slotReserved = await this.reserveDailyReplySlot(comment.post.network as SocialNetwork);
    if (!slotReserved) {
      return { success: false, error: `Daily reply budget reached for ${comment.post.network}` };
    }

    try {
      const targetUrl = comment.commentUrl ?? comment.post.postUrl ?? "";
      if (!targetUrl) {
        await this.releaseDailyReplySlot(comment.post.network as SocialNetwork);
        return { success: false, error: "No target URL for reply" };
      }

      const result = await this.engagementService.reply(comment.post.network, targetUrl, replyText);

      if (!result.success) {
        await this.releaseDailyReplySlot(comment.post.network as SocialNetwork);
        return { success: false, error: result.error };
      }

      await this.prisma.incomingComment.update({
        where: { id: commentId },
        data: {
          status: CommentStatus.REPLIED_MANUAL,
          replyText,
          replyPostedAt: new Date(),
          needsHumanReview: false,
        },
      });
      return { success: true };
    } catch (err) {
      await this.releaseDailyReplySlot(comment.post.network as SocialNetwork);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Dismiss a human-review comment (skip replying).
   */
  async dismissReview(commentId: string): Promise<void> {
    await this.prisma.incomingComment.update({
      where: { id: commentId },
      data: { status: CommentStatus.SKIPPED, needsHumanReview: false },
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

/** 2.9.1: Normalize a social handle for comparison. */
function normalizeHandle(handle: string): string {
  return handle.toLowerCase().replace(/^@+/, "").trim();
}

/** 2.9.1: Extract a comparable handle from an author profile URL. */
function extractHandleFromProfileUrl(url: string): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  const segments = path.split("/").filter((s) => s.length > 0);
  const first = segments[0];
  if (!first) return null;

  // X: /handle or /handle/status/...; Threads: /@handle or /@handle/post/...; Facebook: /user/123
  if (first === "user") {
    const second = segments[1];
    return second ? decodeURIComponent(second).toLowerCase() : null;
  }
  if (first.startsWith("@")) {
    return normalizeHandle(first);
  }
  return normalizeHandle(first);
}
