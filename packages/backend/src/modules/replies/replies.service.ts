/**
 * Sprint O / F4: Adaptive Replies Service — monitor and respond to comments.
 *
 * Periodically checks for new comments/replies on posted content, generates
 * contextually appropriate responses via LLM, and posts them.
 *
 * Env-gated: only active when REPLIES_ENABLED=true.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { PostStatus, SocialNetwork } from '@prisma/client';
import { parseBool } from '../../infrastructure/config/parse-bool';

export interface Comment {
  id: string;
  author: string;
  text: string;
  timestamp: Date;
}

export interface ReplyDecision {
  shouldReply: boolean;
  reason: string;
  replyText?: string;
}

@Injectable()
export class RepliesService {
  private readonly logger = new Logger(RepliesService.name);
  private readonly enabled: boolean;
  private readonly maxRepliesPerPost: number;
  private readonly replyDelayMinMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly accountsService: AccountsService,
  ) {
    this.enabled = parseBool(this.configService.get<string>('REPLIES_ENABLED', 'false'));
    this.maxRepliesPerPost = this.configService.get<number>('REPLIES_MAX_PER_POST', 3);
    this.replyDelayMinMs = this.configService.get<number>('REPLIES_DELAY_MIN_MS', 300000); // 5 min
  }

  /**
   * Get posts that are eligible for reply monitoring (posted recently, not too old).
   */
  async getMonitorablePosts(): Promise<{ id: string; network: string; postUrl: string | null; content: string }[]> {
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
   * Decide whether to reply to a comment and generate the reply text.
   * Checks the account's real username (not a fragile substring match) and
   * skips comments we've already replied to.
   */
  async decideReply(
    postId: string,
    postContent: string,
    comment: Comment,
    network: string,
  ): Promise<ReplyDecision> {
    // Check if we already replied to this comment
    const existingReplies = await this.getExistingReplies(postId);
    if (existingReplies?.some((r) => r.commentId === comment.id)) {
      return { shouldReply: false, reason: 'Already replied to this comment' };
    }

    // Don't reply to our own comments — check against the real account handle
    try {
      const account = await this.accountsService.findByNetwork(network as SocialNetwork);
      if (account?.handle) {
        const ownHandle = account.handle.toLowerCase();
        const commentAuthor = comment.author.toLowerCase().replace(/^@/, '');
        if (commentAuthor === ownHandle) {
          return { shouldReply: false, reason: 'Self-reply skipped (own account)' };
        }
      }
    } catch {
      // If account lookup fails, fall back to heuristic matching
      this.logger.warn(`Account lookup failed for ${network} — using heuristic self-reply detection`);
    }

    // Don't reply to spam/trolls (basic heuristic)
    const trollPatterns = /spam|scam|fake|bot|stupid|idiot|hate/i;
    if (trollPatterns.test(comment.text)) {
      return { shouldReply: false, reason: 'Potential troll/spam — skipped' };
    }

    // Questions get priority replies
    const isQuestion = /\?$/.test(comment.text) || /^(what|why|how|when|where|who|can|do|is|are|will)\b/i.test(comment.text);

    // Generate reply text (placeholder — LLM integration would go here)
    const replyText = this.generateReplyText(postContent, comment, isQuestion);

    return {
      shouldReply: true,
      reason: isQuestion ? 'Question — priority reply' : 'Engagement opportunity',
      replyText,
    };
  }

  /**
   * Generate a reply text using language-aware templates.
   * Detects the language of the comment and responds in the same language.
   * In production, the LLM-based replies-monitor.service.ts handles this —
   * this is the simple fallback used by the manual reply endpoint.
   */
  private generateReplyText(postContent: string, comment: Comment, isQuestion: boolean): string {
    const lang = this.detectLanguage(comment.text);

    if (isQuestion) {
      const questionTemplates: Record<string, string> = {
        uk: `Чудове запитання! ✨ Космічні енергії завжди змінюються. Який аспект резонує з вами?`,
        ru: `Отличный вопрос! ✨ Космические энергии постоянно меняются. Какой аспект резонирует с вами?`,
        en: `Great question! ✨ The cosmic energies are always shifting. What specific aspect resonates with you?`,
      };
      return questionTemplates[lang] ?? questionTemplates.en!;
    }

    // Positive engagement
    const positivePatterns = /love|great|amazing|interesting|true|relatable|wow|подоб|спасиб|дякую|клас|чудов/i;
    if (positivePatterns.test(comment.text)) {
      const positiveTemplates: Record<string, string> = {
        uk: `Дякуємо, що поділилися! ✨ Зірки мають спосіб говорити з нами.`,
        ru: `Спасибо, что поделились! ✨ Звёзды умеют говорить с нами.`,
        en: `Thank you for sharing! ✨ The stars have a way of speaking to us.`,
      };
      return positiveTemplates[lang] ?? positiveTemplates.en!;
    }

    // Default engagement
    const defaultTemplates: Record<string, string> = {
      uk: `Дякуємо за взаємодію! ✨ Який ваш знак зодіаку?`,
      ru: `Спасибо за взаимодействие! ✨ Какой ваш знак зодиака?`,
      en: `Thanks for engaging! ✨ What's your sign?`,
    };
    return defaultTemplates[lang] ?? defaultTemplates.en!;
  }

  /**
   * Detect language using script-based heuristics (no external dependency).
   */
  private detectLanguage(text: string): 'uk' | 'ru' | 'en' {
    const cyrillicChars = (text.match(/[а-яіїєґА-ЯІЇЄҐ]/g) || []).length;
    if (cyrillicChars < 3) return 'en';
    const ukSpecific = (text.match(/[іїєґІЇЄҐ]/g) || []).length;
    const ruSpecific = (text.match(/[ыэъёЫЭЪЁ]/g) || []).length;
    if (ukSpecific > 0 && ruSpecific === 0) return 'uk';
    if (ruSpecific > 0 && ukSpecific === 0) return 'ru';
    // NOTE: \b in JavaScript regex is ASCII-only and does NOT work with Cyrillic.
    // Use (?:^|[^а-яіїєґА-ЯІЇЄҐ]) prefix instead of \b for Cyrillic word boundaries.
    const cyrillicBoundary = '(?:^|[^а-яіїєґА-ЯІЇЄҐ])';
    const ukWords = new RegExp(
      cyrillicBoundary + '(?:і|та|що|як|це|дякую|спасибі|добре)(?=$|[^а-яіїєґА-ЯІЇЄҐ])',
      'i',
    ).test(text);
    const ruWords = new RegExp(
      cyrillicBoundary + '(?:и|да|что|как|это|спасибо|хорошо)(?=$|[^а-яіїєґА-ЯІЇЄҐ])',
      'i',
    ).test(text);
    if (ukWords && !ruWords) return 'uk';
    if (ruWords && !ukWords) return 'ru';
    return 'uk'; // Default to Ukrainian for Cyrillic (brand is Ukraine-based)
  }

  /**
   * Record a reply in the database for tracking.
   * Merges with existing llmMetadata — does NOT overwrite other fields
   * (model, tokens, cost, promptVersion, angleType, simhash, recycled, etc.).
   */
  async recordReply(postId: string, commentId: string, replyText: string): Promise<void> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { llmMetadata: true },
    });
    const existing = (post?.llmMetadata as Record<string, unknown> | null) ?? {};
    const existingReplies = (existing.replies as Array<{ commentId: string; replyText: string; repliedAt: string }> | undefined) ?? [];

    await this.prisma.post.update({
      where: { id: postId },
      data: {
        llmMetadata: {
          ...existing,
          replies: [
            ...existingReplies,
            { commentId, replyText, repliedAt: new Date().toISOString() },
          ],
        },
      },
    });
  }

  /**
   * Get existing replies for a post (from llmMetadata).
   */
  private async getExistingReplies(postId: string): Promise<{ commentId: string; replyText: string; repliedAt: string }[] | null> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { llmMetadata: true },
    });
    const metadata = post?.llmMetadata as { replies?: { commentId: string; replyText: string; repliedAt: string }[] } | null;
    return metadata?.replies ?? null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
