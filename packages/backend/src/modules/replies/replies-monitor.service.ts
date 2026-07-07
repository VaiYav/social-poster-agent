/**
 * Sprint Q / F4: Replies Monitor Service — automated comment monitoring and reply posting.
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
import { Injectable, Logger, Optional, Inject, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { SessionsService } from '../sessions/sessions.service';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { buildCommentId } from './comment-id.js';
import { detectSensitive, isLikelyTroll } from './sensitive-filter.js';
import { LlmService } from '../../infrastructure/llm/llm.service.js';
import { sanitizeUntrustedInput } from '../../infrastructure/llm/sanitize-untrusted-input.js';
import { DiscordNotificationService } from '../../infrastructure/notifications/discord-notification.service.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { QueueFactory } from '../../infrastructure/queue/queue.factory.js';
import { PostStatus, SocialNetwork, CommentStatus } from '@prisma/client';
import type { Page } from '../../domain/ports/browser-primitives';
import { parseBool } from '../../infrastructure/config/parse-bool';
import { isOrchestratorEnabled } from '../orchestrator/feature-flag.js';
import { matchesScript, normalizeLanguage } from '../../infrastructure/util/script-check.js';

export interface ScrapedComment {
  commentId: string;
  author: string;
  text: string;
  authorProfileUrl?: string;
}

export interface ReplyDecision {
  action: 'auto_reply' | 'human_review' | 'skip';
  reason: string;
  replyText?: string;
  reviewReason?: string;
  /** Language the LLM detected in the comment (en/ru/uk/es/it).
   * Used for post-validation: if replyText script doesn't match, downgrade to human_review. */
  detectedLanguage?: string;
}

@Injectable()
export class RepliesMonitorService implements OnModuleInit {
  private readonly logger = new Logger(RepliesMonitorService.name);
  private readonly enabled: boolean;
  private readonly cronSchedule: string;
  private readonly maxRepliesPerPost: number;
  private readonly autoReplyComplexity: 'low' | 'medium' | 'high';

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly accountsService: AccountsService,
    private readonly sessionsService: SessionsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly discord: DiscordNotificationService,
    private readonly sseService: SseService,
    @Optional() private readonly llmService?: LlmService,
    @Optional() @Inject(IBrowserPort) private readonly browser?: IBrowserPort,
    @Optional() private readonly engagementService?: EngagementService,
    // RP1: when present, auto-replies are scheduled as delayed BullMQ jobs instead of
    // blocking the cron with an inline setTimeout. Absent in unit tests (inline fallback).
    @Optional() private readonly queueFactory?: QueueFactory,
  ) {
    this.enabled = parseBool(this.configService.get<string>('REPLIES_ENABLED', 'false'));
    this.cronSchedule = this.configService.get<string>('REPLIES_CRON_SCHEDULE', '0 */4 * * *');
    const rawMax = Number(this.configService.get<string>('REPLIES_MAX_PER_POST', '3'));
    this.maxRepliesPerPost = Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : 3;
    const rawComplexity = this.configService.get<string>('REPLIES_AUTO_REPLY_COMPLEXITY', 'medium');
    this.autoReplyComplexity = rawComplexity === 'low' || rawComplexity === 'medium' || rawComplexity === 'high' ? rawComplexity : 'medium';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Replies monitor disabled (REPLIES_ENABLED=false)');
      return;
    }

    // Orchestrator mode: CHECK_REPLIES is handled by the orchestrator decision loop.
    if (isOrchestratorEnabled()) {
      this.logger.log('Orchestrator is enabled — replies monitor cron NOT registered');
      return;
    }

    const job = new CronJob(this.cronSchedule, async () => {
      await this.runMonitoringCycle();
    });

    try {
      this.schedulerRegistry?.addCronJob('replies-monitor', job);
      job.start();
      this.logger.log(`Replies monitor cron registered: ${this.cronSchedule}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — replies monitor cron will not run');
    }
  }

  /**
   * Main monitoring cycle — called by cron.
   * 1. Get monitorable posts (posted in last 24h)
   * 2. Scrape comments from each post
   * 3. Process new comments (decide + reply/flag)
   */
  async runMonitoringCycle(): Promise<{ postsChecked: number; commentsScraped: number; repliesPosted: number; humanReview: number }> {
    this.logger.log('Replies monitoring cycle started');
    const stats = { postsChecked: 0, commentsScraped: 0, repliesPosted: 0, humanReview: 0 };

    try {
      const posts = await this.getMonitorablePosts();
      this.logger.log(`Found ${posts.length} posts to monitor for comments`);

      for (const post of posts) {
        try {
          const comments = await this.scrapeComments(post.network as SocialNetwork, post.postUrl!);
          stats.postsChecked++;
          stats.commentsScraped += comments.length;

          // Save new comments to DB (dedup by commentId)
          const newComments = await this.saveNewComments(post.id, post.network as SocialNetwork, comments);

          // Process each new comment
          for (const comment of newComments) {
            // RP1 re-entrancy guard: a reply may already be scheduled (a delayed BullMQ
            // job) from an earlier cycle. The comment stays NEW until the job posts it,
            // so without this guard we would re-run the (costly) LLM decision every cycle.
            // jobId=commentId; the lookup is Redis-backed, so it survives restarts.
            if (this.queueFactory && (await this.queueFactory.getEngagementJob(comment.commentId, post.network))) {
              this.logger.debug(`Reply already scheduled for comment ${comment.commentId} — skipping re-decision`);
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
        `Replies monitoring cycle complete: ${stats.postsChecked} posts, ${stats.commentsScraped} comments, ${stats.repliesPosted} replies, ${stats.humanReview} human review`,
      );

      // SSE event for UI
      await this.sseService.publish({
        type: 'replies_monitor',
        ...stats,
      });

      // Discord summary if there are human review items
      if (stats.humanReview > 0) {
        await this.discord.warning(
          'Comments Need Human Review',
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
  private async getMonitorablePosts(): Promise<{ id: string; network: string; postUrl: string | null; content: string }[]> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.prisma.post.findMany({
      where: {
        status: PostStatus.POSTED,
        postedAt: { gte: twentyFourHoursAgo },
        postUrl: { not: null },
      },
      select: {
        id: true,
        network: true,
        postUrl: true,
        content: true,
      },
    });
  }

  /**
   * Scrape comments from a post page using browser automation.
   * Navigates to the post URL, extracts comment text + authors.
   */
  private async scrapeComments(network: SocialNetwork, postUrl: string): Promise<ScrapedComment[]> {
    if (!this.browser) {
      this.logger.warn('Browser port not available — cannot scrape comments');
      return [];
    }

    let context: Awaited<ReturnType<typeof this.browser.acquireContext>> | null = null;
    let page: Page | null = null;

    try {
      // Get or create a session for this network
      const session = await this.sessionsService.getOrCreateSession(network);
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
      context = await this.browser.acquireContext(network, storageState);
      page = await context.newPage();

      await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(3000); // Let comments load

      // Scroll to load more comments
      await this.scrollForComments(page);

      // Extract comments using network-specific selectors
      const comments = await this.extractComments(page, network);

      this.logger.debug(`Scraped ${comments.length} comments from ${network} post ${postUrl}`);
      return comments;
    } catch (err) {
      this.logger.warn(`Comment scraping failed for ${postUrl}: ${(err as Error).message}`);
      return [];
    } finally {
      if (page) await page.close().catch(() => void 0);
      if (context && this.browser) {
        try {
          this.browser.releaseContext(network, context);
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
   */
  private async extractComments(page: Page, network: SocialNetwork): Promise<ScrapedComment[]> {
    const selectors = this.getCommentSelectors(network);
    const comments: ScrapedComment[] = [];

    try {
      const commentElements = await page.locator(selectors.commentContainer).all();

      for (const el of commentElements.slice(0, 20)) {
        // Limit to 20 comments per post
        try {
          const text = (await el.locator(selectors.commentText).first().textContent())?.trim() ?? '';
          const author = (await el.locator(selectors.author).first().textContent())?.trim() ?? 'unknown';

          if (!text || text.length < 2) continue;

          // RP2: stable, script-safe commentId — the old strip-non-alnum approach collapsed
          // Cyrillic/emoji comments into collisions and silently dropped real comments.
          const commentId = buildCommentId(author, text);

          comments.push({ commentId, author, text });
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
        return { commentContainer: '', commentText: '', author: '' };
    }
  }

  /**
   * Save new comments to DB. Returns only the NEW comments (not already seen).
   */
  private async saveNewComments(
    postId: string,
    network: SocialNetwork,
    comments: ScrapedComment[],
  ): Promise<{ id: string; commentId: string; author: string; text: string }[]> {
    const newComments: { id: string; commentId: string; author: string; text: string }[] = [];

    for (const comment of comments) {
      try {
        const created = await this.prisma.incomingComment.upsert({
          where: { postId_commentId: { postId, commentId: comment.commentId } },
          update: {}, // Don't update existing — we only want NEW comments
          create: {
            postId,
            network,
            commentId: comment.commentId,
            author: comment.author,
            text: comment.text,
            status: CommentStatus.NEW,
          },
          select: { id: true, commentId: true, author: true, text: true, status: true },
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
    comment: { id: string; commentId: string; author: string; text: string },
  ): Promise<ReplyDecision> {
    // 1. Skip spam/trolls (deterministic check first — free; word-boundary so "about" ≠ "bot")
    if (isLikelyTroll(comment.text)) {
      return { action: 'skip', reason: 'Potential troll/spam — skipped' };
    }

    // 2. Don't reply to our own comments — look up account by network, compare handle
    try {
      const account = await this.accountsService.findByNetwork(post.network as SocialNetwork);
      if (account?.handle) {
        const ownHandle = account.handle.toLowerCase();
        const commentAuthor = comment.author.toLowerCase().replace(/^@/, '');
        if (commentAuthor === ownHandle) {
          return { action: 'skip', reason: 'Self-reply skipped (own account)' };
        }
      }
    } catch {
      // Account lookup failed — continue
    }

    // 3. Check max replies per post
    const existingRepliesCount = await this.prisma.incomingComment.count({
      where: { postId: post.id, status: { in: [CommentStatus.REPLIED, CommentStatus.REPLIED_MANUAL] } },
    });
    if (existingRepliesCount >= this.maxRepliesPerPost) {
      return { action: 'skip', reason: `Max replies per post reached (${this.maxRepliesPerPost})` };
    }

    // RP3: deterministic sensitive-topic backstop — runs BEFORE the LLM so a misclassification
    // can never auto-reply to grief/crisis/complaint.
    const sensitive = detectSensitive(comment.text);
    if (sensitive.sensitive) {
      return {
        action: 'human_review',
        reason: `Sensitive topic (${sensitive.kind}) — requires human review`,
        reviewReason: sensitive.reason,
      };
    }

    // 4. LLM is the sole content generator — no template fallback.
    // If LLM service is not wired or all providers fail, skip the comment
    // (it stays NEW and will be retried in the next monitoring cycle).
    if (!this.llmService) {
      this.logger.warn('LlmService not available — skipping comment (will retry next cycle)');
      return { action: 'skip', reason: 'LLM service not available — will retry next cycle' };
    }

    return this.llmDecideReply(post, comment);
  }

  /**
   * LLM-based reply decision — classifies comment complexity and generates reply.
   */
  private async llmDecideReply(
    post: { id: string; network: string; content: string },
    comment: { id: string; commentId: string; author: string; text: string },
  ): Promise<ReplyDecision> {
    const systemPrompt = `You manage social media for an astrology app. Someone commented on your post. You need to:
1. Figure out what kind of comment this is
2. Decide: reply yourself or flag for a human
3. If replying, write something that doesn't sound like a bot

LANGUAGE — CRITICAL:
- Reply in the SAME LANGUAGE as the comment. Always. No exceptions.
- Ukrainian comment → Ukrainian reply. Russian → Russian. Spanish → Spanish. English → English.
- Match the vibe: if they're casual, be casual. If they're formal, be measured. If they're funny, be funny back.
- Replying in English to a non-English comment is the #1 bot tell. Don't do it.

CLASSIFICATION:
- simple: "love this!", "so true", emojis, quick thanks → reply yourself
- complex: real questions about astrology, detailed discussions, someone sharing their chart → reply if you know the answer, otherwise flag for human
- sensitive: complaints, personal crises, mental health mentions, someone asking for medical/financial advice → ALWAYS flag for human. Never attempt these yourself.

HOW TO WRITE A GOOD REPLY:
- Be specific. Reference what they actually said. "Thanks!" is not a reply, it's an acknowledgment.
- Have personality. You can be warm, funny, sarcastic, or sincere — depending on the comment.
- If they asked a question, actually answer it. Don't dodge.
- If they shared something personal, acknowledge it genuinely.
- Keep it short: 280 chars for X/Threads, 500 for Facebook.
- No absolute predictions. No medical/financial advice. No self-promo links.
- NO generic phrases: "Great question!" "Thanks for sharing!" "We appreciate your comment!" "Love this!"

GOOD replies (English):
- Comment: "Is Mercury retrograde really that bad?" → "Honestly? It's mostly overhyped. The real chaos comes from the shadow period — the 2 weeks before and after. That's when stuff actually breaks."
- Comment: "This is so accurate for me as a Cancer moon 😭" → "Cancer moon hits different. The emotional memory is no joke — you probably remember how people made you feel 10 years ago."
- Comment: "What does it mean if my Venus is in Scorpio?" → "Venus in Scorpio means you love like it's a matter of life and death. No casual dating for you — it's all or nothing, and you can spot a lie from across the room."

GOOD replies (Ukrainian):
- "Чесно? Це переважно перебільшено. Справжній хаос — у періоді тіні, 2 тижні до і після. Тоді все реально ламається."
- "Місяць у Раку — це окрема ліга. Емоційна пам'ять — не жарт, ти напевно пам'ятаєш, як люди змусили тебе почуватися 10 років тому."

GOOD replies (Russian):
- "Честно? Это в основном преувеличено. Настоящий хаос — в периоде тени, 2 недели до и после. Тогда всё реально ломается."
- "Луна в Раке — это отдельная лига. Эмоциональная память — не шутка, ты наверное помнишь, как люди заставили тебя чувствовать себя 10 лет назад."

BAD replies (forbidden — if you write these, you failed):
- "Thank you for your comment! We appreciate your engagement!" (corporate bot)
- "Great question! Mercury retrograde is a fascinating topic..." (AI filler)
- "Love this! ✨✨✨" (generic + emoji spam)
- Replying in English to a Ukrainian/Russian/Spanish comment (language mismatch)
- "Check out our website for more!" (self-promo)

Return JSON:
{"action": "auto_reply" | "human_review", "reason": "why", "detectedLanguage": "en|ru|uk|es|it", "replyText": "the reply (in detectedLanguage)", "reviewReason": "why human review (if applicable)"}

LANGUAGE DETECTION — DO THIS FIRST, before writing the reply:
1. Look at the comment's script: Cyrillic → ru or uk. Latin → en, es, or it.
2. Ukrainian-specific chars: і, ї, є, ґ. If present → uk. Otherwise Cyrillic → ru.
3. Latin script: Spanish has "que", "para", "gracias", "está". Italian has "che", "per", "grazie", "è". Otherwise → en.
4. Set detectedLanguage to the ISO code. Then write replyText in THAT language.
5. A missed language switch is worse than an extra one — when in doubt, commit.`;

    // SEC3: the comment author + text are untrusted external input — sanitize
    // before interpolating so a comment can't inject instructions the model then
    // follows and posts under our account.
    const userPrompt = `Post content: "${post.content.slice(0, 300)}"

Comment from @${sanitizeUntrustedInput(comment.author, 60)}: "${sanitizeUntrustedInput(comment.text)}"

Network: ${post.network}

Identify the language of the comment (set detectedLanguage), then write replyText in that language.`;

    try {
      const response = await this.llmService!.generateChat(systemPrompt, userPrompt, { temperature: 0.4 });

      // Parse JSON response — LLM may wrap in markdown
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('LLM reply decision: no JSON found in response — skipping (will retry next cycle)');
        return { action: 'skip', reason: 'LLM returned no JSON — will retry next cycle' };
      }

      let parsed: ReplyDecision;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        this.logger.warn('LLM reply decision: JSON parse failed — skipping (will retry next cycle)');
        return { action: 'skip', reason: 'LLM JSON parse failed — will retry next cycle' };
      }

      // Validate action — default to human_review if invalid
      if (parsed.action !== 'auto_reply' && parsed.action !== 'human_review') {
        parsed.action = 'human_review';
        parsed.reviewReason = 'LLM returned invalid action — defaulting to human review';
      }

      // Validate replyText exists for auto_reply
      if (parsed.action === 'auto_reply' && (!parsed.replyText || typeof parsed.replyText !== 'string')) {
        parsed.action = 'human_review';
        parsed.reviewReason = 'LLM auto_reply missing replyText — defaulting to human review';
      }

      // Post-validation: verify the reply's script matches the detected language.
      // This catches the #1 bot tell — replying in English to a non-English comment.
      // The LLM commits to a language via detectedLanguage; we verify the replyText
      // actually uses that language's script. If mismatch → downgrade to human_review.
      if (parsed.action === 'auto_reply' && parsed.replyText) {
        const lang = normalizeLanguage(parsed.detectedLanguage);
        if (!matchesScript(parsed.replyText, lang)) {
          this.logger.warn(
            `Reply script mismatch: detectedLanguage=${lang}, replyText="${parsed.replyText.slice(0, 60)}" — downgrading to human_review`,
          );
          parsed.action = 'human_review';
          parsed.reviewReason = `Reply script does not match detected language (${lang}) — requires human review`;
        }
      }

      // Complexity threshold check
      if (parsed.action === 'auto_reply') {
        const complexityLevel = { low: 0, medium: 1, high: 2 };
        const threshold = complexityLevel[this.autoReplyComplexity];
        // If the comment seems complex (long, multiple questions, etc.), escalate based on threshold
        const isComplex = comment.text.length > 200 || (comment.text.match(/\?/g)?.length ?? 0) > 1;
        if (isComplex && threshold < 2) {
          return {
            action: 'human_review',
            reason: 'Comment complexity exceeds auto-reply threshold',
            reviewReason: `Complex comment (length=${comment.text.length}, questions=${comment.text.match(/\?/g)?.length ?? 0}) — threshold=${this.autoReplyComplexity}`,
          };
        }
      }

      return parsed;
    } catch (err) {
      // LLM failed (all providers down, rate limited, etc.) — skip, don't post a template.
      // The comment stays NEW and will be retried in the next monitoring cycle when
      // providers may have recovered (circuit breakers reset, rate limits cleared).
      this.logger.warn(`LLM reply decision failed: ${(err as Error).message} — skipping (will retry next cycle)`);
      return { action: 'skip', reason: `LLM unavailable: ${(err as Error).message} — will retry next cycle` };
    }
  }


  /**
   * Execute the reply decision — post reply, flag for review, or skip.
   */
  private async executeDecision(
    post: { id: string; network: string; postUrl: string | null; content: string },
    comment: { id: string; commentId: string; author: string; text: string },
    decision: ReplyDecision,
    stats: { postsChecked: number; commentsScraped: number; repliesPosted: number; humanReview: number },
  ): Promise<void> {
    switch (decision.action) {
      case 'skip': {
        await this.prisma.incomingComment.update({
          where: { id: comment.id },
          data: { status: CommentStatus.SKIPPED },
        });
        this.logger.debug(`Skipped comment ${comment.commentId}: ${decision.reason}`);
        break;
      }

      case 'human_review': {
        await this.prisma.incomingComment.update({
          where: { id: comment.id },
          data: {
            status: CommentStatus.HUMAN_REVIEW,
            needsHumanReview: true,
            humanReviewReason: decision.reviewReason ?? decision.reason,
            replyText: decision.replyText ?? null,
          },
        });
        stats.humanReview++;
        this.logger.log(`Comment ${comment.commentId} flagged for human review: ${decision.reviewReason ?? decision.reason}`);
        break;
      }

      case 'auto_reply': {
        if (!decision.replyText) {
          this.logger.warn(`Auto-reply decision has no replyText — skipping`);
          return;
        }
        if (!post.postUrl) {
          this.logger.warn(`Auto-reply for comment ${comment.commentId} has no postUrl — cannot reply`);
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
            comment.commentId,
            post.network,
            'reply',
            {
              commentDbId: comment.id,
              commentId: comment.commentId,
              postId: post.id,
              postUrl: post.postUrl,
              replyText: decision.replyText,
            },
            { delay },
          );
          // Persist the decided reply text so the UI can show it while the job waits.
          // Status stays NEW until the worker posts it; the re-entrancy guard (an
          // existing engagement job for this commentId) prevents re-deciding it.
          await this.prisma.incomingComment.update({
            where: { id: comment.id },
            data: { replyText: decision.replyText },
          });
          this.logger.log(
            `Auto-reply scheduled for comment ${comment.commentId} on post ${post.id} (~${Math.round(delay / 60000)}min)`,
          );
          break;
        }

        // Fallback when no queue is wired (e.g. unit tests): post immediately. This path
        // no longer blocks on a 5-30 min timer — production always has the queue.
        if (this.engagementService) {
          try {
            await this.postScheduledReply({
              commentDbId: comment.id,
              commentId: comment.commentId,
              postId: post.id,
              network: post.network,
              postUrl: post.postUrl,
              replyText: decision.replyText,
            });
            stats.repliesPosted++;
          } catch (err) {
            this.logger.warn(`Reply posting error for comment ${comment.commentId}: ${(err as Error).message}`);
            // Comment stays NEW for a future cycle to retry.
          }
        } else {
          this.logger.warn(`EngagementService not available — cannot post reply`);
        }
        break;
      }
    }
  }

  /**
   * Random human-like delay (ms) before an auto-reply is posted.
   * Defaults: 5 min … 30 min. Robust against malformed env values.
   */
  private computeReplyDelayMs(): number {
    const rawMin = Number(this.configService.get<string>('REPLIES_AUTO_DELAY_MIN_MS', '300000'));
    const rawMax = Number(this.configService.get<string>('REPLIES_AUTO_DELAY_MAX_MS', '1800000'));
    const min = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : 300000;
    const max = Number.isFinite(rawMax) && rawMax > min ? rawMax : min + 1;
    return min + Math.floor(Math.random() * (max - min));
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
    postUrl: string;
    replyText: string;
  }): Promise<void> {
    if (!this.engagementService) {
      throw new Error('EngagementService not available — cannot post reply');
    }

    // Re-check the per-post cap at execution time: multiple replies can be scheduled in
    // one cycle before any is posted, so the live count may now exceed the limit.
    const alreadyReplied = await this.prisma.incomingComment.count({
      where: { postId: data.postId, status: { in: [CommentStatus.REPLIED, CommentStatus.REPLIED_MANUAL] } },
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

    const result = await this.engagementService.reply(
      data.network as SocialNetwork,
      data.postUrl,
      data.replyText,
    );

    if (!result.success) {
      // Throw → BullMQ retries (and DLQ-alerts on exhaustion). Comment stays NEW.
      throw new Error(result.error ?? 'Reply posting failed');
    }

    await this.prisma.incomingComment.update({
      where: { id: data.commentDbId },
      data: {
        status: CommentStatus.REPLIED,
        replyText: data.replyText,
        replyPostedAt: new Date(),
      },
    });
    this.logger.log(`Auto-replied to comment ${data.commentId} on post ${data.postId}`);

    await this.sseService.publish({
      type: 'reply_posted',
      postId: data.postId,
      commentId: data.commentId,
      network: data.network,
    });
  }

  /**
   * Get comments pending human review (for UI).
   */
  async getPendingHumanReview(): Promise<{ id: string; postId: string; network: string; author: string; text: string; humanReviewReason: string | null; replyText: string | null; scrapedAt: Date }[]> {
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
      orderBy: { scrapedAt: 'desc' },
    });
  }

  /**
   * Manually approve and post a reply for a human-review comment (from UI).
   */
  async manualReply(commentId: string, replyText: string): Promise<{ success: boolean; error?: string }> {
    const comment = await this.prisma.incomingComment.findUnique({
      where: { id: commentId },
      include: { post: { select: { postUrl: true, network: true } } },
    });

    if (!comment) {
      return { success: false, error: 'Comment not found' };
    }

    if (!comment.post || !comment.post.postUrl) {
      return { success: false, error: 'Post has no URL' };
    }

    if (!this.engagementService) {
      return { success: false, error: 'Engagement service not available' };
    }

    try {
      const result = await this.engagementService.reply(
        comment.post.network,
        comment.post.postUrl,
        replyText,
      );

      if (result.success) {
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
      }
      return { success: false, error: result.error };
    } catch (err) {
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
