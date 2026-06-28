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
 *   REPLIES_LLM_ENABLED=true  (use LLM for reply generation)
 *   REPLIES_AUTO_REPLY_COMPLEXITY=medium  (low/medium/high — threshold for human review)
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
import { DiscordNotificationService } from '../../infrastructure/notifications/discord-notification.service.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { PostStatus, SocialNetwork, CommentStatus } from '@prisma/client';
import type { Page } from '../../domain/ports/browser-primitives';
import { parseBool } from '../../infrastructure/config/parse-bool';

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
}

@Injectable()
export class RepliesMonitorService implements OnModuleInit {
  private readonly logger = new Logger(RepliesMonitorService.name);
  private readonly enabled: boolean;
  private readonly cronSchedule: string;
  private readonly maxRepliesPerPost: number;
  private readonly llmEnabled: boolean;
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
  ) {
    this.enabled = parseBool(this.configService.get<string>('REPLIES_ENABLED', 'false'));
    this.cronSchedule = this.configService.get<string>('REPLIES_CRON_SCHEDULE', '0 */4 * * *');
    const rawMax = Number(this.configService.get<string>('REPLIES_MAX_PER_POST', '3'));
    this.maxRepliesPerPost = Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : 3;
    this.llmEnabled = parseBool(this.configService.get<string>('REPLIES_LLM_ENABLED', 'true'));
    const rawComplexity = this.configService.get<string>('REPLIES_AUTO_REPLY_COMPLEXITY', 'medium');
    this.autoReplyComplexity = rawComplexity === 'low' || rawComplexity === 'medium' || rawComplexity === 'high' ? rawComplexity : 'medium';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Replies monitor disabled (REPLIES_ENABLED=false)');
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
   * Uses LLM for sophisticated decision-making when enabled.
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
    // can never auto-reply to grief/crisis/complaint. Applies on both LLM and heuristic paths.
    const sensitive = detectSensitive(comment.text);
    if (sensitive.sensitive) {
      return {
        action: 'human_review',
        reason: `Sensitive topic (${sensitive.kind}) — requires human review`,
        reviewReason: sensitive.reason,
      };
    }

    // 4. Use LLM to classify and generate reply
    if (this.llmEnabled && this.llmService) {
      return this.llmDecideReply(post, comment);
    }

    // 5. Fallback: simple heuristic without LLM
    return this.heuristicDecideReply(post, comment);
  }

  /**
   * LLM-based reply decision — classifies comment complexity and generates reply.
   */
  private async llmDecideReply(
    post: { id: string; network: string; content: string },
    comment: { id: string; commentId: string; author: string; text: string },
  ): Promise<ReplyDecision> {
    const systemPrompt = `You are a social media manager for an astrology/wellness brand. Your task is to:
1. Classify the incoming comment as: simple, complex, or sensitive
2. Decide whether to auto-reply or flag for human review
3. If auto-replying, generate an appropriate reply

LANGUAGE ADAPTATION — CRITICAL:
- Detect the language of the comment AND the post content.
- Write your reply IN THE SAME LANGUAGE as the comment.
- If the comment is in Ukrainian → reply in Ukrainian. Russian → Russian. Spanish → Spanish. English → English. Etc.
- Never reply in English to a non-English comment — it looks robotic and breaks trust.
- Match the register: formal comment → formal reply, casual comment → casual reply.

Classification rules:
- simple: positive comments, thanks, emojis, brief acknowledgments → auto-reply
- complex: questions requiring domain knowledge, detailed discussions → auto-reply if confident, else human review
- sensitive: complaints, controversies, personal crises, mental health mentions → ALWAYS human review

Reply guidelines:
- Keep replies under 280 characters (X/Threads) or 500 characters (Facebook)
- Be warm, authentic, and on-brand (mystical-but-grounded, empowering)
- Don't make absolute predictions or give professional advice
- For questions, provide helpful context and invite further engagement
- Never engage with controversy — flag for human review instead

Return your response in this exact JSON format:
{"action": "auto_reply" | "human_review", "reason": "brief explanation", "replyText": "the reply text (if auto_reply, IN THE SAME LANGUAGE as the comment)", "reviewReason": "why human review is needed (if human_review)"}`;

    const userPrompt = `Post content: "${post.content.slice(0, 300)}"

Comment from @${comment.author}: "${comment.text}"

Network: ${post.network}

IMPORTANT: Reply in the SAME LANGUAGE as the comment above. Detect the language and match it exactly.`;

    try {
      const response = await this.llmService!.generateChat(systemPrompt, userPrompt, { temperature: 0.4 });

      // Parse JSON response — LLM may wrap in markdown
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('LLM reply decision: no JSON found in response — falling back to heuristic');
        return this.heuristicDecideReply(post, comment);
      }

      let parsed: ReplyDecision;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        this.logger.warn('LLM reply decision: JSON parse failed — falling back to heuristic');
        return this.heuristicDecideReply(post, comment);
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
      this.logger.warn(`LLM reply decision failed: ${(err as Error).message} — falling back to heuristic`);
      return this.heuristicDecideReply(post, comment);
    }
  }

  /**
   * Heuristic-based reply decision (fallback when LLM is not available).
   * Includes basic language detection for multilingual reply templates.
   */
  private heuristicDecideReply(
    post: { id: string; network: string; content: string },
    comment: { id: string; commentId: string; author: string; text: string },
  ): ReplyDecision {
    const text = comment.text.toLowerCase();

    // Detect language using Cyrillic + Latin script heuristics
    const lang = this.detectLanguageHeuristic(comment.text);

    // Sensitive topics / complaints → human review. Shared detector with the decideReply
    // pre-filter (RP3) so both paths use a single multilingual source of truth.
    const sensitive = detectSensitive(comment.text);
    if (sensitive.sensitive) {
      return {
        action: 'human_review',
        reason: `Sensitive topic (${sensitive.kind}) — requires human review`,
        reviewReason: sensitive.reason,
      };
    }

    // Multilingual reply templates
    const templates = this.getReplyTemplates(lang);

    // Questions → auto-reply with template
    // NOTE: \b in JavaScript regex is ASCII-only and does NOT work with Cyrillic.
    // Use (?:$|[^а-яіїєґА-ЯІЇЄҐa-z]) suffix instead of \b for Cyrillic word boundaries.
    const isQuestion = /\?$/.test(comment.text) ||
      /^(what|why|how|when|where|who|can|do|is|are|will)\b/i.test(text) ||
      /^(що|чому|як|коли|де|хто|чи|что|почему|как|когда|где|кто|ли)(?:$|[^а-яіїєґА-ЯІЇЄҐa-z])/i.test(text);
    if (isQuestion) {
      return {
        action: 'auto_reply',
        reason: 'Question — auto-reply with template',
        replyText: templates.question,
      };
    }

    // Positive engagement → auto-reply (multilingual)
    const positivePatterns = /love|great|amazing|interesting|true|relatable|wow|thank|nice|cool|✨|🌟|💫|подоб|спасиб|дякую|клас|чудов|цікав|правда|дяка/i;
    if (positivePatterns.test(text)) {
      return {
        action: 'auto_reply',
        reason: 'Positive engagement — auto-reply',
        replyText: templates.positive,
      };
    }

    // Default → auto-reply with generic response
    return {
      action: 'auto_reply',
      reason: 'General engagement — auto-reply',
      replyText: templates.default,
    };
  }

  /**
   * Detect language using script-based heuristics (no external dependency).
   * Returns 'uk' for Ukrainian, 'ru' for Russian, 'en' for English/default.
   */
  private detectLanguageHeuristic(text: string): 'uk' | 'ru' | 'en' {
    // Count Cyrillic characters
    const cyrillicChars = (text.match(/[а-яіїєґА-ЯІЇЄҐ]/g) || []).length;
    if (cyrillicChars < 3) return 'en'; // Not enough Cyrillic → assume Latin script

    // Ukrainian-specific characters: і, ї, є, ґ
    const ukSpecific = (text.match(/[іїєґІЇЄҐ]/g) || []).length;
    // Russian-specific: ы, э, ъ, ё (not in Ukrainian)
    const ruSpecific = (text.match(/[ыэъёЫЭЪЁ]/g) || []).length;

    if (ukSpecific > 0 && ruSpecific === 0) return 'uk';
    if (ruSpecific > 0 && ukSpecific === 0) return 'ru';
    // Ambiguous — use word-level markers.
    // NOTE: \b in JavaScript regex is ASCII-only and does NOT work with Cyrillic.
    // Use (?:^|[^а-яіїєґА-ЯІЇЄҐ]) prefix instead of \b for Cyrillic word boundaries.
    const cyrillicBoundary = '(?:^|[^а-яіїєґА-ЯІЇЄҐ])';
    const ukWords = new RegExp(
      cyrillicBoundary + '(?:і|та|що|як|це|він|вона|ми|ви|вони|бути|україн|дякую|спасибі|добре|гарно)(?=$|[^а-яіїєґА-ЯІЇЄҐ])',
      'i',
    ).test(text);
    const ruWords = new RegExp(
      cyrillicBoundary + '(?:и|да|что|как|это|он|она|мы|вы|они|быть|спасибо|хорошо|красиво)(?=$|[^а-яіїєґА-ЯІЇЄҐ])',
      'i',
    ).test(text);
    if (ukWords && !ruWords) return 'uk';
    if (ruWords && !ukWords) return 'ru';
    // Default to Ukrainian for Cyrillic (brand is Ukraine-based)
    return 'uk';
  }

  /**
   * Get reply templates for the detected language.
   */
  private getReplyTemplates(lang: 'uk' | 'ru' | 'en'): {
    question: string;
    positive: string;
    default: string;
  } {
    const templates: Record<string, { question: string; positive: string; default: string }> = {
      uk: {
        question: `Чудове запитання! ✨ Космічні енергії завжди змінюються. Який саме аспект резонує з вами?`,
        positive: `Дякуємо, що поділилися! ✨ Зірки мають спосіб говорити з нами. Залишайтеся з нами для нових космічних інсайтів!`,
        default: `Дякуємо за взаємодію з цим постом! ✨ Всесвіт має багато чого сказати. Який ваш знак зодіаку?`,
      },
      ru: {
        question: `Отличный вопрос! ✨ Космические энергии постоянно меняются. Какой именно аспект резонирует с вами?`,
        positive: `Спасибо, что поделились! ✨ Звёзды умеют говорить с нами. Оставайтесь с нами для новых космических инсайтов!`,
        default: `Спасибо за взаимодействие с этим постом! ✨ Вселенная хочет сказать многое. Какой ваш знак зодиака?`,
      },
      en: {
        question: `Great question! ✨ The cosmic energies are always shifting. What specific aspect resonates with you?`,
        positive: `Thank you for sharing! ✨ The stars have a way of speaking to us. Stay tuned for more cosmic insights!`,
        default: `Thanks for engaging with this post! ✨ The universe has much to share. What's your sign?`,
      },
    };
    return templates[lang] ?? templates.en!;
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

        // Post the reply via engagement service
        if (this.engagementService && post.postUrl) {
          try {
            // Human-like delay before posting reply (5-30 min random).
            // Instant replies look bot-like and can trigger platform detection.
            const delayMinMs = this.configService.get<number>('REPLIES_AUTO_DELAY_MIN_MS', 300000); // 5 min
            const delayMaxMs = this.configService.get<number>('REPLIES_AUTO_DELAY_MAX_MS', 1800000); // 30 min
            const delay = delayMinMs + Math.floor(Math.random() * (delayMaxMs - delayMinMs));
            this.logger.debug(`Auto-reply: waiting ${Math.round(delay / 60000)}min before posting (human-like delay)`);
            await new Promise((resolve) => setTimeout(resolve, delay));

            const result = await this.engagementService.reply(
              post.network as SocialNetwork,
              post.postUrl,
              decision.replyText,
            );

            if (result.success) {
              await this.prisma.incomingComment.update({
                where: { id: comment.id },
                data: {
                  status: CommentStatus.REPLIED,
                  replyText: decision.replyText,
                  replyPostedAt: new Date(),
                },
              });
              stats.repliesPosted++;
              this.logger.log(`Auto-replied to comment ${comment.commentId} on post ${post.id}`);

              // SSE event for UI
              await this.sseService.publish({
                type: 'reply_posted',
                postId: post.id,
                commentId: comment.commentId,
                network: post.network,
              });
            } else {
              this.logger.warn(`Reply posting failed for comment ${comment.commentId}: ${result.error}`);
              // Keep as NEW for next cycle retry
            }
          } catch (err) {
            this.logger.warn(`Reply posting error for comment ${comment.commentId}: ${(err as Error).message}`);
          }
        } else {
          this.logger.warn(`EngagementService not available or no postUrl — cannot post reply`);
        }
        break;
      }
    }
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
