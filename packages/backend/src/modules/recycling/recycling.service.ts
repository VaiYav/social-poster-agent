/**
 * Sprint O / F13: Content Recycling Service — refresh old top-performing posts.
 *
 * Identifies posts that performed well (posted >30 days ago) and creates
 * new draft variants with updated angles/hooks. Avoids exact duplicates via SimHash.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostStatus } from '@prisma/client';
import { simhash, hammingDistance } from '../generation/simhash.js';
import { GenerationService } from '../generation/generation.service.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';

@Injectable()
export class RecyclingService {
  private readonly logger = new Logger(RecyclingService.name);

  constructor(
    private readonly prisma: PrismaService,
    // RC3: recycling re-writes content through the generation graph (no verbatim copies).
    private readonly generationService: GenerationService,
  ) {}

  /**
   * Find posts eligible for recycling — posted >30 days ago, not yet recycled.
   */
  async findRecyclablePosts(limit = 10): Promise<{ id: string; network: string; content: string; postedAt: Date | null }[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const posts = await this.prisma.post.findMany({
      where: {
        status: PostStatus.POSTED,
        postedAt: { lt: thirtyDaysAgo },
        // Check llmMetadata for recycled flag
        llmMetadata: { path: ['recycled'], not: true },
      },
      orderBy: { postedAt: 'desc' },
      take: limit * 2, // get more than needed, filter by simhash
      select: {
        id: true,
        network: true,
        content: true,
        postedAt: true,
        accountId: true,
        sourceRef: true,
      },
    });

    // Filter out posts that are too similar to recent posts
    const recentHashes = await this.loadRecentHashes();
    const recyclable = posts.filter((post) => {
      const hash = simhash(post.content);
      return !recentHashes.some((existing) => hammingDistance(hash, existing) <= 5);
    });

    return recyclable.slice(0, limit);
  }

  /**
   * RC3: recycle one post by id. Delegates to the generation graph so the new draft is a
   * genuinely re-written variant — NEVER a verbatim copy of the 30-day-old original (the
   * old implementation copied content verbatim and "will be re-written by the pipeline" —
   * but nothing rewrote it, so an approved recycled draft was an exact duplicate that
   * bypassed SimHash).
   */
  async recyclePost(postId: string): Promise<{ id: string; status: string } | null> {
    return this.generationService.recycleById(postId);
  }

  /**
   * Run recycling for all eligible posts.
   */
  async runRecycling(limit = 5): Promise<{ recycled: number; skipped: number }> {
    this.logger.log(`Running content recycling (limit: ${limit})...`);

    const candidates = await this.findRecyclablePosts(limit);

    let recycled = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      try {
        const result = await this.recyclePost(candidate.id);
        if (result) {
          recycled++;
        } else {
          skipped++;
        }
      } catch (err) {
        this.logger.error(`Failed to recycle post ${candidate.id}: ${(err as Error).message}`);
        skipped++;
      }
    }

    this.logger.log(`Recycling complete: ${recycled} recycled, ${skipped} skipped`);
    return { recycled, skipped };
  }

  /**
   * RC2: recycling never ran automatically — there was no scheduler, only a manual endpoint.
   * Flag-gated cron (default OFF, like the other autonomy features) so enabling auto-recycling
   * is an explicit opt-in. NOTE: until metrics land (AN1), candidate selection is by age, not
   * by real performance — recycled drafts still require approval (auto-approve is separate).
   */
  @Cron(process.env.RECYCLING_CRON_SCHEDULE ?? '0 8 * * 1') // weekly, Mon 08:00
  async recyclingCron(): Promise<void> {
    if (!parseBool(process.env.RECYCLING_CRON_ENABLED ?? 'false')) {
      return;
    }
    this.logger.log('RC2: scheduled recycling run starting');
    await this.runRecycling();
  }

  private async loadRecentHashes(): Promise<string[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentPosts = await this.prisma.post.findMany({
      where: { createdAt: { gte: sevenDaysAgo } },
      select: { content: true, simhash: true },
      take: 100,
    });

    return recentPosts.map((p) => p.simhash ?? simhash(p.content));
  }
}
