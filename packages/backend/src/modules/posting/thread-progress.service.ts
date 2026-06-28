/**
 * P0-H2: ThreadProgressService — persists per-reply tracking for resumable threads.
 *
 * Previously, per-reply tracking was in-memory only (threadReplyResults array).
 * If the process crashed mid-thread, there was no way to know which replies
 * had been posted. This service persists progress to the ThreadProgress table.
 *
 * Flow:
 *   1. initThread(rootPostId, replies) — creates PENDING entries for all replies
 *   2. markReplyPosted(rootPostId, replyPostId, url) — marks individual reply POSTED
 *   3. markReplyFailed(rootPostId, replyPostId, error) — marks individual reply FAILED
 *   4. getPendingReplies(rootPostId) — returns replies not yet posted (for resume)
 *   5. getThreadProgress(rootPostId) — returns all progress entries for inspection
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class ThreadProgressService {
  private readonly logger = new Logger(ThreadProgressService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Initialize thread progress entries for all replies in a thread.
   * Creates PENDING entries for each reply that doesn't already exist.
   * Idempotent — safe to call multiple times.
   */
  async initThread(
    rootPostId: string,
    replies: Array<{ id: string; threadPosition: number }>,
  ): Promise<void> {
    for (const reply of replies) {
      try {
        await this.prisma.threadProgress.upsert({
          where: {
            postId_replyPostId: {
              postId: rootPostId,
              replyPostId: reply.id,
            },
          },
          create: {
            postId: rootPostId,
            replyPostId: reply.id,
            position: reply.threadPosition,
            status: 'PENDING',
          },
          update: {}, // don't overwrite if already exists
        });
      } catch (err) {
        this.logger.warn(
          `Failed to init ThreadProgress for reply ${reply.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Mark an individual reply as POSTED.
   */
  async markReplyPosted(
    rootPostId: string,
    replyPostId: string,
    postUrl: string,
  ): Promise<void> {
    try {
      await this.prisma.threadProgress.update({
        where: {
          postId_replyPostId: {
            postId: rootPostId,
            replyPostId,
          },
        },
        data: {
          status: 'POSTED',
          postUrl,
          completedAt: new Date(),
          error: null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to mark reply ${replyPostId} as POSTED: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Mark an individual reply as FAILED.
   */
  async markReplyFailed(
    rootPostId: string,
    replyPostId: string,
    error: string,
  ): Promise<void> {
    try {
      await this.prisma.threadProgress.update({
        where: {
          postId_replyPostId: {
            postId: rootPostId,
            replyPostId,
          },
        },
        data: {
          status: 'FAILED',
          error,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to mark reply ${replyPostId} as FAILED: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Get all PENDING replies for a thread (for resume after crash).
   * Returns reply post IDs that haven't been posted yet.
   */
  async getPendingReplies(rootPostId: string): Promise<string[]> {
    const pending = await this.prisma.threadProgress.findMany({
      where: {
        postId: rootPostId,
        status: 'PENDING',
      },
      select: { replyPostId: true },
    });
    return pending.map((p) => p.replyPostId);
  }

  /**
   * Get all progress entries for a thread (for inspection / UI display).
   */
  async getThreadProgress(rootPostId: string): Promise<
    Array<{
      replyPostId: string;
      position: number;
      status: string;
      postUrl: string | null;
      error: string | null;
      attemptedAt: Date;
      completedAt: Date | null;
    }>
  > {
    return this.prisma.threadProgress.findMany({
      where: { postId: rootPostId },
      orderBy: { position: 'asc' },
      select: {
        replyPostId: true,
        position: true,
        status: true,
        postUrl: true,
        error: true,
        attemptedAt: true,
        completedAt: true,
      },
    });
  }

  /**
   * Check if a thread is fully posted (all replies POSTED).
   */
  async isThreadComplete(rootPostId: string): Promise<boolean> {
    const total = await this.prisma.threadProgress.count({
      where: { postId: rootPostId },
    });
    if (total === 0) return true; // no replies = complete

    const posted = await this.prisma.threadProgress.count({
      where: {
        postId: rootPostId,
        status: 'POSTED',
      },
    });
    return posted === total;
  }

  /**
   * Get summary stats for a thread.
   */
  async getThreadStats(rootPostId: string): Promise<{
    total: number;
    posted: number;
    failed: number;
    pending: number;
  }> {
    const [total, posted, failed, pending] = await Promise.all([
      this.prisma.threadProgress.count({ where: { postId: rootPostId } }),
      this.prisma.threadProgress.count({
        where: { postId: rootPostId, status: 'POSTED' },
      }),
      this.prisma.threadProgress.count({
        where: { postId: rootPostId, status: 'FAILED' },
      }),
      this.prisma.threadProgress.count({
        where: { postId: rootPostId, status: 'PENDING' },
      }),
    ]);

    return { total, posted, failed, pending };
  }
}
